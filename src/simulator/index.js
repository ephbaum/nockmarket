// The market simulator: submits random orders against one book per symbol.
//
// E2 — the old loop kept the pre-order book in a local, reassigned the slot
// to the new book, then read `.trades` off the stale local, so every trade
// was persisted one order late and stamped with the NEXT order's side.
// submit() returning its own trades removes the second object entirely,
// which makes the bug unrepresentable rather than merely fixed.
//
// C8 — it also re-armed setTimeout with no way to halt, so importing the
// module kept the process alive and hung tests.
import { OrderBook } from '../order-book/index.js';
import { buildMarketPayload } from '../realtime/market.js';
import { createRng, generateRandomOrder } from './random-order.js';

/**
 * @param {{ symbols: string[], minMs: number, maxMs: number, seed?: number,
 *           sink: { insertOrder: Function, insertTrades: Function },
 *           publish?: (payload: object) => void,
 *           logger?: object,
 *           setTimeoutFn?: Function, clearTimeoutFn?: Function }} options
 */
export function createSimulator({
  symbols,
  minMs,
  maxMs,
  seed = 1,
  sink,
  publish = () => {},
  logger = { error() {}, debug() {} },
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) {
  const books = new Map(symbols.map((s) => [s, new OrderBook({ symbol: s })]));
  const rng = createRng(seed);
  const timers = new Map();
  let running = false;

  async function tick(symbol) {
    if (!running) {
      return;
    }
    const book = books.get(symbol);

    try {
      const order = generateRandomOrder({
        bestBid: book.bestBid(),
        bestAsk: book.bestAsk(),
        rng,
      });

      const result = book.submit({ ...order, stock: symbol });

      await sink.insertOrder({ ...order, stock: symbol, ts: new Date() });

      // E2: the trades THIS order produced.
      if (result.trades.length > 0) {
        await sink.insertTrades(
          result.trades.map((t) => ({
            stock: symbol,
            price: t.price,
            volume: t.volume,
            side: order.side,
            ts: new Date(),
          }))
        );
      }

      // Every order, not only trades — the ladder changes either way.
      publish(buildMarketPayload(symbol, book, result.trades.at(-1) ?? null));
    } catch (err) {
      logger.error({ err, symbol }, 'simulator tick failed');
    }

    schedule(symbol);
  }

  function schedule(symbol) {
    if (!running) {
      return;
    }
    const delay = Math.floor(rng() * (maxMs - minMs)) + minMs;
    const timer = setTimeoutFn(() => tick(symbol), delay);
    timer?.unref?.(); // never hold the event loop open
    timers.set(symbol, timer);
  }

  return {
    start() {
      if (running) {
        return;
      }
      running = true;
      for (const symbol of symbols) {
        schedule(symbol);
      }
    },

    /** Idempotent, and safe to call before start(). */
    stop() {
      running = false;
      for (const timer of timers.values()) {
        clearTimeoutFn(timer);
      }
      timers.clear();
    },

    isRunning() {
      return running;
    },

    books,
  };
}
