// All order/trade persistence. Signatures match the repository contract in
// README.md.
import { getDb } from './client.js';

function transactions() {
  return getDb().collection('transactions');
}

// C7: a real timestamp. The legacy code reverse-engineered `ts` from an
// ObjectId hex prefix, which has only 1-second granularity.
function withTimestamp(doc) {
  return { ...doc, ts: doc.ts instanceof Date ? doc.ts : new Date() };
}

function toPlainDoc(doc, insertedId) {
  return { ...doc, _id: insertedId.toString() };
}

/**
 * Persisted whether or not the order traded.
 * @param {{ stock: string, side: 'buy'|'sell', price: number, volume: number, ts: Date }} order
 * @returns {Promise<object>}
 */
export async function insertOrder(order) {
  const doc = withTimestamp(order);
  const result = await transactions().insertOne(doc);
  return toPlainDoc(doc, result.insertedId);
}

/**
 * Must be called with the trades submit() returned, never re-derived from a
 * separately-read book — that mismatch was E2.
 * @param {Array<{ stock: string, price: number, volume: number, ts: Date }>} trades
 * @returns {Promise<object[]>}
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
 *   ticker; the old code merged every ticker into one series (C6).
 * @returns {Promise<object[]>} most recent first
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
