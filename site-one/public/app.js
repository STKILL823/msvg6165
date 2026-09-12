'use strict';

const translations = {
  ru: {
    welcome: 'Добро пожаловать в технический отдел ',
    languageTitle: 'Язык — Language',
    languageLabel: 'Выберите язык',
    authorization: 'Авторизация',
    username: 'Nick_Name:',
    password: 'Пароль:',
    signIn: 'Войти',
    invalid: 'Неверный Nick_Name или пароль.',
    limited: 'Слишком много попыток. Попробуйте позже.',
    error: 'Не удалось связаться с сервером.',
    loading: 'Проверка…',
  },
  en: {
    welcome: 'Welcome to Technical Department ', languageTitle: 'Language',
    languageLabel: 'Choose a language', authorization: 'Authentication', username: 'Nick_Name:',
    password: 'Password:', signIn: 'Sign in', invalid: 'Invalid Nick_Name or password.',
    limited: 'Too many attempts. Try again later.', error: 'Unable to reach the server.', loading: 'Checking…',
  },
  uk: {
    welcome: 'Ласкаво просимо до технічного відділу ', languageTitle: 'Мова — Language',
    languageLabel: 'Виберіть мову', authorization: 'Авторизація', username: 'Nick_Name:',
    password: 'Пароль:', signIn: 'Увійти', invalid: 'Невірний Nick_Name або пароль.',
    limited: 'Забагато спроб. Спробуйте пізніше.', error: 'Не вдалося з’єднатися із сервером.', loading: 'Перевірка…',
  },
  de: {
    welcome: 'Willkommen in der technischen Abteilung ', languageTitle: 'Sprache — Language',
    languageLabel: 'Sprache auswählen', authorization: 'Anmeldung', username: 'Nick_Name:',
    password: 'Passwort:', signIn: 'Anmelden', invalid: 'Nick_Name oder Passwort ist falsch.',
    limited: 'Zu viele Versuche. Bitte später erneut versuchen.', error: 'Server nicht erreichbar.', loading: 'Prüfung…',
  },
  fr: {
    welcome: 'Bienvenue au service technique ', languageTitle: 'Langue — Language',
    languageLabel: 'Choisir une langue', authorization: 'Authentification', username: 'Nick_Name :',
    password: 'Mot de passe :', signIn: 'Connexion', invalid: 'Nick_Name ou mot de passe incorrect.',
    limited: 'Trop de tentatives. Réessayez plus tard.', error: 'Serveur inaccessible.', loading: 'Vérification…',
  },
};

const form = document.querySelector('#login-form');
const language = document.querySelector('#language');
const message = document.querySelector('#message');
const submitButton = document.querySelector('#submit-button');
let locale = localStorage.getItem('pmt_language') || 'ru';
if (!translations[locale]) locale = 'ru';
language.value = locale;
applyLanguage(locale);

language.addEventListener('change', () => {
  locale = language.value;
  localStorage.setItem('pmt_language', locale);
  applyLanguage(locale);
  message.textContent = '';
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  message.className = 'message';
  message.textContent = translations[locale].loading;
  submitButton.disabled = true;

  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: form.elements.username.value,
        password: form.elements.password.value,
      }),
    });

    if (response.ok) {
      message.classList.add('success');
      window.location.assign('/app');
      return;
    }

    const payload = await response.json().catch(() => ({}));
    message.textContent = payload.error === 'too_many_attempts'
      ? translations[locale].limited
      : translations[locale].invalid;
    form.elements.password.value = '';
    form.elements.password.focus();
  } catch {
    message.textContent = translations[locale].error;
  } finally {
    submitButton.disabled = false;
  }
});

function applyLanguage(selectedLocale) {
  const dictionary = translations[selectedLocale];
  document.documentElement.lang = selectedLocale;
  for (const element of document.querySelectorAll('[data-i18n]')) {
    element.textContent = dictionary[element.dataset.i18n];
  }
}
