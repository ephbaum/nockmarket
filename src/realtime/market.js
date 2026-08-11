// Order-book -> wire payload.
//
// Replaces transformStockData in lib/nocklib.js (E5), which read negative
// array indices when a side had fewer than 5 levels, took ordering from
// Object.keys() — correct only by accident, for small integer prices — and
// leaked stringified prices to the browser. book.depth(n) is sorted,
// numeric and bounded, so this is now a structural mapping.

/**
 * @param {string} stock
 * @param {{ depth: Function }} book
 * @param {{price: number, volume: number}|null} [lastTrade]
 * @param {number} [levels]
 * @returns {{stock: string, lastTrade: object|null, bids: object[], asks: object[]}}
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

// Padding short sides keeps the client's ladder a stable height, and is why
// nothing here ever indexes past the end of the array (E5).
function padLevels(pairs, levels) {
  const out = [];
  for (let i = 0; i < levels; i++) {
    const pair = pairs[i];
    out.push(pair ? { price: pair[0], volume: pair[1] } : { price: null, volume: 0 });
  }
  return out;
}

/**
 * Latest payload per symbol, so a client connecting mid-session gets a
 * snapshot instead of waiting for the next order.
 *
 * These are plain rebuilt payloads, not references to live books. The old
 * lastExchangeData held the mutating book itself, which is how snapshots
 * drifted out of sync with the data they were supposed to describe.
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
