// Owns the single MongoClient/Db for the process.
//
// Does nothing at import time. The old lib/db.js constructed its Db and
// connected at require time, which made anything importing it untestable
// and unstoppable — callers must call connect() explicitly.
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
 * Idempotent — a second call while connected returns the existing Db.
 * @param {string} uri
 * @param {object} [options] - passed to MongoClient, except `dbName`, which
 *   selects the database directly so tests can use a unique name per run
 *   without rewriting the URI.
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
 * Exposed so connect-mongo reuses this connection rather than dialling a
 * second one (S10).
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
 * Idempotent — MongoDB no-ops a createIndex that matches an existing index.
 *
 * The unique index on users.usernameLower (S7) makes the database the
 * arbiter of username uniqueness rather than a racy findOne-then-insert.
 * If the collection already holds case-duplicates, the build fails and is
 * re-thrown as an IndexBuildError naming the collisions, since the raw
 * driver error says nothing actionable.
 *
 * The transactions index follows `side`; the 2014 schema's `init` field is
 * no longer written by anything.
 */
export async function ensureIndexes(database = getDb()) {
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
