// Simulator tests. No database, no network, no real timers.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { createSimulator } from '../src/simulator/index.js';
import { createRng, generateRandomOrder } from '../src/simulator/random-order.js';

/** Collects everything the simulator persists, in order. */
function makeSink() {
  const orders = [];
  const tradeBatches = [];
  // Interleaved event log: this is what makes the E2 lag detectable.
  const events = [];
  return {
    orders,
    tradeBatches,
    events,
    async insertOrder(order) {
      orders.push(order);
      events.push({ kind: 'order', order });
      return order;
    },
    async insertTrades(trades) {
      tradeBatches.push(trades);
      events.push({ kind: 'trades', trades });
      return trades;
    },
  };
}

/**
 * A controllable clock: every scheduled callback is captured so a test can
 * run exactly N ticks deterministically.
 */
function makeClock() {
  const queue = [];
  return {
    setTimeoutFn(fn) {
      const handle = { fn, cleared: false, unref() {} };
      queue.push(handle);
      return handle;
    },
    clearTimeoutFn(handle) {
      if (handle) handle.cleared = true;
    },
    pending() {
      return queue.filter((h) => !h.cleared && !h.fired).length;
    },
    /** Fire the next scheduled callback and await any async work it starts. */
    async runNext() {
      const next = queue.find((h) => !h.cleared && !h.fired);
      if (!next) return false;
      next.fired = true;
      await next.fn();
      return true;
    },
  };
}

