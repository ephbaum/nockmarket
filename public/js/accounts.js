// "My Account" tab: update the session user's email over the socket.
//
// Closes C10: the old version registered `socket.on('updateSuccess', ...)`
// at the top level of the file, which only worked because chat.js had
// already run first and created `window.socket` — an implicit global with
// a load-order dependency. This imports the shared connection explicitly.
import { socket } from './socket.js';

export function initAccount() {
  const form = document.getElementById('account-form');
  const status = document.getElementById('account-status');
  if (!form || !status) {
    return;
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const email = document.getElementById('email-input').value.trim();
    status.textContent = 'Updating…';
    socket.emit('account:update', { email });
  });

  socket.on('account:updated', (response) => {
    status.textContent =
      response && response.ok
        ? 'Email updated.'
        : (response?.errors ?? ['Could not update email.']).join(' ');
  });
}
