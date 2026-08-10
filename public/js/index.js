// Landing page: native <dialog> modals for login/signup, replacing
// Bootstrap's `.modal` + `data-toggle="modal"`.
function csrfToken() {
  return document.querySelector('meta[name="csrf-token"]')?.content ?? '';
}

function setupDialogs() {
  for (const button of document.querySelectorAll('[data-open-dialog]')) {
    button.addEventListener('click', () => {
      document.getElementById(button.dataset.openDialog)?.showModal();
    });
  }
  for (const button of document.querySelectorAll('[data-close-dialog]')) {
    button.addEventListener('click', () => {
      button.closest('dialog')?.close();
    });
  }
}

function renderErrors(container, errors) {
  if (!container) {
    return;
  }
  container.textContent = (errors ?? ['Something went wrong.']).join(' ');
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'x-csrf-token': csrfToken(),
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, data };
}

function setupLoginForm() {
  const form = document.getElementById('login-form');
  if (!form) {
    return;
  }
  const errorBox = document.getElementById('login-errors');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    renderErrors(errorBox, []);
    const formData = new FormData(form);
    const { ok, data } = await postJson('/login', {
      username: formData.get('username'),
      password: formData.get('password'),
    });
    // Success navigates away entirely, so the freshly rotated CSRF token
    // (see auth.js's session.regenerate()) simply arrives embedded in the
    // next page's rendered <meta> tag — there is no stale token left
    // behind on this page for a later write to fail against.
    if (ok) {
      window.location.assign('/portfolio');
      return;
    }
    renderErrors(errorBox, data.errors);
  });
}

function setupSignupForm() {
  const form = document.getElementById('signup-form');
  if (!form) {
    return;
  }
  const errorBox = document.getElementById('signup-errors');
  const usernameInput = document.getElementById('signup-username');
  const availability = document.getElementById('username-availability');
  const passwordInput = document.getElementById('signup-password');
  const confirmInput = document.getElementById('signup-password-confirm');
  const submitButton = document.getElementById('signup-submit');

  function refreshSubmitState() {
    const matches = passwordInput.value.length > 0 && passwordInput.value === confirmInput.value;
    submitButton.disabled = !matches;
  }
  passwordInput.addEventListener('input', refreshSubmitState);
  confirmInput.addEventListener('input', refreshSubmitState);

  usernameInput.addEventListener('blur', async () => {
    const username = usernameInput.value.trim();
    availability.textContent = '';
    if (!username) {
      return;
    }
    try {
      const response = await fetch(`/api/user/${encodeURIComponent(username)}`, {
        headers: { Accept: 'application/json' },
      });
      const data = await response.json();
      availability.textContent = data.available
        ? 'Username is available.'
        : 'Username already in use.';
    } catch {
      availability.textContent = '';
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    renderErrors(errorBox, []);
    const formData = new FormData(form);
    const { ok, data } = await postJson('/signup', {
      username: formData.get('username'),
      email: formData.get('email'),
      password: formData.get('password'),
      passwordConfirm: formData.get('passwordConfirm'),
    });
    if (ok) {
      window.location.assign('/portfolio');
      return;
    }
    renderErrors(errorBox, data.errors);
  });
}

setupDialogs();
setupLoginForm();
setupSignupForm();
