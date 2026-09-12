'use strict';

const { randomBytes, scryptSync } = require('node:crypto');

const password = process.env.APP_PASSWORD;

if (!password || password.length < 12) {
  console.error('Задайте APP_PASSWORD длиной не менее 12 символов.');
  process.exit(1);
}

const salt = randomBytes(16);
const derived = scryptSync(password, salt, 64);
process.stdout.write(`scrypt:${salt.toString('hex')}:${derived.toString('hex')}\n`);

