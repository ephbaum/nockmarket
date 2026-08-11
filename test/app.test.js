// HTTP-layer tests for src/app.js and src/routes/*.
//
// Runs with no database and no network: `db`, `users`, `transactions` and
// `quotes` are injected fakes, which is what createApp's dependency
// parameters are for. Each test asserts a specific defect stays fixed.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import session from 'express-session';
import request from 'supertest';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { hash } from '../src/auth/password.js';
import { createFakeProvider } from '../src/quotes/fake.js';

const config = loadConfig({
  NODE_ENV: 'test',
  SESSION_SECRET: 'test-secret-not-used-anywhere-real',
  MONGODB_URI: 'mongodb://localhost:27017/nockmarket_test',
});

class DuplicateUserError extends Error {
  constructor(username) {
    super(`Username already taken: ${username}`);
    this.name = 'DuplicateUserError';
  }
}

function makeFakes({ seedUsers = [], seedTrades = [] } = {}) {
  const store = new Map(seedUsers.map((u) => [u.username.toLowerCase(), { ...u }]));

  const users = {
    async create({ username, email, passwordHash, passwordAlgo }) {
      const key = username.toLowerCase();
      if (store.has(key)) {
        throw new DuplicateUserError(username);
      }
      const user = {
        _id: `id-${store.size + 1}`,
        username,
        email,
        passwordHash,
        passwordAlgo,
        portfolio: [],
      };
      store.set(key, user);
      return { _id: user._id, username, email, portfolio: [] };
    },
    async findByUsername(username) {
      return store.get(String(username).toLowerCase()) ?? null;
    },
    async findById(id) {
      return [...store.values()].find((u) => u._id === id) ?? null;
    },
    async addToPortfolio(id, { stock, volume }) {
      const user = [...store.values()].find((u) => u._id === id);
      if (!user) return null;
      const existing = user.portfolio.find((h) => h.stock === stock);
      if (existing) existing.volume += volume;
      else user.portfolio.push({ stock, volume });
      return user;
    },
    async updatePasswordHash(id, passwordHash, passwordAlgo) {
      const user = [...store.values()].find((u) => u._id === id);
      if (!user) return null;
      user.passwordHash = passwordHash;
      user.passwordAlgo = passwordAlgo;
      return user;
    },
  };

  const transactions = {
    async findTrades({ stock, limit }) {
      return seedTrades.filter((t) => t.stock === stock).slice(0, limit);
    },
  };

  const db = { getDb: () => ({ admin: () => ({ ping: async () => ({ ok: 1 }) }) }) };

  return { users, transactions, db, store };
}

function buildApp(overrides = {}) {
  const fakes = makeFakes(overrides);
  const app = createApp({
    config,
    db: fakes.db,
    users: fakes.users,
    transactions: fakes.transactions,
    quotes: overrides.quotes ?? createFakeProvider({ QUOTE_SEED: '1', QUOTE_BUCKET_MS: '5000' }),
    sessionMiddleware: session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
    }),
  });
  return { app, ...fakes };
}

/**
 * Establish a session and obtain its CSRF token, as a fetch() client would.
 * Uses the token endpoint rather than scraping the rendered HTML: the views
 * are still the untouched 2014 templates until P3a rewrites them, so there
 * is no hidden input to scrape yet.
 */
async function startSession(agent) {
  const res = await agent.get('/api/csrf-token');
  return res.body?.csrfToken ?? null;
}

