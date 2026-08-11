// Environment parsing, validation and defaulting — the single source of
// truth for every setting listed in the "Environment variables" table of
// the README's "Contract" section. That table is frozen; the names,
// types, defaults and required-ness implemented here must match it.
//
// Design:
//   - `loadConfig(env)` is a pure factory: it never reads or mutates
//     `process.env` itself, so tests can pass arbitrary env objects
//     without touching global state (parallel-test-safe).
//   - Every problem found is collected into one list and thrown together,
//     so a new environment reports everything wrong in a single run
//     instead of one error at a time.
//   - The returned config is deeply frozen. Nothing downstream — this
//     app has no legitimate reason to mutate config at runtime — can
//     accidentally (or "temporarily, just this once") change it.
//
// Closes defect S2 (hardcoded session secret in nockmarket.js): there is
// no default session secret anywhere in this file. Production with no
// `SESSION_SECRET` fails fast at startup; development generates a
// throwaway one per process with a loud warning. `docker compose up`
// supplies its own demo secret directly in compose.yaml (documented
// there as demo-only), so the production check below is never relaxed
// to accommodate it.

import crypto from 'node:crypto';

const NODE_ENVS = new Set(['development', 'production', 'test']);
const QUOTE_PROVIDERS = new Set(['fake', 'stooq']);
const MONGO_URI_PATTERN = /^mongodb(\+srv)?:\/\/.+/;

/**
 * Recursively freezes an object and every plain-object/array value it
 * contains, so nested groups (`session`, `quotes`, `simulator`) are just
 * as immutable as the top level.
 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze(value[key]);
  }
  return Object.freeze(value);
}

function isBlank(raw) {
  return raw === undefined || raw === null || String(raw).trim() === '';
}

function parseIntegerVar(raw, { name, defaultValue, min, max, errors }) {
  if (isBlank(raw)) return defaultValue;
  const trimmed = String(raw).trim();
  if (!/^[+-]?\d+$/.test(trimmed)) {
    errors.push(`${name} must be an integer, got ${JSON.stringify(raw)}`);
    return defaultValue;
  }
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n)) {
    errors.push(`${name} must be a safe integer, got ${JSON.stringify(raw)}`);
    return defaultValue;
  }
  if (min !== undefined && n < min) {
    errors.push(`${name} must be >= ${min}, got ${n}`);
    return defaultValue;
  }
  if (max !== undefined && n > max) {
    errors.push(`${name} must be <= ${max}, got ${n}`);
    return defaultValue;
  }
  return n;
}

function parseBooleanVar(raw, { name, defaultValue, errors }) {
  if (isBlank(raw)) return defaultValue;
  const trimmed = String(raw).trim().toLowerCase();
  if (trimmed === 'true' || trimmed === '1') return true;
  if (trimmed === 'false' || trimmed === '0') return false;
  errors.push(
    `${name} must be one of true/false/1/0 (case-insensitive), got ${JSON.stringify(raw)}`
  );
  return defaultValue;
}

function parseEnumVar(raw, { name, defaultValue, allowed, errors }) {
  if (isBlank(raw)) return defaultValue;
  const trimmed = String(raw).trim();
  if (!allowed.has(trimmed)) {
    errors.push(`${name} must be one of ${[...allowed].join(', ')}, got ${JSON.stringify(raw)}`);
    return defaultValue;
  }
  return trimmed;
}

function parseSymbolsVar(raw, { name, defaultValue, errors }) {
  const source = isBlank(raw) ? defaultValue : raw;
  const symbols = [
    ...new Set(
      String(source)
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter((s) => s.length > 0)
    ),
  ];
  if (symbols.length === 0) {
    errors.push(
      `${name} must contain at least one non-empty, comma-separated symbol, got ${JSON.stringify(raw)}`
    );
    return String(defaultValue)
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s.length > 0);
  }
  return symbols;
}

// Express's `trust proxy` setting accepts a boolean, a hop-count number,
// or a string (`'loopback'`, a specific IP/CIDR, or a comma-separated
// list of them). We coerce the obvious boolean/number spellings and pass
// anything else through verbatim so Express can interpret it itself.
function parseTrustProxyVar(raw, { defaultValue }) {
  if (isBlank(raw)) return defaultValue;
  const trimmed = String(raw).trim();
  const lower = trimmed.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function parseMongoUriVar(raw, { name, defaultValue, errors }) {
  const value = isBlank(raw) ? defaultValue : String(raw).trim();
  if (!MONGO_URI_PATTERN.test(value)) {
    errors.push(
      `${name} must be a mongodb:// or mongodb+srv:// connection URI, got ${JSON.stringify(raw)}`
    );
    return defaultValue;
  }
  return value;
}

// SESSION_SECRET is deliberately not handled by a generic parser: the
// production/development split *is* the defect fix (S2), so it gets its
// own function rather than being folded into a "string with default"
// helper that some future edit could quietly give a default value.
function resolveSessionSecret(raw, { isProd, errors }) {
  const trimmed = isBlank(raw) ? '' : String(raw).trim();
  if (trimmed) {
    return { secret: trimmed, generated: false };
  }
  if (isProd) {
    errors.push(
      'SESSION_SECRET is required in production and must not be empty. Set it to a long, ' +
        'random value (e.g. `openssl rand -hex 32`) in the environment or .env file. Refusing ' +
        'to start rather than fall back to a default or auto-generated secret in production.'
    );
    return { secret: undefined, generated: false };
  }
  const generated = crypto.randomBytes(32).toString('hex');
  console.warn(
    '[config] SESSION_SECRET is not set. Generated an ephemeral secret for this process only — ' +
      'all existing sessions will be invalidated on restart. Set SESSION_SECRET in your ' +
      'environment or .env file to avoid this. (This is development-only behavior; production ' +
      'fails fast instead.)'
  );
  return { secret: generated, generated: true };
}

/**
 * Parse, validate and default every environment variable in the frozen
 * README contract, returning a deeply frozen config object.
 *
 * @param {NodeJS.ProcessEnv} [env] - defaults to `process.env`; tests
 *   should pass their own plain object instead of mutating global state.
 * @returns {Readonly<object>}
 * @throws {Error} listing every validation failure found, if any.
 */
