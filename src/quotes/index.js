// Quote provider registry. See README.md "Contract" for QUOTE_PROVIDER,
// QUOTE_SEED and QUOTE_BUCKET_MS.
//
// Deliberately takes `env` as a plain argument rather than importing
// src/config.js: config.js is developed in parallel by another work
// package, so depending on it here would create a build-order coupling
// neither package needs. `createQuoteProvider(env)` composes with
// whatever config module lands later — the caller just passes
// `config.raw ?? process.env` (or process.env directly) through.
//
// @typedef {Object} Quote
// @property {string} symbol
// @property {number} price
// @property {'USD'} currency
// @property {Date} asOf
// @property {string} source
// @property {boolean} stale
//
// @typedef {Object} QuoteProvider
// @property {'fake'|'stooq'|string} name
// @property {(symbols: string[]) => Promise<Map<string, Quote|null>>} getQuotes
//   Every requested symbol is a key in the returned Map, in no particular
//   order requirement — unresolvable symbols map to `null`. Never omits a
//   key, never re-derives one symbol's value from another's position
//   (that positional coupling was defect C1). Never throws, never
//   rejects (defect C5) — a total failure still resolves with `null` (or
//   a stale cached quote) for every affected symbol.

import { createFakeProvider } from './fake.js';
import { createStooqProvider } from './stooq.js';

const DEFAULT_PROVIDER_NAME = 'fake';

// Plain Map<name, factory> so a third adapter (e.g. a keyed Finnhub
// provider — see the comment block at the top of stooq.js) is one new
// file plus one line here.
const registry = new Map([
  ['fake', (env) => createFakeProvider(env)],
  ['stooq', (env) => createStooqProvider(env)],
]);

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {QuoteProvider}
 */
export function createQuoteProvider(env = process.env) {
  const requested = (env.QUOTE_PROVIDER ?? DEFAULT_PROVIDER_NAME).trim();
  const factory = registry.get(requested);

  if (!factory) {
    console.warn(
      `[quotes] Unknown QUOTE_PROVIDER "${requested}" — falling back to "${DEFAULT_PROVIDER_NAME}".`
    );
    return registry.get(DEFAULT_PROVIDER_NAME)(env);
  }

  return factory(env);
}
