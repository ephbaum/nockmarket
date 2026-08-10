# Contributing

Thanks for poking at this. It's a teaching project (see `README.md`), so contributions that keep it
readable and well-tested are worth more here than contributions that add features.

## Setup

```sh
npm ci
cp .env.example .env
```

You'll need a MongoDB reachable at `MONGODB_URI` for anything beyond unit tests and lint — see the
README's [Quick start](README.md#quick-start) for the fastest way to get one (`docker compose up`,
or a standalone `docker run -p 27017:27017 mongo:7`).

## Running things

| What                      | Command                                               | Needs Mongo? | Needs network?                              |
| ------------------------- | ----------------------------------------------------- | ------------ | ------------------------------------------- |
| App, watching for changes | `npm run dev`                                         | Yes          | No (with the default `fake` quote provider) |
| Unit tests                | `npm test`                                            | No           | No                                          |
| Integration tests         | `npm run test:integration`                            | Yes          | No                                          |
| Lint                      | `npm run lint` (`npm run lint:fix` to auto-fix)       | No           | No                                          |
| Format check              | `npm run format:check` (`npm run format` to auto-fix) | No           | No                                          |

Before opening a PR, all four of `npm run lint`, `npm run format:check`, `npm test`, and (if you
touched anything that talks to Mongo) `npm run test:integration` should be clean — CI runs the same
four.

Unit tests must stay hermetic: no real database, no real network call, ever. Anything that needs
Mongo belongs in a `*.integration.test.js` file, which self-skips (`{ skip: !process.env.MONGODB_URI }`)
when no `MONGODB_URI` is set, so the plain `npm test` path never depends on it.

## Code style

- ES modules throughout (`"type": "module"` in `package.json`), `async`/`await`, no TypeScript.
- Formatting is Prettier's job, not yours — run `npm run format` rather than hand-wrapping lines.
  `eslint-config-prettier` is loaded last in `eslint.config.js` specifically so lint and format never
  fight each other.
- **`src/order-book/**` is a closed box.** It may not import anything outside its own directory —
  not a relative `../` escape, not a bare package specifier, not even a Node builtin like `node:fs`.
  This is enforced by a `no-restricted-imports` rule in `eslint.config.js`, not just a convention —
  `npm run lint` will fail if you break it. The reason is in `docs/ARCHITECTURE.md`: keeping that
  directory dependency-free is what makes it a `git mv` away from being its own published package.
  If you need something from outside in there, the dependency belongs in the caller
  (`src/simulator/index.js`), not in the engine.
- Quote providers, database repositories, and the order book all take their dependencies as
  constructor/factory arguments rather than importing a shared singleton — that's what lets tests
  drive them with fakes and in-process fixtures instead of a real Mongo or a real network call. New
  code in those areas should follow the same pattern.

## Adding a quote provider

See the README's [Quote providers](README.md#quote-providers) section and the comment block at the
top of `src/quotes/stooq.js` for a worked sketch. In short: implement `{ name, async
getQuotes(symbols) -> Map<symbol, Quote|null> }` in a new `src/quotes/your-provider.js`, register it
in the `registry` map in `src/quotes/index.js`, and give it a unit test that proves two things
independent of everything else: it never throws (stub the network call to fail and confirm you get
`null`s back, not an exception), and one unresolved symbol never shifts or drops any other symbol's
entry in the returned `Map`.

## Tests as documentation

A handful of tests in this codebase exist specifically to pin down a historical bug so it can't
silently come back — they're commented with what the old code did wrong. If you're changing
behavior near the order book, the quote providers, or presence/session handling, read the existing
test file first; there's a good chance the exact edge case you're worried about is already named and
asserted on.

## Commit and PR expectations

- Keep commits scoped — one logical change per commit, and a commit message that says _why_, not
  just _what changed_ (the diff already shows what changed).
- If a change touches `src/order-book/**`, run the fuzz test (`test/order-book/invariants.test.js`)
  locally even though `npm test` already includes it — it's the one most likely to catch a subtle
  matching-engine regression that a hand-written example test would miss.
- Don't add a dependency without a real reason. Part of what keeps `docker compose up` working with
  zero API keys is a deliberately short dependency list; a new runtime dependency should replace an
  existing one or close a real gap, not just be convenient.
