import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrderBook, BUY, SELL } from '../../src/order-book/order-book.js';

// Small seeded PRNG so the fuzz run is reproducible. src/order-book/**
// must stay dependency-free (see eslint.config.js's boundary rule), and
// that constraint extends in spirit to its tests: no importing a random
// package just to fuzz it.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function assertBijection(book, side, label) {
  const { heapPrices, volumeKeys } = book._debugLevels(side);
  assert.equal(heapPrices.length, volumeKeys.length, `${label}: heap/volume size mismatch`);

  const heapSet = new Set(heapPrices);
  assert.equal(heapSet.size, heapPrices.length, `${label}: heap has a duplicate price entry`);

  const volSet = new Set(volumeKeys);
  assert.equal(volSet.size, volumeKeys.length, `${label}: volume map has a duplicate key`);

  for (const price of heapSet) {
    assert.ok(volSet.has(price), `${label}: orphan heap price ${price} with no volume entry`);
  }
  for (const price of volSet) {
    assert.ok(heapSet.has(price), `${label}: orphan volume entry at ${price} with no heap price`);
  }
}

test('invariant fuzz: 10,000 seeded random orders', () => {
  const rng = mulberry32(20260809);
  const book = new OrderBook({ symbol: 'NOCK1' });

  const ITERATIONS = 10_000;
  const PRICE_RANGE = 100; // deliberately narrow so levels collide/aggregate/empty out a lot

  for (let i = 0; i < ITERATIONS; i++) {
    const side = rng() < 0.5 ? BUY : SELL;
    const price = 1 + Math.floor(rng() * PRICE_RANGE);
    const volume = 1 + Math.floor(rng() * 50);

    const result = book.submit({ side, price, volume });

    // Volume conservation (defect-adjacent to E1/E2: silently gaining or
    // losing volume across a submission).
    const tradedVolume = result.trades.reduce((sum, t) => sum + t.volume, 0);
    assert.equal(
      volume,
      tradedVolume + result.restingVolume,
      `iteration ${i}: volume not conserved`
    );

    // Every emitted trade has finite price > 0 and volume > 0 — the
    // `{price: 45, volume: undefined}` guard from the E3 writeup.
    for (const trade of result.trades) {
      assert.ok(
        Number.isFinite(trade.price) && trade.price > 0,
        `iteration ${i}: bad trade price ${trade.price}`
      );
      assert.ok(
        Number.isFinite(trade.volume) && trade.volume > 0,
        `iteration ${i}: bad trade volume ${trade.volume}`
      );
    }

    // Heap contents and volume-map keys are in bijection on both sides —
    // this is the test that would have caught E3 automatically.
    assertBijection(book, BUY, `iteration ${i} BUY`);
    assertBijection(book, SELL, `iteration ${i} SELL`);

    // The book is never crossed.
    const bid = book.bestBid();
    const ask = book.bestAsk();
    if (bid !== null && ask !== null) {
      assert.ok(bid < ask, `iteration ${i}: book crossed, bid=${bid} ask=${ask}`);
    }
  }
});
