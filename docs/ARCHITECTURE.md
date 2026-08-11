# Architecture

This document describes how nockmarket is actually built, not how the 2014 original worked. See
the repository's `README.md` for what the app is and how to run it, and `NOTICE` for the project's
history and attribution. Line/file references below point at the current source; if you find one
that has drifted, trust the source and file an issue.

## The two halves

Nockmarket is two mostly-independent systems wired together at the socket layer:

1. **The exchange** (`src/order-book/`, `src/simulator/`) — a limit-order-book matching engine and
   a background process that feeds it random orders. It knows nothing about HTTP, sessions, users,
   or Mongo. Give it a `{side, price, volume}` and it gives you back trades.
2. **The portfolio web app** (`src/app.js`, `src/routes/`, `src/auth/`, `src/db/`, `views/`,
   `public/`) — signup/login, a per-user stock portfolio priced against a quote provider, and a
   chat room. It knows nothing about matching logic; it only ever calls `OrderBook#submit()` and
   `#depth()` through the simulator's output, never touches a `Ledger` or `BinaryHeap` directly.

They meet in exactly one place: `src/realtime/`, which turns order-book state into Socket.IO
broadcasts the browser can render, and turns authenticated Socket.IO connections into requests the
exchange side never has to know about (auth is a portfolio-app concern; the order book has no
concept of a user).

```
 Browser                    Portfolio app                 Exchange
 ───────                    ─────────────                 ────────
 fetch/forms  ──HTTP──▶     src/routes/*.js
                            src/db/*.js  ◀────────────┐
                                                       │
 socket.io    ──WS───▶      src/realtime/io.js         │
                              │  session (shared,       │
                              │  see below)             │
                              ▼                         │
                            src/realtime/{chat,market,  │
                            presence}.js                │
                                                         │
                            src/simulator/index.js ─────┴──▶ src/order-book/*.js
                              (submit/depth/bestBid/bestAsk)
```

## Request flow (HTTP)

`src/server.js` is the only file that calls `.listen()`. It, in order:

1. Connects to Mongo and builds indexes (`db.connect`, `db.ensureIndexes`) — fails fast if Mongo is
   unreachable or the `users.usernameLower` unique index can't be built (pre-existing case-duplicate
   usernames raise `IndexBuildError` with the offending names).
2. Builds the quote provider from `process.env` (`createQuoteProvider`).
3. Builds one `express-session` middleware instance (`createSessionMiddleware`) — this instance,
   not a second one, is reused by Socket.IO (see below).
4. Builds the Express app (`createApp`) — a pure factory over its dependencies, so `test/app.test.js`
   drives it with `supertest` and no real database or open port.
5. Wraps the app in an `http.Server`, attaches Socket.IO, seeds the simulator's order books into the
   realtime layer's snapshot cache, starts the simulator (if enabled), then listens.
6. Installs `SIGTERM`/`SIGINT` handlers that shut everything down in the order that matters:
   simulator timers first (stop generating work), then Socket.IO (`io.close()`), then the HTTP
   server (stop accepting new connections, drain in-flight ones), then the Mongo connection last.
   Getting this order wrong is what makes a container hang for its full termination grace period on
   `docker stop`.

Inside `createApp` (`src/app.js`), middleware order is fixed and load-bearing:

```
trust proxy → pino-http → helmet (strict CSP, no 'unsafe-inline') → urlencoded/json (10kb cap)
  → session → CSRF (must follow session — it reads/writes req.session.csrfSecret)
  → static (public/, then /vendor/pico and /vendor/uplot mounted straight from node_modules)
  → rate limiters on /login, /signup, /api/user
  → routes/pages.js, routes/auth.js, routes/api.js
  → 404 handler → error handler
```

Express 5 forwards a rejected promise from any `async` route handler straight to the error handler,
so every route in `src/routes/` uses plain `await` with no per-route `try/catch` for the unexpected
case; the error handler is the single place that decides HTML vs JSON and logs.

## Request flow (realtime)

```js
// src/server.js / src/realtime/io.js
app.use(sessionMiddleware);
io.engine.use(sessionMiddleware); // socket.io >= 4.6
io.use((socket, next) => {
  if (!socket.request.session?.userId) return next(new Error('unauthorized'));
  socket.data.userId = socket.request.session.userId;
  socket.data.username = socket.request.session.username;
  next();
});
```

