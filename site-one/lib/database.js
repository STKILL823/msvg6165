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
  supportBigNumbers: true,
  bigNumberStrings: true,
});

async function initializeDatabase() {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      username VARCHAR(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role ENUM('user', 'admin', 'superadmin', 'developer') NOT NULL DEFAULT 'user',
      server_id TINYINT UNSIGNED NULL,
      created_by BIGINT UNSIGNED NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_users_username (username),
      KEY idx_users_role (role),
      KEY idx_users_server (server_id),
      CONSTRAINT fk_users_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.execute("ALTER TABLE users MODIFY COLUMN role ENUM('user', 'admin', 'superadmin', 'developer') NOT NULL DEFAULT 'user'");
  await addColumnIfMissing('users', 'server_id', 'TINYINT UNSIGNED NULL AFTER role');
  await addIndexIfMissing('users', 'idx_users_server', 'server_id');
  await pool.execute(`
    UPDATE users
    SET server_id = CAST(RIGHT(username, 2) AS UNSIGNED)
    WHERE role = 'user'
      AND server_id IS NULL
      AND RIGHT(username, 2) IN ('61', '62', '63', '64', '65')
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS work_rows (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      server_id TINYINT UNSIGNED NOT NULL,
      sheet_key VARCHAR(40) NOT NULL,
      row_key VARCHAR(120) NOT NULL,
      data_json JSON NOT NULL,
      status ENUM('pending', 'violation', 'clear', 'help', 'processed') NOT NULL DEFAULT 'pending',
      assigned_user_id BIGINT UNSIGNED NULL,
      status_by BIGINT UNSIGNED NULL,
      status_updated_at TIMESTAMP NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_work_row (server_id, sheet_key, row_key),
      KEY idx_work_scope (server_id, sheet_key, status),
      KEY idx_work_assigned (assigned_user_id),
      CONSTRAINT fk_work_assigned FOREIGN KEY (assigned_user_id) REFERENCES users(id) ON DELETE SET NULL,
      CONSTRAINT fk_work_status_by FOREIGN KEY (status_by) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      actor_user_id BIGINT UNSIGNED NULL,
      actor_username VARCHAR(80) NULL,
      action VARCHAR(60) NOT NULL,
      target_type VARCHAR(40) NULL,
      target_id VARCHAR(120) NULL,
      server_id TINYINT UNSIGNED NULL,
      ip_address VARCHAR(128) NULL,
      details_json JSON NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_audit_created (created_at),
      KEY idx_audit_actor (actor_user_id),
      KEY idx_audit_server (server_id),
      CONSTRAINT fk_audit_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await ensureBootstrapAccount('superadmin');
  await ensureBootstrapAccount('developer');

  const [countRows] = await pool.execute('SELECT COUNT(*) AS count FROM users');
  if (Number(countRows[0].count) === 0) {
    throw new Error('Нет первоначального аккаунта. Задайте BOOTSTRAP_DEVELOPER_USERNAME и пароль developer.');
  }
}

async function ensureBootstrapAccount(role) {
  const [rows] = await pool.execute('SELECT COUNT(*) AS count FROM users WHERE role = ?', [role]);
  if (Number(rows[0].count) > 0) return;
  const prefix = role === 'developer' ? 'BOOTSTRAP_DEVELOPER' : 'BOOTSTRAP_SUPERADMIN';
  const username = String(process.env[`${prefix}_USERNAME`] || '').trim();
  const plainPassword = process.env[`${prefix}_PASSWORD`] || '';
  const configuredHash = process.env[`${prefix}_PASSWORD_HASH`] || '';
  if (!username || (!configuredHash && plainPassword.length < 12)) return;
  const passwordHash = configuredHash || hashPassword(plainPassword);
  try {
    await pool.execute('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)', [username, passwordHash, role]);
    console.log(`Создан первоначальный ${role}: ${username}`);
  } catch (error) {
    if (error.code !== 'ER_DUP_ENTRY') throw error;
  }
}

async function findUserByUsername(username) {
  const [rows] = await pool.execute(
    'SELECT id, username, password_hash, role, server_id FROM users WHERE username = ? LIMIT 1',
    [username],
  );
  return rows[0] || null;
}

async function findUserById(id) {
  const [rows] = await pool.execute(
    'SELECT id, username, role, server_id FROM users WHERE id = ? LIMIT 1',
    [id],
  );
  return rows[0] || null;
}

async function listUsers() {
  const [rows] = await pool.execute(`
    SELECT u.id, u.username, u.role, u.server_id, u.created_at, creator.username AS created_by_username
    FROM users u
    LEFT JOIN users creator ON creator.id = u.created_by
    ORDER BY FIELD(u.role, 'developer', 'superadmin', 'admin', 'user'), u.server_id, u.username
  `);
  return rows;
}

async function createUser({ username, passwordHash, role, serverId, createdBy }) {
  const [result] = await pool.execute(
    'INSERT INTO users (username, password_hash, role, server_id, created_by) VALUES (?, ?, ?, ?, ?)',
    [username, passwordHash, role, serverId, createdBy],
  );
  return result.insertId;
}

async function updateUser(id, { role, serverId }) {
  const [result] = await pool.execute('UPDATE users SET role = ?, server_id = ? WHERE id = ?', [role, serverId, id]);
  return result.affectedRows === 1;
}

async function deleteUser(id) {
  const [result] = await pool.execute('DELETE FROM users WHERE id = ?', [id]);
  return result.affectedRows === 1;
}

async function listWorkRows({ serverId, sheetKey, userId, restrictToAssigned }) {
  const assignment = restrictToAssigned ? ' AND (w.assigned_user_id IS NULL OR w.assigned_user_id = ?)' : '';
  const params = restrictToAssigned ? [serverId, sheetKey, userId] : [serverId, sheetKey];
  const [rows] = await pool.execute(`
    SELECT w.id, w.row_key, w.data_json, w.status, w.assigned_user_id,
           assigned.username AS assigned_username, editor.username AS status_by_username,
           w.status_updated_at, w.created_at
    FROM work_rows w
    LEFT JOIN users assigned ON assigned.id = w.assigned_user_id
    LEFT JOIN users editor ON editor.id = w.status_by
    WHERE w.server_id = ? AND w.sheet_key = ?${assignment}
    ORDER BY w.id
    LIMIT 2000
  `, params);
  return rows;
}

async function findWorkRow(id) {
  const [rows] = await pool.execute(
    'SELECT id, server_id, sheet_key, row_key, data_json, status, assigned_user_id FROM work_rows WHERE id = ? LIMIT 1',
    [id],
  );
  return rows[0] || null;
}

async function updateWorkRowStatus(id, status, userId) {
  const [result] = await pool.execute(
    'UPDATE work_rows SET status = ?, status_by = ?, status_updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [status, userId, id],
  );
  return result.affectedRows === 1;
}

async function listStatistics(serverId = null) {
  const where = serverId ? 'WHERE server_id = ?' : '';
  const params = serverId ? [serverId] : [];
  const [rows] = await pool.execute(`
    SELECT server_id,
      COUNT(*) AS total,
      SUM(status <> 'pending') AS completed,
      SUM(status = 'pending') AS pending,
      SUM(status = 'violation') AS violation,
      SUM(status = 'clear') AS clear_count,
      SUM(status = 'help') AS help_count,
      SUM(status = 'processed') AS processed
    FROM work_rows ${where}
    GROUP BY server_id ORDER BY server_id
  `, params);
  return rows;
}

async function listHelpRequests(serverId = null) {
  const where = serverId ? "AND w.server_id = ?" : '';
  const params = serverId ? [serverId] : [];
  const [rows] = await pool.execute(`
    SELECT w.id, w.server_id, w.sheet_key, w.row_key, w.data_json, w.status_updated_at,
           assigned.username AS assigned_username, editor.username AS status_by_username
    FROM work_rows w
    LEFT JOIN users assigned ON assigned.id = w.assigned_user_id
    LEFT JOIN users editor ON editor.id = w.status_by
    WHERE w.status = 'help' ${where}
    ORDER BY w.status_updated_at DESC LIMIT 200
  `, params);
  return rows;
}

async function addAuditLog({ actorUserId = null, actorUsername = null, action, targetType = null, targetId = null, serverId = null, ipAddress = null, details = null }) {
  await pool.execute(`
    INSERT INTO audit_logs (actor_user_id, actor_username, action, target_type, target_id, server_id, ip_address, details_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [actorUserId, actorUsername, action, targetType, targetId, serverId, ipAddress, details ? JSON.stringify(details) : null]);
}

async function listAuditLogs(limit = 500) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const [rows] = await pool.query(`
    SELECT id, actor_username, action, target_type, target_id, server_id, ip_address, details_json, created_at
    FROM audit_logs ORDER BY id DESC LIMIT ${safeLimit}
  `);
  return rows;
}

async function addColumnIfMissing(table, column, definition) {
  const [rows] = await pool.execute(`
    SELECT COUNT(*) AS count FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?
  `, [table, column]);
  if (Number(rows[0].count) === 0) await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
}

async function addIndexIfMissing(table, index, columns) {
  const [rows] = await pool.execute(`
    SELECT COUNT(*) AS count FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?
  `, [table, index]);
  if (Number(rows[0].count) === 0) await pool.query(`ALTER TABLE \`${table}\` ADD INDEX \`${index}\` (${columns})`);
}

async function closeDatabase() { await pool.end(); }
function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

module.exports = {
  initializeDatabase, findUserByUsername, findUserById, listUsers, createUser, updateUser, deleteUser,
  listWorkRows, findWorkRow, updateWorkRowStatus, listStatistics, listHelpRequests,
  addAuditLog, listAuditLogs, closeDatabase,
};
