const db = require('../db');
const config = require('../config');
const settings = require('../settings');
const { AppError, now, toCents, fromCents } = require('../util');

// Earnings from these sources pay a commission to the user's referrer.
const COMMISSIONABLE = new Set(['daily', 'farm', 'task']);

const q = {
  get: db.prepare('SELECT * FROM users WHERE id = ?'),
  insert: db.prepare(`
    INSERT INTO users (id, username, first_name, last_name, language_code, photo_url, is_premium,
                       referrer_id, bot_started, created_at, last_seen_at)
    VALUES (@id, @username, @first_name, @last_name, @language_code, @photo_url, @is_premium,
            @referrer_id, @bot_started, @now, @now)`),
  updateProfile: db.prepare(`
    UPDATE users SET username = @username, first_name = @first_name, last_name = @last_name,
      language_code = @language_code, photo_url = COALESCE(@photo_url, photo_url),
      is_premium = @is_premium, last_seen_at = @now,
      bot_started = MAX(bot_started, @bot_started),
      bot_blocked = CASE WHEN @bot_started = 1 THEN 0 ELSE bot_blocked END
    WHERE id = @id`),
  addBalance: db.prepare('UPDATE users SET balance = balance + ?, total_earned = total_earned + ? WHERE id = ?'),
  addRefEarnings: db.prepare('UPDATE users SET referral_earnings = referral_earnings + ? WHERE id = ?'),
  incRefCount: db.prepare('UPDATE users SET referral_count = referral_count + 1 WHERE id = ?'),
  insertTx: db.prepare(
    'INSERT INTO transactions (user_id, amount, type, from_user_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ),
  welcomeTx: db.prepare(
    "SELECT type, amount, from_user_id FROM transactions WHERE user_id = ? AND type IN ('welcome','invitee_bonus')"
  ),
  setWelcomeSeen: db.prepare('UPDATE users SET welcome_seen = 1 WHERE id = ?'),
  setLang: db.prepare('UPDATE users SET lang = ? WHERE id = ?'),
  setWallet: db.prepare('UPDATE users SET wallet_address = ? WHERE id = ?'),
  walletTaken: db.prepare('SELECT id FROM users WHERE wallet_address = ? AND id != ? LIMIT 1'),
  rank: db.prepare(
    'SELECT COUNT(*) AS c FROM users WHERE is_banned = 0 AND (balance > ? OR (balance = ? AND id < ?))'
  ),
  countUsers: db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_banned = 0'),
  top: db.prepare(`
    SELECT id, first_name, last_name, photo_url, is_premium, balance
    FROM users WHERE is_banned = 0 ORDER BY balance DESC, id ASC LIMIT ?`),
  friends: db.prepare(`
    SELECT u.id, u.first_name, u.last_name, u.photo_url, u.is_premium, u.created_at,
      COALESCE((SELECT SUM(t.amount) FROM transactions t WHERE t.user_id = ? AND t.from_user_id = u.id), 0) AS earned
    FROM users u WHERE u.referrer_id = ? ORDER BY u.created_at DESC LIMIT ?`),
  txs: db.prepare('SELECT id, amount, type, note, created_at FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT ?'),
};

const get = (id) => q.get.get(id);

/**
 * Adds (or subtracts) cents to a user's balance and records it in the ledger.
 * Commissionable earnings also pay the referrer their percentage.
 * Must be called inside a transaction when combined with other writes.
 */
function credit(userId, cents, type, opts = {}) {
  cents = Math.trunc(cents);
  if (!cents) return 0;
  q.addBalance.run(cents, cents > 0 ? cents : 0, userId);
  q.insertTx.run(userId, cents, type, opts.fromUserId ?? null, opts.note ?? null, now());
  if (opts.referralEarning) q.addRefEarnings.run(cents, userId);

  if (cents > 0 && COMMISSIONABLE.has(type)) {
    const pct = Number(settings.get('referral_commission_percent')) || 0;
    const u = q.get.get(userId);
    if (pct > 0 && u && u.referrer_id) {
      const ref = q.get.get(u.referrer_id);
      const c = Math.floor((cents * pct) / 100);
      if (ref && !ref.is_banned && c > 0) {
        credit(ref.id, c, 'commission', { fromUserId: userId, referralEarning: true });
      }
    }
  }
  return cents;
}

const parseRef = (payload) => {
  const m = String(payload || '').match(/^(?:ref_?)?(\d{3,15})$/i);
  return m ? Number(m[1]) : null;
};

/**
 * Creates the user on first contact (granting the welcome bonus and referral rewards)
 * or refreshes their profile on later visits.
 */
const register = db.transaction((tg, opts = {}) => {
  if (!tg || !tg.id || tg.is_bot) throw new AppError(400, 'invalid_user');
  const t = now();
  const row = {
    id: tg.id,
    username: tg.username || null,
    first_name: String(tg.first_name || '').slice(0, 128),
    last_name: tg.last_name ? String(tg.last_name).slice(0, 128) : null,
    language_code: tg.language_code || null,
    photo_url: tg.photo_url || null,
    is_premium: tg.is_premium ? 1 : 0,
    bot_started: opts.fromBot ? 1 : 0,
    now: t,
  };

  const existing = q.get.get(tg.id);
  if (existing) {
    q.updateProfile.run(row);
    return { user: q.get.get(tg.id), isNew: false, referrer: null, referralBonus: 0 };
  }

  let referrer = null;
  const refId = parseRef(opts.refPayload);
  if (refId && refId !== tg.id) {
    referrer = q.get.get(refId);
    if (referrer && referrer.is_banned) referrer = null;
  }

  q.insert.run({ ...row, referrer_id: referrer ? referrer.id : null });
  credit(tg.id, toCents(settings.get('welcome_bonus')), 'welcome');

  let referralBonus = 0;
  if (referrer) {
    credit(tg.id, toCents(settings.get('invitee_bonus')), 'invitee_bonus', { fromUserId: referrer.id });
    referralBonus = toCents(settings.get(row.is_premium ? 'referral_bonus_premium' : 'referral_bonus'));
    q.incRefCount.run(referrer.id);
    credit(referrer.id, referralBonus, 'referral', { fromUserId: tg.id, referralEarning: true });
  }

  return {
    user: q.get.get(tg.id),
    isNew: true,
    referrer: referrer ? q.get.get(referrer.id) : null,
    referralBonus,
  };
});

function publicUser(u) {
  return {
    id: u.id,
    first_name: u.first_name,
    last_name: u.last_name,
    username: u.username,
    photo_url: u.photo_url,
    is_premium: !!u.is_premium,
    balance: fromCents(u.balance),
    total_earned: fromCents(u.total_earned),
    referral_count: u.referral_count,
    referral_earnings: fromCents(u.referral_earnings),
    wallet_address: u.wallet_address,
    lang: u.lang,
    created_at: u.created_at,
  };
}

function welcomeInfo(u) {
  if (u.welcome_seen) return null;
  const rows = q.welcomeTx.all(u.id);
  const welcome = rows.find((r) => r.type === 'welcome');
  const bonus = rows.find((r) => r.type === 'invitee_bonus');
  const inviter = bonus && bonus.from_user_id ? q.get.get(bonus.from_user_id) : null;
  return {
    amount: fromCents(welcome ? welcome.amount : 0),
    bonus: fromCents(bonus ? bonus.amount : 0),
    inviter: inviter ? inviter.first_name : null,
  };
}

function rankOf(u) {
  if (u.is_banned) return null;
  return q.rank.get(u.balance, u.balance, u.id).c + 1;
}

let topCache = { at: 0, rows: [] };
function leaderboard(u) {
  if (Date.now() - topCache.at > 15000) {
    topCache = {
      at: Date.now(),
      rows: q.top.all(100).map((r) => ({
        id: r.id,
        name: [r.first_name, r.last_name].filter(Boolean).join(' ') || 'User',
        photo_url: r.photo_url,
        is_premium: !!r.is_premium,
        balance: fromCents(r.balance),
      })),
      total: q.countUsers.get().c,
    };
  }
  return { top: topCache.rows, total: topCache.total, me: { rank: rankOf(u), balance: fromCents(u.balance) } };
}

function friends(u) {
  const list = q.friends.all(u.id, u.id, 200).map((f) => ({
    id: f.id,
    name: [f.first_name, f.last_name].filter(Boolean).join(' ') || 'User',
    photo_url: f.photo_url,
    is_premium: !!f.is_premium,
    joined_at: f.created_at,
    earned: fromCents(f.earned),
  }));
  return list;
}

function transactions(u, limit = 50) {
  return q.txs.all(u.id, limit).map((t) => ({ ...t, amount: fromCents(t.amount) }));
}

const TON_RE = /^(?:[EUk0]Q[A-Za-z0-9_-]{46}|-?[01]:[0-9a-fA-F]{64})$/;

function setWallet(u, address) {
  const addr = String(address || '').trim();
  if (!addr) {
    q.setWallet.run(null, u.id);
    return null;
  }
  if (!TON_RE.test(addr)) throw new AppError(400, 'invalid_wallet');
  if (q.walletTaken.get(addr, u.id)) throw new AppError(409, 'wallet_taken');
  q.setWallet.run(addr, u.id);
  return addr;
}

module.exports = {
  get,
  credit,
  register,
  parseRef,
  publicUser,
  welcomeInfo,
  rankOf,
  leaderboard,
  friends,
  transactions,
  setWallet,
  markWelcomeSeen: (id) => q.setWelcomeSeen.run(id),
  setLang: (id, lang) => q.setLang.run(lang, id),
  countUsers: () => q.countUsers.get().c,
  refLink: (id) => `https://t.me/${config.botUsername}?start=ref_${id}`,
};
