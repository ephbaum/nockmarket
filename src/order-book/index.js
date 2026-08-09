// Public entry point for the order-book package. Everything outside
// src/order-book/** should reach this module through here — see the
// eslint.config.js boundary rule and README.md's "Contract" section.
export { OrderBook, BUY, SELL } from './order-book.js';
export { BinaryHeap } from './binary-heap.js';
