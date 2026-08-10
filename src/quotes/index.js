// Quote provider registry. See README.md "Contract" for the env vars.
//
// Providers guarantee two things, both of which are fixes for real defects:
// getQuotes() returns every requested symbol as a Map key (unresolvable ones
// map to null) so no symbol's price can ever be derived from another's
// position — that was C1; and it never throws or rejects, because an
// unreachable upstream used to take the whole process down (C5).
//
// @typedef {{symbol: string, price: number, currency: 'USD', asOf: Date,
//            source: string, stale: boolean}} Quote
// @typedef {{name: string,
//            getQuotes: (symbols: string[]) => Promise<Map<string, Quote|null>>}} QuoteProvider

import { createFakeProvider } from './fake.js';
import { createStooqProvider } from './stooq.js';

const DEFAULT_PROVIDER_NAME = 'fake';

// A plain Map keeps adding an adapter to one file plus one line here.
const registry = new Map([
  ['fake', (env) => createFakeProvider(env)],
  ['stooq', (env) => createStooqProvider(env)],
]);

/**
 * Takes `env` rather than importing config.js, so the provider layer stays
 * independent of how configuration is assembled.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {QuoteProvider}
 */
export function createQuoteProvider(env = process.env) {
  const requested = (env.QUOTE_PROVIDER ?? DEFAULT_PROVIDER_NAME).trim();
  const factory = registry.get(requested);

  // An unknown provider name degrades to the offline default rather than
  // failing startup — a typo here should not take the app down.
  if (!factory) {
    console.warn(
      `[quotes] Unknown QUOTE_PROVIDER "${requested}" — falling back to "${DEFAULT_PROVIDER_NAME}".`
    );
    return registry.get(DEFAULT_PROVIDER_NAME)(env);
  }

  return factory(env);
}
