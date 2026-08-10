// Order-book -> wire payload.
//
// Replaces transformStockData / transformExchangeData in lib/nocklib.js
// (E5). The old version emitted a flat, cryptic shape — b1p, b1v ... a5p,
// a5v, tp, tv, st — and had three defects:
//
//   1. It walked `for (i = buyPrices.length - 5; i < buyPrices.length; i++)`
//      so a book with fewer than 5 bid levels read NEGATIVE indices,
//      producing undefined values and phantom keys b6p..b9p.
//   2. It took level ordering from `Object.keys(volumes)`, which only
//      happened to come out ascending because the prices were small
//      non-negative integers. Decimal or large prices would have silently
//      inverted the displayed book.
//   3. `Object.keys()` stringifies, so prices reached the browser as
//      strings and sorted/compared as text.
//
// book.depth(n) is explicitly sorted, numeric, and never over-reads, so
// this is now a straight structural mapping.

/**
 * Build the frozen market payload for one symbol.
 * See README "Contract" — prices and volumes are numbers, arrays are
 * best-first (bids descending, asks ascending), and both are padded to
 * exactly `levels` entries so the client renders a stable ladder.
 *
 * @param {string} stock
 * @param {{ depth: Function }} book
 * @param {{price: number, volume: number}|null} [lastTrade]
 * @param {number} [levels]
 * @returns {{stock: string, lastTrade: object|null,
 *            bids: Array<{price: number|null, volume: number}>,
 *            asks: Array<{price: number|null, volume: number}>}}
 */
export function buildMarketPayload(stock, book, lastTrade = null, levels = 5) {
  const { bids, asks } = book.depth(levels);
  return {
    stock,
    lastTrade: lastTrade ? { price: lastTrade.price, volume: lastTrade.volume } : null,
    bids: padLevels(bids, levels),
    asks: padLevels(asks, levels),
  };
}

/**
 * Normalise [[price, volume], ...] into objects, padding short sides with
 * empty levels rather than reading past the end of the array (E5).
 */
function padLevels(pairs, levels) {
  const out = [];
  for (let i = 0; i < levels; i++) {
    const pair = pairs[i];
    out.push(pair ? { price: pair[0], volume: pair[1] } : { price: null, volume: 0 });
  }
  return out;
}

/**
 * Tracks the latest payload per symbol so a client connecting mid-session
 * gets a full snapshot instead of waiting for the next order.
 *
 * The old code kept `lastExchangeData[stock] = exchangeData`, holding a
 * reference to a live, mutating book. These payloads are plain data built
 * fresh each time, so there is nothing to alias.
 */
export function createMarketState() {
  /** @type {Map<string, object>} */
  const latest = new Map();

  return {
    update(payload) {
      latest.set(payload.stock, payload);
      return payload;
    },
    snapshot() {
      return [...latest.values()];
    },
    get(stock) {
      return latest.get(stock) ?? null;
    },
  };
}
