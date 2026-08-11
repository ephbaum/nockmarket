import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createStooqProvider } from '../../src/quotes/stooq.js';

function okResponse(csv) {
  return { ok: true, status: 200, text: async () => csv };
}

function errorResponse(status) {
  return { ok: false, status, text: async () => '' };
}

function fetchStub(responses) {
  const calls = [];
  let i = 0;
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    const next = responses[Math.min(i, responses.length - 1)];
    i++;
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next();
    return next;
  };
  impl.calls = calls;
  return impl;
}

describe('stooq provider: happy path', () => {
  test('parses a well-formed CSV response into quotes keyed by symbol', async () => {
    const csv =
      'Symbol,Date,Time,Open,High,Low,Close,Volume\nAAPL,2026-08-09,16:00:00,190,192,189,191.23,1000\n';
    const fetchImpl = fetchStub([okResponse(csv)]);
    const provider = createStooqProvider({}, { fetchImpl, now: () => 1000 });

    const quotes = await provider.getQuotes(['AAPL']);
    const quote = quotes.get('AAPL');

    assert.equal(quote.symbol, 'AAPL');
    assert.equal(quote.price, 191.23);
    assert.equal(quote.currency, 'USD');
    assert.equal(quote.source, 'stooq');
    assert.equal(quote.stale, false);
    assert.ok(quote.asOf instanceof Date);
    assert.equal(provider.name, 'stooq');
    assert.equal(fetchImpl.calls.length, 1);
  });

  test('rejects invalid symbol shapes without ever calling fetch for them', async () => {
    const fetchImpl = fetchStub([okResponse('Symbol,Close\n')]);
    const provider = createStooqProvider({}, { fetchImpl, now: () => 0 });

    const quotes = await provider.getQuotes(['aapl', '<script>']);
    assert.equal(quotes.get('aapl'), null);
    assert.equal(quotes.get('<script>'), null);
    assert.equal(fetchImpl.calls.length, 0);
  });
});

describe('stooq provider: C1 regression (match by symbol field, never by row index)', () => {
  test('rows out of order are matched to the correct requested symbol', async () => {
    const csv = ['Symbol,Close', 'MSFT,410.50', 'AAPL,191.23', 'GOOG,171.00'].join('\n');
    const fetchImpl = fetchStub([okResponse(csv)]);
    const provider = createStooqProvider({}, { fetchImpl, now: () => 0 });

    const quotes = await provider.getQuotes(['AAPL', 'MSFT', 'GOOG']);
    assert.equal(quotes.get('AAPL').price, 191.23);
    assert.equal(quotes.get('MSFT').price, 410.5);
    assert.equal(quotes.get('GOOG').price, 171.0);
  });

  test('fewer rows than requested: missing symbols map to null, present ones unaffected', async () => {
    const csv = ['Symbol,Close', 'AAPL,191.23'].join('\n');
    const fetchImpl = fetchStub([okResponse(csv)]);
    const provider = createStooqProvider({}, { fetchImpl, now: () => 0 });

    const quotes = await provider.getQuotes(['AAPL', 'NOTAREALTICKER', 'MSFT']);
    assert.equal(quotes.size, 3);
    assert.equal(quotes.get('AAPL').price, 191.23);
    assert.equal(quotes.get('NOTAREALTICKER'), null);
    assert.equal(quotes.get('MSFT'), null);
  });

  test('N/D rows resolve to null rather than NaN or a shifted price', async () => {
    const csv = ['Symbol,Close', 'AAPL,191.23', 'NOTAREALTICKER,N/D'].join('\n');
    const fetchImpl = fetchStub([okResponse(csv)]);
    const provider = createStooqProvider({}, { fetchImpl, now: () => 0 });

    const quotes = await provider.getQuotes(['AAPL', 'NOTAREALTICKER']);
    assert.equal(quotes.get('AAPL').price, 191.23);
    assert.equal(quotes.get('NOTAREALTICKER'), null);
  });
});