`io.engine.use(sessionMiddleware)` runs the _exact same_ `express-session` middleware instance the
HTTP app uses, against the engine.io handshake request. That is the entire mechanism that lets an
HTTP login and a Socket.IO connection agree on who's talking — there is no cookie-parsing, no second
session store, no `connect.sid` handling of any kind in `src/realtime/`. A handshake with no
`session.userId` is rejected before `connection` ever fires.

Two consequences worth knowing before you touch this code:

- **The session is snapshotted onto `socket.data` at handshake time.** If the server destroys the
  session afterward (logout), an already-open socket does not notice on its own — nothing re-reads
  `socket.request.session` after the handshake. `POST /logout` (`src/routes/auth.js`) therefore
  calls `app.get('disconnectUser')(username)`, which `src/realtime/io.js` wires to force-close every
  socket the presence tracker has on file for that username.
- **`disconnect` is a reserved Socket.IO event name** (throws if you try to `emit` it, as of
  Socket.IO v3+). Server code only ever _listens_ for it (to update presence); the event told to
  clients when someone leaves is the custom `presence:leave`.

### Socket.IO events

All defined in `src/realtime/chat.js`, `market.js`, `presence.js`, `io.js`. This table reflects what
the server actually sends and expects today — treat it as the contract other work builds against.

| Event             | Direction                                                                     | Payload                                                    | Notes                                                                                                                                         |
| ----------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `presence:join`   | client → server                                                               | _(none)_                                                   | Sent once after connecting. Registers this socket under the session's username.                                                               |
| `presence:join`   | server → other clients                                                        | `{ username }`                                             | Broadcast only when this was the user's _first_ open socket — a second tab for the same user does not re-announce them.                       |
| `presence:list`   | server → client                                                               | `{ users: string[] }`                                      | Reply to the client's own `presence:join`, listing everyone currently present (sorted, de-duplicated by username).                            |
| `presence:leave`  | server → other clients                                                        | `{ username }`                                             | Broadcast only when the user's _last_ socket disconnected.                                                                                    |
| `chat:message`    | client → server                                                               | `{ text: string }`                                         | Server trims and caps it at 1000 characters; empty messages are dropped silently.                                                             |
| `chat:message`    | server → all clients (incl. sender)                                           | `{ username, text, at }`                                   | `username` comes from the session, never the client; `at` is `Date.now()`. Rendered with `textContent` client-side — never HTML-interpolated. |
| `market:request`  | client → server                                                               | _(none)_                                                   | Ask for a fresh full snapshot (e.g. a chart page that wasn't connected when the initial one went out).                                        |
| `market:snapshot` | server → client                                                               | `{ books: MarketPayload[] }`                               | Sent automatically right after a successful `connection`, and again on `market:request`. One entry per symbol the simulator tracks.           |
| `market:delta`    | server → **all** clients                                                      | `MarketPayload` (single, not wrapped)                      | Broadcast on **every** submitted order, not only on trades that occurred — the depth ladder can change with no trade.                         |
| `account:update`  | client → server                                                               | `{ email: string }`, optional ack callback                 | Updates the connected user's email (this is an update, not a request-to-resend — the name is a holdover from an earlier design).              |
| `account:updated` | server → client (ack, or emitted back to the same socket if no ack was given) | `{ ok: true, email }` or `{ ok: false, errors: string[] }` |                                                                                                                                               |

`MarketPayload` shape (`src/realtime/market.js#buildMarketPayload`):

```js
{
  stock: 'NOCK1',
  lastTrade: { price: 101.5, volume: 100 } | null,   // null if this submission produced no trade
  bids: [ { price: 101.25, volume: 200 }, ... ],      // always exactly 5 entries
  asks: [ { price: 101.75, volume: 150 }, ... ],      // always exactly 5 entries
}
```

- `price`/`volume` are always numbers, never strings — no more `Object.keys()`-derived string
  prices shifting things around.
- `bids`/`asks` are sorted best-first (highest bid, lowest ask) and **padded to exactly 5 entries**:
  a level past the real depth of the book is `{ price: null, volume: 0 }` rather than an array
  shorter than 5. This is a deliberate choice (`padLevels` in `market.js`) so the client can render
  a fixed-height ladder without special-casing a short book — it deliberately differs from an
  earlier draft of this contract that called for omitting empty levels outright; padding with an
  explicit `null` sentinel turned out easier for the frontend than a variable-length array, and
  `null` can never be confused with a real price the way `0` could.

## The `src/order-book/` extraction boundary

`src/order-book/{index,order-book,binary-heap}.js` is written to be lifted out of this repository
and published as its own package with no code changes, only a move. That guarantee is enforced, not
just documented: `eslint.config.js` has a `no-restricted-imports` rule scoped to
`src/order-book/**/*.js` that rejects two things:

- any import starting with `../` (no escaping the directory), and
- any import that isn't a relative path at all — which includes **every Node builtin** (`node:fs`,
  `node:crypto`, everything). This is easy to miss: it's not just "no npm dependencies", it's zero
  dependencies of any kind.

