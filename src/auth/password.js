// Password hashing (closes defect S1 — unsalted MD5, see lib/nocklib.js:232-234).
//
// Format: a self-describing PHC-style string, so the algorithm and its
// parameters are explicit rather than sniffed from length/shape:
//
//   scrypt$N=16384,r=8,p=1$<base64 salt>$<base64 hash>
//
// Why scrypt over argon2/bcrypt: both of those ship as native addons, and
// this project's hard requirement is that `node:22-alpine` builds with no
// compiler toolchain (see README "Contract" / target stack). `node:crypto`
// scrypt is pure-JS-surface, built in, and needs nothing extra in the
// Docker image. If that constraint is ever relaxed, argon2id is the
// drop-in upgrade: keep this same PHC-string shape, add an `argon2id$...`
// branch to `verify`/`isLegacy`/`needsRehash`, and make `hash()` emit the
// new format for newly-created/rehashed passwords while these functions
// keep reading old scrypt rows forever (the same lazy-rehash pattern this
// module already uses for the MD5 -> scrypt transition below).
//
// This module is crypto-only: no DB, no HTTP, no config import. Callers
// (P2's login flow) pass policy in as plain arguments/return values.

import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

const ALGO_TAG = 'scrypt';
const CURRENT_PARAMS = { N: 16384, r: 8, p: 1 };
const SALT_BYTES = 16;
const KEY_LENGTH = 32;

// `crypto.scrypt`'s default `maxmem` is 32 MiB; the memory a given (N, r)
// pair needs is roughly 128 * N * r bytes. Current params need 16 MiB.
// This is a *fixed* ceiling, not derived from whatever N/r a stored value
// claims: `verify()` parses `stored` (attacker/corruption-reachable data),
// and if its cap tracked the parsed params, an absurd N would just widen
// the cap to match and let Node attempt the matching allocation. Node's
// scrypt implementation checks the requested cost against `maxmem` *before*
// allocating, so keeping this fixed means oversized params fail fast with
// an error (caught below, degraded to `false`) instead of ever allocating.
const MAXMEM = 64 * 1024 * 1024;

const LEGACY_MD5_RE = /^[a-f0-9]{32}$/;

// scrypt$N=<int>,r=<int>,p=<int>$<base64>$<base64>
const PHC_RE = /^scrypt\$N=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9+/]+=*)\$([A-Za-z0-9+/]+=*)$/;

/**
 * Hash a plaintext password into the PHC-style scrypt string described at
 * the top of this file. Uses a fresh random 16-byte salt every call, so
 * hashing the same password twice yields two different (both-valid) strings.
 *
 * @param {string} plain
 * @returns {Promise<string>}
 */
