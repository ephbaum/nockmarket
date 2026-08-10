// Chat and presence event handlers.
//
// The 2014 code emitted a custom `disconnect` event to announce departures.
// That name is RESERVED in socket.io v3+ and emitting it throws at runtime,
// hence `presence:leave` (R3).
//
// Payloads carry { username, text } separately rather than a
// pre-concatenated string: the client renders with textContent, and handing
// it ready-made markup is what made the old XSS natural (S4).
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
    // A second tab must not produce a second "joined" message (C2).
    if (isFirstConnection) {
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

  // Listening for 'disconnect' is fine; only emitting it violates R3.
  socket.on('disconnect', () => {
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
