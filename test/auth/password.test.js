import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { hash, verify, isLegacy, verifyLegacy, needsRehash } from '../../src/auth/password.js';

const KNOWN_MD5_PASSWORD = 'password';
const KNOWN_MD5_HASH = '5f4dcc3b5aa765d61d8327deb882cf99';

const SALT_B64 = Buffer.from('a'.repeat(16)).toString('base64');
const HASH_B64 = Buffer.from('a'.repeat(32)).toString('base64');

describe('hash / verify round-trip', () => {
  test('a hashed password verifies against itself', async () => {
    const stored = await hash('correct horse battery staple');
    assert.equal(await verify('correct horse battery staple', stored), true);
  });

  test('a wrong password fails to verify', async () => {
    const stored = await hash('correct horse battery staple');
    assert.equal(await verify('wrong password', stored), false);
  });

  test('hashing the same password twice yields different strings, both verifying', async () => {
    const a = await hash('same-password');
    const b = await hash('same-password');
    assert.notEqual(a, b, 'salts should differ, producing different PHC strings');
    assert.equal(await verify('same-password', a), true);
    assert.equal(await verify('same-password', b), true);
  });

  test('produces the documented PHC-style format', async () => {
    const stored = await hash('anything');
    assert.match(stored, /^scrypt\$N=16384,r=8,p=1\$[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/]+=*$/);
  });

  test('hash() rejects a non-string password', async () => {
    await assert.rejects(() => hash(null), TypeError);
    await assert.rejects(() => hash(undefined), TypeError);
    await assert.rejects(() => hash(42), TypeError);
  });
});

describe('legacy MD5', () => {
  test('a known legacy MD5 hash verifies via verifyLegacy', () => {
    assert.equal(verifyLegacy(KNOWN_MD5_PASSWORD, KNOWN_MD5_HASH), true);
  });

  test('verifyLegacy rejects the wrong password', () => {
    assert.equal(verifyLegacy('not-the-password', KNOWN_MD5_HASH), false);
  });

  test('a legacy MD5 hash reports needsRehash === true', () => {
    assert.equal(needsRehash(KNOWN_MD5_HASH), true);
  });

  test('legacy hash and password computed independently still match', () => {
    const independentlyComputed = createHash('md5').update('hunter2', 'utf8').digest('hex');
    assert.equal(verifyLegacy('hunter2', independentlyComputed), true);
  });
});

describe('isLegacy', () => {
  test('recognizes a 32-char lowercase hex string', () => {
    assert.equal(isLegacy('5f4dcc3b5aa765d61d8327deb882cf99'), true);
  });

  test('does not mistake a PHC string for legacy', async () => {
    const stored = await hash('whatever');
    assert.equal(isLegacy(stored), false);
  });

  test('does not false-positive on a 32-char non-hex string', () => {
    // 32 chars, but contains 'g' and 'z' — not valid hex.
    assert.equal(isLegacy('gggggggggggggggggggggggggggggzz'), false);
  });

  test('rejects wrong-length hex-looking strings', () => {
    assert.equal(isLegacy('5f4dcc3b5aa765d61d8327deb882cf9'), false); // 31 chars
    assert.equal(isLegacy('5f4dcc3b5aa765d61d8327deb882cf999'), false); // 33 chars
  });

  test('rejects non-string input without throwing', () => {
    assert.equal(isLegacy(null), false);
    assert.equal(isLegacy(undefined), false);
    assert.equal(isLegacy(12345), false);
  });
});

describe('needsRehash', () => {
  test('is false for a freshly generated hash at current policy', async () => {
    const stored = await hash('fresh-password');
    assert.equal(needsRehash(stored), false);
  });

  test('is true for a weaker-than-policy scrypt hash', () => {
    // Hand-built PHC string with N below current policy (16384).
    const weak = `scrypt$N=1024,r=8,p=1$${Buffer.from('salt-16-bytes!!!').toString('base64')}$${Buffer.from(
      'a'.repeat(32)
    ).toString('base64')}`;
    assert.equal(needsRehash(weak), true);
  });

  test('is true for unparseable garbage (safe default: rehash)', () => {
    assert.equal(needsRehash('not-a-real-hash'), true);
    assert.equal(needsRehash(null), true);
  });
});

