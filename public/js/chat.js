// Chat and presence.
//
// Closes S4 (stored XSS). The old implementation built HTML strings out of
// server-supplied usernames and fed them to jQuery's `.html()`/`.append()`,
// and removed a departing user via a concatenated-string id selector
// (`$('#username-' + data.username)`) — both are exploitable by a username
// like `<img src=x onerror=alert(1)>`.
//
// The fix here is structural, not a sanitizer: every node is built with
// `document.createElement` and every piece of server data is assigned with
// `textContent`, which never parses its argument as markup. Presence
// removal looks a badge up by comparing its `data-username` attribute
// value, never by interpolating the username into a selector string.
import { socket } from './socket.js';

function appendMessage(log, { username, text, at }) {
  const entry = document.createElement('p');
  entry.className = 'chat-message';

  const who = document.createElement('strong');
  who.textContent = `${username}: `;
  entry.appendChild(who);

  const body = document.createElement('span');
  body.textContent = text;
  entry.appendChild(body);

  if (at) {
    const time = document.createElement('time');
    const date = new Date(at);
    time.dateTime = date.toISOString();
    time.textContent = ` ${date.toLocaleTimeString()}`;
    entry.appendChild(time);
  }

  log.appendChild(entry);
  log.scrollTop = log.scrollHeight;
}

function renderUsers(container, usernames) {
  container.textContent = '';
  for (const username of usernames) {
    container.appendChild(buildUserBadge(username));
  }
}

function buildUserBadge(username) {
  const badge = document.createElement('span');
  badge.className = 'chat-user';
  badge.dataset.username = username;
  badge.textContent = username;
  return badge;
}

function addUser(container, username) {
  const alreadyPresent = [...container.children].some(
    (badge) => badge.dataset.username === username
  );
  if (alreadyPresent) {
    return;
  }
  container.appendChild(buildUserBadge(username));
}

function removeUser(container, username) {
  const badge = [...container.children].find((el) => el.dataset.username === username);
  badge?.remove();
}

export function initChat() {
  const joinButton = document.getElementById('join-chat');
  const widget = document.getElementById('chat-widget');
  const log = document.getElementById('chat-log');
  const form = document.getElementById('chat-form');
  const input = document.getElementById('chat-message');
  const userList = document.getElementById('chat-users');

  if (!joinButton || !widget || !log || !form || !input || !userList) {
    return;
  }

  joinButton.addEventListener('click', () => {
    joinButton.hidden = true;
    widget.hidden = false;
    socket.emit('presence:join');
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) {
      return;
    }
    socket.emit('chat:message', { text });
    input.value = '';
  });

  socket.on('chat:message', (data) => appendMessage(log, data));
  socket.on('presence:list', ({ users }) => renderUsers(userList, users));
  socket.on('presence:join', ({ username }) => addUser(userList, username));
  // Note: listening for the reserved 'disconnect' event is fine (that is
  // how the socket itself notices it went away); only EMITTING it as a
  // custom application event is the R3 violation, and this app never does
  // that — departures are announced as 'presence:leave' by the server.
  socket.on('presence:leave', ({ username }) => removeUser(userList, username));
}
