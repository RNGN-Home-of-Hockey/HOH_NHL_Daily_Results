// Login of the EPL operator site (owner 2026-10-23: every commentator has their own e-mail + password). The server
// sets an HttpOnly session cookie; then back to the page asked for (same site only).
const form = document.getElementById('login');
const error = document.getElementById('error');
const MESSAGES = {
  bad_login: 'Неверная почта или пароль',
  locked: 'Слишком много неверных попыток. Подождите 15 минут',
  no_access: 'Доступ закрыт. Напишите администратору',
};

function nextPage() {
  const raw = new URLSearchParams(location.search).get('next') || '/';
  const path = raw.startsWith('/') && !raw.startsWith('//') && !raw.includes(String.fromCharCode(92)) ? raw.split('?')[0] : '/';
  return (/\/login(\.html)?$/.test(path) ? '/' : path) + location.hash;
}

function show(text) {
  error.textContent = text;
  error.classList.toggle('on', Boolean(text));
}

// already logged in (an old tab, the back button): straight to the site
fetch('/api/onair/me', { cache: 'no-store' }).then((response) => { if (response.ok) location.replace(nextPage()); }).catch(() => {});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = form.querySelector('button');
  button.disabled = true;
  show('');
  try {
    const response = await fetch('/api/onair/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: form.email.value, password: form.password.value }),
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok && data.ok) { location.replace(nextPage()); return; }
    show(MESSAGES[data.error] || `Не получилось войти (ошибка ${response.status})`);
    form.password.select();
  } catch {
    show('Нет связи с сервером. Проверьте интернет и попробуйте ещё раз');
  } finally {
    button.disabled = false;
  }
});
