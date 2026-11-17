// REST API used by the Telegram Mini App.
const express = require('express');
const config = require('../config');
const settings = require('../settings');
const users = require('../services/users');
const rewards = require('../services/rewards');
const tasks = require('../services/tasks');
const { notifyReferral } = require('../bot');
const { validateInitData } = require('../auth');
const { AppError, asyncH, now } = require('../util');

const router = express.Router();

/* ------------------------------- Middleware ------------------------------- */

// Authenticates every request with Telegram initData ("Authorization: tma <initData>").
router.use((req, res, next) => {
  const h = req.get('authorization') || '';
  if (h.startsWith('tma ')) {
    const data = validateInitData(h.slice(4));
    if (!data) return next(new AppError(401, 'unauthorized'));
    req.tg = data;
    return next();
  }
  if (config.devMode && h.startsWith('dev ')) {
    const id = parseInt(h.slice(4), 10);
    if (!id) return next(new AppError(401, 'unauthorized'));
    req.tg = {
      user: { id, first_name: 'Dev', last_name: `#${id}`, username: `dev${id}`, language_code: 'en' },
      startParam: req.get('x-dev-start') || '',
    };
    return next();
  }
  next(new AppError(401, 'unauthorized'));
});

// Simple per-user rate limit: 40 requests / 10 seconds.
const hits = new Map();
setInterval(() => hits.clear(), 10_000).unref();
router.use((req, res, next) => {
  const id = req.tg.user.id;
  const n = (hits.get(id) || 0) + 1;
  hits.set(id, n);
  if (n > 40) return next(new AppError(429, 'too_many_requests'));
  next();
});

// Loads (or creates) the user record; blocks banned users and maintenance mode.
router.use((req, res, next) => {
  let user = users.get(req.tg.user.id);
  if (!user) {
    const r = users.register(req.tg.user, { refPayload: req.tg.startParam });
    user = r.user;
    req.registration = r;
  }
  if (user.is_banned) return next(new AppError(403, 'banned'));
  if (settings.get('maintenance') && !config.isAdminId(user.id)) return next(new AppError(503, 'maintenance'));
  req.user = user;
  next();
});

/* --------------------------------- Helpers -------------------------------- */

function publicConfig() {
  const s = settings.all();
  return {
    currency: s.currency_symbol,
    token_name: s.token_name,
    bot_username: config.botUsername,
    welcome_bonus: s.welcome_bonus,
    referral_bonus: s.referral_bonus,
    referral_bonus_premium: s.referral_bonus_premium,
    invitee_bonus: s.invitee_bonus,
    commission_percent: s.referral_commission_percent,
    farm_hours: s.farm_hours,
    farm_reward: s.farm_reward,
    channel_url: s.channel_url,
    support_url: s.support_url,
    airdrop_text_en: s.airdrop_text_en,
    airdrop_text_fa: s.airdrop_text_fa,
  };
}

const fresh = (req) => users.get(req.user.id);

function snapshot(u) {
  return {
    user: users.publicUser(u),
    daily: rewards.dailyState(u),
    farm: rewards.farmState(u),
    rank: users.rankOf(u),
    now: now(),
  };
}

/* --------------------------------- Routes --------------------------------- */

router.post(
  '/init',
  asyncH(async (req, res) => {
    // Refresh profile (name, photo, premium) on every app open.
    const r = req.registration || users.register(req.tg.user, { refPayload: req.tg.startParam });
    if (r.isNew && r.referrer) notifyReferral(r.referrer, r.user, r.referralBonus);
    const u = r.user;
    res.json({
      ...snapshot(u),
      is_new: r.isNew,
      welcome: users.welcomeInfo(u),
      ref_link: users.refLink(u.id),
      config: publicConfig(),
      total_users: users.countUsers(),
    });
  })
);

router.get('/me', (req, res) => res.json(snapshot(fresh(req))));

router.post('/welcome/seen', (req, res) => {
  users.markWelcomeSeen(req.user.id);
  res.json({ ok: true });
});

router.post('/lang', (req, res) => {
  const lang = req.body && req.body.lang === 'fa' ? 'fa' : 'en';
  users.setLang(req.user.id, lang);
  res.json({ ok: true, lang });
});

router.post('/daily/claim', (req, res) => {
  const r = rewards.claimDaily(req.user.id);
  res.json({ ...r, ...snapshot(fresh(req)) });
});

router.post('/farm/start', (req, res) => {
  rewards.startFarm(req.user.id);
  res.json(snapshot(fresh(req)));
});

router.post('/farm/claim', (req, res) => {
  const r = rewards.claimFarm(req.user.id);
  res.json({ ...r, ...snapshot(fresh(req)) });
});

router.get('/tasks', (req, res) => res.json({ tasks: tasks.listForUser(req.user.id) }));

router.post('/tasks/:id/start', (req, res) => {
  const status = tasks.start(req.user.id, Number(req.params.id));
  res.json({ status });
});

router.post(
  '/tasks/:id/check',
  asyncH(async (req, res) => {
    const r = await tasks.check(req.user.id, Number(req.params.id));
    res.json({ ...r, ...snapshot(fresh(req)) });
  })
);

router.get('/friends', (req, res) => {
  const u = req.user;
  res.json({
    ref_link: users.refLink(u.id),
    count: u.referral_count,
    earned: users.publicUser(u).referral_earnings,
    friends: users.friends(u),
    milestones: rewards.milestones(u),
  });
});

router.post('/milestones/:friends/claim', (req, res) => {
  const r = rewards.claimMilestone(req.user.id, Number(req.params.friends));
  const u = fresh(req);
  res.json({ ...r, ...snapshot(u), milestones: rewards.milestones(u) });
});

router.get('/leaderboard', (req, res) => res.json(users.leaderboard(req.user)));

router.get('/transactions', (req, res) => res.json({ transactions: users.transactions(req.user, 50) }));

router.post('/wallet', (req, res) => {
  const address = users.setWallet(req.user, req.body && req.body.address);
  res.json({ ok: true, wallet_address: address });
});

module.exports = router;