export async function hash(plain) {
  if (typeof plain !== 'string') {
    throw new TypeError('hash() requires a string password');
  }
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(plain, salt, KEY_LENGTH, {
    N: CURRENT_PARAMS.N,
    r: CURRENT_PARAMS.r,
    p: CURRENT_PARAMS.p,
    maxmem: MAXMEM,
  });
  return [
    ALGO_TAG,
    `N=${CURRENT_PARAMS.N},r=${CURRENT_PARAMS.r},p=${CURRENT_PARAMS.p}`,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/**
 * True if `stored` has the shape of a legacy (pre-modernization) unsalted
 * MD5 hash: exactly 32 lowercase hex characters. Does not verify anything
 * about the value beyond its shape.
 *
 * @param {unknown} stored
 * @returns {boolean}
 */
export function isLegacy(stored) {
  return typeof stored === 'string' && LEGACY_MD5_RE.test(stored);
}

/**
 * Parse a PHC-style scrypt string into its components. Returns null for
 * anything that doesn't cleanly parse — never throws.
 *
 * @param {unknown} stored
 * @returns {{N: number, r: number, p: number, salt: Buffer, hash: Buffer} | null}
 */
function parsePhc(stored) {
  if (typeof stored !== 'string') return null;
  const match = PHC_RE.exec(stored);
  if (!match) return null;

  const [, nStr, rStr, pStr, saltB64, hashB64] = match;
  const N = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);

  // Reject anything scrypt itself would reject or that is obviously
  // nonsensical, before it ever reaches the crypto call.
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
  if (N < 2 || (N & (N - 1)) !== 0) return null; // scrypt requires N to be a power of 2 > 1
  if (r < 1 || p < 1) return null;
  if (N > 2 ** 20 || r > 1024 || p > 1024) return null; // guard against absurd params (DoS)

  // Buffer.from(..., 'base64') never throws on malformed input — it just
  // decodes whatever it can and drops the rest — so guard with a length
  // check instead of a try/catch: an empty decode means the field wasn't
  // usable base64 to begin with (this module's public contract that
  // parsing never throws is enforced by callers wrapping this in their own
  // try/catch regardless — see `verify`).
  const salt = Buffer.from(saltB64, 'base64');
  const hashBuf = Buffer.from(hashB64, 'base64');
  if (salt.length === 0 || hashBuf.length === 0) return null;

  return { N, r, p, salt, hash: hashBuf };
}

/**
 * Verify a plaintext password against a stored scrypt PHC string or a
 * legacy MD5 hash. Dispatches on the shape of `stored`. Never throws —
 * any malformed, truncated, or otherwise-garbage `stored` value simply
 * verifies as false, so a corrupt row can never become a denial-of-service
 * vector on the login path.
 *
 * Note: this does NOT perform the legacy-MD5 comparison itself (that
 * requires an explicit opt-in — see `verifyLegacy` and the
 * `LEGACY_MD5_LOGIN` contract). It only handles current-format scrypt
 * hashes; legacy rows always verify false here.
 *
 * @param {string} plain
 * @param {unknown} stored
 * @returns {Promise<boolean>}
 */
export async function verify(plain, stored) {
  try {
    if (typeof plain !== 'string') return false;
    const parsed = parsePhc(stored);
    if (!parsed) return false;

    const derived = await scrypt(plain, parsed.salt, parsed.hash.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: MAXMEM,
    });

    // Lengths always match here (derived is requested at parsed.hash.length),
    // but guard explicitly anyway since timingSafeEqual throws on mismatch.
    if (derived.length !== parsed.hash.length) return false;
    return timingSafeEqual(derived, parsed.hash);
  } catch {
    // Absolutely anything unexpected (bad scrypt params rejected internally,
    // OOM guard, etc.) degrades to "does not verify", never a thrown error.
    return false;
  }
}

/**
 * Verify a plaintext password against a legacy unsalted-MD5 hash, using a
 * constant-time comparison. Callers must first confirm `isLegacy(stored)`
 * and that the `LEGACY_MD5_LOGIN` flag is enabled — this function performs
 * no such gating itself, it only does the raw comparison. Never throws.
 *
 * @param {string} plain
 * @param {unknown} stored
 * @returns {boolean}
 */
export function verifyLegacy(plain, stored) {
  if (typeof plain !== 'string' || typeof stored !== 'string') return false;
  // Everything past this point is safe by construction: `stored` is now
  // known to be exactly 32 lowercase hex characters, which always decodes
  // to a 16-byte buffer, and `createHash('md5')` never throws on string
  // input — so there is nothing left here that can raise.
  if (!LEGACY_MD5_RE.test(stored)) return false;

  const candidate = createHash('md5').update(plain, 'utf8').digest();
  const storedBuf = Buffer.from(stored, 'hex');

  if (candidate.length !== storedBuf.length) return false;
  return timingSafeEqual(candidate, storedBuf);
}

/**
 * True if `stored` should be replaced with a fresh `hash()` output at the
 * next opportunity: legacy MD5 hashes always qualify, and so does any
 * scrypt hash whose parameters are weaker than the current policy (e.g. an
 * older row hashed under a lower N before this module's defaults were
 * raised). Never throws; an unparseable value is treated as needing a
 * rehash too, since the safe response to "row we can't make sense of" is
 * "replace it as soon as we successfully authenticate".
 *
 * @param {unknown} stored
 * @returns {boolean}
 */
export function needsRehash(stored) {
  if (isLegacy(stored)) return true;
  const parsed = parsePhc(stored);
  if (!parsed) return true;
  return (
    parsed.N < CURRENT_PARAMS.N ||
    parsed.r < CURRENT_PARAMS.r ||
    parsed.p < CURRENT_PARAMS.p ||
    parsed.hash.length < KEY_LENGTH
  );
}
