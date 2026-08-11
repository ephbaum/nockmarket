// Password hashing (closes defect S1 — unsalted MD5, see lib/nocklib.js:232-234).
//
// Format: a self-describing PHC-style string, so the algorithm and its
// parameters are explicit rather than sniffed from length/shape:
//
//   scrypt$N=16384,r=8,p=1$<base64 salt>$<base64 hash>
//
// Why scrypt over argon2/bcrypt: both are native addons, and the project
// requires node:22-alpine to build with no compiler toolchain. To upgrade to
// argon2id later, keep this PHC shape and add a branch to verify/needsRehash
// — the same lazy-rehash path used for MD5 below carries rows across.

import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

const ALGO_TAG = 'scrypt';
const CURRENT_PARAMS = { N: 16384, r: 8, p: 1 };
const SALT_BYTES = 16;
const KEY_LENGTH = 32;

// Deliberately a FIXED ceiling, never derived from the N/r a stored value
// claims. verify() parses attacker- or corruption-reachable data; a cap that
// tracked those params would widen to fit an absurd N and let Node attempt
// the allocation. Node checks cost against maxmem before allocating, so a
// fixed cap makes oversized params fail fast (degraded to false below).
const MAXMEM = 64 * 1024 * 1024;

const LEGACY_MD5_RE = /^[a-f0-9]{32}$/;

// scrypt$N=<int>,r=<int>,p=<int>$<base64>$<base64>
const PHC_RE = /^scrypt\$N=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9+/]+=*)\$([A-Za-z0-9+/]+=*)$/;

/**
 * @param {string} plain
 * @returns {Promise<string>} PHC string; a fresh salt each call means the
 *   same password hashes to two different, both-valid, values.
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
 * Shape check only — 32 lowercase hex characters. Verifies nothing.
 * @param {unknown} stored
 * @returns {boolean}
 */
export function isLegacy(stored) {
  return typeof stored === 'string' && LEGACY_MD5_RE.test(stored);
}

/**
 * @param {unknown} stored
 * @returns {{N: number, r: number, p: number, salt: Buffer, hash: Buffer} | null}
 *   null for anything that does not cleanly parse. Never throws.
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

  // Buffer.from(…, 'base64') never throws on malformed input, it silently
  // decodes what it can — so an empty result is the only signal that the
  // field was not usable base64.
  const salt = Buffer.from(saltB64, 'base64');
  const hashBuf = Buffer.from(hashB64, 'base64');
  if (salt.length === 0 || hashBuf.length === 0) return null;

  return { N, r, p, salt, hash: hashBuf };
}

/**
 * Never throws: a malformed or corrupt `stored` value verifies as false, so
 * a bad row cannot become a denial-of-service vector on the login path.
 *
 * Legacy MD5 rows always verify false here — that path requires explicit
 * opt-in via verifyLegacy() and the LEGACY_MD5_LOGIN flag.
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

    // Lengths always match here, but timingSafeEqual throws on mismatch.
    if (derived.length !== parsed.hash.length) return false;
    return timingSafeEqual(derived, parsed.hash);
  } catch {
    // Anything unexpected degrades to "does not verify", never a throw.
    return false;
  }
}

/**
 * Raw constant-time MD5 comparison. Does no gating of its own: callers must
 * check isLegacy() and the LEGACY_MD5_LOGIN flag first. Never throws.
 *
 * @param {string} plain
 * @param {unknown} stored
 * @returns {boolean}
 */
export function verifyLegacy(plain, stored) {
  if (typeof plain !== 'string' || typeof stored !== 'string') return false;
  if (!LEGACY_MD5_RE.test(stored)) return false;

  const candidate = createHash('md5').update(plain, 'utf8').digest();
  const storedBuf = Buffer.from(stored, 'hex');

  if (candidate.length !== storedBuf.length) return false;
  return timingSafeEqual(candidate, storedBuf);
}

/**
 * An unparseable value counts as needing a rehash: the safe response to a
 * row we cannot make sense of is to replace it once the user authenticates.
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