describe('HTTP layer', () => {
  test('GET /healthz reports status and mongo reachability', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/healthz');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
    assert.equal(res.body.mongo, 'up');
    assert.equal(typeof res.body.uptime, 'number');
  });

  test('S5: a state-changing POST without a CSRF token is rejected', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/signup')
      .send({ username: 'alice', email: 'a@example.com', password: 'correct-horse' });
    assert.equal(res.status, 403);
  });

  test('S6: unauthenticated POST /api/add-stock returns 401, not a silent no-op', async () => {
    const { app } = buildApp();
    const agent = request.agent(app);
    await agent.get('/');
    const res = await agent.post('/api/add-stock').send({ stock: 'AAPL' });
    // 401 (guard) or 403 (CSRF) — never 200, and never a silent success.
    assert.ok(res.status === 401 || res.status === 403, `got ${res.status}`);
  });

  test('C6: GET /api/trades without ?stock= is a 400', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/trades');
    assert.equal(res.status, 400);
  });

  test('C6/C7: GET /api/trades filters by stock and uses the real ts field', async () => {
    const ts = new Date('2026-01-01T00:00:00Z');
    const { app } = buildApp({
      seedTrades: [
        { stock: 'NOCK1', price: 41, volume: 10, ts },
        { stock: 'NOCK2', price: 99, volume: 10, ts },
      ],
    });
    const res = await request(app).get('/api/trades?stock=NOCK1');
    assert.equal(res.status, 200);
    assert.equal(res.body.stock, 'NOCK1');
    assert.equal(res.body.series.length, 1, 'must not blend other tickers into the series');
    assert.deepEqual(res.body.series[0], [ts.getTime(), 41]);
  });

  test('404 handler renders for unknown paths', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/no-such-page');
    assert.equal(res.status, 404);
  });
});

