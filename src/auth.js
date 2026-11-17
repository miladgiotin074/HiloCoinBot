const crypto = require('crypto');
const config = require('./config');

const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

/**
 * Validates Telegram Mini App initData (HMAC-SHA256 with the bot token).
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 * Returns { user, startParam, authDate } or null.
 */
function validateInitData(initData, botToken = config.botToken, maxAgeSec = config.initDataMaxAge) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calc = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  if (!safeEqual(calc, hash)) return null;

  const authDate = parseInt(params.get('auth_date') || '0', 10);
  if (!authDate || (maxAgeSec > 0 && Date.now() / 1000 - authDate > maxAgeSec)) return null;

  let user;
  try {
    user = JSON.parse(params.get('user') || 'null');
  } catch {
    return null;
  }
  if (!user || !user.id) return null;
  return { user, startParam: params.get('start_param') || '', authDate };
}

/* ------------------------------ Admin sessions ------------------------------ */

const sign = (data) => crypto.createHmac('sha256', config.sessionSecret).update(data).digest('hex');

function createAdminToken(ttlMs = 7 * 24 * 3600 * 1000) {
  const exp = Date.now() + ttlMs;
  return `${exp}.${sign('admin:' + exp)}`;
}

function verifyAdminToken(token) {
  const [exp, sig] = String(token || '').split('.');
  if (!exp || !sig || !/^\d+$/.test(exp) || Date.now() > Number(exp)) return false;
  return safeEqual(sig, sign('admin:' + exp));
}

function checkAdminPassword(pw) {
  if (!config.adminPassword) return false;
  const h = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
  return safeEqual(h(pw), h(config.adminPassword));
}

module.exports = { validateInitData, createAdminToken, verifyAdminToken, checkAdminPassword };
