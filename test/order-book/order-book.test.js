import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { OrderBook, BUY, SELL } from '../../src/order-book/order-book.js';

describe('OrderBook — basic API surface', () => {
  test('bestBid()/bestAsk() are null on an empty book', () => {
    const book = new OrderBook({ symbol: 'NOCK1' });
    assert.equal(book.bestBid(), null);
    assert.equal(book.bestAsk(), null);
  });

  test('depth() on an empty book returns empty, well-shaped arrays', () => {
    const book = new OrderBook({ symbol: 'NOCK1' });
    assert.deepEqual(book.depth(), { bids: [], asks: [] });
  });

  test('order against an empty book rests in full', () => {
    const book = new OrderBook({ symbol: 'NOCK1' });
    const result = book.submit({ side: BUY, price: 10, volume: 100 });
    assert.deepEqual(result, {
      trades: [],
      filledVolume: 0,
      restingVolume: 100,
      restingPrice: 10,
    });
    assert.equal(book.bestBid(), 10);
    assert.equal(book.bestAsk(), null);
  });

  test('rejects an unknown side', () => {
    const book = new OrderBook();
    assert.throws(() => book.submit({ side: 'nope', price: 1, volume: 1 }), TypeError);
  });

  test('rejects non-positive or non-finite price/volume', () => {
    const book = new OrderBook();
    for (const price of [0, -5, NaN, Infinity, '10']) {
      assert.throws(() => book.submit({ side: BUY, price, volume: 10 }), TypeError);
    }
    for (const volume of [0, -5, NaN, Infinity, '10']) {
      assert.throws(() => book.submit({ side: BUY, price: 10, volume }), TypeError);
    }
  });
});

describe('OrderBook — E1 regression: limit price integrity', () => {
  test('BUY 200 @ 50 against asks {49:100, 55:100} fills only the marketable level', () => {
    const book = new OrderBook({ symbol: 'NOCK1' });
    book.submit({ side: SELL, price: 49, volume: 100 });
    book.submit({ side: SELL, price: 55, volume: 100 });

    const result = book.submit({ side: BUY, price: 50, volume: 200 });

    assert.deepEqual(result.trades, [{ price: 49, volume: 100 }]);
    assert.equal(result.filledVolume, 100);
    assert.equal(result.restingVolume, 100);
    assert.equal(result.restingPrice, 50);

    // The 55 level must be completely untouched.
    assert.equal(book.bestAsk(), 55);
    assert.deepEqual(book.depth().asks, [[55, 100]]);
    assert.equal(book.bestBid(), 50);
    assert.deepEqual(book.depth().bids, [[50, 100]]);
  });

  test('symmetric SELL case: SELL 200 @ 50 against bids {51:100, 45:100}', () => {
    const book = new OrderBook({ symbol: 'NOCK1' });
    book.submit({ side: BUY, price: 51, volume: 100 });
    book.submit({ side: BUY, price: 45, volume: 100 });

    const result = book.submit({ side: SELL, price: 50, volume: 200 });

    assert.deepEqual(result.trades, [{ price: 51, volume: 100 }]);
    assert.equal(result.filledVolume, 100);
    assert.equal(result.restingVolume, 100);
    assert.equal(result.restingPrice, 50);

    assert.equal(book.bestBid(), 45);
    assert.deepEqual(book.depth().bids, [[45, 100]]);
    assert.equal(book.bestAsk(), 50);
    assert.deepEqual(book.depth().asks, [[50, 100]]);
  });

  test('an order that is not marketable at all rests untouched', () => {
    const book = new OrderBook();
    book.submit({ side: SELL, price: 100, volume: 50 });
    const result = book.submit({ side: BUY, price: 90, volume: 30 });
    assert.deepEqual(result.trades, []);
    assert.equal(result.restingVolume, 30);
    assert.equal(book.depth().asks[0][1], 50);
  });
});

