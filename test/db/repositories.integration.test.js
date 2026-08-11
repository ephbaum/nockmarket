// test/db/repositories.integration.test.js
//
// Integration tests for src/db/{client,users,transactions}.js against a
// real MongoDB. Guarded end-to-end: with no MONGODB_URI, this whole file
// skips (npm test stays green with no database and no network). CI's
// `npm run test:integration` supplies a mongo:7 service.
//
// Uses a uniquely-named database per run (and closes/drops it afterwards)
// so repeated local runs never interfere with each other.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import * as client from '../../src/db/client.js';
import * as users from '../../src/db/users.js';
import * as transactions from '../../src/db/transactions.js';

const MONGODB_URI = process.env.MONGODB_URI;
const dbName = `nockmarket_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

describe('db repositories (integration)', { skip: !MONGODB_URI }, () => {
  before(async () => {
    await client.connect(MONGODB_URI, { dbName });
    await client.ensureIndexes();
  });

  after(async () => {
    await client.getDb().dropDatabase();
    await client.close();
  });

  function uniqueUsername(label) {
    return `${label}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  }

  describe('users.create', () => {
    test('returns a document with a real _id', async () => {
      const username = uniqueUsername('alice');
      const created = await users.create({
        username,
        email: 'alice@example.com',
        passwordHash: 'hash',
        passwordAlgo: 'scrypt',
      });

      assert.equal(created.username, username);
      assert.equal(created.email, 'alice@example.com');
      assert.deepEqual(created.portfolio, []);
      assert.equal(typeof created._id, 'string');
      assert.equal(ObjectId.isValid(created._id), true);
    });

    test('rejects a duplicate username with DuplicateUserError', async () => {
      const username = uniqueUsername('dupe');
      await users.create({
        username,
        email: 'dupe@example.com',
        passwordHash: 'hash',
        passwordAlgo: 'scrypt',
      });

      await assert.rejects(
        () =>
          users.create({
            username,
            email: 'dupe2@example.com',
            passwordHash: 'hash2',
            passwordAlgo: 'scrypt',
          }),
        users.DuplicateUserError
      );
    });

    test('rejects a case-insensitive duplicate username (Bob after bob)', async () => {
      const base = uniqueUsername('bob');
      await users.create({
        username: base,
        email: 'bob@example.com',
        passwordHash: 'hash',
        passwordAlgo: 'scrypt',
      });

      const upperVariant = base.charAt(0).toUpperCase() + base.slice(1);
      await assert.rejects(
        () =>
          users.create({
            username: upperVariant,
            email: 'bob2@example.com',
            passwordHash: 'hash2',
            passwordAlgo: 'scrypt',
          }),
        users.DuplicateUserError
      );
    });
  });

  describe('users.findByUsername / findById', () => {
    test('findByUsername is case-insensitive', async () => {
      const username = uniqueUsername('carol');
      const created = await users.create({
        username,
        email: 'carol@example.com',
        passwordHash: 'hash',
        passwordAlgo: 'scrypt',
      });

      const foundLower = await users.findByUsername(username.toLowerCase());
      const foundUpper = await users.findByUsername(username.toUpperCase());

      assert.equal(foundLower._id, created._id);
      assert.equal(foundUpper._id, created._id);
    });

    test('findById handles a string id and an ObjectId', async () => {
      const username = uniqueUsername('dave');
      const created = await users.create({
        username,
        email: 'dave@example.com',
        passwordHash: 'hash',
        passwordAlgo: 'scrypt',
      });

      const byString = await users.findById(created._id);
      const byObjectId = await users.findById(new ObjectId(created._id));

      assert.equal(byString._id, created._id);
      assert.equal(byObjectId._id, created._id);
    });

    test('findById returns null for a well-formed but absent id', async () => {
      const result = await users.findById(new ObjectId().toString());
      assert.equal(result, null);
    });

    test('findById returns null (not throws) for a malformed id', async () => {
      const result = await users.findById('not-an-object-id');
      assert.equal(result, null);
    });
  });

  describe('users.addToPortfolio', () => {
    test('is idempotent by symbol: adding the same stock twice does not duplicate it', async () => {
      const username = uniqueUsername('erin');
      const created = await users.create({
        username,
        email: 'erin@example.com',
        passwordHash: 'hash',
        passwordAlgo: 'scrypt',
      });

      const afterFirst = await users.addToPortfolio(created._id, { stock: 'NOCK1', volume: 10 });
      const afterSecond = await users.addToPortfolio(created._id, { stock: 'NOCK1', volume: 5 });

      const nock1Entries = afterSecond.portfolio.filter((h) => h.stock === 'NOCK1');
      assert.equal(nock1Entries.length, 1);
      assert.equal(nock1Entries[0].volume, 15);
      assert.equal(afterFirst.portfolio.length, 1);
      assert.equal(afterSecond.portfolio.length, 1);
    });
  });

  describe('users.updatePasswordHash', () => {
    test('sets hash and algo together', async () => {
      const username = uniqueUsername('frank');
      const created = await users.create({
        username,
        email: 'frank@example.com',
        passwordHash: 'oldhash',
        passwordAlgo: 'md5',
      });

      const updated = await users.updatePasswordHash(created._id, 'newscrypthash', 'scrypt');

      assert.equal(updated.passwordHash, 'newscrypthash');
      assert.equal(updated.passwordAlgo, 'scrypt');
    });

    test('defaults passwordAlgo to scrypt when omitted', async () => {
      const username = uniqueUsername('grace');
      const created = await users.create({
        username,
        email: 'grace@example.com',
        passwordHash: 'oldhash',
        passwordAlgo: 'md5',
      });

      const updated = await users.updatePasswordHash(created._id, 'newhash');

      assert.equal(updated.passwordHash, 'newhash');
      assert.equal(updated.passwordAlgo, 'scrypt');
    });
  });

  describe('transactions', () => {
    test('insertTrades stamps a real ts on every trade', async () => {
      const before2 = Date.now();
      const stored = await transactions.insertTrades([
        { stock: 'NOCK1', price: 50, volume: 10 },
        { stock: 'NOCK2', price: 60, volume: 20 },
      ]);
      const after2 = Date.now();

      assert.equal(stored.length, 2);
      for (const trade of stored) {
        assert.equal(typeof trade._id, 'string');
        assert.ok(trade.ts instanceof Date);
        assert.ok(trade.ts.getTime() >= before2 && trade.ts.getTime() <= after2);
      }
    });

    test('findTrades({stock}) filters to one ticker; findTrades({}) does not', async () => {
      const marker = `FILT${Date.now()}${Math.floor(Math.random() * 1e6)}`;
      const stockA = `${marker}A`;
      const stockB = `${marker}B`;

      await transactions.insertTrades([
        { stock: stockA, price: 10, volume: 1 },
        { stock: stockA, price: 11, volume: 2 },
        { stock: stockB, price: 20, volume: 3 },
      ]);

      const filtered = await transactions.findTrades({ stock: stockA });
      assert.equal(filtered.length, 2);
      assert.ok(filtered.every((t) => t.stock === stockA));

      const unfiltered = await transactions.findTrades({});
      const unfilteredForMarker = unfiltered.filter(
        (t) => t.stock === stockA || t.stock === stockB
      );
      assert.equal(unfilteredForMarker.length, 3);
    });

    test('findTrades sorts newest-first and applies limit', async () => {
      const marker = `SORT${Date.now()}${Math.floor(Math.random() * 1e6)}`;
      await transactions.insertOrder({ stock: marker, side: 'buy', price: 1, volume: 1 });
      await new Promise((resolve) => setTimeout(resolve, 5));
      await transactions.insertTrades([{ stock: marker, price: 2, volume: 1 }]);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await transactions.insertTrades([{ stock: marker, price: 3, volume: 1 }]);

      const results = await transactions.findTrades({ stock: marker, limit: 2 });
      assert.equal(results.length, 2);
      assert.equal(results[0].price, 3);
      assert.equal(results[1].price, 2);
      assert.ok(results[0].ts >= results[1].ts);
    });

    test('insertOrder persists an order and returns it with a real _id', async () => {
      const order = await transactions.insertOrder({
        stock: 'NOCK3',
        side: 'sell',
        price: 42,
        volume: 7,
      });
      assert.equal(typeof order._id, 'string');
      assert.equal(order.stock, 'NOCK3');
      assert.ok(order.ts instanceof Date);
    });
  });

  describe('client.ensureIndexes', () => {
    test('is idempotent: running it twice in a row succeeds', async () => {
      await client.ensureIndexes();
      await client.ensureIndexes();

      const indexes = await client.getDb().collection('users').indexes();
      const usernameIndex = indexes.find((idx) => idx.name === 'uniq_usernameLower');
      assert.ok(usernameIndex);
      assert.equal(usernameIndex.unique, true);
    });
  });
});
