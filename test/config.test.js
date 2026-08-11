import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../src/config.js';

// Every test builds its own plain env object and passes it explicitly to
// `loadConfig` — never touching `process.env` — so these tests are safe
// to run in parallel with each other and with everything else in the
// suite (see README's "must run with no database and no network").

describe('loadConfig — SESSION_SECRET (S2)', () => {
  test('throws in production when SESSION_SECRET is unset', () => {
    assert.throws(
      () => loadConfig({ NODE_ENV: 'production', MONGODB_URI: 'mongodb://localhost/x' }),
      /SESSION_SECRET/
    );
  });

  test('throws in production when SESSION_SECRET is empty string', () => {
    assert.throws(
      () => loadConfig({ NODE_ENV: 'production', SESSION_SECRET: '   ' }),
      /SESSION_SECRET/
    );
  });

  test('does not silently default in production — message is actionable', () => {
    try {
      loadConfig({ NODE_ENV: 'production' });
      assert.fail('expected loadConfig to throw');
    } catch (err) {
      assert.match(err.message, /SESSION_SECRET/);
      assert.match(err.message, /required/i);
    }
  });

  test('generates an ephemeral secret in development when unset', () => {
    const config = loadConfig({ NODE_ENV: 'development' });
    assert.equal(typeof config.session.secret, 'string');
    assert.ok(config.session.secret.length > 0);
    assert.equal(config.session.generated, true);
  });

  test('two development loads with no secret produce different secrets', () => {
    const a = loadConfig({ NODE_ENV: 'development' });
    const b = loadConfig({ NODE_ENV: 'development' });
    assert.notEqual(a.session.secret, b.session.secret);
  });

  test('an explicit SESSION_SECRET is used as-is and not marked generated', () => {
    const config = loadConfig({ NODE_ENV: 'production', SESSION_SECRET: 'a-real-secret' });
    assert.equal(config.session.secret, 'a-real-secret');
    assert.equal(config.session.generated, false);
  });
});

describe('loadConfig — empty env / defaults', () => {
  test('an empty env produces a fully working development config', () => {
    const config = loadConfig({});
    assert.equal(config.nodeEnv, 'development');
    assert.equal(config.isProd, false);
    assert.equal(config.port, 3000);
    assert.equal(config.mongoUri, 'mongodb://localhost:27017/nockmarket');
    assert.equal(typeof config.session.secret, 'string');
    assert.equal(config.quotes.provider, 'fake');
    assert.equal(config.quotes.seed, 42);
    assert.equal(config.quotes.bucketMs, 5000);
    assert.equal(config.simulator.enabled, true);
    assert.deepEqual(config.simulator.symbols, ['NOCK1', 'NOCK2', 'NOCK3', 'NOCK4', 'NOCK5']);
    assert.equal(config.simulator.minMs, 500);
    assert.equal(config.simulator.maxMs, 3000);
    assert.equal(config.legacyMd5Login, true);
    assert.equal(config.trustProxy, false);
  });
});

describe('loadConfig — PORT', () => {
  test('non-numeric PORT throws', () => {
    assert.throws(() => loadConfig({ PORT: 'banana' }), /PORT/);
  });

  test('out-of-range PORT throws', () => {
    assert.throws(() => loadConfig({ PORT: '0' }), /PORT/);
    assert.throws(() => loadConfig({ PORT: '70000' }), /PORT/);
    assert.throws(() => loadConfig({ PORT: '-1' }), /PORT/);
  });

  test('valid PORT is coerced to a number', () => {
    const config = loadConfig({ PORT: '8080' });
    assert.equal(config.port, 8080);
    assert.equal(typeof config.port, 'number');
  });
});

describe('loadConfig — MONGODB_URI', () => {
  test('rejects a non-mongodb URI', () => {
    assert.throws(() => loadConfig({ MONGODB_URI: 'postgres://localhost/x' }), /MONGODB_URI/);
  });

  test('accepts mongodb+srv URIs', () => {
    const config = loadConfig({ MONGODB_URI: 'mongodb+srv://user:pass@cluster0/db' });
    assert.equal(config.mongoUri, 'mongodb+srv://user:pass@cluster0/db');
  });
});