Run `npm run lint` after touching anything in that directory; a violation is a hard error, not a
warning.

The entire directory currently imports nothing but itself (`order-book.js` imports
`binary-heap.js`; `index.js` re-exports both). Everything outside the directory — currently just
`src/simulator/index.js`, plus the test files under `test/order-book/` — reaches it exclusively
through `src/order-book/index.js`'s three exports: `OrderBook`, `BUY`, `SELL`.

**What extracting it would actually take**, when that becomes a priority:

1. `git mv src/order-book <new-repo>/src` (or `mv` + a fresh `git init` if history should be
   squashed instead of carried) into its own repository.
2. Add a `package.json` there: `{"name": "@nockmarket/order-book", "type": "module", "exports":
"./index.js", "engines": {"node": ">=22"}}` — no `dependencies` field needed, because there are
   no dependencies.
3. Add whatever this repo's own tooling needs to run standalone: its own `eslint.config.js` (a
   trivial one — the boundary rule becomes moot once nothing else can reach it), its own copy of the
   3 files under `test/order-book/`, and a CI workflow that runs `node --test`.
4. `npm publish`.
5. Back in this repo: `npm install @nockmarket/order-book`, delete `src/order-book/`, and change the
   two import sites (`src/simulator/index.js` and the test files) from `../order-book/index.js` to
   the package name. Delete the now-unreachable `no-restricted-imports` rule from
   `eslint.config.js`.

No API redesign, no rewrite — the whole job is steps 1–5 above, which is the point of the boundary
existing at all.

### Why this shape of engine

`OrderBook#submit({side, price, volume})` returns `{trades, filledVolume, restingVolume,
restingPrice}` — the caller gets the trades an order produced directly from the call that produced
them. There is no second "read `.trades` off some other, possibly stale, object" step for a caller
to get wrong, which is what makes the old engine's most damaging bug (persisting the _previous_
order's trades, mislabeled with the _next_ order's side) structurally impossible to reintroduce
here rather than merely fixed once.

`OrderBook#snapshot()` returns plain, JSON-serializable data with no shared references back into the
live book — mutating the book after taking a snapshot cannot retroactively corrupt it. The
alternative the original code used (deep-cloning the price/volume map but copying the heap by
reference) is exactly the kind of partial-clone bug that's easy to write and easy to miss in review;
returning genuinely independent data sidesteps the whole class.

The limit price is re-checked against the _current_ best opposing price on every iteration of the
matching loop, not once before the loop starts — the difference between a `BUY 200 @ 50` that fills
`100 @ 49` and then correctly stops, versus one that keeps eating asks at 55, 60, 70 because the
original check at price ≥ 50 was only ever evaluated against the very first opposing price it saw.

## The quote-provider interface

`src/quotes/index.js` defines the shape every provider implements:

```js
createQuoteProvider(env) -> { name: string, async getQuotes(symbols: string[]) -> Map<string, Quote|null> }
// Quote: { symbol, price, currency: 'USD', asOf: Date, source, stale: boolean }
```

Two hard rules for any implementation, both load-bearing:

- **Every requested symbol is a key in the returned `Map`**, even if the value is `null`. Never
  return a shorter list.
- **Never throw, never reject.** A total upstream failure (network down, malformed response, rate
  limited) degrades to `null` — or a stale cached quote, marked `stale: true` — for the affected
  symbols. Nothing about a bad quote should ever be able to crash the process; the caller
  (`priceHoldings` in `src/routes/api.js`) does not wrap `getQuotes()` in a `try/catch`, on purpose,
  because the contract says it doesn't need to.