describe('OrderBook — matching behavior', () => {
  test('price priority: best-first across multiple levels', () => {
    const book = new OrderBook();
    book.submit({ side: SELL, price: 10, volume: 50 });
    book.submit({ side: SELL, price: 9, volume: 30 });
    book.submit({ side: SELL, price: 11, volume: 20 });

    const result = book.submit({ side: BUY, price: 12, volume: 100 });

    assert.deepEqual(result.trades, [
      { price: 9, volume: 30 },
      { price: 10, volume: 50 },
      { price: 11, volume: 20 },
    ]);
    assert.equal(result.filledVolume, 100);
    assert.equal(result.restingVolume, 0);
    assert.equal(result.restingPrice, null);
    assert.equal(book.bestAsk(), null);
  });

  test('level aggregation: a second order at an existing price aggregates, not duplicates', () => {
    const book = new OrderBook();
    book.submit({ side: SELL, price: 10, volume: 50 });
    book.submit({ side: SELL, price: 10, volume: 30 });

    assert.deepEqual(book.depth().asks, [[10, 80]]);
    const { heapPrices, volumeKeys } = book._debugLevels(SELL);
    assert.equal(heapPrices.length, 1);
    assert.equal(volumeKeys.length, 1);
  });

  test('partial fill leaves the remainder of the opposite level resting', () => {
    const book = new OrderBook();
    book.submit({ side: SELL, price: 10, volume: 100 });
    const result = book.submit({ side: BUY, price: 10, volume: 40 });

    assert.deepEqual(result.trades, [{ price: 10, volume: 40 }]);
    assert.equal(result.restingVolume, 0);
    assert.equal(result.restingPrice, null);
    assert.deepEqual(book.depth().asks, [[10, 60]]);
  });

  test('exact fill removes the opposite level entirely', () => {
    const book = new OrderBook();
    book.submit({ side: SELL, price: 10, volume: 100 });
    const result = book.submit({ side: BUY, price: 10, volume: 100 });

    assert.deepEqual(result.trades, [{ price: 10, volume: 100 }]);
    assert.equal(result.restingVolume, 0);
    assert.equal(book.bestAsk(), null);
    assert.deepEqual(book.depth().asks, []);
  });

  test('multi-level sweep consumes several levels then rests the remainder', () => {
    const book = new OrderBook();
    book.submit({ side: SELL, price: 10, volume: 20 });
    book.submit({ side: SELL, price: 11, volume: 20 });
    book.submit({ side: SELL, price: 12, volume: 20 });

    const result = book.submit({ side: BUY, price: 11, volume: 50 });

    assert.deepEqual(result.trades, [
      { price: 10, volume: 20 },
      { price: 11, volume: 20 },
    ]);
    assert.equal(result.filledVolume, 40);
    assert.equal(result.restingVolume, 10);
    assert.equal(result.restingPrice, 11);
    // 12 was never marketable against a limit of 11 — untouched.
    assert.deepEqual(book.depth().asks, [[12, 20]]);
  });

  test('volume conservation holds for every kind of submission', () => {
    const book = new OrderBook();
    book.submit({ side: SELL, price: 10, volume: 20 });
    book.submit({ side: SELL, price: 11, volume: 20 });

    for (const order of [
      { side: BUY, price: 11, volume: 15 },
      { side: BUY, price: 10, volume: 100 },
      { side: SELL, price: 5, volume: 40 },
    ]) {
      const result = book.submit(order);
      const tradedVolume = result.trades.reduce((sum, t) => sum + t.volume, 0);
      assert.equal(order.volume, tradedVolume + result.restingVolume);
    }
  });
});

describe('OrderBook — E3 regression: snapshot isolation', () => {
  test('a retained snapshot is unaffected by later orders, and round-trips', () => {
    const book = new OrderBook({ symbol: 'NOCK1' });

    // Seed a reasonably deep book on both sides.
    for (let i = 0; i < 10; i++) {
      book.submit({ side: BUY, price: 100 - i, volume: 10 * (i + 1) });
      book.submit({ side: SELL, price: 110 + i, volume: 10 * (i + 1) });
    }

    const snapshot = book.snapshot();
    const expected = JSON.parse(JSON.stringify(snapshot));

    // Every price in the snapshot must have a positive finite volume.
    for (const [price, volume] of [...snapshot.bids, ...snapshot.asks]) {
      assert.ok(Number.isFinite(price) && price > 0, `bad price ${price}`);
      assert.ok(Number.isFinite(volume) && volume > 0, `bad volume ${volume} at price ${price}`);
    }

    // ~20 further orders, including ones that fully consume a level.
    book.submit({ side: SELL, price: 100, volume: 10 }); // fully consumes bid @100
    for (let i = 0; i < 19; i++) {
      book.submit({
        side: i % 2 === 0 ? BUY : SELL,
        price: 90 + i,
        volume: 5 + i,
      });
    }

    // The retained snapshot object must be byte-identical to what it was
    // at capture time — this is the exact E3 desync signature: the old
    // code's snapshot shared the live heap by reference and drifted.
    assert.deepStrictEqual(snapshot, expected);

    // fromSnapshot() round-trips.
    const restored = OrderBook.fromSnapshot(snapshot);
    assert.deepEqual(restored.depth(Infinity), { bids: snapshot.bids, asks: snapshot.asks });
    assert.equal(restored.symbol, 'NOCK1');
  });

  test('mutating the live book after snapshot() does not alias into the snapshot', () => {
    const book = new OrderBook();
    book.submit({ side: BUY, price: 10, volume: 100 });
    const snap1 = book.snapshot();

    book.submit({ side: BUY, price: 10, volume: 50 }); // aggregates into the same level
    const snap2 = book.snapshot();

    assert.deepEqual(snap1.bids, [[10, 100]]);
    assert.deepEqual(snap2.bids, [[10, 150]]);
  });
});

describe('OrderBook — toString()', () => {
  test('renders a ladder without throwing on an empty or populated book', () => {
    const book = new OrderBook({ symbol: 'NOCK1' });
    assert.equal(typeof book.toString(), 'string');

    book.submit({ side: BUY, price: 10, volume: 100 });
    book.submit({ side: SELL, price: 12, volume: 50 });
    const display = book.toString();
    assert.match(display, /12, 50/);
    assert.match(display, /10, 100/);
  });
});
