'use strict';

(() => {
  const storageKey = 'mass_theme';
  const root = document.documentElement;
  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
  const savedTheme = localStorage.getItem(storageKey);

  applyTheme(savedTheme === 'light' || savedTheme === 'dark'
    ? savedTheme
    : systemTheme.matches ? 'dark' : 'light');

  document.addEventListener('DOMContentLoaded', () => {
    const buttons = [...document.querySelectorAll('[data-theme-toggle]')];
    updateButtons(buttons);
    for (const button of buttons) {
      button.addEventListener('click', () => {
        const nextTheme = root.dataset.theme === 'dark' ? 'light' : 'dark';
        localStorage.setItem(storageKey, nextTheme);
        applyTheme(nextTheme);
        updateButtons(buttons);
      });
    }
  });

  systemTheme.addEventListener('change', (event) => {
    if (localStorage.getItem(storageKey)) return;
    applyTheme(event.matches ? 'dark' : 'light');
    updateButtons([...document.querySelectorAll('[data-theme-toggle]')]);
  });

  function applyTheme(theme) {
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) themeColor.content = theme === 'dark' ? '#0b1020' : '#f3f6fb';
  }

  function updateButtons(buttons) {
    const dark = root.dataset.theme === 'dark';
    for (const button of buttons) {
      button.textContent = dark ? '☀ Светлая' : '☾ Тёмная';
      button.setAttribute('aria-label', dark ? 'Включить светлую тему' : 'Включить тёмную тему');
      button.title = dark ? 'Включить светлую тему' : 'Включить тёмную тему';
    }
  }
})();
