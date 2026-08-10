// JSON API.
//
// Replaces routes/nockroutes.js:4-22 and the inline /api/trades handler at
// nockmarket.js:89-115. Defects closed here:
//   C3 — POST /add-stock was wrapped in `if (req.xhr)` with no else, so a
//        non-XHR post never received any response and the socket hung. It
//        also hung whenever the quote lookup errored, because the 2-counter
//        callback in nocklib.addStock never reached 2.
//   C6 — GET /api/trades blended all five tickers into one price series.
//   C7 — it derived timestamps from the ObjectId hex prefix, giving
//        1-second granularity, which forced a throttle that discarded most
//        points. Trades now carry a real `ts`.
//   C11 — `res.send(price)` returned a raw CSV string as the body.
//   S6 — POST /add-stock had no auth guard; `new ObjectID(undefined)`
//        minted a fresh id and the update silently no-opped.
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

  // Rate-limited by the caller. Note this endpoint is inherently an
  // account-enumeration oracle: it answers "does this username exist" to
  // anyone who asks. It is kept because the signup form uses it for
  // availability feedback, but signup correctness must NOT depend on it —
  // the unique index on users.usernameLower is the real check (S7).
  router.get('/user/:username', async (req, res) => {
    const user = await users.findByUsername(req.params.username);
    res.json({ available: !user });
  });

  // Hands the current session's CSRF token to fetch() callers. Safe to
  // expose: the same-origin policy stops a cross-site attacker from
  // reading the response, and the token is scoped to this session. Views
  // also render it directly (hidden input + <meta>), but this keeps
  // script-driven clients from having to scrape the DOM for it.
  router.get('/csrf-token', (req, res) => {
    res.json({ csrfToken: res.locals.csrfToken });
  });

  router.get('/trades', async (req, res) => {
    const { stock } = req.query;
    if (typeof stock !== 'string' || !SYMBOL_RE.test(stock)) {
      // C6: a series is meaningless without knowing which instrument it
      // belongs to, so the filter is required rather than optional.
      return res.status(400).json({ errors: ['A ?stock= query parameter is required.'] });
    }

    const limit = clampLimit(req.query.limit);
    const trades = await transactions.findTrades({ stock, limit });

    // Highcharts/uPlot want [[epochMillis, price], ...] oldest-first.
    // findTrades returns newest-first, so reverse a copy.
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

    // Quotes are keyed by symbol. Look up by key — never by array index.
    // The old code zipped portfolio[i] with prices[i], so a single
    // unresolved symbol shifted every subsequent price onto the wrong
    // ticker (C1). Never reintroduce a positional pairing here.
    const priced = await priceHoldings(updated.portfolio, quotes, logger);

    // C3: always respond, XHR or not. C11: JSON, not a raw CSV string.
    res.status(200).json({ stock, volume, portfolio: priced });
  });

  return router;
}

/**
 * Pair each holding with its quote by symbol key.
 * Shared with the /portfolio page route so both render identical data.
 * @returns {Promise<Array<{stock, volume, price: number|null, stale: boolean}>>}
 */
export async function priceHoldings(portfolio = [], quotes, logger) {
  const symbols = portfolio.map((h) => h.stock);
  if (symbols.length === 0) {
    return [];
  }

  // getQuotes never throws and never rejects (C5) — a total upstream
  // failure still resolves with null for every affected symbol, so this
  // does not need a try/catch and must not take the process down.
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
