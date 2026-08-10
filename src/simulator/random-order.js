// Random order generation — pure, seedable, no I/O.
//
// The 2014 version reached into the book's internals
// (exchangeData.buys.prices.peek()) and called Math.random() inline. Taking
// bestBid/bestAsk as numbers and an injected RNG keeps the engine's data
// structures private and makes sequences reproducible.

const PRICE_FLOOR = 35;
const PRICE_RANGE = 10;
const VOLUME_FLOOR = 80;
const VOLUME_RANGE = 40;

/**
 * @param {{ bestBid: number|null, bestAsk: number|null, rng: () => number }} input
 * @returns {{ side: 'buy'|'sell', price: number, volume: number }}
 */
export function generateRandomOrder({ bestBid = null, bestAsk = null, rng = Math.random } = {}) {
  const side = rng() > 0.5 ? 'buy' : 'sell';

  let price;
  if (bestBid === null && bestAsk === null) {
    price = Math.floor(rng() * PRICE_RANGE) + PRICE_FLOOR;
  } else if (bestBid !== null && bestAsk !== null) {
    price = rng() > 0.5 ? bestBid : bestAsk;
  } else {
    price = bestBid ?? bestAsk;
  }

  const shift = Math.floor((rng() * PRICE_RANGE) / 2);
  price += rng() > 0.5 ? shift : -shift;

  // A long run of downward shifts could walk the price to zero, and
  // submit() rejects that — an invalid draw must not kill the loop.
  price = Math.max(1, price);

  const volume = Math.floor(rng() * VOLUME_RANGE) + VOLUME_FLOOR;

  return { side, price, volume };
}

/**
 * mulberry32 — seedable PRNG, so a simulator run replays exactly in tests.
 * @param {number} seed
 * @returns {() => number}
 */
export function createRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
