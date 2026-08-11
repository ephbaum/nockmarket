// src/db/users.js
//
// All user persistence. Nothing outside this module talks to the
// `users` collection directly. Signatures here match the frozen
// "Database repository signatures" section of README.md exactly.
import { ObjectId } from 'mongodb';
import { getDb } from './client.js';

/**
 * Thrown by create() when the username is already taken, case-insensitively.
 * Derived from the E11000 duplicate-key error the unique index on
 * usernameLower produces — the database is the arbiter, not a
 * check-then-insert race.
 */
export class DuplicateUserError extends Error {
  constructor(username) {
    super(`Username "${username}" is already taken`);
    this.name = 'DuplicateUserError';
    this.username = username;
  }
}

function users() {
  return getDb().collection('users');
}

function isDuplicateKeyError(err) {
  return Boolean(err) && (err.code === 11000 || err.code === 11001);
}

/**
 * Parse a string or ObjectId into an ObjectId, or null if malformed.
 * Never throws — callers get a clean "not found" instead of a driver
 * exception for a malformed id.
 */
function toObjectId(id) {
  if (id instanceof ObjectId) {
    return id;
  }
  if (typeof id !== 'string' || !ObjectId.isValid(id)) {
    return null;
  }
  try {
    return new ObjectId(id);
  } catch {
    return null;
  }
}

/** Strip internal-only fields and stringify _id for anything leaving this module. */
function toPublicUser(doc) {
  if (!doc) {
    return null;
  }
  const { _id, ...rest } = doc;
  delete rest.usernameLower;
  return { _id: _id.toString(), ...rest };
}

/**
 * Create a new user. Rejects with `DuplicateUserError` (checking the
 * unique index on `usernameLower`, not a check-then-insert race) if the
 * username is already taken, case-insensitively.
 * @param {{ username: string, email: string, passwordHash: string, passwordAlgo: string }} user
 * @returns {Promise<{ _id: string, username: string, email: string, portfolio: object[] }>}
 */
export async function create(user) {
  const { username, email, passwordHash, passwordAlgo } = user;
  const doc = {
    username,
    usernameLower: username.toLowerCase(),
    email,
    passwordHash,
    passwordAlgo,
    portfolio: [],
  };

  let result;
  try {
    result = await users().insertOne(doc);
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      throw new DuplicateUserError(username);
    }
    throw err;
  }

  return {
    _id: result.insertedId.toString(),
    username: doc.username,
    email: doc.email,
    portfolio: doc.portfolio,
  };
}

/**
 * @param {string} username - matched case-insensitively via `usernameLower`.
 * @returns {Promise<object|null>}
 */
export async function findByUsername(username) {
  if (typeof username !== 'string' || username.length === 0) {
    return null;
  }
  const doc = await users().findOne({ usernameLower: username.toLowerCase() });
  return toPublicUser(doc);
}

/**
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export async function findById(id) {
  const oid = toObjectId(id);
  if (!oid) {
    return null;
  }
  const doc = await users().findOne({ _id: oid });
  return toPublicUser(doc);
}

/**
 * @param {string} id
 * @param {string} email
 * @returns {Promise<object|null>} the updated user document, or null if not found.
 */
export async function updateEmail(id, email) {
  const oid = toObjectId(id);
  if (!oid) {
    return null;
  }
  const doc = await users().findOneAndUpdate(
    { _id: oid },
    { $set: { email } },
    { returnDocument: 'after' }
  );
  return toPublicUser(doc);
}

/**
 * @param {string} id
 * @param {{ stock: string, volume: number }} holding
 * @returns {Promise<object|null>} the updated user document, or null if not found.
 */
export async function addToPortfolio(id, holding) {
  const oid = toObjectId(id);
  if (!oid) {
    return null;
  }
  const { stock, volume } = holding;

  // Idempotent by symbol: if the stock is already held, add to its
  // volume instead of pushing a second entry for the same symbol.
  const incremented = await users().findOneAndUpdate(
    { _id: oid, 'portfolio.stock': stock },
    { $inc: { 'portfolio.$.volume': volume } },
    { returnDocument: 'after' }
  );
  if (incremented) {
    return toPublicUser(incremented);
  }

  // Not held yet: push a new entry, guarded so a concurrent call that
  // just added the same symbol doesn't produce a duplicate.
  const pushed = await users().findOneAndUpdate(
    { _id: oid, 'portfolio.stock': { $ne: stock } },
    { $push: { portfolio: { stock, volume } } },
    { returnDocument: 'after' }
  );
  if (pushed) {
    return toPublicUser(pushed);
  }

  // Lost the race: another call added it between our two updates above.
  // Fall back to incrementing the now-present entry.
  const afterRace = await users().findOneAndUpdate(
    { _id: oid, 'portfolio.stock': stock },
    { $inc: { 'portfolio.$.volume': volume } },
    { returnDocument: 'after' }
  );
  return toPublicUser(afterRace);
}

/**
 * @param {string} id
 * @param {string} passwordHash
 * @param {string} [passwordAlgo] - defaults to the current scheme (scrypt).
 * @returns {Promise<object|null>} the updated user document, or null if not found.
 */
export async function updatePasswordHash(id, passwordHash, passwordAlgo = 'scrypt') {
  const oid = toObjectId(id);
  if (!oid) {
    return null;
  }
  const doc = await users().findOneAndUpdate(
    { _id: oid },
    { $set: { passwordHash, passwordAlgo } },
    { returnDocument: 'after' }
  );
  return toPublicUser(doc);
}