describe('loadConfig — simulator numeric cross-field validation', () => {
  test('SIMULATOR_MIN_MS > SIMULATOR_MAX_MS throws', () => {
    assert.throws(
      () => loadConfig({ SIMULATOR_MIN_MS: '5000', SIMULATOR_MAX_MS: '1000' }),
      /SIMULATOR_MIN_MS.*SIMULATOR_MAX_MS/s
    );
  });

  test('equal min and max is allowed', () => {
    const config = loadConfig({ SIMULATOR_MIN_MS: '1000', SIMULATOR_MAX_MS: '1000' });
    assert.equal(config.simulator.minMs, 1000);
    assert.equal(config.simulator.maxMs, 1000);
  });

  test('non-positive SIMULATOR_MIN_MS throws', () => {
    assert.throws(() => loadConfig({ SIMULATOR_MIN_MS: '0' }), /SIMULATOR_MIN_MS/);
    assert.throws(() => loadConfig({ SIMULATOR_MIN_MS: '-5' }), /SIMULATOR_MIN_MS/);
  });

  test('non-integer simulator bounds throw without also triggering the cross-field error', () => {
    try {
      loadConfig({ SIMULATOR_MIN_MS: 'soon' });
      assert.fail('expected loadConfig to throw');
    } catch (err) {
      assert.match(err.message, /SIMULATOR_MIN_MS/);
      assert.doesNotMatch(err.message, /must be <=/);
    }
  });
});

describe('loadConfig — boolean parsing', () => {
  for (const [name, envKey, configPath] of [
    ['SIMULATOR_ENABLED', 'SIMULATOR_ENABLED', ['simulator', 'enabled']],
    ['LEGACY_MD5_LOGIN', 'LEGACY_MD5_LOGIN', ['legacyMd5Login']],
  ]) {
    test(`${name}: 'false' and '0' are false, 'true' and '1' are true`, () => {
      for (const truthy of ['true', '1', 'TRUE', '  true  ']) {
        const config = loadConfig({ [envKey]: truthy });
        const value = configPath.reduce((o, k) => o[k], config);
        assert.equal(value, true, `expected ${truthy} to parse true`);
      }
      for (const falsy of ['false', '0', 'FALSE', '  false  ']) {
        const config = loadConfig({ [envKey]: falsy });
        const value = configPath.reduce((o, k) => o[k], config);
        assert.equal(value, false, `expected ${falsy} to parse false`);
      }
    });

    test(`${name}: unset uses the documented default`, () => {
      const config = loadConfig({});
      const value = configPath.reduce((o, k) => o[k], config);
      // Documented defaults: SIMULATOR_ENABLED=true, LEGACY_MD5_LOGIN=true.
      assert.equal(value, true);
    });

    test(`${name}: garbage value throws rather than naively coercing`, () => {
      // Boolean('false') === true in plain JS — this guards against that
      // exact class of bug reaching env parsing.
      assert.throws(() => loadConfig({ [envKey]: 'yes' }), new RegExp(name));
    });
  }
});

describe('loadConfig — TRUST_PROXY', () => {
  test('defaults to false', () => {
    assert.equal(loadConfig({}).trustProxy, false);
  });

  test('parses boolean strings', () => {
    assert.equal(loadConfig({ TRUST_PROXY: 'true' }).trustProxy, true);
    assert.equal(loadConfig({ TRUST_PROXY: 'false' }).trustProxy, false);
  });

  test('parses a numeric hop count', () => {
    const config = loadConfig({ TRUST_PROXY: '2' });
    assert.equal(config.trustProxy, 2);
    assert.equal(typeof config.trustProxy, 'number');
  });

  test('passes through other string forms (e.g. loopback) for Express to interpret', () => {
    assert.equal(loadConfig({ TRUST_PROXY: 'loopback' }).trustProxy, 'loopback');
  });
});

