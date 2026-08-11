// JSON API. Closes C3, C6, C7, C11, S6.
//
// The old /add-stock was wrapped in `if (req.xhr)` with no else, so a
// non-XHR post never got a response at all, and a failed quote lookup hung
// it too (a 2-counter callback that never reached 2).
import { Router } from 'express';

const SYMBOL_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;
const DEFAULT_TRADE_LIMIT = 100;
const MAX_TRADE_LIMIT = 1000;

/**
 * @param {{ users: object, transactions: object, quotes: object,
 *           requireAuth: import('express').RequestHandler, logger: object }} deps
 */
export function createApiRouter({ users, transactions, quotes, requireAuth, logger }) {
  const router = Router();

  // Inherently an account-enumeration oracle, so it is rate-limited and
  // signup correctness must not depend on it — the unique index is the real
  // check (S7). Kept only for availability feedback on the form.
  router.get('/user/:username', async (req, res) => {
    const user = await users.findByUsername(req.params.username);
    res.json({ available: !user });
  });

  // Safe to expose: same-origin policy stops a cross-site attacker reading
  // the response, and the token is scoped to this session. Saves
  // script-driven clients from scraping the DOM for it.
  router.get('/csrf-token', (req, res) => {
    res.json({ csrfToken: res.locals.csrfToken });
  });

  router.get('/trades', async (req, res) => {
    const { stock } = req.query;
    // C6: a series is meaningless without knowing which instrument it is,
    // so the filter is required rather than optional.
    if (typeof stock !== 'string' || !SYMBOL_RE.test(stock)) {
      return res.status(400).json({ errors: ['A ?stock= query parameter is required.'] });
    }

    const limit = clampLimit(req.query.limit);
    const trades = await transactions.findTrades({ stock, limit });

    // uPlot wants [[epochMillis, price], ...] oldest-first; findTrades
    // returns newest-first.
    const series = [...trades].reverse().map((t) => [new Date(t.ts).getTime(), t.price]);

    res.json({ stock, series });
  });

  router.post('/add-stock', requireAuth, async (req, res) => {
    const stock = String(req.body?.stock ?? '')
      .trim()
      .toUpperCase();
    const volume = Number(req.body?.volume ?? 1);

    if (!SYMBOL_RE.test(stock)) {
      return res.status(400).json({ errors: ['A valid stock symbol is required.'] });
    }
    if (!Number.isFinite(volume) || volume <= 0) {
      return res.status(400).json({ errors: ['Volume must be a positive number.'] });
    }

    const updated = await users.addToPortfolio(req.session.userId, { stock, volume });
    if (!updated) {
      return res.status(404).json({ errors: ['User not found.'] });
    }

    // By key, never by index: the old code zipped portfolio[i] with
    // prices[i], so one unresolved symbol shifted every subsequent price
    // onto the wrong ticker (C1).
    const priced = await priceHoldings(updated.portfolio, quotes, logger);

    // C3: always respond, XHR or not. C11: JSON, not a raw CSV string.
    res.status(200).json({ stock, volume, portfolio: priced });
  });

  return router;
}

/**
 * Shared with the /portfolio page so both render identical data.
 * @returns {Promise<Array<{stock, volume, price: number|null, stale: boolean}>>}
 */
export async function priceHoldings(portfolio = [], quotes, logger) {
  const symbols = portfolio.map((h) => h.stock);
  if (symbols.length === 0) {
    return [];
  }

  // getQuotes never throws or rejects (C5): a total upstream failure still
  // resolves with null per symbol, so no try/catch is needed here.
  const bySymbol = await quotes.getQuotes(symbols);

  return portfolio.map((holding) => {
    const quote = bySymbol.get(holding.stock) ?? null;
    if (!quote) {
      logger?.debug?.({ stock: holding.stock }, 'no quote available');
    }
    return {
      stock: holding.stock,
      volume: holding.volume,
      price: quote ? quote.price : null,
      stale: quote ? Boolean(quote.stale) : false,
    };
  });
}

function clampLimit(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return DEFAULT_TRADE_LIMIT;
  }
  return Math.min(Math.floor(n), MAX_TRADE_LIMIT);
}