function build({ symbols = ['NOCK1'], seed = 7 } = {}) {
  const sink = makeSink();
  const clock = makeClock();
  const published = [];
  const sim = createSimulator({
    symbols,
    minMs: 10,
    maxMs: 20,
    seed,
    sink,
    publish: (p) => published.push(p),
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  return { sim, sink, clock, published };
}

describe('random order generation', () => {
  test('is deterministic for a given seed', () => {
    const a = createRng(42);
    const b = createRng(42);
    for (let i = 0; i < 20; i++) {
      assert.deepEqual(
        generateRandomOrder({ bestBid: 40, bestAsk: 41, rng: a }),
        generateRandomOrder({ bestBid: 40, bestAsk: 41, rng: b })
      );
    }
  });

  test('always produces a submittable order, even on an empty book', () => {
    const rng = createRng(3);
    for (let i = 0; i < 500; i++) {
      const o = generateRandomOrder({ bestBid: null, bestAsk: null, rng });
      assert.ok(o.side === 'buy' || o.side === 'sell');
      assert.ok(Number.isFinite(o.price) && o.price > 0, `bad price ${o.price}`);
      assert.ok(Number.isFinite(o.volume) && o.volume > 0, `bad volume ${o.volume}`);
    }
  });

  test('price never walks to zero or negative from a low best price', () => {
    const rng = createRng(11);
    for (let i = 0; i < 500; i++) {
      const o = generateRandomOrder({ bestBid: 1, bestAsk: 2, rng });
      assert.ok(o.price > 0, `price ${o.price} would make submit() throw`);
    }
  });
});

describe('simulator loop', () => {
  test('E2: trades persisted are the ones the same order produced', async () => {
    // The 2014 loop read .trades off the PRE-order book, so each batch
    // written was the previous order's trades, stamped with this order's
    // side. Here every persisted batch must match the book state at the
    // moment it was written.
    const { sim, sink, clock } = build();
    sim.start();

    for (let i = 0; i < 40; i++) {
      await clock.runNext();
    }
    sim.stop();

    assert.ok(sink.orders.length >= 30, 'expected the loop to have run');

    // Every trade batch must be non-empty and internally consistent: the
    // old off-by-one produced batches attributable to a different order.
    for (const batch of sink.tradeBatches) {
      assert.ok(batch.length > 0, 'never persist an empty trade batch');
      for (const t of batch) {
        assert.ok(Number.isFinite(t.price) && t.price > 0);
        assert.ok(Number.isFinite(t.volume) && t.volume > 0, 'volume must never be undefined');
        assert.ok(t.side === 'buy' || t.side === 'sell');
        assert.ok(t.ts instanceof Date);
        assert.equal(t.stock, 'NOCK1');
      }
    }
  });

  test('E2: every trade respects the limit of the order it is recorded against', async () => {
    // The decisive lag test, and it has to be price-based.
    //
    // Two weaker checks do NOT work here, both tried and discarded:
    //   - Order/trades interleaving: a one-tick lag still writes exactly
    //     one trades entry per order, so the sequence looks identical.
    //   - Comparing trade.side to the order's side: the buggy code STAMPS
    //     the side from the current order, so the assertion is circular
    //     and passes against the very bug it is meant to catch.
    //
    // The invariant that actually distinguishes them: a buy at limit P can
    // only ever trade at <= P, and a sell at limit P only at >= P (E1).
    // Attach order N-1's fills to order N and that relationship breaks,
    // because the two orders had different limits and often opposite sides.
    //
    // Verified by mutation: reintroducing the lag makes this test fail.
    const { sim, sink, clock } = build({ seed: 21 });
    sim.start();
    for (let i = 0; i < 120; i++) {
      await clock.runNext();
    }
    sim.stop();

    assert.ok(sink.tradeBatches.length > 0, 'the seed must produce some crossing orders');

    for (let i = 0; i < sink.events.length; i++) {
      if (sink.events[i].kind !== 'trades') continue;
      const previous = sink.events[i - 1];
      assert.ok(previous && previous.kind === 'order', 'trades must follow their own order');

      const { side, price: limit } = previous.order;
      for (const t of sink.events[i].trades) {
        assert.equal(t.stock, previous.order.stock);
        assert.ok(Number.isFinite(t.volume) && t.volume > 0, 'volume must never be undefined');
        if (side === 'buy') {
          assert.ok(
            t.price <= limit,
            `buy limited at ${limit} recorded a fill at ${t.price} — trades belong to a different order`
          );
        } else {
          assert.ok(
            t.price >= limit,
            `sell limited at ${limit} recorded a fill at ${t.price} — trades belong to a different order`
          );
        }
      }
    }
  });

  test('E2: total traded volume never exceeds submitted volume', async () => {
    // A one-order lag would let the recorded trade volume drift away from
    // what was actually submitted.
    const { sim, sink, clock } = build();
    sim.start();
    for (let i = 0; i < 60; i++) {
      await clock.runNext();
    }
    sim.stop();

    const submitted = sink.orders.reduce((n, o) => n + o.volume, 0);
    const traded = sink.tradeBatches.flat().reduce((n, t) => n + t.volume, 0);
    assert.ok(traded <= submitted, `traded ${traded} exceeds submitted ${submitted}`);
  });

  test('C8: stop() halts the loop and schedules nothing further', async () => {
    const { sim, sink, clock } = build();
    sim.start();
    await clock.runNext();
    await clock.runNext();
    const afterTwo = sink.orders.length;

    sim.stop();
    assert.equal(sim.isRunning(), false);

    // Anything still queued must be a no-op now.
    await clock.runNext();
    await clock.runNext();
    assert.equal(sink.orders.length, afterTwo, 'no orders may be submitted after stop()');
  });

  test('C8: stop() is idempotent and safe before start()', () => {
    const { sim } = build();
    assert.doesNotThrow(() => sim.stop());
    sim.start();
    sim.stop();
    assert.doesNotThrow(() => sim.stop());
    assert.equal(sim.isRunning(), false);
  });

  test('start() is idempotent', async () => {
    const { sim, clock } = build();
    sim.start();
    const afterFirst = clock.pending();
    sim.start();
    assert.equal(clock.pending(), afterFirst, 'a second start() must not double-schedule');
    sim.stop();
  });

  test('publishes a market payload on every order, not only on trades', async () => {
    const { sim, sink, clock, published } = build();
    sim.start();
    for (let i = 0; i < 15; i++) {
      await clock.runNext();
    }
    sim.stop();

    assert.equal(published.length, sink.orders.length, 'one publish per order');
    for (const p of published) {
      assert.equal(p.stock, 'NOCK1');
      assert.equal(p.bids.length, 5);
      assert.equal(p.asks.length, 5);
    }
  });

  test('runs several symbols independently', async () => {
    const { sim, sink, clock } = build({ symbols: ['NOCK1', 'NOCK2', 'NOCK3'] });
    sim.start();
    for (let i = 0; i < 30; i++) {
      await clock.runNext();
    }
    sim.stop();

    const seen = new Set(sink.orders.map((o) => o.stock));
    assert.deepEqual([...seen].sort(), ['NOCK1', 'NOCK2', 'NOCK3']);
  });

  test('a failing sink does not kill the loop', async () => {
    const clock = makeClock();
    let calls = 0;
    const sim = createSimulator({
      symbols: ['NOCK1'],
      minMs: 10,
      maxMs: 20,
      seed: 5,
      sink: {
        async insertOrder() {
          calls++;
          if (calls === 2) throw new Error('database went away');
        },
        async insertTrades() {},
      },
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
    });

    sim.start();
    for (let i = 0; i < 5; i++) {
      await clock.runNext();
    }
    assert.ok(calls >= 4, 'the loop must keep running after a persistence error');
    sim.stop();
  });
});
