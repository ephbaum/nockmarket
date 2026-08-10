// Socket.IO server wiring.
//
// Replaces nocklib.createSocket (lib/nocklib.js:54-120). The old version
// hand-rolled session lookup inside io.set('authorization'): it read
// `handshakeData.headers.cookie`, URI-decoded it, pulled `connect.sid`
// out and fetched it straight from the MemoryStore. That was already
// wrong in 2014 — connect.sid is SIGNED in Express 3+, so the raw cookie
// value is not the session id — and the whole API disappeared in
// socket.io v1.
//
// io.engine.use(sessionMiddleware) (socket.io >= 4.6) runs the very same
// express-session instance the HTTP app uses, so handshakes and requests
// agree on the session with no bespoke parsing at all.
import { Server } from 'socket.io';
import { registerChatHandlers } from './chat.js';
import { createPresence } from './presence.js';
import { createMarketState } from './market.js';

/**
 * @param {import('node:http').Server} httpServer
 * @param {{ sessionMiddleware: Function, users: object, logger: object }} deps
 */
export function createIo(httpServer, { sessionMiddleware, users, logger }) {
  const io = new Server(httpServer, {
    // The 2014 app forced ['xhr-polling'] because socket.io 0.9's
    // websocket support was unreliable behind the proxies of the day.
    // Modern socket.io upgrades to websocket and falls back on its own.
    serveClient: true,
  });

  const presence = createPresence();
  const marketState = createMarketState();

  // Must be the SAME middleware instance the Express app mounts, so both
  // read and write one session.
  io.engine.use(sessionMiddleware);

  io.use((socket, next) => {
    const session = socket.request.session;
    if (!session?.userId) {
      // The old handshake accepted any request carrying a resolvable
      // session, logged in or not.
      return next(new Error('unauthorized'));
    }
    socket.data.userId = session.userId;
    socket.data.username = session.username;
    return next();
  });

  io.on('connection', (socket) => {
    logger.debug({ userId: socket.data.userId }, 'socket connected');
    registerChatHandlers(io, socket, { presence, users, marketState, logger });
    // Send the current books immediately so a late joiner is not staring
    // at an empty ladder until the next order arrives.
    socket.emit('market:snapshot', { books: marketState.snapshot() });
  });

  return {
    io,
    presence,
    marketState,

    /**
     * Publish a book update to every connected client.
     * Called by the simulator (P2c) after each order.
     */
    publishMarket(payload) {
      marketState.update(payload);
      io.emit('market:delta', payload);
      return payload;
    },

    /**
     * Force-disconnect a user's sockets.
     *
     * Needed on logout: the session is snapshotted onto socket.data at
     * handshake time, so destroying it server-side does NOT make an open
     * socket notice. Without this an already-authenticated socket keeps
     * chatting after its owner logged out.
     */
    disconnectUser(username) {
      const ids = presence.socketsFor(username);
      for (const id of ids) {
        io.sockets.sockets.get(id)?.disconnect(true);
      }
      return ids.length;
    },

    async close() {
      await io.close();
    },
  };
}
