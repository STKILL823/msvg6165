'use strict';

const mysql = require('mysql2/promise');
const { hashPassword } = require('./passwords');

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInteger(process.env.DB_PORT, 3306),
  database: process.env.DB_NAME || 'phpmytech',
  user: process.env.DB_USER || 'phpmytech',
  password: process.env.DB_PASSWORD || '',
  waitForConnections: true,
  connectionLimit: 10,
  maxIdle: 10,
  idleTimeout: 60_000,
  queueLimit: 0,
  charset: 'utf8mb4',
  timezone: 'Z',
});

async function initializeDatabase() {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      username VARCHAR(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role ENUM('user', 'admin', 'superadmin') NOT NULL DEFAULT 'user',
      created_by BIGINT UNSIGNED NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_users_username (username),
      KEY idx_users_role (role),
      CONSTRAINT fk_users_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  const [rows] = await pool.execute("SELECT COUNT(*) AS count FROM users WHERE role = 'superadmin'");
  if (Number(rows[0].count) > 0) return;

  const username = String(process.env.BOOTSTRAP_SUPERADMIN_USERNAME || '').trim();
  const plainPassword = process.env.BOOTSTRAP_SUPERADMIN_PASSWORD || '';
  const configuredHash = process.env.BOOTSTRAP_SUPERADMIN_PASSWORD_HASH || '';
  if (!username || (!configuredHash && plainPassword.length < 12)) {
    throw new Error('Для первой настройки задайте BOOTSTRAP_SUPERADMIN_USERNAME и пароль длиной от 12 символов (или его хеш).');
  }

  const passwordHash = configuredHash || hashPassword(plainPassword);
  await pool.execute(
    "INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'superadmin')",
    [username, passwordHash],
  );
  console.log(`Создан первоначальный superadmin: ${username}`);
}

async function findUserByUsername(username) {
  const [rows] = await pool.execute(
    'SELECT id, username, password_hash, role FROM users WHERE username = ? LIMIT 1',
    [username],
  );
  return rows[0] || null;
}

async function findUserById(id) {
  const [rows] = await pool.execute(
    'SELECT id, username, role FROM users WHERE id = ? LIMIT 1',
    [id],
  );
  return rows[0] || null;
}

async function listUsers() {
  const [rows] = await pool.execute(`
    SELECT u.id, u.username, u.role, u.created_at, creator.username AS created_by_username
    FROM users u
    LEFT JOIN users creator ON creator.id = u.created_by
    ORDER BY FIELD(u.role, 'superadmin', 'admin', 'user'), u.username
  `);
  return rows;
}

async function createUser({ username, passwordHash, role, createdBy }) {
  const [result] = await pool.execute(
    'INSERT INTO users (username, password_hash, role, created_by) VALUES (?, ?, ?, ?)',
    [username, passwordHash, role, createdBy],
  );
  return result.insertId;
}

async function deleteUser(id) {
  const [result] = await pool.execute('DELETE FROM users WHERE id = ?', [id]);
  return result.affectedRows === 1;
}

async function closeDatabase() {
  await pool.end();
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

module.exports = {
  initializeDatabase,
  findUserByUsername,
  findUserById,
  listUsers,
  createUser,
  deleteUser,
  closeDatabase,
};
