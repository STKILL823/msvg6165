'use strict';

const { hashPassword } = require('../lib/passwords');

const password = process.env.APP_PASSWORD;

if (!password || password.length < 12) {
  console.error('Задайте APP_PASSWORD длиной не менее 12 символов.');
  process.exit(1);
}

process.stdout.write(`${hashPassword(password)}\n`);
