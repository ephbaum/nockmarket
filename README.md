# Nockmarket

A simulated stock exchange (limit order book + a handful of fake tickers) bolted onto a portfolio
web app — sign up, watch fake stocks tick, buy some, chat with whoever else is connected. It began
as a walkthrough of the SitePoint book *Jump Start Node.js* by Don Nguyen, written in 2014 against
Node 0.8. This repository is a from-scratch modernization of that project onto Node 22 + ES modules,
with the original defects fixed rather than carried forward. See `docs/ARCHITECTURE.md` for how it's
built and `NOTICE` for the full history and attribution.

**What this is not:** a real trading system, an example of production security hardening beyond
what's noted below, or a maintained product. It's a teaching artifact — read the code, break it,
learn from it. See [Known limitations](#known-limitations-this-is-a-teaching-app).

> **The old Heroku demo is gone.** Earlier versions of this README linked a live demo at
> `fskirschbaum-nockmarket.herokuapp.com`. Heroku retired free dynos in November 2022, and that demo
> has been dead since. Don't click it — run it yourself instead, which takes about as long either
> way (see below).

## Quick start

You need Node 22+ either way. Pick one:

### Docker (zero setup, zero API keys)

```sh
git clone <this-repo>
cd nockmarket
docker compose up
```

Wait for both services to report healthy, then open **http://localhost:3000**. No `.env` file, no
API key, no separately-installed MongoDB — `compose.yaml` runs Mongo alongside the app and supplies
a demo session secret for you. Sign up on the site directly (a form, top of the page), or see
[Demo data](#demo-data) below to script an account instead.

Stop it with `docker compose down` (add `-v` to also drop the Mongo volume).

### Plain Node

```sh
npm ci
cp .env.example .env    # every default already works; edit only if you want to change something
npm run dev
```

`npm run dev` needs a MongoDB it can reach at `MONGODB_URI` (default
`mongodb://localhost:27017/nockmarket`) — the app connects to it before it starts listening, and
without one reachable it will sit there for up to ~30 seconds and then fail rather than exit
instantly. If you don't already have a `mongod` running locally, the fastest way to get one is:

```sh
docker run -d -p 27017:27017 --name nockmarket-mongo mongo:7
```

Once it's up, open **http://localhost:3000**. `npm run dev` auto-restarts on file changes
(`node --watch`).

## Demo data

```sh
node scripts/seed.js
```

Creates one demo user (`demo` / `demo-password-123` by default — override with the `SEED_USERNAME`,
`SEED_EMAIL`, `SEED_PASSWORD` env vars) using the exact same repository and password-hashing code
the app itself uses, so it can never drift from what a real signup produces. It reads `MONGODB_URI`
the same way the app does, and is safe to run more than once (a second run detects the existing
account and does nothing, rather than failing on the unique username index).

This is **not** currently wired up to run inside the Docker container — `Dockerfile` doesn't copy
`scripts/` into the image, and `compose.yaml` doesn't publish Mongo's port to the host, so there's
no path from a host shell to the compose stack's database today. For the `docker compose up`
workflow, just sign up through the web UI; for the plain-Node workflow above, `node scripts/seed.js`
works as described.

## Environment variables

Parsed and validated in one place: `src/config.js`. This table matches it exactly — if the two ever
disagree, `src/config.js` is the one that's actually running. `cp .env.example .env` and every
default below applies with zero edits; `docker compose up` supplies its own values and needs no
`.env` file at all.

| Var | Type | Default | Required? |
|---|---|---|---|
| `PORT` | integer | `3000` | No |
| `NODE_ENV` | `development` \| `production` \| `test` | `development` | No |
| `MONGODB_URI` | string (`mongodb://` or `mongodb+srv://` URI) | `mongodb://localhost:27017/nockmarket` | No |
| `SESSION_SECRET` | string | none | **Yes, in production** — the app refuses to start rather than fall back to a default. In `development`, an ephemeral secret is generated at startup with a loud warning (sessions won't survive a restart) if left unset. |
| `QUOTE_PROVIDER` | `fake` \| `stooq` | `fake` | No |
| `QUOTE_SEED` | integer | `42` | No — only consumed by the `fake` provider. |
| `QUOTE_BUCKET_MS` | integer (ms) | `5000` | No — only consumed by the `fake` provider. |
| `SIMULATOR_ENABLED` | boolean | `true` | No |
| `SIMULATOR_SYMBOLS` | comma-separated string | `NOCK1,NOCK2,NOCK3,NOCK4,NOCK5` | No |
| `SIMULATOR_MIN_MS` | integer (ms) | `500` | No — must be `<= SIMULATOR_MAX_MS`. |
| `SIMULATOR_MAX_MS` | integer (ms) | `3000` | No |
| `LEGACY_MD5_LOGIN` | boolean | `true` | No — accepts legacy unsalted-MD5 password hashes at login, upgrading them to scrypt in place on success. See [Password migration](docs/ARCHITECTURE.md#password-hashing-and-the-md5--scrypt-migration) for why this can only ever be lazy, never a batch job. |
| `TRUST_PROXY` | boolean or integer (hop count) | `false` | No — set truthy only when actually behind a reverse proxy, so `secure` cookies and client-IP-based rate limiting see the real client. |

Booleans accept `true`/`false`/`1`/`0`, case-insensitively. Anything that fails to parse (a
non-integer `PORT`, an out-of-range `SIMULATOR_MIN_MS`, an unknown `QUOTE_PROVIDER`, …) is collected
and reported together in one error at startup, not one crash at a time.

## Quote providers

Stock prices come from a small pluggable interface (`src/quotes/index.js`); which one is active is
just `QUOTE_PROVIDER`. See `docs/ARCHITECTURE.md` for the interface itself and why it's keyed by
symbol rather than by array position.

| Provider | Needs a key? | Needs network? | Behavior |
|---|---|---|---|
| `fake` (default) | No | No | Deterministic per-symbol random walk seeded from `QUOTE_SEED`; the same symbol at the same `QUOTE_BUCKET_MS`-sized time bucket always returns the same price. This is what makes `docker compose up` and the test suite work fully offline. |
| `stooq` | No | Yes (stooq.com) | Real (delayed) quotes over plain HTTPS. Chosen specifically because it needs no API key, so this code path is exercisable by anyone who clones the repo — not dead code behind a secret nobody has. Failures (timeout, bad response, an unresolved symbol) degrade to a stale cached quote or `null`, never a crash. |

**Adding a third provider** is one new file plus one line: implement `{ name, async
getQuotes(symbols) -> Map<symbol, Quote|null> }` in `src/quotes/your-provider.js` (never throw,
never omit a requested symbol from the returned `Map`, never derive one symbol's value from
another's position), then register it in `src/quotes/index.js`'s `registry` map. A worked ~40-line
sketch for a keyed provider (Finnhub) is in the comment block at the top of `src/quotes/stooq.js`.

## npm scripts

| Script | Command | Notes |
|---|---|---|
| `start` | `node src/server.js` | Production entry point. |
| `dev` | `node --watch --env-file-if-exists=.env src/server.js` | Auto-restarts on change; loads `.env` if present, no error if it's not. |
| `test` | `node --test --experimental-test-coverage "test/**/*.test.js"` | Unit tests. Runs with no database and no network. |
| `test:integration` | `node --test "test/**/*.integration.test.js"` | Needs a reachable `MONGODB_URI`; individual test files self-skip when it's absent. |
| `lint` | `eslint .` | Flat config, see `eslint.config.js`. |
| `lint:fix` | `eslint . --fix` | |
| `format` | `prettier --write .` | |
| `format:check` | `prettier --check .` | CI gate; nothing merges unformatted. |

There is no `npm run seed` — `package.json`'s dependency and script set was frozen early in this
project's modernization so parallel work couldn't collide on it, so the seed script (added after
that point) is run directly: `node scripts/seed.js` (see [Demo data](#demo-data)).

## Known limitations (this is a teaching app)

- **Fake exchange.** The five `NOCK*` tickers and their prices are entirely synthetic; nothing here
  reflects a real market, and `stooq`, when enabled, only ever *reads* real quotes — you cannot
  trade anything real through this app under any configuration.
- **No password reset flow.** If `LEGACY_MD5_LOGIN` is turned off and an account is still on MD5,
  or if anyone simply forgets a password, there is no self-service recovery — see
  `docs/ARCHITECTURE.md` for why a legacy password can't be migrated any other way.
- **Single-process only.** Sessions live in Mongo (via `connect-mongo`) so they survive a restart,
  but the order book and simulator state are in-memory per process — running more than one app
  replica gives each one its own, independent, disagreeing order book.
- **Rate limiting is per-process and in-memory**, not shared across replicas, and not intended to
  withstand a determined attacker — it exists to close the obvious brute-force and enumeration
  holes in the original code, not to be a production-grade defense.
- **The chat room is one global room.** Everyone connected sees every message; there's no concept of
  channels or private messages.
- **This has not received a professional security review.** CSRF, rate limiting, a strict CSP,
  salted+stretched password hashing, and session fixation protection are all in place (see
  `docs/ARCHITECTURE.md`), closing the specific defects the original 2014 code had — that is a
  different claim from "safe to expose to the public internet with real user data."

## Contributing

See `CONTRIBUTING.md`.

## History and attribution

This project began in 2014 as the author's walkthrough of *Jump Start Node.js* by Don Nguyen
(SitePoint), picked up as a free ebook and worked through on a Node version the book itself was
already slightly out of date for. The original author's account, lightly condensed from the
pre-modernization README:

> I have made some modifications such as upgrading some of the packages to more current iterations
> as well as improving the overall look and feel of the app by making it more responsive... As I
> worked through it I decided to update my code as I went, and when I was done I decided to improve
> it further to give me more learning opportunity along the way.
>
> Overall I have to say that I enjoyed this project. I was already sold on Node.js before jumping
> into this but I did like the approachable way the book runs through code to help you dive into
> Node.js. I would recommend this for anyone looking to try out Node without a lot of barrier to
> entry, anyone that learns better by doing, and anyone who already has some experience developing
> in some capacity. A word of warning, however: this book tackles a lot of different topics along
> the way and sometimes glosses over things in the interest of keeping pace — Backbone.js makes an
> appearance with almost no explanation of what you're really taking on by using it. That's a
> reasonable tradeoff for a book about getting a jump start on Node, not a tome on full life-cycle
> web development, and the author does point out further resources along the way.

The repository sat untouched from January 2015 until this modernization: current supported
versions of everything (Node 22, Express 5, MongoDB driver 7, Socket.IO 4), the matching engine's
correctness defects fixed, unsalted MD5 replaced with scrypt, and a Docker Compose setup that runs
with zero API keys and zero external network by default. See `docs/ARCHITECTURE.md` for what
changed and why.

* [Jump Start Node.js](https://www.sitepoint.com/store/jump-start-node-js/) — the book this started from.
* [Original companion code](https://github.com/spbooks/NODEJS1) — SitePoint's own repository for the book.

No license was ever published by SitePoint or the book's author for the companion code this project
began from. This repository's `LICENSE` (MIT) covers only the modifications layered on top of that
starting point — see `NOTICE` for the full explanation.