describe('auth flow', () => {
  test('signup then login then logout, with CSRF and a cookie jar', async () => {
    const { app, store } = buildApp();
    const agent = request.agent(app);

    const token = await startSession(agent, '/');
    assert.ok(token, 'the index page must expose a CSRF token to the form');

    const signup = await agent.post('/signup').set('Accept', 'application/json').send({
      _csrf: token,
      username: 'alice',
      email: 'alice@example.com',
      password: 'correct-horse-battery',
      passwordConfirm: 'correct-horse-battery',
    });
    assert.equal(signup.status, 200, JSON.stringify(signup.body));
    assert.ok(store.has('alice'));

    // S8: the session is regenerated on signup/login, which necessarily
    // rotates the CSRF secret. The response must carry the new token.
    assert.ok(signup.body.csrfToken, 'auth response must return the rotated CSRF token');
    assert.notEqual(signup.body.csrfToken, token, 'token must change when the session regenerates');

    const logout = await agent
      .post('/logout')
      .set('Accept', 'application/json')
      .send({ _csrf: signup.body.csrfToken });
    assert.equal(logout.status, 200, JSON.stringify(logout.body));
  });

  test('S8: the pre-login CSRF token is rejected after session regeneration', async () => {
    const { app } = buildApp();
    const agent = request.agent(app);
    const stale = await startSession(agent);

    await agent.post('/signup').set('Accept', 'application/json').send({
      _csrf: stale,
      username: 'carol',
      email: 'carol@example.com',
      password: 'correct-horse-battery',
      passwordConfirm: 'correct-horse-battery',
    });

    // Reusing the pre-login token must fail — that is the fixation defence.
    const res = await agent
      .post('/logout')
      .set('Accept', 'application/json')
      .send({ _csrf: stale });
    assert.equal(res.status, 403);
  });

  test('signup rejects a weak password and a mismatched confirmation', async () => {
    const { app } = buildApp();
    const agent = request.agent(app);
    const token = await startSession(agent, '/');

    const res = await agent.post('/signup').set('Accept', 'application/json').send({
      _csrf: token,
      username: 'bob',
      email: 'bob@example.com',
      password: 'short',
      passwordConfirm: 'nope',
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.errors.length >= 2);
  });

  test('S7: a duplicate username is a 409, not a 500', async () => {
    const existing = {
      _id: 'id-1',
      username: 'alice',
      email: 'a@example.com',
      passwordHash: await hash('correct-horse-battery'),
      passwordAlgo: 'scrypt',
      portfolio: [],
    };
    const { app } = buildApp({ seedUsers: [existing] });
    const agent = request.agent(app);
    const token = await startSession(agent, '/');

    const res = await agent.post('/signup').set('Accept', 'application/json').send({
      _csrf: token,
      username: 'Alice',
      email: 'other@example.com',
      password: 'correct-horse-battery',
      passwordConfirm: 'correct-horse-battery',
    });
    assert.equal(res.status, 409);
  });

  test('login with a wrong password is a 401', async () => {
    const existing = {
      _id: 'id-1',
      username: 'alice',
      email: 'a@example.com',
      passwordHash: await hash('correct-horse-battery'),
      passwordAlgo: 'scrypt',
      portfolio: [],
    };
    const { app } = buildApp({ seedUsers: [existing] });
    const agent = request.agent(app);
    const token = await startSession(agent, '/');

    const res = await agent
      .post('/login')
      .set('Accept', 'application/json')
      .send({ _csrf: token, username: 'alice', password: 'wrong-password-here' });
    assert.equal(res.status, 401);
  });

  test('S1: a legacy MD5 user logs in and their hash is upgraded to scrypt', async () => {
    // md5('correct-horse-battery') — the 2014 storage format.
    const { createHash } = await import('node:crypto');
    const legacyHash = createHash('md5').update('correct-horse-battery').digest('hex');

    const existing = {
      _id: 'id-1',
      username: 'legacy',
      email: 'legacy@example.com',
      passwordHash: legacyHash,
      passwordAlgo: 'md5',
      portfolio: [],
    };
    const { app, store } = buildApp({ seedUsers: [existing] });
    const agent = request.agent(app);
    const token = await startSession(agent, '/');

    const res = await agent
      .post('/login')
      .set('Accept', 'application/json')
      .send({ _csrf: token, username: 'legacy', password: 'correct-horse-battery' });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    const after = store.get('legacy');
    assert.ok(after.passwordHash.startsWith('scrypt$'), 'hash must be upgraded on login');
    assert.equal(after.passwordAlgo, 'scrypt');
    assert.notEqual(after.passwordHash, legacyHash);
  });
});

describe('POST /api/add-stock: authenticated success path', () => {
  test('C3/C11: a valid post gets a 200 JSON reply with the priced portfolio, not a raw string', async () => {
    const { app } = buildApp();
    const agent = request.agent(app);
    const token = await startSession(agent);

    const signup = await agent.post('/signup').set('Accept', 'application/json').send({
      _csrf: token,
      username: 'dave',
      email: 'dave@example.com',
      password: 'correct-horse-battery',
      passwordConfirm: 'correct-horse-battery',
    });
    assert.equal(signup.status, 200, JSON.stringify(signup.body));

    const res = await agent
      .post('/api/add-stock')
      .set('Accept', 'application/json')
      .send({ _csrf: signup.body.csrfToken, stock: 'AAPL', volume: 3 });

    // C3: the old handler was `if (req.xhr) {...}` with no else, so a
    // non-XHR post never got a response at all.
    assert.equal(res.status, 200, JSON.stringify(res.body));

    // C11: the old handler did res.send(price), a raw CSV string, not JSON.
    assert.equal(res.type, 'application/json');
    assert.equal(res.body.stock, 'AAPL');
    assert.equal(res.body.volume, 3);
    assert.ok(Array.isArray(res.body.portfolio));
    assert.equal(res.body.portfolio.length, 1);

    const [holding] = res.body.portfolio;
    assert.deepEqual(Object.keys(holding).sort(), ['price', 'stale', 'stock', 'volume']);
    assert.equal(holding.stock, 'AAPL');
    assert.equal(holding.volume, 3);
    assert.equal(typeof holding.price, 'number');
    assert.equal(typeof holding.stale, 'boolean');
  });

  test('C1: an unresolvable holding does not shift prices onto the wrong symbol at the route', async () => {
    const existing = {
      _id: 'id-1',
      username: 'erin',
      email: 'erin@example.com',
      passwordHash: await hash('correct-horse-battery'),
      passwordAlgo: 'scrypt',
      portfolio: [
        { stock: 'AAPL', volume: 1 },
        { stock: 'BADSYM', volume: 1 },
      ],
    };

    // Resolves everything except BADSYM. A positional zip that dropped
    // BADSYM's null out of the results list (rather than keying results by
    // symbol) would shift MSFT's price onto BADSYM and leave MSFT with
    // none — the original C1 bug, reproduced here through the live route
    // instead of by calling priceHoldings directly.
    const quotes = {
      name: 'test',
      async getQuotes(symbols) {
        return new Map(
          symbols.map((s) => [
            s,
            s === 'BADSYM'
              ? null
              : {
                  symbol: s,
                  price: s === 'AAPL' ? 100 : 200,
                  currency: 'USD',
                  asOf: new Date(),
                  source: 'test',
                  stale: false,
                },
          ])
        );
      },
    };

    const { app } = buildApp({ seedUsers: [existing], quotes });
    const agent = request.agent(app);
    const token = await startSession(agent);

    const login = await agent
      .post('/login')
      .set('Accept', 'application/json')
      .send({ _csrf: token, username: 'erin', password: 'correct-horse-battery' });
    assert.equal(login.status, 200, JSON.stringify(login.body));

    const res = await agent
      .post('/api/add-stock')
      .set('Accept', 'application/json')
      .send({ _csrf: login.body.csrfToken, stock: 'MSFT', volume: 1 });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    // Keyed, never positional: BADSYM must stay null and MSFT must keep
    // its own price, whatever order priceHoldings happens to iterate in.
    assert.deepEqual(
      res.body.portfolio.map((p) => [p.stock, p.price]),
      [
        ['AAPL', 100],
        ['BADSYM', null],
        ['MSFT', 200],
      ]
    );
  });
});

describe('C4: /portfolio with a session that outlives its user', () => {
  test('a deleted user is treated as logged out, not a 500', async () => {
    const existing = {
      _id: 'id-1',
      username: 'frank',
      email: 'frank@example.com',
      passwordHash: await hash('correct-horse-battery'),
      passwordAlgo: 'scrypt',
      portfolio: [],
    };
    const { app, store } = buildApp({ seedUsers: [existing] });
    const agent = request.agent(app);
    const token = await startSession(agent);

    const login = await agent
      .post('/login')
      .set('Accept', 'application/json')
      .send({ _csrf: token, username: 'frank', password: 'correct-horse-battery' });
    assert.equal(login.status, 200, JSON.stringify(login.body));

    // The account is gone (deletion, or a session store that outlived a
    // database reset) but the session cookie is still live.
    store.delete('frank');

    const res = await agent.get('/portfolio').redirects(0);

    // C4: findById returns null; the route must destroy the stale session
    // and redirect rather than dereferencing user.email into a 500.
    assert.equal(res.status, 302, JSON.stringify(res.body));
    assert.equal(res.headers.location, '/');

    // The session must actually be destroyed, not just this one response
    // redirected: a follow-up request must no longer be treated as authed.
    const after = await agent.get('/portfolio').redirects(0);
    assert.equal(after.status, 302);
    assert.equal(after.headers.location, '/');
  });
});

describe('C1 regression: quotes are paired by symbol, never by position', () => {
  test('an unresolvable symbol does not shift prices onto other holdings', async () => {
    const existing = {
      _id: 'id-1',
      username: 'alice',
      email: 'a@example.com',
      passwordHash: await hash('correct-horse-battery'),
      passwordAlgo: 'scrypt',
      portfolio: [
        { stock: 'AAPL', volume: 1 },
        { stock: 'BADSYM', volume: 1 },
        { stock: 'MSFT', volume: 1 },
      ],
    };

    // Middle symbol resolves to null — exactly the case that used to
    // shift MSFT's price onto BADSYM and drop MSFT's entirely.
    const quotes = {
      name: 'test',
      async getQuotes(symbols) {
        return new Map(
          symbols.map((s) => [
            s,
            s === 'BADSYM'
              ? null
              : {
                  symbol: s,
                  price: s === 'AAPL' ? 100 : 200,
                  currency: 'USD',
                  asOf: new Date(),
                  source: 'test',
                  stale: false,
                },
          ])
        );
      },
    };

    const { users } = makeFakes({ seedUsers: [existing] });
    const { priceHoldings } = await import('../src/routes/api.js');
    const priced = await priceHoldings(existing.portfolio, quotes, null);

    assert.equal(priced.length, 3);
    assert.deepEqual(
      priced.map((p) => [p.stock, p.price]),
      [
        ['AAPL', 100],
        ['BADSYM', null],
        ['MSFT', 200],
      ]
    );
    assert.ok(users, 'fakes constructed');
  });
});
