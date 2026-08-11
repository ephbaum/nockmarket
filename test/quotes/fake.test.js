import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeProvider } from '../../src/quotes/fake.js';

const BUCKET_MS = 5000;

function provider(env = {}, now = () => 0) {
  return createFakeProvider(
    { QUOTE_SEED: '42', QUOTE_BUCKET_MS: String(BUCKET_MS), ...env },
    { now }
  );
}

describe('fake quote provider: determinism', () => {
  test('same symbol + fixed now() yields an identical quote across 100 calls', async () => {
    const p = provider();
    const first = (await p.getQuotes(['AAPL'])).get('AAPL');

    for (let i = 0; i < 100; i++) {
      const quote = (await p.getQuotes(['AAPL'])).get('AAPL');
      assert.equal(quote.price, first.price);
      assert.equal(quote.symbol, first.symbol);
      assert.equal(quote.currency, first.currency);
      assert.equal(quote.source, first.source);
      assert.equal(quote.stale, first.stale);
      assert.equal(quote.asOf.getTime(), first.asOf.getTime());
    }
  });

  test('different symbols get different prices', async () => {
    const p = provider();
    const quotes = await p.getQuotes(['AAPL', 'MSFT', 'GOOG', 'AMZN']);
    const prices = new Set([...quotes.values()].map((q) => q.price));
    assert.equal(prices.size, 4);
  });

  test('price changes when the time bucket advances', async () => {
    let now = 0;
    const p = provider({}, () => now);

    const before = (await p.getQuotes(['AAPL'])).get('AAPL');
    now = BUCKET_MS * 1000; // jump far enough forward to guarantee a different bucket
    const after = (await p.getQuotes(['AAPL'])).get('AAPL');

    assert.notEqual(before.price, after.price);
    assert.notEqual(before.asOf.getTime(), after.asOf.getTime());
  });

  test('same symbol, same bucket (different millisecond within it) is unchanged', async () => {
    const a = (await provider({}, () => 1234).getQuotes(['AAPL'])).get('AAPL');
    const b = (await provider({}, () => 4999).getQuotes(['AAPL'])).get('AAPL');
    assert.equal(a.price, b.price);
  });

  test('different QUOTE_SEED changes the price for the same symbol and bucket', async () => {
    const a = (await provider({ QUOTE_SEED: '1' }).getQuotes(['AAPL'])).get('AAPL');
    const b = (await provider({ QUOTE_SEED: '2' }).getQuotes(['AAPL'])).get('AAPL');
    assert.notEqual(a.price, b.price);
  });
});

describe('fake quote provider: C1 regression (symbol-keyed, never positional)', () => {
  test('an unresolvable symbol maps to null without shifting other entries', async () => {
    const p = provider();
    const alone = await p.getQuotes(['AAPL', 'MSFT']);
    const mixed = await p.getQuotes(['AAPL', 'NOTAREALTICKER!!!', 'MSFT']);

    assert.equal(mixed.size, 3);
    assert.ok(mixed.has('AAPL'));
    assert.ok(mixed.has('NOTAREALTICKER!!!'));
    assert.ok(mixed.has('MSFT'));

    assert.equal(mixed.get('NOTAREALTICKER!!!'), null);
    assert.equal(mixed.get('AAPL').price, alone.get('AAPL').price);
    assert.equal(mixed.get('MSFT').price, alone.get('MSFT').price);
  });

  test('every requested symbol is present as a key, in any order requested', async () => {
    const p = provider();
    const symbols = ['ZZZ', 'aaa-not-valid', 'AAA', '', 'BBB'];
    const quotes = await p.getQuotes(symbols);
    assert.equal(quotes.size, new Set(symbols).size);
    for (const s of symbols) assert.ok(quotes.has(s));
  });
});

describe('fake quote provider: symbol validation', () => {
  const cases = [
    ['lowercase', 'aapl'],
    ['empty string', ''],
    ['overlong (>10 chars)', 'ABCDEFGHIJK'],
    ['400-char string', 'A'.repeat(400)],
    ['injection-shaped', '<script>'],
    ['leading digit', '1AAPL'],
    ['embedded space', 'AA PL'],
    ['embedded slash', 'AA/PL'],
  ];

  for (const [label, symbol] of cases) {
    test(`rejects ${label} ("${symbol.slice(0, 20)}")`, async () => {
      const p = provider();
      const quotes = await p.getQuotes([symbol]);
      assert.equal(quotes.get(symbol), null);
    });
  }

  test('accepts valid symbol shapes (letters, dot, hyphen, up to 10 chars)', async () => {
    const p = provider();
    const valid = ['A', 'AAPL', 'BRK.B', 'BF-B', 'ABCDEFGHIJ'];
    const quotes = await p.getQuotes(valid);
    for (const s of valid) {
      assert.notEqual(quotes.get(s), null, `expected ${s} to resolve`);
    }
  });
});

describe('fake quote provider: bounds', () => {
  test('price stays within a plausible range and never <= 0 over many buckets', async () => {
    let min = Infinity;
    let max = -Infinity;

    for (let bucket = 0; bucket < 2000; bucket++) {
      const now = bucket * BUCKET_MS;
      const quotes = await createFakeProvider(
        { QUOTE_SEED: '42', QUOTE_BUCKET_MS: String(BUCKET_MS) },
        { now: () => now }
      ).getQuotes(['AAPL']);
      const { price } = quotes.get('AAPL');
      assert.ok(price > 0, `price ${price} at bucket ${bucket} was not positive`);
      if (price < min) min = price;
      if (price > max) max = price;
    }

    // Plausible bound: base price in [5, 500], clamped log-displacement of
    // +/-0.6 => price in roughly [5*e^-0.6, 500*e^0.6] ~= [2.74, 911.06].
    assert.ok(min > 2.5, `min price ${min} too low`);
    assert.ok(max < 1000, `max price ${max} ran away`);
  });

  test('price never goes negative even at a very large bucket (long uptime)', async () => {
    const farFuture = Date.now() + 1000 * 60 * 60 * 24 * 365 * 50; // 50 years out
    const p = provider({}, () => farFuture);
    const quotes = await p.getQuotes(['AAPL', 'MSFT', 'GOOG']);
    for (const quote of quotes.values()) {
      assert.ok(quote.price > 0);
      assert.ok(Number.isFinite(quote.price));
    }
  });
});

describe('fake quote provider: shape', () => {
  test('quote has the documented shape', async () => {
    const p = provider();
    const quote = (await p.getQuotes(['AAPL'])).get('AAPL');
    assert.equal(quote.symbol, 'AAPL');
    assert.equal(typeof quote.price, 'number');
    assert.equal(quote.currency, 'USD');
    assert.ok(quote.asOf instanceof Date);
    assert.equal(quote.source, 'fake');
    assert.equal(quote.stale, false);
  });

  test('provider name is "fake"', () => {
    assert.equal(provider().name, 'fake');
  });

  test('getQuotes never throws, even given garbage input', async () => {
    const p = provider();
    await assert.doesNotReject(() => p.getQuotes([]));
    await assert.doesNotReject(() =>
      p.getQuotes(['<script>alert(1)</script>', null, undefined, 123])
    );
  });
});
