// src/db/transactions.js
//
// All order/trade persistence. Nothing outside this module talks to the
// `transactions` collection directly. Signatures here match the frozen
// "Database repository signatures" section of README.md exactly.
import { getDb } from './client.js';

function transactions() {
  return getDb().collection('transactions');
}

/**
 * Stamp a real timestamp (C7) — the legacy code reverse-engineered `ts`
 * from an ObjectId hex prefix, which only has 1-second granularity.
 * Honors a caller-supplied `ts` (the documented input shape includes
 * one) but always fills a real Date when it's missing.
 */
function withTimestamp(doc) {
  return { ...doc, ts: doc.ts instanceof Date ? doc.ts : new Date() };
}

function toPlainDoc(doc, insertedId) {
  return { ...doc, _id: insertedId.toString() };
}

/**
 * Persist a submitted order (independent of whether it traded).
 * @param {{ stock: string, side: 'buy'|'sell', price: number, volume: number, ts: Date }} order
 * @returns {Promise<object>} the stored order document, including `_id`.
 */
export async function insertOrder(order) {
  const doc = withTimestamp(order);
  const result = await transactions().insertOne(doc);
  return toPlainDoc(doc, result.insertedId);
}

/**
 * Persist the trade(s) a single order submission produced. Called with
 * the trades `OrderBook#submit()` actually returned — never re-derived
 * from a separately-read book state (that mismatch was defect E2).
 * @param {Array<{ stock: string, price: number, volume: number, ts: Date }>} trades
 * @returns {Promise<object[]>} the stored trade documents, including `_id`.
 */
export async function insertTrades(trades) {
  if (!Array.isArray(trades) || trades.length === 0) {
    return [];
  }
  const docs = trades.map(withTimestamp);
  const result = await transactions().insertMany(docs);
  return docs.map((doc, i) => toPlainDoc(doc, result.insertedIds[i]));
}

/**
 * @param {{ stock: string, limit?: number }} query - `stock` filters to one
 *   ticker (fixes the old code merging every ticker into one series);
 *   `limit` bounds the result count, most recent first, ordered by the
 *   real stored `ts` (not reverse-engineered from an ObjectId hex prefix).
 * @returns {Promise<object[]>}
 */
export async function findTrades({ stock, limit } = {}) {
  const query = {};
  if (stock) {
    query.stock = stock;
  }
  let cursor = transactions().find(query).sort({ ts: -1 });
  if (limit) {
    cursor = cursor.limit(limit);
  }
  const docs = await cursor.toArray();
  return docs.map(({ _id, ...rest }) => ({ _id: _id.toString(), ...rest }));
}
