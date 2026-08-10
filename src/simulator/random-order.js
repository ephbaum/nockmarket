// Random order generation — pure, seedable, no I/O.
//
// Extracted from nocklib.generateRandomOrder (lib/nocklib.js:135-170),
// which reached directly into the book's internals
// (exchangeData.buys.prices.peek()). It now takes bestBid/bestAsk as
// plain numbers, so the engine's data structures stay private and this
// function is trivially testable.
//
// Takes an injected RNG so sequences are reproducible in tests; the old
// version called Math.random() five times inline.

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

  // The 2014 version could walk the price to zero or negative over a long
  // run of downward shifts; submit() now rejects that outright, so clamp
  // to a sane floor rather than generating an order the engine will throw
  // on (C8's sibling — an invalid draw must not kill the loop).
  price = Math.max(1, price);

  const volume = Math.floor(rng() * VOLUME_RANGE) + VOLUME_FLOOR;

  return { side, price, volume };
}

/**
 * mulberry32 — small, fast, seedable PRNG. Used so a simulator run can be
 * replayed exactly in tests.
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
