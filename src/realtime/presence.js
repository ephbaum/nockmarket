// Who is currently in the chat room.
//
// Replaces the `online` array in lib/nocklib.js (C2), where splice(-1, 1) on
// a missing username silently evicted an unrelated user, and an
// unconditional push listed you twice per tab. Keying by username and
// refcounting connections makes both unrepresentable: you are present
// exactly while you hold at least one socket.

export function createPresence() {
  /** @type {Map<string, Set<string>>} */
  const byUsername = new Map();

  return {
    /** @returns {boolean} true only on the user's FIRST socket. */
    join(username, socketId) {
      if (!username || !socketId) {
        return false;
      }
      let sockets = byUsername.get(username);
      if (!sockets) {
        sockets = new Set();
        byUsername.set(username, sockets);
      }
      const wasAbsent = sockets.size === 0;
      sockets.add(socketId);
      return wasAbsent;
    },

    /**
     * @returns {boolean} true only when the user's LAST socket went away. A
     *   leave for an unknown user is a no-op — it can never touch anyone
     *   else's presence (C2).
     */
    leave(username, socketId) {
      const sockets = byUsername.get(username);
      if (!sockets) {
        return false;
      }
      sockets.delete(socketId);
      if (sockets.size === 0) {
        byUsername.delete(username);
        return true;
      }
      return false;
    },

    /** Used to disconnect a user's sockets on logout. */
    socketsFor(username) {
      return [...(byUsername.get(username) ?? [])];
    },

    list() {
      return [...byUsername.keys()].sort();
    },

    count() {
      return byUsername.size;
    },
  };
}
