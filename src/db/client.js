// src/db/client.js
//
// Owns the single MongoClient/Db for the process. Deliberately does
// **nothing** at import time (no connection, no client construction) —
// the old lib/db.js constructed its Db object and connected at require
// time, which made anything that imported it untestable and unstoppable.
// Callers (src/server.js, tests) must explicitly call connect().
import { MongoClient } from 'mongodb';

let client = null;
let db = null;

/**
 * Thrown by ensureIndexes() when the unique index on users.usernameLower
 * cannot be built because the collection already contains case-duplicate
 * usernames. Carries the offending usernameLower values so the failure is
 * actionable instead of an opaque driver stack trace.
 */
export class IndexBuildError extends Error {
  constructor(message, duplicates) {
    super(message);
    this.name = 'IndexBuildError';
    this.duplicates = duplicates;
  }
}

/**
 * Connect to MongoDB. Idempotent: calling it again while already
 * connected returns the existing Db without opening a second connection.
 * @param {string} uri - MongoDB connection URI.
 * @param {object} [options] - Passed to MongoClient, except `dbName`
 *   (pulled out and used to select the database via `client.db(dbName)`
 *   instead of relying on the URI's path — handy for tests that want a
 *   uniquely-named database per run without touching the URI string).
 * @returns {Promise<import('mongodb').Db>}
 */
export async function connect(uri, options = {}) {
  if (client && db) {
    return db;
  }
  const { dbName, ...clientOptions } = options;
  client = new MongoClient(uri, clientOptions);
  await client.connect();
  db = dbName ? client.db(dbName) : client.db();
  return db;
}

/**
 * Close the connection, if open. Safe to call when not connected.
 */
export async function close() {
  if (client) {
    await client.close();
  }
  client = null;
  db = null;
}

/**
 * @returns {import('mongodb').Db}
 * @throws {Error} if connect() has not been called yet.
 */
export function getDb() {
  if (!db) {
    throw new Error('Database not connected. Call connect(uri) before getDb().');
  }
  return db;
}

/**
 * The underlying MongoClient. Exposed so the session store (connect-mongo)
 * can reuse this connection instead of dialling a second one — sharing the
 * client is the point of replacing the old MemoryStore (S10).
 * @returns {import('mongodb').MongoClient}
 * @throws {Error} if connect() has not been called yet.
 */
export function getClient() {
  if (!client) {
    throw new Error('Database not connected. Call connect(uri) before getClient().');
  }
  return client;
}

/**
 * Create (or confirm) the indexes the app depends on. Idempotent — safe
 * to call on every startup; MongoDB no-ops a createIndex call that
 * already matches an existing index.
 *
 * - unique index on users.usernameLower (S7): makes the database the
 *   arbiter of username uniqueness instead of a client-side, racy
 *   findOne-then-insert check.
 * - transactions: { stock: 1, ts: -1 } for the per-symbol trade-history
 *   query (findTrades), and { side: 1, ts: -1 } for filtering by the
 *   initiating side.
 *
 *   Note: the 2014 schema called this field `init` ('b'/'s'). The rewrite
 *   stores `side` ('buy'/'sell') — see insertOrder in transactions.js —
 *   so the index follows the field that is actually written.
 *
 * If the users collection already contains case-duplicate usernames
 * (e.g. "bob" and "Bob"), the unique index build fails server-side. That
 * failure is caught here, the actual colliding usernameLower values are
 * looked up, and an IndexBuildError naming them is thrown instead of
 * letting the raw duplicate-key error propagate.
 */
export async function ensureIndexes() {
  const database = getDb();

  try {
    await database
      .collection('users')
      .createIndex({ usernameLower: 1 }, { unique: true, name: 'uniq_usernameLower' });
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      const duplicates = await findDuplicateUsernames(database);
      const names = duplicates.map((d) => d.usernames.join(', ')).join('; ');
      throw new IndexBuildError(
        `Cannot build unique index on users.usernameLower: the collection already ` +
          `contains case-duplicate username(s): ${names || '(unable to enumerate)'}. ` +
          `Resolve or merge these accounts before starting the app.`,
        duplicates
      );
    }
    throw err;
  }

  await database.collection('transactions').createIndex({ stock: 1, ts: -1 });
  await database.collection('transactions').createIndex({ side: 1, ts: -1 });
}

function isDuplicateKeyError(err) {
  return Boolean(err) && (err.code === 11000 || err.code === 11001);
}

async function findDuplicateUsernames(database) {
  return database
    .collection('users')
    .aggregate([
      { $group: { _id: '$usernameLower', usernames: { $push: '$username' }, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
      { $project: { _id: 0, usernameLower: '$_id', usernames: 1 } },
    ])
    .toArray();
}
