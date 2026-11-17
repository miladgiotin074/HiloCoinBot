require('dotenv').config({ quiet: true });
const path = require('path');
const crypto = require('crypto');

const bool = (v) => /^(1|true|yes|on)$/i.test(String(v || '').trim());

const config = {
  botToken: (process.env.BOT_TOKEN || '').trim(),
  // Filled from getMe() at startup when a token is present.
  botUsername: (process.env.BOT_USERNAME || 'HiloCoinBot').replace(/^@/, '').trim(),
  // Public HTTPS address where this server is reachable (Mini App URL).
  webAppUrl: (process.env.WEBAPP_URL || '').trim().replace(/\/+$/, ''),
  port: parseInt(process.env.PORT || '3000', 10),
  adminPassword: process.env.ADMIN_PASSWORD || '',
  adminIds: (process.env.ADMIN_IDS || '')
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0),
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'hilocoin.db'),
  // polling (default) or webhook
  botMode: (process.env.BOT_MODE || 'polling').toLowerCase(),
  // DEV_MODE lets you open the Mini App in a normal browser with ?dev_user=123.
  // Never enable it in production.
  devMode: bool(process.env.DEV_MODE),
  // How long a Telegram initData signature stays valid (seconds).
  initDataMaxAge: parseInt(process.env.INIT_DATA_MAX_AGE || '86400', 10),
};

// Secret used to sign admin-panel sessions. Changing the admin password logs everyone out.
config.sessionSecret =
  process.env.SESSION_SECRET ||
  crypto.createHash('sha256').update(`hilo-admin:${config.botToken}:${config.adminPassword}`).digest('hex');

config.isAdminId = (id) => config.adminIds.includes(Number(id));

module.exports = config;
