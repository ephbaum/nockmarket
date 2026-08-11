// Signup / login / logout.
//
// Replaces routes/nockroutes.js:49-77. Defects closed here:
//   S3 — the old signup did `console.log(req)`, dumping the entire request
//        (including req.body.password in plaintext) to the logs.
//   S8 — no session regeneration on login, so a session id planted before
//        authentication stayed valid after it (session fixation).
//   S1 — MD5 password verification; now scrypt, with a lazy upgrade path.
// Duplicate usernames are caught as DuplicateUserError off the unique
// index (S7) rather than a check-then-insert race.
import { Router } from 'express';
import { hash, isLegacy, needsRehash, verify, verifyLegacy } from '../auth/password.js';
import { rotateCsrfSecret } from '../auth/csrf.js';

const USERNAME_RE = /^[A-Za-z0-9_-]{3,32}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

/**
 * @param {{ users: object, config: object, logger: object }} deps
 */
export function createAuthRouter({ users, config, logger }) {
  const router = Router();

  router.post('/signup', async (req, res) => {
    const { username, email, password, passwordConfirm } = req.body ?? {};

    // Server-side validation. The 2014 app validated only in the browser
    // (public/js/index.js pinged /api/user/:username on blur), which is
    // not a check at all — anything can POST here.
    const errors = [];
    if (!USERNAME_RE.test(username ?? '')) {
      errors.push('Username must be 3-32 characters: letters, numbers, underscore or hyphen.');
    }
    if (!EMAIL_RE.test(email ?? '')) {
      errors.push('A valid email address is required.');
    }
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      errors.push(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    }
    if (password !== passwordConfirm) {
      errors.push('Passwords do not match.');
    }
    if (errors.length > 0) {
      return res.status(400).json({ errors });
    }

    let user;
    try {
      user = await users.create({
        username,
        email,
        passwordHash: await hash(password),
        passwordAlgo: 'scrypt',
      });
    } catch (err) {
      if (err.name === 'DuplicateUserError') {
        return res.status(409).json({ errors: ['That username is already taken.'] });
      }
      throw err;
    }

    // Never log req or req.body here (S3).
    logger.info({ userId: user._id }, 'user signed up');
    return establishSession(req, res, user);
  });

  router.post('/login', async (req, res) => {
    const { username, password } = req.body ?? {};
    if (typeof username !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ errors: ['Username and password are required.'] });
    }

    const user = await users.findByUsername(username);
    if (!user) {
      return res.status(401).json({ errors: ['Invalid username or password.'] });
    }

    const outcome = await authenticate(user, password, { users, config });
    if (!outcome) {
      return res.status(401).json({ errors: ['Invalid username or password.'] });
    }

    logger.info({ userId: user._id, upgraded: outcome.upgraded }, 'user logged in');
    return establishSession(req, res, user);
  });

  router.post('/logout', (req, res) => {
    const { username } = req.session ?? {};

    // Drop this user's sockets explicitly. The Socket.IO session is
    // snapshotted onto socket.data at handshake time, so destroying the
    // session server-side does NOT make an already-open socket notice —
    // without this it would keep chatting after its owner logged out.
    // Registered by src/server.js once the realtime layer exists; absent
    // in HTTP-only tests, hence the optional call.
    const disconnectUser = req.app.get('disconnectUser');
    if (username && typeof disconnectUser === 'function') {
      disconnectUser(username);
    }

    req.session?.destroy(() => {
      res.clearCookie('connect.sid');
      if (wantsJson(req)) {
        return res.status(200).json({ ok: true });
      }
      return res.redirect('/');
    });
  });

  return router;
}

/**
 * Verify a password, transparently upgrading a legacy MD5 hash to scrypt.
 *
 * MD5 is not reversible, so there is no batch migration — a legacy hash can
 * only be upgraded at the moment the plaintext is in hand, i.e. on a
 * successful login. LEGACY_MD5_LOGIN=false is the cutoff after which
 * remaining legacy users must reset instead.
 *
 * @returns {Promise<{upgraded: boolean}|null>} null when authentication fails.
 */
async function authenticate(user, password, { users, config }) {
  // verify()/verifyLegacy() never throw, on any stored value — no guard needed.
  if (await verify(password, user.passwordHash)) {
    if (needsRehash(user.passwordHash)) {
      await users.updatePasswordHash(user._id, await hash(password), 'scrypt');
      return { upgraded: true };
    }
    return { upgraded: false };
  }

  if (isLegacy(user.passwordHash) && config.legacyMd5Login) {
    if (verifyLegacy(password, user.passwordHash)) {
      await users.updatePasswordHash(user._id, await hash(password), 'scrypt');
      return { upgraded: true };
    }
  }

  return null;
}

/**
 * Regenerate the session before writing the user id (S8), so a session
 * fixed by an attacker prior to login is discarded rather than promoted.
 */
function establishSession(req, res, user) {
  return new Promise((resolve) => {
    req.session.regenerate((err) => {
      if (err) {
        return resolve(res.status(500).json({ errors: ['Could not start a session.'] }));
      }
      req.session.userId = user._id;
      req.session.username = user.username;
      // Regenerating discarded the old CSRF secret, so mint a new one and
      // hand it back — a client still holding the pre-login token would
      // otherwise be rejected on its very next write.
      const csrfToken = rotateCsrfSecret(req);
      res.locals.csrfToken = csrfToken;
      req.session.save(() => {
        if (wantsJson(req)) {
          return resolve(res.status(200).json({ ok: true, username: user.username, csrfToken }));
        }
        return resolve(res.redirect('/portfolio'));
      });
    });
  });
}

function wantsJson(req) {
  return req.xhr || (req.get('accept') ?? '').includes('application/json');
}
