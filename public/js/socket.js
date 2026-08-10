// Single Socket.IO connection, shared by every other client module.
//
// Closes C9 and C10:
//   C9  — the old code called `io.connect(window.location.hostname)`,
//         which drops the protocol and port and breaks the moment the app
//         is not served from bare "localhost" (e.g. localhost:3000). Bare
//         `io()` infers scheme, host and port from the page origin.
//   C10 — `accounts.js` referenced a global `socket` that `chat.js`
//         happened to create first, coupling the two files to <script>
//         tag order. Every module that needs the connection now imports
//         it explicitly; ES module caching guarantees this file's top
//         level runs exactly once, so there is still only one socket.
//
// `io` is the global injected by the server-served
// /socket.io/socket.io.js script (see eslint.config.js's `io: 'readonly'`
// browser global).
export const socket = io();
