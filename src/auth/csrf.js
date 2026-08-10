// Session-backed synchronizer CSRF tokens (S5).
//
// The 2014 app had no CSRF protection at all: /login, /signup and
// /add-stock accepted any cross-origin form post.
//
// Why this rather than the double-submit-cookie library (csrf-csrf):
// double-submit exists for stateless services that have nowhere to keep
// per-session state. This app has a real server-side session store
// (connect-mongo), so the synchronizer pattern is the stronger and simpler
// fit — the secret never leaves the server, and there is no second cookie
// to parse. It also avoids pulling in cookie-parser purely to satisfy a
// library that wants to read req.cookies.
//
// Defence in depth: SameSite=Lax on the session cookie (see session.js)
// already blocks the cross-site form post; this is the second layer.
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
 * Issues a per-session token, exposes it as `res.locals.csrfToken` for
 * views, and rejects unsafe requests that do not present it.
 *
 * Views render it two ways (both consumed by the frontend):
 *   <input type="hidden" name="_csrf" value="<%= csrfToken %>">
 *   <meta name="csrf-token" content="<%= csrfToken %>">
 * fetch() callers send it as the `x-csrf-token` header.
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

/** Length-guarded so timingSafeEqual cannot throw on a mismatched size. */
function constantTimeEquals(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
