// Session-backed synchronizer CSRF tokens (S5). The 2014 app had none:
// /login, /signup and /add-stock accepted any cross-origin form post.
//
// Chosen over double-submit-cookie (csrf-csrf), which exists for stateless
// services with nowhere to keep per-session state. This app has a real
// session store, so the secret never has to leave the server — and it
// avoids adding cookie-parser purely to satisfy a library that reads
// req.cookies.
//
// SameSite=Lax on the session cookie is the first layer; this is the second.
import { randomBytes, timingSafeEqual } from 'node:crypto';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const TOKEN_BYTES = 32;

export class CsrfError extends Error {
  constructor() {
    super('Invalid or missing CSRF token.');
    this.name = 'CsrfError';
    this.code = 'EBADCSRFTOKEN';
    this.status = 403;
  }
}

/**
 * Exposes the token as `res.locals.csrfToken`. Views render it as a hidden
 * `_csrf` input and a `<meta name="csrf-token">`; fetch() callers send it
 * as the `x-csrf-token` header.
 *
 * @returns {import('express').RequestHandler}
 */
export function csrfProtection() {
  return function csrf(req, res, next) {
    if (!req.session) {
      return next(
        new Error('csrfProtection requires a session; mount it after the session middleware.')
      );
    }

    if (!req.session.csrfSecret) {
      req.session.csrfSecret = randomBytes(TOKEN_BYTES).toString('base64url');
    }
    const secret = req.session.csrfSecret;
    res.locals.csrfToken = secret;

    if (SAFE_METHODS.has(req.method)) {
      return next();
    }

    const presented = tokenFromRequest(req);
    if (!presented || !constantTimeEquals(presented, secret)) {
      return next(new CsrfError());
    }

    return next();
  };
}

/**
 * Issue a fresh secret for the current session and return it.
 *
 * Call this after `session.regenerate()` on login/signup. Regenerating the
 * session to defeat fixation (S8) necessarily discards the old CSRF secret,
 * so a client holding the pre-login token would other wise be rejected on its
 * next write. Rotating the token on privilege change is the correct
 * behaviour; handing the new one back in the auth response is what makes it
 * usable.
 *
 * @param {import('express').Request} req
 * @returns {string} the new token
 */
export function rotateCsrfSecret(req) {
  req.session.csrfSecret = randomBytes(TOKEN_BYTES).toString('base64url');
  return req.session.csrfSecret;
}

function tokenFromRequest(req) {
  const fromBody = req.body?._csrf;
  if (typeof fromBody === 'string' && fromBody.length > 0) {
    return fromBody;
  }
  const header = req.get('x-csrf-token');
  return typeof header === 'string' && header.length > 0 ? header : null;
}

/** Length-guarded: timingSafeEqual throws on a size mismatch. */
function constantTimeEquals(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
