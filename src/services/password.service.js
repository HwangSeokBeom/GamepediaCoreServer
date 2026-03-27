const bcrypt = require('bcrypt');
const { env } = require('../config/env');

async function hashPassword(plainPassword) {
  return bcrypt.hash(plainPassword, env.bcryptSaltRounds);
}

async function comparePassword(plainPassword, passwordHash) {
  return bcrypt.compare(plainPassword, passwordHash);
}

module.exports = {
  comparePassword,
  hashPassword
};
