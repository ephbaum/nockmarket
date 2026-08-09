import { BinaryHeap } from './binary-heap.js';

export const BUY = 'buy';
export const SELL = 'sell';

function assertSide(side) {
  if (side !== BUY && side !== SELL) {
    throw new TypeError(`side must be "${BUY}" or "${SELL}", got ${JSON.stringify(side)}`);
  }
}

function assertPositiveFinite(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a finite number > 0, got ${value}`);
  }
}

function oppositeSide(side) {
  return side === BUY ? SELL : BUY;
}

// One side of the book: a price->volume ledger plus a priority heap of the
// prices that currently have volume. These two structures are kept in
// lockstep by construction (every push/insert into `prices` happens
// alongside a `volumes.set`, every pop/delete alongside a `volumes.delete`)
// so there is never a snapshot-style alias between them to desync — that
// aliasing was defect E3 in the module this replaces.
class Ledger {
  constructor(side) {
    this.side = side;
    this.volumes = new Map();
    // Bids want the highest price first (max-heap); asks want the lowest
    // price first (min-heap). A comparator captures that directly instead
    // of the old "negate every value that goes near the heap" hack.
    this.prices = new BinaryHeap(side === BUY ? (a, b) => b - a : (a, b) => a - b);
  }

  bestPrice() {
    return this.prices.peek();
  }

  addVolume(price, volume) {
    const existing = this.volumes.get(price);
    if (existing === undefined) {
      this.volumes.set(price, volume);
      this.prices.push(price);
    } else {
      this.volumes.set(price, existing + volume);
    }
  }

  reduceBestBy(volume) {
    const price = this.bestPrice();
    const remaining = this.volumes.get(price) - volume;
    if (remaining > 0) {
      this.volumes.set(price, remaining);
    } else {
      this.volumes.delete(price);
      this.prices.pop();
    }
  }

  // Sorted best-first: [[price, volume], ...]. `all()` returns the heap's
  // internal array, which only satisfies the heap invariant, not a full
  // ordering, so it is copied and sorted before being handed out.
  levels(n = Infinity) {
    const prices = this.prices.all().sort(this.prices.comparator);
    const out = [];
    for (const price of prices) {
      if (out.length >= n) break;
      out.push([price, this.volumes.get(price)]);
    }
    return out;
  }
}

/**
 * A mutating limit-order-book matching engine for a single symbol.
 *
 * Design notes (see /root/.claude/plans — P1a):
 *  - `submit()` returns the trades an order produced. There is no
 *    "read `.trades` off some other object" step for a caller to get
 *    wrong or get stale (defect E2 in the module this replaces).
 *  - `snapshot()` returns plain, structurally independent JSON. There is
 *    no shared mutable structure between a snapshot and the live book to
 *    desync (defect E3).
 *  - The limit price is re-checked against the current best opposite
 *    price on every iteration of the fill loop, not once up front
 *    (defect E1).
 *  - Zero dependencies, including node builtins (defect R1 / the
 *    extraction boundary enforced by eslint.config.js).
 */
export class OrderBook {
  #symbol;
  #books;

  constructor({ symbol } = {}) {
    this.#symbol = symbol ?? null;
    this.#books = {
      [BUY]: new Ledger(BUY),
      [SELL]: new Ledger(SELL),
    };
  }

  get symbol() {
    return this.#symbol;
  }

  /**
   * @param {{side: 'buy'|'sell', price: number, volume: number}} order
   * @returns {{trades: Array<{price: number, volume: number}>, filledVolume: number, restingVolume: number, restingPrice: number|null}}
   */
  submit({ side, price, volume }) {
    assertSide(side);
    assertPositiveFinite(price, 'price');
    assertPositiveFinite(volume, 'volume');

    const own = this.#books[side];
    const opposite = this.#books[oppositeSide(side)];

    const trades = [];
    let remaining = volume;

    for (;;) {
      if (remaining <= 0) break;

      const bestOppPrice = opposite.bestPrice();
      if (bestOppPrice === null) break;

      // E1: the limit is checked fresh on every iteration against the
      // *current* best opposite price, never once before the loop.
      const marketable = side === BUY ? price >= bestOppPrice : price <= bestOppPrice;
      if (!marketable) break;

      const bestOppVolume = opposite.volumes.get(bestOppPrice);
      const tradeVolume = Math.min(bestOppVolume, remaining);

      trades.push({ price: bestOppPrice, volume: tradeVolume });
      opposite.reduceBestBy(tradeVolume);
      remaining -= tradeVolume;
    }

    const restingVolume = remaining;
    const restingPrice = restingVolume > 0 ? price : null;

    if (restingVolume > 0) {
      own.addVolume(price, restingVolume);
    }

    return {
      trades,
      filledVolume: volume - remaining,
      restingVolume,
      restingPrice,
    };
  }

  bestBid() {
    return this.#books[BUY].bestPrice();
  }

  bestAsk() {
    return this.#books[SELL].bestPrice();
  }

  /**
   * @param {number} [n=5]
   * @returns {{bids: Array<[number, number]>, asks: Array<[number, number]>}}
   */
  depth(n = 5) {
    return {
      bids: this.#books[BUY].levels(n),
      asks: this.#books[SELL].levels(n),
    };
  }

  /**
   * Plain, JSON-serializable, structurally independent of the live book —
   * mutating either the book or a retained snapshot afterwards cannot
   * affect the other.
   */
  snapshot() {
    return {
      symbol: this.#symbol,
      bids: this.#books[BUY].levels(),
      asks: this.#books[SELL].levels(),
    };
  }

  static fromSnapshot(snapshot) {
    const book = new OrderBook({ symbol: snapshot.symbol ?? null });
    for (const [price, volume] of snapshot.bids) {
      book.#books[BUY].addVolume(price, volume);
    }
    for (const [price, volume] of snapshot.asks) {
      book.#books[SELL].addVolume(price, volume);
    }
    return book;
  }

  /**
   * Test-only introspection hook — not part of the frozen public contract
   * in README.md. Exists so tests can assert the heap/volume-map
   * bijection invariant (the exact defect class of E3) directly, instead
   * of only inferring it indirectly through `depth()`.
   * @private
   */
  _debugLevels(side) {
    assertSide(side);
    const book = this.#books[side];
    return {
      heapPrices: book.prices.all(),
      volumeKeys: [...book.volumes.keys()],
    };
  }

  toString() {
    const asks = this.#books[SELL].levels();
    const bids = this.#books[BUY].levels();
    const lines = [''];
    for (const [price, volume] of [...asks].reverse()) {
      lines.push(`        | ${price}, ${volume}`);
    }
    for (const [price, volume] of bids) {
      lines.push(`${price}, ${volume}`);
    }
    lines.push('', '');
    return lines.join('\n');
  }
}
