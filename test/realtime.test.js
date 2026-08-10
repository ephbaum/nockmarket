// Realtime-layer tests: presence refcounting, market payload shape, and a
// real socket.io client/server round-trip over an ephemeral port.
// No database, no external network.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import express from 'express';
import session from 'express-session';
import { io as ioClient } from 'socket.io-client';

import { createPresence } from '../src/realtime/presence.js';
import { buildMarketPayload, createMarketState } from '../src/realtime/market.js';
import { createIo } from '../src/realtime/io.js';
import { OrderBook } from '../src/order-book/index.js';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

describe('presence (C2 regression)', () => {
  test('a user appears once regardless of how many tabs they open', () => {
    const p = createPresence();
    assert.equal(p.join('alice', 's1'), true, 'first socket announces arrival');
    assert.equal(p.join('alice', 's2'), false, 'second tab must not re-announce');
    assert.deepEqual(p.list(), ['alice']);
    assert.equal(p.count(), 1);
  });

  test('closing one of two tabs keeps the user present', () => {
    const p = createPresence();
    p.join('alice', 's1');
    p.join('alice', 's2');
    assert.equal(p.leave('alice', 's1'), false, 'still has another socket');
    assert.deepEqual(p.list(), ['alice']);
    assert.equal(p.leave('alice', 's2'), true, 'last socket departs');
    assert.deepEqual(p.list(), []);
  });

  test('a departure for an unknown user removes nobody else', () => {
    // The old code did online.splice(indexOf(u), 1); indexOf returned -1
    // and splice(-1, 1) deleted the LAST entry — evicting an unrelated
    // user. This is the exact regression.
    const p = createPresence();
    p.join('alice', 's1');
    p.join('bob', 's2');
    p.join('carol', 's3');

    assert.equal(p.leave('mallory', 's99'), false);
    assert.deepEqual(p.list(), ['alice', 'bob', 'carol'], 'nobody may be evicted');

    assert.equal(p.leave('alice', 'not-a-real-socket'), false);
    assert.deepEqual(p.list(), ['alice', 'bob', 'carol']);
  });

  test('socketsFor returns every connection a user holds', () => {
    const p = createPresence();
    p.join('alice', 's1');
    p.join('alice', 's2');
    assert.deepEqual(p.socketsFor('alice').sort(), ['s1', 's2']);
    assert.deepEqual(p.socketsFor('nobody'), []);
  });
});

describe('market payload (E5 regression)', () => {
  test('a book with fewer than 5 levels pads instead of reading negative indices', () => {
    const book = new OrderBook({ symbol: 'NOCK1' });
    book.submit({ side: 'buy', price: 40, volume: 100 });
    book.submit({ side: 'sell', price: 45, volume: 50 });

    const payload = buildMarketPayload('NOCK1', book, null, 5);

    assert.equal(payload.bids.length, 5);
    assert.equal(payload.asks.length, 5);
    // The old transformStockData emitted phantom b6p..b9p keys here.
    assert.equal(payload.bids[0].price, 40);
    assert.equal(payload.bids[0].volume, 100);
    for (let i = 1; i < 5; i++) {
      assert.equal(payload.bids[i].price, null, `bid level ${i} must be an empty level`);
      assert.equal(payload.bids[i].volume, 0);
    }
    assert.equal(payload.asks[0].price, 45);
  });

  test('prices and volumes are numbers, never strings', () => {
    const book = new OrderBook({ symbol: 'NOCK1' });
    book.submit({ side: 'buy', price: 40, volume: 100 });
    const payload = buildMarketPayload('NOCK1', book);
    assert.equal(typeof payload.bids[0].price, 'number');
    assert.equal(typeof payload.bids[0].volume, 'number');
  });

  test('bids are best-first descending and asks best-first ascending', () => {
    const book = new OrderBook({ symbol: 'NOCK1' });
    for (const price of [38, 40, 39]) {
      book.submit({ side: 'buy', price, volume: 10 });
    }
    for (const price of [45, 43, 44]) {
      book.submit({ side: 'sell', price, volume: 10 });
    }
    const { bids, asks } = buildMarketPayload('NOCK1', book);
    assert.deepEqual(
      bids.slice(0, 3).map((b) => b.price),
      [40, 39, 38]
    );
    assert.deepEqual(
      asks.slice(0, 3).map((a) => a.price),
      [43, 44, 45]
    );
  });

  test('market state keeps the latest payload per symbol', () => {
    const state = createMarketState();
    const book = new OrderBook({ symbol: 'NOCK1' });
    book.submit({ side: 'buy', price: 40, volume: 10 });
    state.update(buildMarketPayload('NOCK1', book));
    state.update(buildMarketPayload('NOCK2', book));
    state.update(buildMarketPayload('NOCK1', book));
    assert.equal(state.snapshot().length, 2, 'one entry per symbol, not per update');
  });
});

