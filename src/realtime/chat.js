// Chat and presence event handlers.
//
// Event names come from the frozen contract in README.md. Note in
// particular that the 2014 code emitted a custom `disconnect` event
// (lib/nocklib.js:91) to announce departures. `disconnect` is RESERVED in
// socket.io v3+ and emitting it throws at runtime, so departures are
// announced as `presence:leave` (R3).
//
// The server sends structured fields — { username, text } — rather than the
// old pre-concatenated `username + ': ' + message + '\n'` string. The
// client renders them with textContent, which is what closes the stored
// XSS (S4); handing it a ready-made string invites innerHTML on the other
// end.
const MAX_MESSAGE_LENGTH = 1000;

/**
 * @param {import('socket.io').Server} io
 * @param {import('socket.io').Socket} socket
 * @param {{ presence: object, users: object, marketState: object, logger: object }} deps
 */
export function registerChatHandlers(io, socket, { presence, users, marketState, logger }) {
  const { userId, username } = socket.data;

  socket.on('presence:join', () => {
    const isFirstConnection = presence.join(username, socket.id);
    socket.emit('presence:list', { users: presence.list() });
    if (isFirstConnection) {
      // Only announce on the user's first socket — a second tab must not
      // produce a second "joined" message (C2).
      socket.broadcast.emit('presence:join', { username });
    }
  });

  socket.on('chat:message', (payload) => {
    const text = String(payload?.text ?? '')
      .trim()
      .slice(0, MAX_MESSAGE_LENGTH);
    if (!text) {
      return;
    }
    io.emit('chat:message', { username, text, at: Date.now() });
  });

  socket.on('market:request', () => {
    socket.emit('market:snapshot', { books: marketState.snapshot() });
  });

  socket.on('account:update', async (payload, ack) => {
    const email = String(payload?.email ?? '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return respond(ack, socket, 'account:updated', {
        ok: false,
        errors: ['A valid email address is required.'],
      });
    }
    try {
      await users.updateEmail(userId, email);
      return respond(ack, socket, 'account:updated', { ok: true, email });
    } catch (err) {
      logger.error({ err, userId }, 'failed to update email');
      return respond(ack, socket, 'account:updated', {
        ok: false,
        errors: ['Could not update your email.'],
      });
    }
  });

  socket.on('disconnect', () => {
    // Listening for 'disconnect' is fine and expected; only EMITTING it is
    // the reserved-name violation (R3).
    const wasLastConnection = presence.leave(username, socket.id);
    if (wasLastConnection) {
      socket.broadcast.emit('presence:leave', { username });
    }
  });
}

function respond(ack, socket, event, payload) {
  if (typeof ack === 'function') {
    return ack(payload);
  }
  return socket.emit(event, payload);
}
