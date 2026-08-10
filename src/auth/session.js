// Session middleware factory.
//
// Replaces the 2014 setup in nockmarket.js:61-64, which used a hardcoded
// secret (S2, fixed in src/config.js) and express-session's MemoryStore
// (S10) — the latter leaks on every restart and only works in a single
// process, so it silently breaks the moment there is a second worker.
//
// IMPORTANT — this factory must be called ONCE per app and the resulting
// middleware shared. src/realtime/io.js hands the *same instance* to
// `io.engine.use(...)` so Socket.IO handshakes see the same session as
// HTTP requests. That single shared instance is what replaces the whole
// hand-rolled cookie-parsing block in the old lib/nocklib.js:59-75
// (which read `connect.sid` raw, despite it being signed since Express 3).
import session from 'express-session';
import MongoStore from 'connect-mongo';

/**
 * @param {object} config - from src/config.js
 * @param {import('mongodb').MongoClient} [mongoClient] - reused for the
 *   session store. Omit only in tests, which fall back to the default
 *   in-memory store.
 * @returns {import('express').RequestHandler} a single, shareable instance.
 */
export function createSessionMiddleware(config, mongoClient) {
  return session({
    name: 'connect.sid',
    secret: config.session.secret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    store: mongoClient
      ? MongoStore.create({
          client: mongoClient,
          collectionName: 'sessions',
          ttl: 14 * 24 * 60 * 60,
        })
      : undefined,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.isProd,
      maxAge: 14 * 24 * 60 * 60 * 1000,
    },
  });
}