describe('loadConfig — SIMULATOR_SYMBOLS', () => {
  test('trims whitespace, drops empty entries, dedupes, and uppercases', () => {
    const config = loadConfig({ SIMULATOR_SYMBOLS: ' nock1, NOCK1 ,nock2,, nock3 ' });
    assert.deepEqual(config.simulator.symbols, ['NOCK1', 'NOCK2', 'NOCK3']);
  });

  test('a single symbol works', () => {
    const config = loadConfig({ SIMULATOR_SYMBOLS: 'abc' });
    assert.deepEqual(config.simulator.symbols, ['ABC']);
  });

  test('all-empty input throws', () => {
    assert.throws(() => loadConfig({ SIMULATOR_SYMBOLS: ' , , ' }), /SIMULATOR_SYMBOLS/);
  });
});

describe('loadConfig — QUOTE_PROVIDER / QUOTE_SEED / QUOTE_BUCKET_MS', () => {
  test('defaults to fake with seed 42 and a 5000ms bucket', () => {
    const config = loadConfig({});
    assert.equal(config.quotes.provider, 'fake');
    assert.equal(config.quotes.seed, 42);
    assert.equal(config.quotes.bucketMs, 5000);
  });

  test('accepts stooq', () => {
    assert.equal(loadConfig({ QUOTE_PROVIDER: 'stooq' }).quotes.provider, 'stooq');
  });

  test('rejects an unknown provider', () => {
    assert.throws(() => loadConfig({ QUOTE_PROVIDER: 'yahoo' }), /QUOTE_PROVIDER/);
  });

  test('rejects a non-integer QUOTE_BUCKET_MS', () => {
    assert.throws(() => loadConfig({ QUOTE_BUCKET_MS: 'fast' }), /QUOTE_BUCKET_MS/);
  });
});

describe('loadConfig — NODE_ENV', () => {
  test('rejects an unrecognized NODE_ENV', () => {
    assert.throws(() => loadConfig({ NODE_ENV: 'staging' }), /NODE_ENV/);
  });

  test('test is a valid NODE_ENV and is not treated as production', () => {
    const config = loadConfig({ NODE_ENV: 'test' });
    assert.equal(config.nodeEnv, 'test');
    assert.equal(config.isProd, false);
  });
});

describe('loadConfig — multiple simultaneous failures', () => {
  test('reports every problem together in one error', () => {
    try {
      loadConfig({
        NODE_ENV: 'production',
        PORT: 'not-a-port',
        MONGODB_URI: 'not-a-uri',
        SIMULATOR_MIN_MS: '5000',
        SIMULATOR_MAX_MS: '1000',
        QUOTE_PROVIDER: 'bogus',
      });
      assert.fail('expected loadConfig to throw');
    } catch (err) {
      assert.match(err.message, /SESSION_SECRET/);
      assert.match(err.message, /PORT/);
      assert.match(err.message, /MONGODB_URI/);
      assert.match(err.message, /SIMULATOR_MIN_MS/);
      assert.match(err.message, /QUOTE_PROVIDER/);
      // 6 distinct problems: SESSION_SECRET, PORT, MONGODB_URI, the
      // min/max cross-field check, and QUOTE_PROVIDER.
      const bulletCount = (err.message.match(/^ {2}- /gm) || []).length;
      assert.ok(bulletCount >= 5, `expected at least 5 reported problems, got ${bulletCount}`);
    }
  });
});

describe('loadConfig — frozen output', () => {
  test('assigning a top-level property fails', () => {
    const config = loadConfig({});
    assert.throws(() => {
      config.port = 9999;
    }, TypeError);
    assert.equal(config.port, 3000);
  });

  test('assigning a nested property fails', () => {
    const config = loadConfig({});
    assert.throws(() => {
      config.simulator.enabled = false;
    }, TypeError);
    assert.equal(config.simulator.enabled, true);
  });

  test('the config object and its groups are frozen', () => {
    const config = loadConfig({});
    assert.ok(Object.isFrozen(config));
    assert.ok(Object.isFrozen(config.session));
    assert.ok(Object.isFrozen(config.quotes));
    assert.ok(Object.isFrozen(config.simulator));
    assert.ok(Object.isFrozen(config.simulator.symbols));
  });
});