export function loadConfig(env = process.env) {
  const errors = [];

  const nodeEnv = parseEnumVar(env.NODE_ENV, {
    name: 'NODE_ENV',
    defaultValue: 'development',
    allowed: NODE_ENVS,
    errors,
  });
  const isProd = nodeEnv === 'production';

  const port = parseIntegerVar(env.PORT, {
    name: 'PORT',
    defaultValue: 3000,
    min: 1,
    max: 65535,
    errors,
  });

  const mongoUri = parseMongoUriVar(env.MONGODB_URI, {
    name: 'MONGODB_URI',
    defaultValue: 'mongodb://localhost:27017/nockmarket',
    errors,
  });

  const { secret: sessionSecret, generated: sessionSecretGenerated } = resolveSessionSecret(
    env.SESSION_SECRET,
    { isProd, errors }
  );

  const quoteProvider = parseEnumVar(env.QUOTE_PROVIDER, {
    name: 'QUOTE_PROVIDER',
    defaultValue: 'fake',
    allowed: QUOTE_PROVIDERS,
    errors,
  });
  const quoteSeed = parseIntegerVar(env.QUOTE_SEED, {
    name: 'QUOTE_SEED',
    defaultValue: 42,
    errors,
  });
  const quoteBucketMs = parseIntegerVar(env.QUOTE_BUCKET_MS, {
    name: 'QUOTE_BUCKET_MS',
    defaultValue: 5000,
    min: 1,
    errors,
  });

  const simulatorEnabled = parseBooleanVar(env.SIMULATOR_ENABLED, {
    name: 'SIMULATOR_ENABLED',
    defaultValue: true,
    errors,
  });
  const simulatorSymbols = parseSymbolsVar(env.SIMULATOR_SYMBOLS, {
    name: 'SIMULATOR_SYMBOLS',
    defaultValue: 'NOCK1,NOCK2,NOCK3,NOCK4,NOCK5',
    errors,
  });
  const simulatorMinMs = parseIntegerVar(env.SIMULATOR_MIN_MS, {
    name: 'SIMULATOR_MIN_MS',
    defaultValue: 500,
    min: 1,
    errors,
  });
  const simulatorMaxMs = parseIntegerVar(env.SIMULATOR_MAX_MS, {
    name: 'SIMULATOR_MAX_MS',
    defaultValue: 3000,
    min: 1,
    errors,
  });
  // Cross-field check: only meaningful once both parsed individually
  // without error (otherwise we'd be comparing a real value against a
  // fallback default, producing a confusing second error).
  if (
    !errors.some((e) => e.startsWith('SIMULATOR_MIN_MS')) &&
    !errors.some((e) => e.startsWith('SIMULATOR_MAX_MS')) &&
    simulatorMinMs > simulatorMaxMs
  ) {
    errors.push(
      `SIMULATOR_MIN_MS (${simulatorMinMs}) must be <= SIMULATOR_MAX_MS (${simulatorMaxMs})`
    );
  }

  const legacyMd5Login = parseBooleanVar(env.LEGACY_MD5_LOGIN, {
    name: 'LEGACY_MD5_LOGIN',
    defaultValue: true,
    errors,
  });

  const trustProxy = parseTrustProxyVar(env.TRUST_PROXY, { defaultValue: false });

  if (errors.length > 0) {
    throw new Error(
      `Invalid configuration (${errors.length} problem${errors.length === 1 ? '' : 's'}):\n` +
        errors.map((e) => `  - ${e}`).join('\n')
    );
  }

  return deepFreeze({
    port,
    nodeEnv,
    isProd,
    mongoUri,
    session: {
      secret: sessionSecret,
      generated: sessionSecretGenerated,
    },
    quotes: {
      provider: quoteProvider,
      seed: quoteSeed,
      bucketMs: quoteBucketMs,
    },
    simulator: {
      enabled: simulatorEnabled,
      symbols: simulatorSymbols,
      minMs: simulatorMinMs,
      maxMs: simulatorMaxMs,
    },
    trustProxy,
    legacyMd5Login,
  });
}

export default loadConfig();
