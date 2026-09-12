# PhpMyTech — роли, MySQL и phpMyAdmin

Сайт хранит аккаунты в MariaDB/MySQL. phpMyAdmin — это интерфейс просмотра и администрирования этой базы, а не сама база данных.

## Права

- `user` — обычный пользователь, admin-панели нет;
- `admin` — создаёт и удаляет только обычных пользователей;
- `superadmin` — создаёт и удаляет `admin` и обычных пользователей;
- создавать других `superadmin` и удалять аккаунты с равными или большими правами через панель нельзя.

Пароли сохраняются только как `scrypt`-хеши. При удалении пользователя его активные сессии завершаются.

## Запуск через Docker

1. Скопируйте `.env.example` в `.env`.
2. Замените все тестовые значения длинными уникальными паролями.
3. Запустите:

```powershell
docker compose up --build -d
```

- сайт: `http://localhost:3000`;
- phpMyAdmin: `http://localhost:8080`;
- сервер базы в phpMyAdmin: `database`;
- вход в phpMyAdmin: значения `DB_USER` и `DB_PASSWORD` из `.env`.

При пустой базе автоматически создаётся единственный первоначальный `superadmin` из `BOOTSTRAP_SUPERADMIN_USERNAME` и `BOOTSTRAP_SUPERADMIN_PASSWORD`. После создания он хранится в таблице `users`, и повторный запуск его не дублирует.

Для production создайте хеш командой `npm run hash-password`, передайте его как `BOOTSTRAP_SUPERADMIN_PASSWORD_HASH`, очистите обычный `BOOTSTRAP_SUPERADMIN_PASSWORD` и включите `COOKIE_SECURE=true` за HTTPS reverse proxy.

## Локальный запуск Node.js без контейнера приложения

База должна быть доступна по параметрам `DB_*`:

```powershell
npm install
npm start
```