**Why a `Map` keyed by symbol, not an array in request order.** The provider this replaced returned
prices as an array built by pushing onto it only when a price was successfully resolved — skipping
unresolved tickers instead of leaving a gap. The caller then zipped that array against the
portfolio positionally (`portfolio[i]` ↔ `prices[i]`). The moment any single symbol failed to
resolve, every price after it in the array silently paired with the wrong ticker: one dead symbol
in the middle of a five-stock portfolio could show you someone else's price for the rest of your
holdings, with no error and no visible sign anything was wrong. A positional array is the wrong
data structure for "a lookup that can partially fail" — a map that always has an entry for every key
you asked about, present or `null`, makes that entire bug class impossible to express: there is no
"shift everything after the gap" operation available on a `Map`.

`src/quotes/fake.js` (the default, `QUOTE_PROVIDER=fake`) needs no network and no key: it derives a
deterministic price purely from `hash32(symbol) ^ QUOTE_SEED` and the current
`floor(now() / QUOTE_BUCKET_MS)` time bucket, via a jump-ahead mulberry32 walk (see the comment
block at the top of that file for why the jump-ahead matters — a naive "step the PRNG forward N
times" implementation would be O(hundreds of millions) per call against a real wall clock). Same
symbol, same time bucket, same price — always — which is what makes it safe to use as the default in
tests, in CI, and in `docker compose up`.

`src/quotes/stooq.js` is the one real network adapter, chosen specifically because Stooq needs no
API key, so the live-network code path stays exercisable by anyone who clones the repo instead of
being permanently untested behind a secret nobody has. It matches CSV rows back to symbols by the
CSV's own `symbol` column — never by row position — for the same C1-shaped reason described above,
retries once with jittered backoff, caches for 60 seconds, and funnels every failure mode (timeout,
non-200, unparsable CSV, a symbol Stooq doesn't recognize) into `null` or a stale cached quote.

**Adding a third provider** is a new file plus one line in the registry:

```js
// src/quotes/finnhub.js
export function createFinnhubProvider(env = process.env, deps = {}) {
  const apiKey = env.FINNHUB_API_KEY;
  return {
    name: 'finnhub',
    async getQuotes(symbols) {
      const result = new Map();
      if (!apiKey) {
        for (const s of symbols) result.set(s, null); // no key configured: fail open, never throw
        return result;
      }
      // fetch + AbortSignal.timeout, one retry, TTL cache, match by the response's own
      // symbol/ticker field (never by array position) — same shape as stooq.js above.
      return result;
    },
  };
}
```

```js
// src/quotes/index.js
import { createFinnhubProvider } from './finnhub.js';
registry.set('finnhub', (env) => createFinnhubProvider(env));
```

`QUOTE_PROVIDER=finnhub` then selects it. See the comment block at the top of `stooq.js` for the
fuller ~40-line sketch this is condensed from.

## Password hashing and the MD5 → scrypt migration

`src/auth/password.js` stores passwords as a self-describing PHC-style string —
`scrypt$N=16384,r=8,p=1$<base64 salt>$<base64 hash>` — rather than a bare hash, so the algorithm and
its cost parameters are explicit and versioned instead of guessed from the value's length. scrypt
was chosen over argon2/bcrypt specifically because both of those ship as native addons, and this
project's build has to work in `node:22-alpine` with **no compiler toolchain at all** (see the
Dockerfile) — `node:crypto`'s scrypt is pure JS-surface and built in. If that constraint is ever
relaxed, the documented upgrade path is argon2id as a second branch on the same PHC-string dispatch
(`isLegacy` / `verify` / `needsRehash`), with `hash()` switched over to emit the new format for
newly-created and newly-rehashed passwords while old scrypt rows keep verifying forever — the exact
same lazy-rehash pattern already used for the MD5 transition below.

This app ships with no seeded MD5 accounts (the demo user `scripts/seed.js` creates is scrypt from
the start), but the login path still supports them because the original 2014 book's schema stored
plain unsalted MD5, and a real deployment migrating existing users forward needs somewhere for that
data to go:

1. On login, `src/routes/auth.js#authenticate` first tries `verify()` against the stored value as a
   current-format scrypt string. That always fails cleanly (never throws) against an MD5 row, since
   it doesn't parse as the PHC format.
2. If that fails **and** `isLegacy(stored)` is true (32 lowercase hex characters) **and**
   `LEGACY_MD5_LOGIN` is not explicitly disabled, it retries with `verifyLegacy()` — a plain
   constant-time MD5 comparison.
3. A successful legacy verification immediately calls `users.updatePasswordHash()` with a freshly
   computed scrypt hash of the same plaintext, in the same request. The row is upgraded from that
   point on; the next login for that user takes the fast path in step 1.

**Why this has to be lazy, and cannot be a batch migration script:** MD5 is a one-way hash. There is
no operation that turns a stored MD5 digest back into the plaintext password, so there is no
possible script that reads the `users` collection and rewrites every row to scrypt — by the time any
such script runs, the only material it has to work with is already the thing it can't reverse. The
plaintext exists, briefly, in exactly one place: the login request from a user who still remembers
their password. That is the only opportunity to upgrade a given row, which is why the migration
lives inline in the login handler instead of in a script.

`LEGACY_MD5_LOGIN` (default `true`) is the cutoff switch. Flipping it to `false` does not touch any
data — it simply stops step 2 above from running, so any user whose row is still MD5 at that point
can no longer log in with their old password at all. There is no batch-migrate-then-flip sequence
available; the honest operational answer once you flip it off is "the remaining MD5 accounts must
reset their password," documented as such in `.env.example`.

## Target `src/` layout

```
src/
  server.js              entry; wires app + io + simulator, owns signals and shutdown
  app.js                 createApp({config, db, users, transactions, quotes, sessionMiddleware, logger}) -> app
  config.js              env parsing + validation, single source of truth (see README's env table)
  routes/                pages.js · auth.js · api.js
  realtime/              io.js · chat.js · market.js · presence.js
  simulator/             index.js (start/stop) · random-order.js (pure)
  quotes/                index.js · fake.js · stooq.js
  db/                    client.js · users.js · transactions.js
  auth/                  password.js · session.js · csrf.js
  order-book/            ← extractable, see above. index.js · order-book.js · binary-heap.js
```

## Database repository signatures

Two modules own all Mongo access; nothing else in the app talks to the driver directly. Both are
async, take/return plain objects, and never leak driver-specific shapes (`insertedId`, `ObjectId`
casing) past their own boundary.

```js
// src/db/users.js

/**
 * Create a new user. Rejects with DuplicateUserError (checking the unique
 * index on usernameLower, not a check-then-insert race) if the username is
 * already taken, case-insensitively.
 * @param {{username, email, passwordHash, passwordAlgo}} user
 * @returns {Promise<{_id: string, username, email, portfolio: object[]}>}
 */
export async function create(user) {}

/** @param {string} username - matched case-insensitively via usernameLower. */
export async function findByUsername(username) {}

export async function findById(id) {}

/** @returns {Promise<object|null>} the updated user, or null if not found. */
export async function updateEmail(id, email) {}

/**
 * Idempotent by symbol: increments existing volume rather than pushing a
 * duplicate portfolio entry for a stock already held.
 * @param {{stock: string, volume: number}} holding
 */
export async function addToPortfolio(id, holding) {}

/** @param {string} [passwordAlgo] - defaults to 'scrypt'. */
export async function updatePasswordHash(id, passwordHash, passwordAlgo) {}
```

```js
// src/db/transactions.js

/** Persist a submitted order, independent of whether it traded. */
export async function insertOrder(order) {}

/**
 * Persist the trade(s) a single order submission produced — always called
 * with the trades OrderBook#submit() actually returned for that order, never
 * re-derived from a separately-read book state afterward.
 */
export async function insertTrades(trades) {}

/**
 * @param {{stock: string, limit?: number}} query - stock filters to one
 *   ticker; limit bounds the result count, most recent first by the real
 *   stored `ts` (not reverse-engineered from an ObjectId hex prefix).
 */
export async function findTrades({ stock, limit }) {}
```

## Health check

`GET /healthz` → `200` always (even with Mongo down — the container is alive either way; the
distinction is in the body):

```js
{ status: 'ok', mongo: 'up' | 'down', uptime: 12.34 }
```

`uptime` is `process.uptime()` in seconds. Used by the Dockerfile `HEALTHCHECK` and by
`compose.yaml`'s app healthcheck.
