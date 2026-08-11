// Server-rendered pages plus the health endpoint.
//
// Replaces routes/nockroutes.js:11-48. Defects closed here:
//   C4  — /portfolio read `user.email` with no null guard, so a session
//         whose user had been deleted threw inside an async callback.
//   C12 — views/chart.ejs was orphaned: nothing routed to it. GET /chart
//         renders it now.
import { Router } from 'express';
import { priceHoldings } from './api.js';

/**
 * @param {{ users: object, quotes: object, db: object,
 *           requireAuth: import('express').RequestHandler,
 *           config: object, logger: object }} deps
 */
export function createPagesRouter({ users, quotes, db, requireAuth, config, logger }) {
  const router = Router();

  router.get('/', (req, res) => {
    if (req.session?.userId) {
      return res.redirect('/portfolio');
    }
    res.render('index', { csrfToken: res.locals.csrfToken });
  });

  router.get('/portfolio', requireAuth, async (req, res) => {
    const user = await users.findById(req.session.userId);

    // C4: the session can outlive the user document (deleted account, or a
    // session store that survived a database reset). Treat it as logged
    // out rather than dereferencing null.
    if (!user) {
      logger.warn({ userId: req.session.userId }, 'session references a missing user');
      return req.session.destroy(() => res.redirect('/'));
    }

    const portfolio = await priceHoldings(user.portfolio, quotes, logger);

    res.render('portfolio', {
      username: user.username,
      email: user.email ?? '',
      portfolio,
      symbols: config.simulator.symbols,
      csrfToken: res.locals.csrfToken,
    });
  });

  // C12: this view existed since 2014 with no route pointing at it.
  router.get('/chart', requireAuth, (req, res) => {
    res.render('chart', {
      symbols: config.simulator.symbols,
      csrfToken: res.locals.csrfToken,
    });
  });

  router.get('/healthz', async (req, res) => {
    let mongo;
    try {
      await db.getDb().admin().ping();
      mongo = 'up';
    } catch {
      mongo = 'down';
    }
    // Report 200 even when Mongo is down so the container distinguishes
    // "process alive, dependency degraded" from "process dead"; the
    // compose healthcheck keys off the body, not just the status.
    res.json({ status: 'ok', mongo, uptime: Math.round(process.uptime()) });
  });

  return router;
}