describe('stooq provider: failure modes never throw (C5)', () => {
  test('a non-200 response resolves to null for every requested symbol', async () => {
    const fetchImpl = fetchStub([errorResponse(500), errorResponse(500)]);
    const provider = createStooqProvider({}, { fetchImpl, now: () => 0 });

    const quotes = await provider.getQuotes(['AAPL', 'MSFT']);
    assert.equal(quotes.get('AAPL'), null);
    assert.equal(quotes.get('MSFT'), null);
    // one retry: two attempts total
    assert.equal(fetchImpl.calls.length, 2);
  });

  test('a rejected fetch (timeout/network error) resolves to null, retried once', async () => {
    const fetchImpl = fetchStub([
      new Error('AbortError: timeout'),
      new Error('AbortError: timeout'),
    ]);
    const provider = createStooqProvider({}, { fetchImpl, now: () => 0 });

    await assert.doesNotReject(() => provider.getQuotes(['AAPL']));
    const quotes = await provider.getQuotes(['AAPL']);
    assert.equal(quotes.get('AAPL'), null);
    assert.ok(fetchImpl.calls.length >= 1);
  });

  test('a single retry succeeding recovers the quote', async () => {
    const csv = 'Symbol,Close\nAAPL,191.23\n';
    const fetchImpl = fetchStub([new Error('network blip'), okResponse(csv)]);
    const provider = createStooqProvider({}, { fetchImpl, now: () => 0 });

    const quotes = await provider.getQuotes(['AAPL']);
    assert.equal(quotes.get('AAPL').price, 191.23);
    assert.equal(fetchImpl.calls.length, 2);
  });

  test('malformed CSV (no header, garbage body) resolves to null, never throws', async () => {
    const fetchImpl = fetchStub([okResponse('not,a,valid\ncsv;;;garbage||')]);
    const provider = createStooqProvider({}, { fetchImpl, now: () => 0 });

    await assert.doesNotReject(() => provider.getQuotes(['AAPL']));
    const quotes = await provider.getQuotes(['AAPL']);
    assert.equal(quotes.get('AAPL'), null);
  });

  test('empty response body resolves to null, never throws', async () => {
    const fetchImpl = fetchStub([okResponse('')]);
    const provider = createStooqProvider({}, { fetchImpl, now: () => 0 });
    await assert.doesNotReject(() => provider.getQuotes(['AAPL']));
    assert.equal((await provider.getQuotes(['AAPL'])).get('AAPL'), null);
  });

  test('a fetchImpl that throws synchronously still never propagates', async () => {
    const fetchImpl = () => {
      throw new Error('boom');
    };
    const provider = createStooqProvider({}, { fetchImpl, now: () => 0 });
    await assert.doesNotReject(() => provider.getQuotes(['AAPL']));
  });
});

describe('stooq provider: TTL cache', () => {
  test('a cached quote is served without calling fetch again within the TTL window', async () => {
    const csv = 'Symbol,Close\nAAPL,191.23\n';
    const fetchImpl = fetchStub([okResponse(csv)]);
    let now = 0;
    const provider = createStooqProvider({}, { fetchImpl, now: () => now });

    await provider.getQuotes(['AAPL']);
    now += 1000; // well within the 60s TTL
    const second = await provider.getQuotes(['AAPL']);

    assert.equal(second.get('AAPL').price, 191.23);
    assert.equal(second.get('AAPL').stale, false);
    assert.equal(fetchImpl.calls.length, 1);
  });

  test('past-TTL with a failing refetch returns the stale cached quote marked stale', async () => {
    const csv = 'Symbol,Close\nAAPL,191.23\n';
    const fetchImpl = fetchStub([okResponse(csv), errorResponse(500), errorResponse(500)]);
    let now = 0;
    const provider = createStooqProvider({}, { fetchImpl, now: () => now });

    await provider.getQuotes(['AAPL']);
    now += 61_000; // past the 60s TTL
    const second = await provider.getQuotes(['AAPL']);

    assert.equal(second.get('AAPL').price, 191.23);
    assert.equal(second.get('AAPL').stale, true);
  });

  test('past-TTL with a successful refetch returns a fresh, non-stale quote', async () => {
    const fetchImpl = fetchStub([
      okResponse('Symbol,Close\nAAPL,191.23\n'),
      okResponse('Symbol,Close\nAAPL,195.00\n'),
    ]);
    let now = 0;
    const provider = createStooqProvider({}, { fetchImpl, now: () => now });

    await provider.getQuotes(['AAPL']);
    now += 61_000;
    const second = await provider.getQuotes(['AAPL']);

    assert.equal(second.get('AAPL').price, 195.0);
    assert.equal(second.get('AAPL').stale, false);
  });
});

describe('stooq provider: interface shape', () => {
  test('every requested symbol is present as a key, even on total failure', async () => {
    const fetchImpl = fetchStub([new Error('down'), new Error('down')]);
    const provider = createStooqProvider({}, { fetchImpl, now: () => 0 });
    const symbols = ['AAPL', 'MSFT', 'GOOG'];
    const quotes = await provider.getQuotes(symbols);
    assert.equal(quotes.size, symbols.length);
    for (const s of symbols) assert.ok(quotes.has(s));
  });

  test('empty symbol list resolves to an empty Map without calling fetch', async () => {
    const fetchImpl = fetchStub([okResponse('Symbol,Close\n')]);
    const provider = createStooqProvider({}, { fetchImpl, now: () => 0 });
    const quotes = await provider.getQuotes([]);
    assert.equal(quotes.size, 0);
    assert.equal(fetchImpl.calls.length, 0);
  });
});
