'use strict';

const roleLabels = {
  user: 'Пользователь',
  admin: 'Зам. куратора (Admin)',
  superadmin: 'Куратор (superadmin)',
};
const errorLabels = {
  invalid_username: 'Nick_Name: от 3 до 80 символов; разрешены буквы, цифры, точка, дефис и подчёркивание.',
  weak_password: 'Пароль должен содержать не менее 12 символов.',
  username_exists: 'Такой Nick_Name уже существует.',
  invalid_role: 'Нельзя выдать роль, равную или выше вашей.',
  cannot_manage_role: 'Недостаточно прав для удаления этого пользователя.',
};
const createForm = document.querySelector('#create-form');
const usersBody = document.querySelector('#users-body');
const message = document.querySelector('#message');
let currentUser;

initialize();

async function initialize() {
  try {
    const response = await fetch('/api/me');
    if (!response.ok) return window.location.replace('/');
    currentUser = await response.json();
    if (!currentUser.canAdminister) return window.location.replace('/app');
    document.querySelector('#current-user').textContent = `${currentUser.username} — ${roleLabels[currentUser.role]}`;
    if (currentUser.role !== 'superadmin') document.querySelector('#admin-role-option').remove();
    await loadUsers();
  } catch {
    showMessage('Не удалось загрузить admin panel.');
  }
}

createForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = createForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  message.textContent = '';
  try {
    const response = await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: createForm.elements.username.value,
        password: createForm.elements.password.value,
        role: createForm.elements.role.value,
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return showMessage(errorLabels[payload.error] || 'Не удалось создать пользователя.');
    createForm.reset();
    showMessage(`Пользователь ${payload.username} создан.`, true);
    await loadUsers();
  } catch { showMessage('Сервер недоступен.'); }
  finally { submit.disabled = false; }
});

document.querySelector('#refresh').addEventListener('click', loadUsers);
document.querySelector('#logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' }).catch(() => {});
  window.location.replace('/');
});

async function loadUsers() {
  const response = await fetch('/api/users');
  if (!response.ok) throw new Error('Unable to load users');
  const { users } = await response.json();
  usersBody.replaceChildren(...users.map(renderUser));
}

function renderUser(user) {
  const row = document.createElement('tr');
  row.append(cell(user.username));
  const roleCell = document.createElement('td');
  const badge = document.createElement('span');
  badge.className = `badge badge-${user.role}`;
  badge.textContent = roleLabels[user.role] || user.role;
  roleCell.append(badge);
  row.append(roleCell, cell(user.createdBy || 'Система'), cell(formatDate(user.createdAt)));
  const actionCell = document.createElement('td');
  if (user.canDelete) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'delete-button';
    button.textContent = 'Удалить';
    button.addEventListener('click', () => removeUser(user, button));
    actionCell.append(button);
  } else {
    const protectedLabel = document.createElement('span');
    protectedLabel.className = 'protected';
    protectedLabel.textContent = 'Защищён';
    actionCell.append(protectedLabel);
  }
  row.append(actionCell);
  return row;
}

async function removeUser(user, button) {
  if (!window.confirm(`Удалить пользователя ${user.username}?`)) return;
  button.disabled = true;
  try {
    const response = await fetch(`/api/users/${encodeURIComponent(user.id)}`, { method: 'DELETE' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return showMessage(errorLabels[payload.error] || 'Не удалось удалить пользователя.');
    showMessage(`Пользователь ${user.username} удалён.`, true);
    await loadUsers();
  } catch { showMessage('Сервер недоступен.'); }
  finally { button.disabled = false; }
}

function cell(text) {
  const element = document.createElement('td');
  element.textContent = text;
  return element;
}
function formatDate(value) {
  return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
}
function showMessage(text, ok = false) {
  message.textContent = text;
  message.className = ok ? 'message ok' : 'message';
}
