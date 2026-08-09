import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { BinaryHeap } from '../../src/order-book/binary-heap.js';

const MIN = (a, b) => a - b;
const MAX = (a, b) => b - a;

describe('BinaryHeap', () => {
  test('peek() and pop() return null on an empty heap', () => {
    const heap = new BinaryHeap(MIN);
    assert.equal(heap.peek(), null);
    assert.equal(heap.pop(), null);
    assert.equal(heap.size(), 0);
  });

  test('min comparator pops in ascending order', () => {
    const heap = new BinaryHeap(MIN);
    for (const v of [5, 3, 8, 1, 9, 2]) heap.push(v);
    const popped = [];
    while (heap.size() > 0) popped.push(heap.pop());
    assert.deepEqual(popped, [1, 2, 3, 5, 8, 9]);
  });

  test('max comparator pops in descending order', () => {
    const heap = new BinaryHeap(MAX);
    for (const v of [5, 3, 8, 1, 9, 2]) heap.push(v);
    const popped = [];
    while (heap.size() > 0) popped.push(heap.pop());
    assert.deepEqual(popped, [9, 8, 5, 3, 2, 1]);
  });

  test('peek() does not remove the element', () => {
    const heap = new BinaryHeap(MIN);
    heap.push(4);
    heap.push(2);
    assert.equal(heap.peek(), 2);
    assert.equal(heap.size(), 2);
  });

  test('handles duplicate values', () => {
    const heap = new BinaryHeap(MIN);
    for (const v of [3, 1, 3, 1, 2, 3]) heap.push(v);
    const popped = [];
    while (heap.size() > 0) popped.push(heap.pop());
    assert.deepEqual(popped, [1, 1, 2, 3, 3, 3]);
  });

  test('remove() of the head', () => {
    const heap = new BinaryHeap(MIN);
    for (const v of [1, 2, 3, 4, 5]) heap.push(v);
    const removed = heap.remove(1);
    assert.equal(removed, true);
    const popped = [];
    while (heap.size() > 0) popped.push(heap.pop());
    assert.deepEqual(popped, [2, 3, 4, 5]);
  });

  test('remove() of the tail', () => {
    const heap = new BinaryHeap(MIN);
    for (const v of [1, 2, 3, 4, 5]) heap.push(v);
    const removed = heap.remove(5);
    assert.equal(removed, true);
    const popped = [];
    while (heap.size() > 0) popped.push(heap.pop());
    assert.deepEqual(popped, [1, 2, 3, 4]);
  });

  test('remove() of a middle element', () => {
    const heap = new BinaryHeap(MIN);
    for (const v of [10, 20, 30, 40, 50, 60, 70]) heap.push(v);
    const removed = heap.remove(30);
    assert.equal(removed, true);
    const popped = [];
    while (heap.size() > 0) popped.push(heap.pop());
    assert.deepEqual(popped, [10, 20, 40, 50, 60, 70]);
  });

  test('remove() bubbles the replacement element up when it sorts before its new parent', () => {
    // Shape a heap where removing the root forces the array's tail element
    // into a slot whose parent is larger than it — the bubble-up branch of
    // remove(), as opposed to the sink-down branch exercised above.
    const heap = new BinaryHeap(MIN);
    for (const v of [1, 5, 2, 10, 9, 8, 3]) heap.push(v);
    const removed = heap.remove(1);
    assert.equal(removed, true);
    const popped = [];
    while (heap.size() > 0) popped.push(heap.pop());
    assert.deepEqual(popped, [2, 3, 5, 8, 9, 10]);
  });

  test('remove() of an absent value returns false and leaves the heap intact', () => {
    const heap = new BinaryHeap(MIN);
    for (const v of [1, 2, 3]) heap.push(v);
    const removed = heap.remove(999);
    assert.equal(removed, false);
    assert.equal(heap.size(), 3);
    const popped = [];
    while (heap.size() > 0) popped.push(heap.pop());
    assert.deepEqual(popped, [1, 2, 3]);
  });

  test('remove() from a single-element heap', () => {
    const heap = new BinaryHeap(MIN);
    heap.push(42);
    assert.equal(heap.remove(42), true);
    assert.equal(heap.size(), 0);
    assert.equal(heap.peek(), null);
  });

  test('all() returns the current content without mutating the heap', () => {
    const heap = new BinaryHeap(MIN);
    heap.push(3);
    heap.push(1);
    const before = heap.all();
    assert.equal(heap.size(), 2);
    before.push(999);
    // Mutating the returned array must not affect the heap's own state.
    assert.equal(heap.size(), 2);
  });

  test('heap property holds under randomized push/pop interleaving', () => {
    // Small deterministic PRNG (mulberry32) so this is reproducible without
    // importing anything (src/order-book/** must stay dependency-free).
    let seed = 12345;
    function rand() {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    const heap = new BinaryHeap(MIN);
    const reference = [];
    for (let i = 0; i < 500; i++) {
      if (reference.length === 0 || rand() < 0.7) {
        const v = Math.floor(rand() * 1000);
        heap.push(v);
        reference.push(v);
      } else {
        reference.sort((a, b) => a - b);
        const expected = reference.shift();
        assert.equal(heap.pop(), expected);
      }
    }
    reference.sort((a, b) => a - b);
    const popped = [];
    while (heap.size() > 0) popped.push(heap.pop());
    assert.deepEqual(popped, reference);
  });
});
