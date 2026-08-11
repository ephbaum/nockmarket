// Deterministic, zero-network quote provider. Selected when QUOTE_PROVIDER
// is unset or "fake" (see index.js). This is the provider that actually
// runs in dev, in CI, and in `docker compose up` with no API key and no
// external network — see README.md "Contract" for QUOTE_PROVIDER,
// QUOTE_SEED and QUOTE_BUCKET_MS.
//
// Design: price(symbol, timeBucket) is a pure function of
// `hash32(symbol) ^ QUOTE_SEED` and `floor(now() / QUOTE_BUCKET_MS)`. Same
// symbol + same time bucket always yields the same price (reproducible
// tests); the price visibly moves once `now()` crosses into the next
// bucket.
//
// A literal "seed a PRNG, then step it forward N times" implementation
// would be O(N) per call, where N = floor(realEpochMs / bucketMs) — on the
// order of hundreds of millions for a 5s bucket against a real wall clock.
// mulberry32's internal state is a plain Weyl sequence
// (`state_k = state_0 + k * INCREMENT mod 2^32`), so the k-th draw can be
// computed directly in O(1) without replaying the first k-1. We use that
// jump-ahead to evaluate only a small trailing window of decayed draws per
// call (an EWMA-style walk: recent buckets dominate, older ones decay
// toward zero), which is what keeps the walk bounded over long uptimes
// "for free" instead of needing an unbounded accumulator that must be
// clamped after the fact.

const SYMBOL_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;

const WEYL_INCREMENT = 0x6d2b79f5n;
const MASK32 = 0xffffffffn;

// Random-walk shape constants. Kept small and named so the bounds are
// easy to reason about / retune without hunting magic numbers.
const WINDOW = 32; // how many trailing buckets contribute to the walk
const DECAY = 0.85; // per-step decay applied to the running displacement
const STEP_SIZE = 0.05; // max magnitude of a single step's log-return contribution
const MAX_LOG_DISPLACEMENT = 0.6; // hard clamp -> price within [base*e^-0.6, base*e^0.6]
const MIN_BASE_PRICE = 5;
const MAX_BASE_PRICE = 500;

const DEFAULT_SEED = 42;
const DEFAULT_BUCKET_MS = 5000;

/** 32-bit FNV-1a hash of a string. */
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32's mixing function, applied to a raw 32-bit state. */
function mix(state) {
  let t = state >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
  t = (t ^ ((t + Math.imul(t ^ (t >>> 7), t | 61)) >>> 0)) >>> 0;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * The mulberry32 state after `k` draws from the given 32-bit seed,
 * computed directly (O(1)) rather than by iterating k times.
 * @param {number} seed - unsigned 32-bit integer
 * @param {number} k - non-negative step index, may be arbitrarily large
 */
function stateAt(seed, k) {
  const s = (BigInt(seed >>> 0) + BigInt(k) * WEYL_INCREMENT) & MASK32;
  return Number(s);
}

/** A stable, plausible base price in [MIN_BASE_PRICE, MAX_BASE_PRICE] for a seed. */
function basePriceFor(seed) {
  const u = mix(stateAt(seed, 0));
  return MIN_BASE_PRICE + u * (MAX_BASE_PRICE - MIN_BASE_PRICE);
}

/**
 * Price for a given per-symbol seed at a given time bucket. Pure function:
 * identical inputs always produce identical output, in O(WINDOW) time
 * regardless of how large `bucket` is.
 */
function priceForBucket(seed, bucket) {
  const b = Math.max(0, Math.floor(bucket));
  const base = basePriceFor(seed);
  const start = Math.max(1, b - WINDOW + 1);
  let displacement = 0;
  for (let k = start; k <= b; k++) {
    const noise = mix(stateAt(seed, k)) - 0.5; // in (-0.5, 0.5)
    displacement = displacement * DECAY + noise * STEP_SIZE;
  }
  displacement = Math.max(-MAX_LOG_DISPLACEMENT, Math.min(MAX_LOG_DISPLACEMENT, displacement));
  return base * Math.exp(displacement);
}

function parseIntEnv(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ now?: () => number }} [deps] - inject the clock so tests
 *   control time instead of sleeping.
 * @returns {import('./index.js').QuoteProvider}
 */
export function createFakeProvider(env = process.env, { now = Date.now } = {}) {
  const seed = parseIntEnv(env.QUOTE_SEED, DEFAULT_SEED) >>> 0;
  let bucketMs = parseIntEnv(env.QUOTE_BUCKET_MS, DEFAULT_BUCKET_MS);
  if (!Number.isFinite(bucketMs) || bucketMs <= 0) bucketMs = DEFAULT_BUCKET_MS;

  return {
    name: 'fake',

    async getQuotes(symbols) {
      const result = new Map();
      const nowMs = now();
      const bucket = Math.floor(nowMs / bucketMs);

      for (const symbol of symbols) {
        if (typeof symbol !== 'string' || !SYMBOL_RE.test(symbol)) {
          result.set(symbol, null);
          continue;
        }
        const symbolSeed = (hash32(symbol) ^ seed) >>> 0;
        const price = priceForBucket(symbolSeed, bucket);
        result.set(symbol, {
          symbol,
          price: Math.round(price * 100) / 100,
          currency: 'USD',
          asOf: new Date(nowMs),
          source: 'fake',
          stale: false,
        });
      }

      return result;
    },
  };
}

export { SYMBOL_RE };
