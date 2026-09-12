'use strict';

fetch('/api/me')
  .then((response) => response.ok ? response.json() : Promise.reject(new Error('Unauthorized')))
  .then((data) => {
    document.querySelector('#user').textContent = `Пользователь: ${data.username}`;
  })
  .catch(() => window.location.replace('/'));

document.querySelector('#logout').addEventListener('click', async () => {
  try {
    await fetch('/api/logout', { method: 'POST' });
  } finally {
    window.location.replace('/');
  }
});