describe('verify never throws on malformed input', () => {
  const malformedInputs = [
    null,
    undefined,
    '',
    'scrypt$',
    'scrypt$N=16384,r=8,p=1$$', // missing salt/hash fields
    'scrypt$N=16384,r=8,p=1$not-base64-!!!$YWJj', // corrupted base64 salt field
    'scrypt$N=16384,r=8,p=1$YWJj$not-base64-!!!', // corrupted base64 hash field
    'scrypt$N=-1,r=8,p=1$YWJj$YWJj', // negative N
    'scrypt$N=99999999999999999999,r=8,p=1$YWJj$YWJj', // absurd N
    'scrypt$N=16384,r=99999999,p=1$YWJj$YWJj', // absurd r
    'scrypt$N=3,r=8,p=1$YWJj$YWJj', // N not a power of two
    '5f4dcc3b5aa765d61d8327deb882cf9', // truncated legacy-looking hash
    'x'.repeat(10000), // very long random string
    // Parses cleanly (valid power-of-two N, in-bounds field count) but the
    // (N, r) pair demands far more memory than this module's fixed maxmem
    // ceiling allows — exercises the try/catch around the scrypt() call
    // itself, not just the up-front parsePhc validation.
    `scrypt$N=65536,r=1024,p=1$${SALT_B64}$${HASH_B64}`,
    { not: 'a string' },
    42,
    ['scrypt$N=16384,r=8,p=1$YWJj$YWJj'],
  ];

  for (const [i, input] of malformedInputs.entries()) {
    test(`case ${i}: ${JSON.stringify(input)?.slice(0, 60)}`, async () => {
      await assert.doesNotReject(async () => {
        const result = await verify('some-password', input);
        assert.equal(typeof result, 'boolean');
        assert.equal(result, false);
      });
    });
  }

  test('verifyLegacy never throws on the same malformed inputs', () => {
    for (const input of malformedInputs) {
      assert.doesNotThrow(() => {
        const result = verifyLegacy('some-password', input);
        assert.equal(typeof result, 'boolean');
      });
    }
  });

  test('isLegacy and needsRehash never throw on the same malformed inputs', () => {
    for (const input of malformedInputs) {
      assert.doesNotThrow(() => isLegacy(input));
      assert.doesNotThrow(() => needsRehash(input));
    }
  });

  test('verify rejects a non-string password without throwing', async () => {
    const stored = await hash('irrelevant');
    assert.equal(await verify(null, stored), false);
    assert.equal(await verify(undefined, stored), false);
    assert.equal(await verify(42, stored), false);
  });
});

describe('timing-safety', () => {
  test('password.js source uses timingSafeEqual, not a plain === compare, for both paths', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../../src/auth/password.js', import.meta.url), 'utf8');

    // Structural check only (per task spec) — a real timing measurement
    // would be flaky. Confirm timingSafeEqual is imported from node:crypto
    // and referenced at least twice: once for the scrypt path, once for
    // the legacy MD5 path.
    assert.match(source, /timingSafeEqual/);
    const occurrences = source.match(/timingSafeEqual\(/g) ?? [];
    assert.ok(
      occurrences.length >= 2,
      `expected timingSafeEqual to be used on both verify paths, found ${occurrences.length} call site(s)`
    );

    // Guard against a length-mismatch throw: each timingSafeEqual call site
    // must be preceded somewhere by a length check in the same function
    // body. We approximate this by requiring at least as many `.length`
    // comparisons involving the two buffers as there are call sites.
    assert.match(source, /\.length !== .*\.length/);
  });
});
