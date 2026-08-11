// Socket.IO server wiring.
//
// Replaces nocklib.createSocket, which hand-rolled session lookup inside
// io.set('authorization') — reading connect.sid straight off the cookie
// header, already wrong in 2014 because Express 3 signs it. That API is
// gone anyway. io.engine.use() (socket.io >= 4.6) runs the same
// express-session instance the HTTP app uses, so no bespoke parsing.
import { Server } from 'socket.io';
import { registerChatHandlers } from './chat.js';
import { createPresence } from './presence.js';
import { createMarketState } from './market.js';

/**
 * @param {import('node:http').Server} httpServer
 * @param {{ sessionMiddleware: Function, users: object, logger: object }} deps
 */
export function createIo(httpServer, { sessionMiddleware, users, logger }) {
  // The 2014 app forced ['xhr-polling'] for socket.io 0.9; modern versions
  // negotiate the transport themselves.
  const io = new Server(httpServer, { serveClient: true });

  const presence = createPresence();
  const marketState = createMarketState();

  // Must be the SAME instance the Express app mounts.
  io.engine.use(sessionMiddleware);

  io.use((socket, next) => {
    const session = socket.request.session;
    // The old handshake accepted any resolvable session, logged in or not.
    if (!session?.userId) {
      return next(new Error('unauthorized'));
    }
    socket.data.userId = session.userId;
    socket.data.username = session.username;
    return next();
  });

  io.on('connection', (socket) => {
    logger.debug({ userId: socket.data.userId }, 'socket connected');
    registerChatHandlers(io, socket, { presence, users, marketState, logger });
    // So a late joiner is not staring at an empty ladder.
    socket.emit('market:snapshot', { books: marketState.snapshot() });
  });

  return {
    io,
    presence,
    marketState,

    /** Called by the simulator after each order. */
    publishMarket(payload) {
      marketState.update(payload);
      io.emit('market:delta', payload);
      return payload;
    },

    /**
     * Needed on logout: the session is snapshotted onto socket.data at
     * handshake time, so destroying it server-side does not make an open
     * socket notice — it would keep chatting after its owner logged out.
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
