// Express application factory.
//
// Replaces nockmarket.js:56-127. Defects closed here:
//   R2  — express.createServer() was removed in Express 3 (2012).
//   S5  — no CSRF protection on any state-changing route.
//   S9  — no rate limiting anywhere; /login, /signup and the username
//         lookup were all freely brute-forceable.
//   S10 — MemoryStore sessions (see src/auth/session.js).
//   S3  — request logging that dumped plaintext passwords.
//
// Exported as a factory taking its dependencies so tests can drive it with
// supertest and fakes, without a database, a network, or a listening port.
// src/server.js owns listen() and the process lifecycle.
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { csrfProtection } from './auth/csrf.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { createAuthRouter } from './routes/auth.js';
import { createApiRouter } from './routes/api.js';
import { createPagesRouter } from './routes/pages.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');

/**
 * @param {{ config: object, db: object, users: object, transactions: object,
 *           quotes: object, sessionMiddleware: import('express').RequestHandler,
 *           logger: object }} deps
 * @returns {import('express').Express}
 */
export function createApp({
  config,
  db,
  users,
  transactions,
  quotes,
  sessionMiddleware,
  logger = defaultLogger(),
}) {
  const app = express();

  // Must precede session/rate-limit so `secure` cookies and client-IP
  // detection work behind a proxy. Without it, secure cookies are never
  // set in production and every request appears to come from the proxy.
  app.set('trust proxy', config.trustProxy);

  app.set('views', path.join(projectRoot, 'views'));
  app.set('view engine', 'ejs');

  app.use(
    pinoHttp({
      logger,
      // Never serialise the body — it carries plaintext passwords on
      // /login and /signup. This is the structural fix for S3.
      serializers: {
        req: (req) => ({ method: req.method, url: req.url }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    })
  );

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          // No 'unsafe-inline'. P3a moves the inline <script> out of
          // chart.ejs and the inline style= attributes out of
          // portfolio.ejs rather than the policy being weakened for them.
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
    })
  );

  app.use(express.urlencoded({ extended: false, limit: '10kb' }));
  app.use(express.json({ limit: '10kb' }));
  app.use(sessionMiddleware);

  // Sets res.locals.csrfToken for views and rejects unsafe methods that
  // do not present it. Must come after the session middleware.
  app.use(csrfProtection());

  app.use(express.static(path.join(projectRoot, 'public')));
  // Pico.css and the uPlot bundle are served straight from node_modules
  // rather than vendored into public/ — that vendoring is what left six
  // stale minified libraries in the 2014 tree.
  app.use('/vendor/pico', express.static(path.join(projectRoot, 'node_modules/@picocss/pico/css')));
  app.use('/vendor/uplot', express.static(path.join(projectRoot, 'node_modules/uplot/dist')));

  const requireAuth = (req, res, next) => {
    if (req.session?.userId) {
      return next();
    }
    // S6: /add-stock previously had no guard at all, and the resulting
    // `new ObjectID(undefined)` minted a fresh id so the write silently
    // vanished instead of erroring.
    if (req.xhr || req.path.startsWith('/api/')) {
      return res.status(401).json({ errors: ['Authentication required.'] });
    }
    return res.redirect('/');
  };

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  });
  const lookupLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 30,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  });

  app.use('/login', authLimiter);
  app.use('/signup', authLimiter);
  app.use('/api/user', lookupLimiter);

  app.use('/', createPagesRouter({ users, quotes, db, requireAuth, config, logger }));
  app.use('/', createAuthRouter({ users, config, logger }));
  app.use('/api', createApiRouter({ users, transactions, quotes, requireAuth, logger }));

  app.use((req, res) => {
    res.status(404);
    if (req.accepts('html')) {
      return res.render('404');
    }
    return res.json({ errors: ['Not found.'] });
  });

  // Express 5 forwards rejected promises from async handlers here
  // automatically, which is what lets every route above use await without
  // its own try/catch.
  // eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity
  app.use((err, req, res, next) => {
    // Match on the code only. An earlier version also matched /csrf/i
    // against the message, which turned an unrelated crash inside the CSRF
    // middleware into a plausible-looking 403 and hid the real failure.
    if (err?.code === 'EBADCSRFTOKEN') {
      return res.status(403).json({ errors: ['Invalid or missing CSRF token.'] });
    }
    logger.error({ err }, 'unhandled error');
    res.status(500);
    if (req.accepts('html')) {
      return res.render('404');
    }
    return res.json({ errors: ['Internal server error.'] });
  });

  return app;
}

// pino-http reads internals off the logger (levels.values), so this must be
// a real pino instance rather than a hand-rolled noop object. 'silent'
// keeps test output clean without changing any code paths.
function defaultLogger() {
  return pino({ level: 'silent' });
}
