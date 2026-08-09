#Nockmarket
===
#### A (**No**)de.js Sto(**ck**) (**Market**) Web Application
---

Based on the application outlined in the **SitePoint Book Jump Start Node.js** by *Don Nguyen*.

---

###Huh?

I have made some modifications such as upgrading some of the packages to more current iterations as well as improving the overall look and feel of the app by making it more responsive. You can check out my version [here](http://fskirschbaum-nockmarket.herokuapp.com).

I picked this ebook up for free and decided to work my way through it. I am running a MacBook Pro Retina with OS X 10.9 Mavericks and ran into various issues with some of the information in the book being out a bit out of date since its publication in *2012*, an eternity by all rights and regards.

As I worked through it I decided to update my code as I went and when I was done I decided to improve it further to give me more learning opportunity along the way.

I figured there was a chance that others might encounter the same problems along their way as well and decided to dump everything here. Since I'd already `git push heroku master`'d it, it seemed like a trivial thing to also push it up to GitHub as well. 

---

###Verdict?

Overall I have to say that I enjoyed this project. I was already sold on Node.js before jumping into this but I did like the approachable way the book runs through code to help you dive into the wonderful world of Node.js. I would recommend this for anyone looking to try out node without a lot of barrier to entry, anyone that learns better by doing, and anyone who already has some experience developing in some capacity.

A word of warning, however, is that this book tackles a lot of different topics along the way and sometimes the author glosses a bit over things in the interest of keeping pace with producing a useful product. For example, Backbone.js makes an appearence in this text but there is almost *no* explanation of what you're really tackling by using that library. I think the reasons are obvious when you bear in mind that this is a book about getting a jump start on Node.js and not a tome on full life-cycle development of a web application for both front- and back-end. He does take the time, however, to point out resources that will help you get a deeper understanding of pretty much everything along the way giving you the opportunity to dive deeper if you want.

---

###License Information(?)

I do not own any of this code and to be honest I didn't get any indication from the book that there were any license restrictions, however, I assume it's best not to use this code as-is on your production project. So, if you have questions about the license, use, and copyright of the code contained herein, you're probably better off asking the book's author.

---

###Some Links(?)

* [Jump Start Node.js](http://www.sitepoint.com/store/jump-start-node-js/)
* [Original Project Code](https://github.com/spbooks/NODEJS1)
* [Demo for my version](http://fskirschbaum-nockmarket.herokuapp.com)

---

####What's next?

I plan to poke at this this a bit more going forward. Mainly, I want to implement a bit more account management, toy with updating the password security, maybe a logout button, perhaps do some more with the public stocks, improve the filtering and anything else that I feel like playing around with.

Maybe...

---

#####Heaps of Praise? Burning Hatred?

If you like what I've done or feel that I am someone *wrong* on the **internet** and need to be put in my place, you can reach out to me here or on [twitter](https://twitter.com/fskirschbaum). I make no promises on how I'll respond, though, but I'm usually a relatively pleasant person.

To be clear, though, I make no promises that what I've done here is perfect or could not have been achieved better. I'm sure there are bound to be problems with my code. If you see something you think I could have done better, feel free to let me know (in a constructive way) as I'm always looking for feedback to help me learn and grow as a developer.

---

## Contract

This project is being modernized to Node 22 + ES modules (Express 5, MongoDB driver 7,
Socket.IO 4). This section is the **frozen interface** that all of the modernization work builds
against — npm scripts, environment variables, Socket.IO event names, the market data-wire shape,
and the database repository signatures. It is written and locked before the corresponding
implementation exists, specifically so that independent pieces of work can be built against it in
parallel without colliding. (P3b will eventually replace the rest of this README with a proper
quickstart/architecture doc; this section stays put until then.)

### npm scripts

| Script             | Command                                                | Notes                                                                                                                     |
| ------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `start`            | `node src/server.js`                                   | Production entry point.                                                                                                   |
| `dev`              | `node --watch --env-file-if-exists=.env src/server.js` | Auto-restarts on change; loads `.env` if present, no error if it's not.                                                   |
| `test`             | `node --test --experimental-test-coverage test/`       | Unit tests. **Must run with no database and no network.**                                                                 |
| `test:integration` | `node --test test/**/*.integration.test.js`            | Needs a reachable `MONGODB_URI`; individual test files self-skip (`{ skip: !process.env.MONGODB_URI }`) when it's absent. |
| `lint`             | `eslint .`                                             | Flat config, see `eslint.config.js`.                                                                                      |
| `lint:fix`         | `eslint . --fix`                                       |                                                                                                                           |
| `format`           | `prettier --write .`                                   |                                                                                                                           |
| `format:check`     | `prettier --check .`                                   | CI gate; nothing merges unformatted.                                                                                      |

### Environment variables

Parsed and validated in one place: `src/config.js`. Copy `.env.example` to `.env` — every default
below is chosen so that `cp .env.example .env && npm run dev` (or `docker compose up`, which
doesn't even need a `.env` file) works with zero edits.

| Var                 | Type                                    | Default                                | Required?                                                                                                                                                                                                                                                                              |
| ------------------- | --------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`              | integer                                 | `3000`                                 | No                                                                                                                                                                                                                                                                                     |
| `NODE_ENV`          | `development` \| `production` \| `test` | `development`                          | No                                                                                                                                                                                                                                                                                     |
| `MONGODB_URI`       | string (mongodb connection URI)         | `mongodb://localhost:27017/nockmarket` | No                                                                                                                                                                                                                                                                                     |
| `SESSION_SECRET`    | string                                  | none                                   | **Yes, in production** — the app fails fast at startup if unset. In `development`, an ephemeral secret is generated at startup with a loud warning logged (sessions won't survive a restart) if left unset.                                                                            |
| `QUOTE_PROVIDER`    | `fake` \| `stooq`                       | `fake`                                 | No                                                                                                                                                                                                                                                                                     |
| `QUOTE_SEED`        | integer                                 | `42`                                   | No — only consumed by the `fake` provider.                                                                                                                                                                                                                                             |
| `QUOTE_BUCKET_MS`   | integer (milliseconds)                  | `5000`                                 | No — only consumed by the `fake` provider.                                                                                                                                                                                                                                             |
| `SIMULATOR_ENABLED` | boolean                                 | `true`                                 | No                                                                                                                                                                                                                                                                                     |
| `SIMULATOR_SYMBOLS` | comma-separated string                  | `NOCK1,NOCK2,NOCK3,NOCK4,NOCK5`        | No                                                                                                                                                                                                                                                                                     |
| `SIMULATOR_MIN_MS`  | integer (milliseconds)                  | `500`                                  | No                                                                                                                                                                                                                                                                                     |
| `SIMULATOR_MAX_MS`  | integer (milliseconds)                  | `3000`                                 | No                                                                                                                                                                                                                                                                                     |
| `LEGACY_MD5_LOGIN`  | boolean                                 | `true`                                 | No — the cutoff switch for accepting legacy unsalted-MD5 password hashes at login (upgraded to scrypt in place on successful verification). Once flipped to `false`, any remaining MD5 accounts must reset their password — there is no batch migration, because MD5 isn't reversible. |
| `TRUST_PROXY`       | boolean or integer (hop count)          | `false`                                | No — set truthy only when actually behind a reverse proxy, so `secure` cookies and rate limiting see the real client.                                                                                                                                                                  |

### Socket.IO events

| Event             | Direction        | Payload                                                                                            |
| ----------------- | ---------------- | -------------------------------------------------------------------------------------------------- |
| `chat:message`    | client ↔ server  | `{ username, message, ts }`                                                                        |
| `presence:join`   | server → clients | `{ username }`                                                                                     |
| `presence:leave`  | server → clients | `{ username }`                                                                                     |
| `market:snapshot` | server → client  | Full order-book state for a stock, sent on (re)subscribe. Shape: see "Market payload shape" below. |
| `market:delta`    | server → clients | Same shape as `market:snapshot`, broadcast on every order (not only on trades).                    |
| `account:update`  | client → server  | Client requests its own account/portfolio be re-sent.                                              |
| `account:updated` | server → client  | Updated account/portfolio state.                                                                   |

> **Never use `disconnect` as a custom event name.** It is a reserved event in Socket.IO v3+
> (`socket.io`/`socket.emit('disconnect', ...)` throws at runtime). This bit the pre-modernization
> code (`nocklib.js:91`) and must not recur — search the defect register for `R3` for the full
> history.

### Market payload shape

```js
{
  stock: 'NOCK1',
  lastTrade: { price: 101.5, volume: 100 },
  bids: [ { price: 101.25, volume: 200 }, { price: 101.0, volume: 50 } ],
  asks: [ { price: 101.75, volume: 150 }, { price: 102.0, volume: 300 } ],
}
```

- `price` and `volume` are always **numbers** (never strings) — the legacy payload's
  `Object.keys()`-derived string prices are gone.
- `bids` and `asks` are arrays, **sorted best-first** (highest bid first, lowest ask first), and
  contain only real levels — no phantom entries for empty levels, no reliance on integer-key
  object property ordering.
- `lastTrade` is `null` if the stock has not traded yet this session.

### Database repository signatures

Two repository modules own all Mongo access; nothing else in the app talks to the driver
directly. Both are async, take/return plain objects, and never leak driver-specific shapes
(`insertedId`, `ObjectId` casing, etc.) past their own boundary.

```js
// src/db/users.js

/**
 * Create a new user. Rejects with `DuplicateUserError` (checking the
 * unique index on `usernameLower`, not a check-then-insert race) if the
 * username is already taken, case-insensitively.
 * @param {{ username: string, email: string, passwordHash: string, passwordAlgo: string }} user
 * @returns {Promise<{ _id: string, username: string, email: string, portfolio: object[] }>}
 */
export async function create(user) {}

/**
 * @param {string} username - matched case-insensitively via `usernameLower`.
 * @returns {Promise<object|null>}
 */
export async function findByUsername(username) {}

/**
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export async function findById(id) {}

/**
 * @param {string} id
 * @param {string} email
 * @returns {Promise<object|null>} the updated user document, or null if not found.
 */
export async function updateEmail(id, email) {}

/**
 * @param {string} id
 * @param {{ stock: string, volume: number }} holding
 * @returns {Promise<object|null>} the updated user document, or null if not found.
 */
export async function addToPortfolio(id, holding) {}

/**
 * @param {string} id
 * @param {string} passwordHash
 * @param {string} [passwordAlgo] - defaults to the current scheme (scrypt).
 * @returns {Promise<object|null>} the updated user document, or null if not found.
 */
export async function updatePasswordHash(id, passwordHash, passwordAlgo) {}
```

```js
// src/db/transactions.js

/**
 * Persist a submitted order (independent of whether it traded).
 * @param {{ stock: string, side: 'buy'|'sell', price: number, volume: number, ts: Date }} order
 * @returns {Promise<object>} the stored order document, including `_id`.
 */
export async function insertOrder(order) {}

/**
 * Persist the trade(s) a single order submission produced. Called with
 * the trades `OrderBook#submit()` actually returned — never re-derived
 * from a separately-read book state (that mismatch was defect E2).
 * @param {Array<{ stock: string, price: number, volume: number, ts: Date }>} trades
 * @returns {Promise<object[]>} the stored trade documents, including `_id`.
 */
export async function insertTrades(trades) {}

/**
 * @param {{ stock: string, limit?: number }} query - `stock` filters to one
 *   ticker (fixes the old code merging every ticker into one series);
 *   `limit` bounds the result count, most recent first, ordered by the
 *   real stored `ts` (not reverse-engineered from an ObjectId hex prefix).
 * @returns {Promise<object[]>}
 */
export async function findTrades({ stock, limit }) {}
```

### Health check

`GET /healthz` → `200` with JSON:

```js
{ status: 'ok' | 'degraded', mongo: 'up' | 'down', uptime: 12.34 }
```

`uptime` is process uptime in seconds (`process.uptime()`). Used by the Dockerfile
`HEALTHCHECK` and by `compose.yaml`'s app healthcheck.

### Target `src/` layout

```
src/
  server.js              entry; wires app + io + simulator, owns signals and shutdown
  app.js                 createApp({config, db, quotes}) -> app   (exported for supertest)
  config.js              env parsing + validation, single source of truth
  routes/                pages.js · auth.js · api.js
  realtime/              io.js · chat.js · market.js · presence.js
  simulator/             index.js (start/stop) · random-order.js (pure)
  quotes/                index.js · fake.js · stooq.js
  db/                    client.js · users.js · transactions.js
  auth/                  password.js · session.js
  order-book/            ← extractable. index.js · order-book.js · binary-heap.js
```

`src/order-book/**` is enforced (via an ESLint `no-restricted-imports` rule, see
`eslint.config.js`) to import nothing outside its own directory — no relative escapes, no bare
package specifiers. Everything else reaches it only through `src/order-book/index.js`. That
constraint is what keeps the matching engine a `git mv` + a `package.json` away from being
published as a standalone package later, rather than a rewrite.
