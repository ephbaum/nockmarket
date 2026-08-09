import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createQuoteProvider } from '../../src/quotes/index.js';

describe('quote provider registry', () => {
  test('defaults to "fake" when QUOTE_PROVIDER is unset', () => {
    const provider = createQuoteProvider({});
    assert.equal(provider.name, 'fake');
  });

  test('selects "fake" explicitly', () => {
    const provider = createQuoteProvider({ QUOTE_PROVIDER: 'fake' });
    assert.equal(provider.name, 'fake');
  });

  test('selects "stooq" when named', () => {
    const provider = createQuoteProvider({ QUOTE_PROVIDER: 'stooq' });
    assert.equal(provider.name, 'stooq');
    assert.equal(typeof provider.getQuotes, 'function');
  });

  test('unknown provider name falls back to "fake" with a warning', () => {
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      const provider = createQuoteProvider({ QUOTE_PROVIDER: 'definitely-not-a-real-provider' });
      assert.equal(provider.name, 'fake');
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /definitely-not-a-real-provider/);
    } finally {
      console.warn = originalWarn;
    }
  });

  test('does not warn for a known provider', () => {
    const originalWarn = console.warn;
    let warned = false;
    console.warn = () => {
      warned = true;
    };
    try {
      createQuoteProvider({ QUOTE_PROVIDER: 'stooq' });
      assert.equal(warned, false);
    } finally {
      console.warn = originalWarn;
    }
  });

  test('every provider returned by the registry implements the QuoteProvider shape', async () => {
    for (const name of ['fake', 'stooq']) {
      const provider = createQuoteProvider({ QUOTE_PROVIDER: name });
      assert.equal(typeof provider.name, 'string');
      assert.equal(typeof provider.getQuotes, 'function');
      const quotes = await provider.getQuotes([]);
      assert.ok(quotes instanceof Map);
    }
  });
});
