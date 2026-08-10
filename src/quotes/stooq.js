// Real network adapter, selected by QUOTE_PROVIDER=stooq. Stooq is chosen
// over a keyed provider like Finnhub specifically because it needs no API
// key, so this live-network code path stays exercisable by anyone who
// clones the repo, instead of being dead code behind a secret nobody has.
//
// Contract with the rest of the app: this provider NEVER throws and NEVER
// rejects. Every failure mode (timeout, non-200, unparsable CSV, an
// unresolved symbol, a network outage) degrades to `null` for the
// affected symbols (or a stale cached quote), never an exception. That is
// the structural fix for defect C5 (the old Yahoo fetch code let an
// unhandled request error crash the process). Adding an error listener
// alone is not sufficient — every code path here funnels into a `null` or
// a stale quote, by construction, not by remembering to catch.
//
// ---------------------------------------------------------------------
// Adding another keyed adapter (e.g. Finnhub) — about 40 lines:
//
//   export function createFinnhubProvider(env = process.env, deps = {}) {
//     const apiKey = env.FINNHUB_API_KEY;
//     const { fetchImpl = fetch, now = Date.now } = deps;
//     return {
//       name: 'finnhub',
//       async getQuotes(symbols) {
//         const result = new Map();
//         if (!apiKey) {
//           // No key configured: never throw, just fail open to null so
//           // the app still starts with zero secrets (same "zero API
//           // keys" requirement fake.js exists to satisfy by default).
//           for (const s of symbols) result.set(s, null);
//           return result;
//         }
//         // ... same shape as below: validate symbols, cache with a TTL,
//         // fetch with AbortSignal.timeout + one retry, match the
//         // response back to symbols by its own symbol/ticker field
//         // (never by array position — that is defect C1), catch
//         // everything, map failures to null or a stale cached quote.
//       },
//     };
//   }
//
// Then register it in index.js:
//   import { createFinnhubProvider } from './finnhub.js';
//   registry.set('finnhub', (env) => createFinnhubProvider(env));
// ---------------------------------------------------------------------

const SYMBOL_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;

const ENDPOINT = 'https://stooq.com/q/l/?s=';
const TIMEOUT_MS = 3000;
const CACHE_TTL_MS = 60000;
const RETRY_JITTER_MIN_MS = 10;
const RETRY_JITTER_MAX_MS = 50;

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Parse the stooq CSV response into rows keyed by whatever column header
 * the response actually used for the symbol/close fields, rather than
 * assuming a fixed column order — defensive against the feed changing
 * field order, and this is also how out-of-order / short row counts get
 * matched correctly instead of by index (C1).
 */
function parseCsv(text) {
  if (typeof text !== 'string') return [];
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return [];

  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const symbolIdx = header.indexOf('symbol');
  const closeIdx = header.indexOf('close');
  if (symbolIdx === -1 || closeIdx === -1) return [];

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = lines[i].split(',');
    const rawSymbol = (fields[symbolIdx] ?? '').trim();
    const rawClose = (fields[closeIdx] ?? '').trim();
    if (!rawSymbol) continue;
    rows.push({ symbol: rawSymbol.toUpperCase(), close: rawClose });
  }
  return rows;
}

function toPrice(rawClose) {
  if (!rawClose || rawClose.toUpperCase() === 'N/D') return null;
  const price = Number(rawClose);
  if (!Number.isFinite(price) || price <= 0) return null;
  return price;
}

/**
 * @param {NodeJS.ProcessEnv} [env] - stooq needs no API key (that's the
 *   point of choosing it), but `STOOQ_ENDPOINT` is read as an optional
 *   escape hatch for pointing at a self-hosted mirror. It is not part of
 *   the frozen env-var contract in README.md; unset, it defaults to the
 *   real stooq endpoint.
 * @param {{ fetchImpl?: typeof fetch, now?: () => number }} [deps] -
 *   inject a stub fetch for tests (never hit the real network in tests)
 *   and the clock for cache-TTL control.
 * @returns {import('./index.js').QuoteProvider}
 */
export function createStooqProvider(env = process.env, deps = {}) {
  const { fetchImpl = fetch, now = Date.now } = deps;
  const endpoint = env.STOOQ_ENDPOINT || ENDPOINT;

  /** @type {Map<string, {quote: object, fetchedAt: number}>} */
  const cache = new Map();

  async function fetchOnce(symbols) {
    const url = `${endpoint}${encodeURIComponent(symbols.join(','))}&f=sd2t2ohlcv&h&e=csv`;
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res || !res.ok) {
      throw new Error(`stooq responded with status ${res ? res.status : 'unknown'}`);
    }
    const text = await res.text();
    return parseCsv(text);
  }

  async function fetchWithRetry(symbols) {
    try {
      return await fetchOnce(symbols);
    } catch {
      const jitter =
        RETRY_JITTER_MIN_MS +
        Math.floor(Math.random() * (RETRY_JITTER_MAX_MS - RETRY_JITTER_MIN_MS));
      await sleep(jitter);
      try {
        return await fetchOnce(symbols);
      } catch {
        return null; // total failure — caller falls back to stale cache / null
      }
    }
  }

  return {
    name: 'stooq',

    async getQuotes(symbols) {
      const result = new Map();
      try {
        const nowMs = now();
        const toFetch = [];

        for (const symbol of symbols) {
          if (typeof symbol !== 'string' || !SYMBOL_RE.test(symbol)) {
            result.set(symbol, null);
            continue;
          }
          const cached = cache.get(symbol);
          if (cached && nowMs - cached.fetchedAt < CACHE_TTL_MS) {
            result.set(symbol, cached.quote);
          } else {
            toFetch.push(symbol);
          }
        }

        if (toFetch.length === 0) return result;

        let rows = null;
        try {
          rows = await fetchWithRetry(toFetch);
        } catch {
          rows = null;
        }

        const bySymbol = new Map((rows ?? []).map((r) => [r.symbol, r]));

        for (const symbol of toFetch) {
          const row = bySymbol.get(symbol.toUpperCase());
          const price = row ? toPrice(row.close) : null;

          if (price !== null) {
            const quote = {
              symbol,
              price,
              currency: 'USD',
              asOf: new Date(nowMs),
              source: 'stooq',
              stale: false,
            };
            cache.set(symbol, { quote, fetchedAt: nowMs });
            result.set(symbol, quote);
            continue;
          }

          const stale = cache.get(symbol);
          result.set(symbol, stale ? { ...stale.quote, stale: true } : null);
        }

        return result;
      } catch {
        // Last-resort guard: whatever happened, every requested symbol
        // still gets a key, and nothing propagates (C5).
        for (const symbol of symbols) {
          if (!result.has(symbol)) result.set(symbol, null);
        }
        return result;
      }
    },
  };
}
