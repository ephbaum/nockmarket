// Session middleware factory. Replaces a hardcoded secret (S2) and
// MemoryStore (S10), which leaked on restart and broke with a second worker.
//
// Call this ONCE per app and share the instance: src/realtime/io.js passes
// the same one to io.engine.use(), which is what lets Socket.IO handshakes
// and HTTP requests agree on the session without the hand-rolled cookie
// parsing the old code used (it read connect.sid raw, despite Express
// having signed it since v3).
import session from 'express-session';
import MongoStore from 'connect-mongo';

/**
 * @param {object} config
 * @param {import('mongodb').MongoClient} [mongoClient] - omit only in tests
 * @returns {import('express').RequestHandler} a single, shareable instance
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