describe('socket.io server', () => {
  const servers = [];

  after(async () => {
    for (const { realtime, httpServer } of servers) {
      await realtime.close();
      await new Promise((resolve) => httpServer.close(resolve));
    }
  });

  async function startServer({ authenticated = true } = {}) {
    const app = express();
    const sessionMiddleware = session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: true,
    });
    app.use(sessionMiddleware);
    // Log in by visiting this route, so the socket handshake sees a real
    // session cookie rather than a synthesised one.
    app.get('/login-as/:username', (req, res) => {
      if (authenticated) {
        req.session.userId = `id-${req.params.username}`;
        req.session.username = req.params.username;
      }
      req.session.save(() => res.json({ ok: true }));
    });

    const httpServer = createServer(app);
    const realtime = createIo(httpServer, {
      sessionMiddleware,
      users: { async updateEmail() {} },
      logger: silentLogger,
    });
    await new Promise((resolve) => httpServer.listen(0, resolve));
    const entry = { realtime, httpServer, port: httpServer.address().port };
    servers.push(entry);
    return entry;
  }

  /** Log in over HTTP and return the session cookie, as a browser would. */
  async function loginCookie(port, username) {
    const res = await fetch(`http://127.0.0.1:${port}/login-as/${username}`);
    return res.headers.getSetCookie().join('; ');
  }

  function connect(port, cookie) {
    return ioClient(`http://127.0.0.1:${port}`, {
      extraHeaders: { Cookie: cookie },
      transports: ['websocket', 'polling'],
      reconnection: false,
    });
  }

  test('rejects a handshake with no authenticated session', async () => {
    const { port } = await startServer({ authenticated: false });
    const cookie = await loginCookie(port, 'nobody');
    const socket = connect(port, cookie);

    const err = await new Promise((resolve) => {
      socket.on('connect_error', resolve);
      socket.on('connect', () => resolve(null));
    });
    socket.close();
    assert.ok(err, 'an unauthenticated handshake must be refused');
  });

  test('an authenticated client connects and receives a market snapshot', async () => {
    const { port } = await startServer();
    const cookie = await loginCookie(port, 'alice');
    const socket = connect(port, cookie);

    const snapshot = await new Promise((resolve, reject) => {
      socket.on('market:snapshot', resolve);
      socket.on('connect_error', reject);
      setTimeout(() => reject(new Error('timed out')), 3000);
    });
    socket.close();
    assert.ok(Array.isArray(snapshot.books));
  });

  test('R3: a departure is announced as presence:leave, never as disconnect', async () => {
    // Emitting 'disconnect' as a custom event throws in socket.io v3+.
    // If this test connects, sends and departs without the server
    // throwing, the reserved name is not being emitted.
    const { port, realtime } = await startServer();
    const aliceCookie = await loginCookie(port, 'alice');
    const bobCookie = await loginCookie(port, 'bob');

    const alice = connect(port, aliceCookie);
    await new Promise((resolve, reject) => {
      alice.on('connect', resolve);
      alice.on('connect_error', reject);
    });
    alice.emit('presence:join');

    const bob = connect(port, bobCookie);
    await new Promise((resolve, reject) => {
      bob.on('connect', resolve);
      bob.on('connect_error', reject);
    });

    const left = new Promise((resolve) => alice.on('presence:leave', resolve));
    bob.emit('presence:join');
    await new Promise((r) => setTimeout(r, 50));
    bob.close();

    const payload = await Promise.race([
      left,
      new Promise((_, reject) => setTimeout(() => reject(new Error('no presence:leave')), 3000)),
    ]);

    assert.equal(payload.username, 'bob');
    assert.equal(realtime.presence.count(), 1, 'only alice remains');
    alice.close();
  });

  test('chat messages are relayed as structured fields, not a pre-built string', async () => {
    const { port } = await startServer();
    const cookie = await loginCookie(port, 'alice');
    const socket = connect(port, cookie);
    await new Promise((resolve, reject) => {
      socket.on('connect', resolve);
      socket.on('connect_error', reject);
    });

    const received = new Promise((resolve) => socket.on('chat:message', resolve));
    socket.emit('chat:message', { text: '<img src=x onerror=alert(1)>' });
    const msg = await received;
    socket.close();

    // The payload carries the raw text and a separate username. Escaping
    // is the renderer's job (textContent) — the server must not
    // pre-concatenate them into markup.
    assert.equal(msg.username, 'alice');
    assert.equal(msg.text, '<img src=x onerror=alert(1)>');
    assert.equal(typeof msg.at, 'number');
  });

  test('disconnectUser drops every socket a user holds (logout)', async () => {
    const { port, realtime } = await startServer();
    const cookie = await loginCookie(port, 'alice');

    const tab1 = connect(port, cookie);
    const tab2 = connect(port, cookie);
    await Promise.all([
      new Promise((res, rej) => {
        tab1.on('connect', res);
        tab1.on('connect_error', rej);
      }),
      new Promise((res, rej) => {
        tab2.on('connect', res);
        tab2.on('connect_error', rej);
      }),
    ]);
    tab1.emit('presence:join');
    tab2.emit('presence:join');
    await new Promise((r) => setTimeout(r, 80));

    const dropped = realtime.disconnectUser('alice');
    assert.equal(dropped, 2, 'both tabs must be disconnected on logout');

    await new Promise((r) => setTimeout(r, 80));
    tab1.close();
    tab2.close();
  });
});
