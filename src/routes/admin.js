// REST API for the admin panel (/admin/api/*).
const express = require('express');
const db = require('../db');
const config = require('../config');
const settings = require('../settings');
const users = require('../services/users');
const tasks = require('../services/tasks');
const broadcast = require('../services/broadcast');
const telegram = require('../telegram');
const { createAdminToken, verifyAdminToken, checkAdminPassword } = require('../auth');
const { AppError, asyncH, now, startOfDay, DAY_MS, toCents, fromCents } = require('../util');

const router = express.Router();

/* ---------------------------------- Login ---------------------------------- */

const failures = new Map(); // ip -> { n, until }
router.post('/login', (req, res, next) => {
  if (!config.adminPassword) return next(new AppError(503, 'admin_password_not_set'));
  const ip = req.ip;
  const f = failures.get(ip);
  if (f && f.n >= 8 && f.until > Date.now()) return next(new AppError(429, 'too_many_attempts'));
  if (!checkAdminPassword(req.body && req.body.password)) {
    const n = f && f.until > Date.now() ? f.n + 1 : 1;
    failures.set(ip, { n, until: Date.now() + 15 * 60 * 1000 });
    return next(new AppError(401, 'wrong_password'));
  }
  failures.delete(ip);
  res.json({ token: createAdminToken() });
});

router.use((req, res, next) => {
  const h = req.get('authorization') || '';
  if (!h.startsWith('Bearer ') || !verifyAdminToken(h.slice(7))) return next(new AppError(401, 'unauthorized'));
  next();
});

/* -------------------------------- Dashboard -------------------------------- */

const one = (sql, ...p) => db.prepare(sql).get(...p);

router.get('/stats', (req, res) => {
  const today = startOfDay();
  const from = today - 13 * DAY_MS;
  const signupRows = db
    .prepare('SELECT created_at / ? AS d, COUNT(*) AS c FROM users WHERE created_at >= ? GROUP BY d')
    .all(DAY_MS, from);
  const byDay = new Map(signupRows.map((r) => [Math.floor(r.d), r.c]));
  const signups = [];
  for (let i = 0; i < 14; i++) {
    const d = Math.floor(from / DAY_MS) + i;
    signups.push({ date: new Date(d * DAY_MS).toISOString().slice(0, 10), count: byDay.get(d) || 0 });
  }

  res.json({
    total_users: one('SELECT COUNT(*) c FROM users').c,
    new_today: one('SELECT COUNT(*) c FROM users WHERE created_at >= ?', today).c,
    new_week: one('SELECT COUNT(*) c FROM users WHERE created_at >= ?', today - 6 * DAY_MS).c,
    active_today: one('SELECT COUNT(*) c FROM users WHERE last_seen_at >= ?', today).c,
    active_week: one('SELECT COUNT(*) c FROM users WHERE last_seen_at >= ?', today - 6 * DAY_MS).c,
    referred: one('SELECT COUNT(*) c FROM users WHERE referrer_id IS NOT NULL').c,
    wallets: one('SELECT COUNT(*) c FROM users WHERE wallet_address IS NOT NULL').c,
    banned: one('SELECT COUNT(*) c FROM users WHERE is_banned = 1').c,
    premium: one('SELECT COUNT(*) c FROM users WHERE is_premium = 1').c,
    reachable: one('SELECT COUNT(*) c FROM users WHERE bot_started = 1 AND bot_blocked = 0 AND is_banned = 0').c,
    total_balance: fromCents(one('SELECT COALESCE(SUM(balance),0) s FROM users').s),
    tasks_completed: one("SELECT COUNT(*) c FROM user_tasks WHERE status = 'completed'").c,
    daily_claims_today: one("SELECT COUNT(*) c FROM transactions WHERE type = 'daily' AND created_at >= ?", today).c,
    signups,
    top_referrers: db
      .prepare(
        'SELECT id, first_name, last_name, username, referral_count, referral_earnings FROM users WHERE referral_count > 0 ORDER BY referral_count DESC LIMIT 10'
      )
      .all()
      .map((u) => ({ ...u, referral_earnings: fromCents(u.referral_earnings) })),
    recent_users: db
      .prepare('SELECT id, first_name, last_name, username, balance, created_at, referrer_id FROM users ORDER BY created_at DESC LIMIT 10')
      .all()
      .map((u) => ({ ...u, balance: fromCents(u.balance) })),
    bot_running: !!telegram.getBot(),
    bot_username: config.botUsername,
    webapp_url: config.webAppUrl,
  });
});

/* ---------------------------------- Users ---------------------------------- */

const SORTS = {
  newest: 'created_at DESC',
  oldest: 'created_at ASC',
  balance: 'balance DESC',
  referrals: 'referral_count DESC',
  active: 'last_seen_at DESC',
};

