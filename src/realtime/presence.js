// Who is currently in the chat room.
//
// Replaces the `online` array in lib/nocklib.js (C2), which had two bugs:
//
//   1. Departure did `online.splice(online.indexOf(username), 1)`. When the
//      username was absent, indexOf returns -1 and splice(-1, 1) removes
//      the LAST element — i.e. it silently kicked an unrelated user out of
//      the list. Any disconnect for someone not in the array corrupted it.
//   2. Arrival did an unconditional `online.push(username)`, so opening a
//      second tab listed you twice, and closing one of them removed only
//      one entry.
//
// Both disappear if presence is keyed by username and refcounted by
// connection: a user is present exactly when they hold >= 1 socket.

/**
 * @returns {{ join(username, socketId): boolean,
 *             leave(username, socketId): boolean,
 *             socketsFor(username): string[],
 *             list(): string[],
 *             count(): number }}
 */
export function createPresence() {
  /** @type {Map<string, Set<string>>} */
  const byUsername = new Map();

  return {
    /**
     * @returns {boolean} true only when this is the user's FIRST socket,
     *   i.e. when other clients should be told they arrived.
     */
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
     * @returns {boolean} true only when the user's LAST socket went away.
     *   A leave for an unknown user or socket is a no-op that returns
     *   false — it can never affect anyone else's presence (C2).
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

    /** Every socket id held by a user — used to disconnect them on logout. */
    socketsFor(username) {
      return [...(byUsername.get(username) ?? [])];
    },

    /** Distinct usernames present, each appearing exactly once. */
    list() {
      return [...byUsername.keys()].sort();
    },

    count() {
      return byUsername.size;
    },
  };
}
