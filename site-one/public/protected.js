'use strict';

fetch('/api/me')
  .then((response) => response.ok ? response.json() : Promise.reject(new Error('Unauthorized')))
  .then((data) => {
    document.querySelector('#user').textContent = `Пользователь: ${data.username}`;
    const labels = {
      user: 'Пользователь',
      admin: 'Зам. куратора технических специалистов (Admin)',
      superadmin: 'Куратор технических специалистов (superadmin)',
    };
    document.querySelector('#role').textContent = `Права: ${labels[data.role] || data.role}`;
    if (data.canAdminister) document.querySelector('#admin-link').classList.remove('hidden');
  })
  .catch(() => window.location.replace('/'));

document.querySelector('#logout').addEventListener('click', async () => {
  try {
    await fetch('/api/logout', { method: 'POST' });
  } finally {
    window.location.replace('/');
  }
});