function userFilter(query) {
  const where = [];
  const params = [];
  const s = String(query.q || '').trim();
  if (s) {
    const like = `%${s.replace(/^@/, '').replace(/[%_]/g, '')}%`;
    if (/^\d+$/.test(s)) {
      where.push('(id = ? OR username LIKE ? OR first_name LIKE ?)');
      params.push(Number(s), like, like);
    } else {
      where.push("(username LIKE ? OR first_name LIKE ? OR last_name LIKE ? OR wallet_address LIKE ?)");
      params.push(like, like, like, like);
    }
  }
  if (query.filter === 'banned') where.push('is_banned = 1');
  if (query.filter === 'wallet') where.push('wallet_address IS NOT NULL');
  if (query.filter === 'premium') where.push('is_premium = 1');
  if (query.filter === 'referred') where.push('referrer_id IS NOT NULL');
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

const adminUser = (u) => ({
  ...u,
  balance: fromCents(u.balance),
  total_earned: fromCents(u.total_earned),
  referral_earnings: fromCents(u.referral_earnings),
});

router.get('/users', (req, res) => {
  const { sql, params } = userFilter(req.query);
  const order = SORTS[req.query.sort] || SORTS.newest;
  const pageSize = 25;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const total = one(`SELECT COUNT(*) c FROM users ${sql}`, ...params).c;
  const rows = db
    .prepare(`SELECT * FROM users ${sql} ORDER BY ${order}, id DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize);
  res.json({ users: rows.map(adminUser), total, page, pages: Math.max(1, Math.ceil(total / pageSize)) });
});

router.get('/users.csv', (req, res) => {
  const { sql, params } = userFilter(req.query);
  const rows = db.prepare(`SELECT * FROM users ${sql} ORDER BY created_at ASC`).all(...params);
  const cols = ['id', 'username', 'first_name', 'last_name', 'balance', 'referral_count', 'referrer_id', 'wallet_address', 'is_premium', 'is_banned', 'created_at'];
  const cell = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(',')].concat(
    rows.map((r) =>
      cols
        .map((c) => (c === 'balance' ? fromCents(r.balance) : c === 'created_at' ? new Date(r.created_at).toISOString() : r[c]))
        .map(cell)
        .join(',')
    )
  );
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="hilocoin-users.csv"');
  res.send('﻿' + lines.join('\n'));
});

function requireUser(id) {
  const u = users.get(Number(id));
  if (!u) throw new AppError(404, 'user_not_found');
  return u;
}

router.get('/users/:id', (req, res) => {
  const u = requireUser(req.params.id);
  const referrer = u.referrer_id ? users.get(u.referrer_id) : null;
  res.json({
    user: adminUser(u),
    rank: users.rankOf(u),
    referrer: referrer ? { id: referrer.id, first_name: referrer.first_name, username: referrer.username } : null,
    referrals: db
      .prepare('SELECT id, first_name, last_name, username, is_premium, balance, created_at FROM users WHERE referrer_id = ? ORDER BY created_at DESC LIMIT 100')
      .all(u.id)
      .map((r) => ({ ...r, balance: fromCents(r.balance) })),
    transactions: db
      .prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 100')
      .all(u.id)
      .map((t) => ({ ...t, amount: fromCents(t.amount) })),
    tasks_completed: one("SELECT COUNT(*) c FROM user_tasks WHERE user_id = ? AND status = 'completed'", u.id).c,
  });
});

router.post('/users/:id/balance', (req, res) => {
  const u = requireUser(req.params.id);
  const cents = toCents(req.body && req.body.amount);
  if (!cents || Math.abs(cents) > 1e11) throw new AppError(400, 'invalid_amount');
  if (u.balance + cents < 0) throw new AppError(400, 'insufficient_balance');
  const note = String((req.body && req.body.note) || '').slice(0, 200) || null;
  db.transaction(() => users.credit(u.id, cents, 'admin', { note }))();
  res.json({ user: adminUser(users.get(u.id)) });
});

router.post('/users/:id/ban', (req, res) => {
  const u = requireUser(req.params.id);
  const banned = req.body && req.body.banned ? 1 : 0;
  db.prepare('UPDATE users SET is_banned = ? WHERE id = ?').run(banned, u.id);
  res.json({ user: adminUser(users.get(u.id)) });
});

router.post('/users/:id/message', asyncH(async (req, res) => {
  const u = requireUser(req.params.id);
  const text = String((req.body && req.body.text) || '').trim();
  if (!text || text.length > 4000) throw new AppError(400, 'invalid_text');
  if (!telegram.getBot()) throw new AppError(400, 'bot_not_running');
  const ok = await telegram.send(u.id, text, { parse_mode: undefined });
  if (!ok) throw new AppError(400, 'send_failed');
  res.json({ ok: true });
}));

/* ---------------------------------- Tasks ---------------------------------- */

router.get('/tasks', (req, res) => res.json({ tasks: tasks.admin.list() }));
router.post('/tasks', (req, res) => res.json({ task: tasks.admin.create(req.body || {}) }));
router.put('/tasks/:id', (req, res) => res.json({ task: tasks.admin.update(Number(req.params.id), req.body || {}) }));
router.delete('/tasks/:id', (req, res) => {
  tasks.admin.remove(Number(req.params.id));
  res.json({ ok: true });
});

/* --------------------------------- Settings -------------------------------- */

router.get('/settings', (req, res) => res.json({ settings: settings.all(), defaults: settings.DEFAULTS }));
router.put('/settings', (req, res) => res.json({ settings: settings.update(req.body || {}) }));

/* -------------------------------- Broadcast -------------------------------- */

router.get('/broadcasts', (req, res) =>
  res.json({ broadcasts: broadcast.list(), running: broadcast.isRunning(), admin_ids: config.adminIds.length })
);
router.post('/broadcasts', (req, res) => res.json(broadcast.start(req.body || {})));
router.post('/broadcasts/test', asyncH(async (req, res) => res.json(await broadcast.test(req.body || {}))));
router.post('/broadcasts/stop', (req, res) => res.json(broadcast.stop()));

module.exports = router;
