// The market simulator: submits random orders against one book per symbol.
//
// Replaces submitRandomOrder in nockmarket.js:18-54. Two defects closed:
//
// E2 (stale trades) — the old loop read the trades off the WRONG object:
//
//     var exchangeData = allData[index];              // pre-order book
//     allData[index] = exch.buy(...);                 // new book returned
//     db.insertOne('transactions', ord, function () {
//       if (exchangeData.trades && ...) {             // <- previous order's
//         var trades = exchangeData.trades.map(...);  //    trades!
//         trade.init = (ord.type == exch.BUY) ...     // <- stamped with the
//
//   So every trade was persisted one order late and labelled with the
//   NEXT order's side. Here submit() returns its own trades and we
//   persist exactly those, in the same tick — there is no second object
//   to read from, which makes the bug unrepresentable rather than fixed.
//
// C8 (no stop signal) — the old loop re-armed setTimeout unconditionally
//   with no way to halt it, so anything that imported the module kept the
//   process alive forever and tests hung. start()/stop() are explicit and
//   the timer is unref'd.
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

      // submit() throws on a non-finite or non-positive price/volume.
      // Guard here so one bad draw can never take the loop (and with it
      // the whole process) down.
      const result = book.submit({ ...order, stock: symbol });

      await sink.insertOrder({ ...order, stock: symbol, ts: new Date() });

      // E2: persist the trades THIS order produced, not whatever happened
      // to be hanging off a previous book object.
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

      // Broadcast on every order, not only when a trade occurs — the
      // depth ladder changes either way.
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
    // Never hold the event loop open on the simulator's account.
    timer?.unref?.();
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

    /** Halts the loop. Safe to call when not started, and idempotent. */
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

    /** Exposed for tests and for the initial market snapshot. */
    books,
  };
}
