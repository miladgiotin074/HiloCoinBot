// Runtime settings editable from the admin panel. Amounts are in dollars here.
const db = require('./db');
const { AppError } = require('./util');

const DEFAULTS = {
  welcome_bonus: 1000,
  referral_bonus: 100,
  referral_bonus_premium: 250,
  invitee_bonus: 50,
  referral_commission_percent: 10,
  daily_rewards: [10, 15, 25, 40, 60, 80, 150],
  farm_hours: 8,
  farm_reward: 50,
  milestones: [
    { friends: 1, reward: 50 },
    { friends: 5, reward: 300 },
    { friends: 10, reward: 750 },
    { friends: 25, reward: 2000 },
    { friends: 50, reward: 5000 },
    { friends: 100, reward: 12000 },
  ],
  task_link_wait_seconds: 10,
  currency_symbol: '$',
  token_name: 'HILO',
  channel_url: '',
  support_url: '',
  airdrop_text_en:
    'HILO is launching soon! Every dollar in your balance will be converted to HILO tokens at listing. Keep earning, invite friends and connect your TON wallet to receive your airdrop.',
  airdrop_text_fa:
    'توکن HILO به‌زودی لیست می‌شود! تمام موجودی شما هنگام لیست شدن به توکن HILO تبدیل خواهد شد. به کسب درآمد ادامه دهید، دوستانتان را دعوت کنید و کیف پول TON خود را ثبت کنید تا ایردراپ را دریافت کنید.',
  maintenance: false,
};

const SCHEMA = {
  welcome_bonus: 'money',
  referral_bonus: 'money',
  referral_bonus_premium: 'money',
  invitee_bonus: 'money',
  referral_commission_percent: 'percent',
  daily_rewards: 'moneyList',
  farm_hours: 'hours',
  farm_reward: 'money',
  milestones: 'milestones',
  task_link_wait_seconds: 'seconds',
  currency_symbol: 'short',
  token_name: 'short',
  channel_url: 'url',
  support_url: 'url',
  airdrop_text_en: 'text',
  airdrop_text_fa: 'text',
  maintenance: 'bool',
};

const cache = { ...DEFAULTS };
for (const row of db.prepare('SELECT key, value FROM settings').all()) {
  if (!(row.key in DEFAULTS)) continue;
  try {
    cache[row.key] = JSON.parse(row.value);
  } catch {
    /* keep default */
  }
}

const upsert = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);

function bad(key) {
  throw new AppError(400, 'invalid_setting', { key });
}

function validate(key, v) {
  const kind = SCHEMA[key];
  const num = (x, min, max) => {
    const n = Number(x);
    if (!Number.isFinite(n) || n < min || n > max) bad(key);
    return n;
  };
  switch (kind) {
    case 'money':
      return Math.round(num(v, 0, 1e9) * 100) / 100;
    case 'percent':
      return num(v, 0, 100);
    case 'hours':
      return num(v, 0.01, 24 * 30);
    case 'seconds':
      return Math.round(num(v, 0, 3600));
    case 'moneyList': {
      if (!Array.isArray(v) || v.length < 1 || v.length > 31) bad(key);
      return v.map((x) => Math.round(num(x, 0, 1e9) * 100) / 100);
    }
    case 'milestones': {
      if (!Array.isArray(v) || v.length > 50) bad(key);
      const list = v.map((m) => ({
        friends: Math.round(num(m && m.friends, 1, 1e7)),
        reward: Math.round(num(m && m.reward, 0, 1e9) * 100) / 100,
      }));
      const seen = new Set();
      for (const m of list) {
        if (seen.has(m.friends)) bad(key);
        seen.add(m.friends);
      }
      return list.sort((a, b) => a.friends - b.friends);
    }
    case 'short': {
      const s = String(v ?? '').trim();
      if (!s || s.length > 12) bad(key);
      return s;
    }
    case 'url': {
      const s = String(v ?? '').trim();
      if (s && !/^https:\/\/\S+$/i.test(s)) bad(key);
      return s;
    }
    case 'text': {
      const s = String(v ?? '');
      if (s.length > 2000) bad(key);
      return s;
    }
    case 'bool':
      return Boolean(v);
    default:
      bad(key);
  }
}

module.exports = {
  DEFAULTS,
  get: (key) => cache[key],
  all: () => JSON.parse(JSON.stringify(cache)),
  update(patch) {
    const clean = {};
    for (const [key, value] of Object.entries(patch || {})) {
      if (!(key in SCHEMA)) continue;
      clean[key] = validate(key, value);
    }
    db.transaction(() => {
      for (const [key, value] of Object.entries(clean)) upsert.run(key, JSON.stringify(value));
    })();
    Object.assign(cache, clean);
    return module.exports.all();
  },
};
