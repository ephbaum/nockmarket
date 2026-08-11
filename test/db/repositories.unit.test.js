// Unit tests for src/db/* against a stubbed MongoDB driver.
//
// The integration suite (repositories.integration.test.js) is gated behind
// MONGODB_URI and has never executed in CI-less environments, which left
// real logic in this layer completely unverified — most notably the
// IndexBuildError translation, which has non-trivial behaviour and zero
// coverage.
//
// These tests do NOT verify driver compatibility; only a real MongoDB can
// do that, and the integration suite remains the place for it. What they
// verify is *our* logic: the ObjectId guards, the E11000 -> typed-error
// translation, the idempotent portfolio update, and the connect-first
// invariants. That is the part that is ours to get wrong.
//
// Requires --experimental-test-module-mocks (set in the npm script) so the
// repositories can be pointed at a fake Db without adding a test-only
// injection seam to production code.
import { beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

/** A fake collection recording calls and returning scripted results. */
function makeCollection(scripted = {}) {
  const calls = [];
  const col = {
    calls,
    async createIndex(spec, opts) {
      calls.push(['createIndex', spec, opts]);
      if (scripted.createIndexError) throw scripted.createIndexError;
      return 'ok';
    },
    async insertOne(doc) {
      calls.push(['insertOne', doc]);
      if (scripted.insertOneError) throw scripted.insertOneError;
      return { insertedId: scripted.insertedId ?? new ObjectId() };
    },
    async insertMany(docs) {
      calls.push(['insertMany', docs]);
      return { insertedIds: docs.map(() => new ObjectId()) };
    },
    async findOne(query) {
      calls.push(['findOne', query]);
      return scripted.findOneResult ?? null;
    },
    async findOneAndUpdate(filter, update, opts) {
      calls.push(['findOneAndUpdate', filter, update, opts]);
      return scripted.findOneAndUpdateResult ?? null;
    },
    async updateOne(filter, update) {
      calls.push(['updateOne', filter, update]);
      return { matchedCount: scripted.matchedCount ?? 1 };
    },
    aggregate(pipeline) {
      calls.push(['aggregate', pipeline]);
      return {
        async toArray() {
          return scripted.aggregateResult ?? [];
        },
      };
    },
    find(query) {
      calls.push(['find', query]);
      return {
        sort() {
          return this;
        },
        limit() {
          return this;
        },
        async toArray() {
          return scripted.findResult ?? [];
        },
      };
    },
  };
  return col;
}

function makeDb(collections = {}) {
  return {
    collection(name) {
      collections[name] ??= makeCollection();
      return collections[name];
    },
    _collections: collections,
  };
}

/** Points src/db/client.js's getDb() at a fake, without touching source. */
async function loadWithDb(db) {
  mock.module('../../src/db/client.js', {
    namedExports: {
      getDb: () => db,
      getClient: () => ({}),
    },
  });
  const users = await import(`../../src/db/users.js?u=${Math.random()}`);
  const transactions = await import(`../../src/db/transactions.js?u=${Math.random()}`);
  return { users, transactions };
}

describe('client.js — connect-first invariants', () => {
  beforeEach(() => mock.reset());

  test('getDb() and getClient() throw before connect()', async () => {
    const client = await import(`../../src/db/client.js?fresh=${Math.random()}`);
    assert.throws(() => client.getDb(), /not connected/i);
    assert.throws(() => client.getClient(), /not connected/i);
  });

  test('close() is safe when never connected', async () => {
    const client = await import(`../../src/db/client.js?fresh=${Math.random()}`);
    await assert.doesNotReject(() => client.close());
  });
});

describe('ensureIndexes — IndexBuildError translation', () => {
  beforeEach(() => mock.reset());

  test('creates the unique username index and both transaction indexes', async () => {
    const collections = {};
    const db = makeDb(collections);
    // ensureIndexes takes the Db as an optional parameter, defaulting to
    // getDb(). Passing it explicitly is what makes this path testable
    // without a live connection.
    const client = await import('../../src/db/client.js');
    await client.ensureIndexes(db);

    const userIdx = collections.users.calls.filter((c) => c[0] === 'createIndex');
    assert.equal(userIdx.length, 1);
    assert.deepEqual(userIdx[0][1], { usernameLower: 1 });
    assert.equal(userIdx[0][2].unique, true);

    const txIdx = collections.transactions.calls.filter((c) => c[0] === 'createIndex');
    assert.equal(txIdx.length, 2, 'both transaction indexes must be created');
    // The index must follow `side`, the field insertOrder actually writes —
    // `init` was the 2014 field name and nothing writes it any more.
    assert.ok(
      txIdx.some((c) => 'side' in c[1]),
      'expected an index on side'
    );
    assert.ok(!txIdx.some((c) => 'init' in c[1]), 'must not index the dead `init` field');
  });

  test('a duplicate-key failure becomes IndexBuildError naming the collisions', async () => {
    const e11000 = Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    const collections = {
      users: makeCollection({
        createIndexError: e11000,
        aggregateResult: [{ _id: 'bob', usernames: ['Bob', 'bob'] }],
      }),
    };
    const db = makeDb(collections);
    const client = await import('../../src/db/client.js');

    await assert.rejects(
      () => client.ensureIndexes(db),
      (err) => {
        assert.equal(err.name, 'IndexBuildError');
        assert.match(err.message, /Bob, bob/, 'must name the actual collisions');
        assert.match(err.message, /Resolve or merge/, 'must be actionable');
        assert.ok(Array.isArray(err.duplicates));
        return true;
      }
    );
  });

  test('a non-duplicate index failure propagates unchanged', async () => {
    const boom = Object.assign(new Error('disk full'), { code: 14031 });
    const collections = { users: makeCollection({ createIndexError: boom }) };
    const client = await import('../../src/db/client.js');

    await assert.rejects(() => client.ensureIndexes(makeDb(collections)), /disk full/);
  });
});

describe('users.js — ObjectId guards and error translation', () => {
  beforeEach(() => mock.reset());

  test('create() surfaces E11000 as DuplicateUserError', async () => {
    const collections = {
      users: makeCollection({
        insertOneError: Object.assign(new Error('E11000'), { code: 11000 }),
      }),
    };
    const { users } = await loadWithDb(makeDb(collections));

    await assert.rejects(
      () =>
        users.create({
          username: 'alice',
          email: 'a@example.com',
          passwordHash: 'scrypt$x',
          passwordAlgo: 'scrypt',
        }),
      (err) => err.name === 'DuplicateUserError'
    );
  });

  test('create() stores usernameLower and round-trips the hash fields', async () => {
    const collections = { users: makeCollection() };
    const { users } = await loadWithDb(makeDb(collections));

    await users.create({
      username: 'Alice',
      email: 'a@example.com',
      passwordHash: 'scrypt$abc',
      passwordAlgo: 'scrypt',
    });

    const [, doc] = collections.users.calls.find((c) => c[0] === 'insertOne');
    assert.equal(doc.username, 'Alice', 'display name preserved as typed');
    assert.equal(doc.usernameLower, 'alice', 'lookup key is case-folded');
    assert.equal(doc.passwordHash, 'scrypt$abc');
    assert.equal(doc.passwordAlgo, 'scrypt');
    assert.deepEqual(doc.portfolio, []);
  });

  test('every id-taking function returns null on a malformed id, never throws', async () => {
    const { users } = await loadWithDb(makeDb());
    const bad = 'not-a-valid-objectid';

    // findById was the only one covered; these three share the same guard
    // and were previously unverified.
    assert.equal(await users.findById(bad), null);
    assert.equal(await users.updateEmail(bad, 'x@example.com'), null);
    assert.equal(await users.addToPortfolio(bad, { stock: 'NOCK1', volume: 1 }), null);
    assert.equal(await users.updatePasswordHash(bad, 'scrypt$x'), null);
  });

  test('findByUsername looks up by the case-folded key', async () => {
    const collections = { users: makeCollection() };
    const { users } = await loadWithDb(makeDb(collections));
    await users.findByUsername('AlIcE');
    const [, query] = collections.users.calls.find((c) => c[0] === 'findOne');
    assert.deepEqual(query, { usernameLower: 'alice' });
  });

  test('addToPortfolio increments an existing holding rather than duplicating it', async () => {
    const id = new ObjectId();
    const collections = {
      users: makeCollection({
        findOneAndUpdateResult: {
          _id: id,
          username: 'a',
          portfolio: [{ stock: 'NOCK1', volume: 3 }],
        },
      }),
    };
    const { users } = await loadWithDb(makeDb(collections));

    await users.addToPortfolio(id.toString(), { stock: 'NOCK1', volume: 2 });

    const call = collections.users.calls.find((c) => c[0] === 'findOneAndUpdate');
    assert.ok(call, 'must attempt an in-place increment first');
    assert.ok(JSON.stringify(call[2]).includes('$inc'), 'expected $inc on the matched holding');
  });

  test('updatePasswordHash sets hash and algo together', async () => {
    const id = new ObjectId();
    const collections = { users: makeCollection({ findOneAndUpdateResult: { _id: id } }) };
    const { users } = await loadWithDb(makeDb(collections));

    await users.updatePasswordHash(id.toString(), 'scrypt$new', 'scrypt');

    const call =
      collections.users.calls.find((c) => c[0] === 'findOneAndUpdate') ??
      collections.users.calls.find((c) => c[0] === 'updateOne');
    const update = JSON.stringify(call[2]);
    assert.ok(update.includes('passwordHash'), 'must set the hash');
    assert.ok(update.includes('passwordAlgo'), 'must set the algo alongside it');
  });
});

describe('transactions.js', () => {
  beforeEach(() => mock.reset());

  test('insertOrder stamps a real ts rather than deriving it from the _id', async () => {
    const collections = { transactions: makeCollection() };
    const { transactions } = await loadWithDb(makeDb(collections));

    await transactions.insertOrder({ stock: 'NOCK1', side: 'buy', price: 40, volume: 10 });

    const [, doc] = collections.transactions.calls.find((c) => c[0] === 'insertOne');
    assert.ok(doc.ts instanceof Date, 'C7: a real ts field, not an ObjectId hex prefix');
  });

  test('findTrades passes the stock filter through', async () => {
    const collections = { transactions: makeCollection({ findResult: [] }) };
    const { transactions } = await loadWithDb(makeDb(collections));

    await transactions.findTrades({ stock: 'NOCK2', limit: 10 });

    const [, query] = collections.transactions.calls.find((c) => c[0] === 'find');
    assert.equal(query.stock, 'NOCK2', 'C6: must filter, not blend all tickers');
  });

  test('findTrades without a stock does not filter by stock', async () => {
    const collections = { transactions: makeCollection({ findResult: [] }) };
    const { transactions } = await loadWithDb(makeDb(collections));

    await transactions.findTrades({});

    const [, query] = collections.transactions.calls.find((c) => c[0] === 'find');
    assert.ok(!('stock' in query), 'an absent filter must not become stock: undefined');
  });
});
