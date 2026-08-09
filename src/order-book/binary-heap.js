// Binary min-heap, ordered by an injected comparator `(a, b) => number`
// (negative when `a` should come before `b`). Passing `(a, b) => b - a`
// turns this into a max-heap — there is no more `max` flag / negate-every-
// value hack, which is what made the old implementation's `peek()` return
// `NaN` on an empty max-heap and its `remove()` need a sign flip it could
// only get right by importing the exchange module (creating a require
// cycle — see the project's defect register, E4).
//
// `peek()` / `pop()` return `null` on an empty heap, as a defined contract.

export class BinaryHeap {
  constructor(comparator) {
    this.comparator = comparator;
    this.content = [];
  }

  size() {
    return this.content.length;
  }

  all() {
    return this.content.slice();
  }

  peek() {
    return this.content.length > 0 ? this.content[0] : null;
  }

  push(value) {
    this.content.push(value);
    this.#bubbleUp(this.content.length - 1);
  }

  pop() {
    if (this.content.length === 0) return null;
    const result = this.content[0];
    const end = this.content.pop();
    if (this.content.length > 0) {
      this.content[0] = end;
      this.#sinkDown(0);
    }
    return result;
  }

  // Removes the first element strictly equal (===) to `value`. Returns
  // `true` if something was removed, `false` if `value` was not present
  // (the old implementation threw — a defined boolean contract is easier
  // to use for the obvious next feature, order cancellation).
  remove(value) {
    const len = this.content.length;
    for (let i = 0; i < len; i++) {
      if (this.content[i] !== value) continue;

      const end = this.content.pop();
      if (i !== len - 1) {
        this.content[i] = end;
        if (this.comparator(end, value) < 0) {
          this.#bubbleUp(i);
        } else {
          this.#sinkDown(i);
        }
      }
      return true;
    }
    return false;
  }

  #bubbleUp(n) {
    const element = this.content[n];
    while (n > 0) {
      const parentN = Math.floor((n + 1) / 2) - 1;
      const parent = this.content[parentN];
      if (this.comparator(element, parent) < 0) {
        this.content[parentN] = element;
        this.content[n] = parent;
        n = parentN;
      } else {
        break;
      }
    }
  }

  #sinkDown(n) {
    const length = this.content.length;
    const element = this.content[n];

    for (;;) {
      const child2N = (n + 1) * 2;
      const child1N = child2N - 1;
      let swap = null;

      if (child1N < length && this.comparator(this.content[child1N], element) < 0) {
        swap = child1N;
      }

      if (
        child2N < length &&
        this.comparator(this.content[child2N], swap === null ? element : this.content[swap]) < 0
      ) {
        swap = child2N;
      }

      if (swap === null) break;
      this.content[n] = this.content[swap];
      this.content[swap] = element;
      n = swap;
    }
  }
}
