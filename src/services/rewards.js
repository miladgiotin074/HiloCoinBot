// Daily check-in, mining (farming) sessions and referral milestones.
const db = require('../db');
const settings = require('../settings');
const users = require('./users');
const { AppError, DAY_MS, now, dayIndex, toCents, fromCents } = require('../util');

const q = {
  setDaily: db.prepare('UPDATE users SET daily_streak = ?, last_daily_at = ? WHERE id = ?'),
  setFarm: db.prepare('UPDATE users SET farm_started_at = ? WHERE id = ?'),
  claimedMilestones: db.prepare('SELECT friends, reward, claimed_at FROM user_milestones WHERE user_id = ?'),
  insertMilestone: db.prepare(
    'INSERT OR IGNORE INTO user_milestones (user_id, friends, reward, claimed_at) VALUES (?, ?, ?, ?)'
  ),
};

/* ----------------------------- Daily check-in ----------------------------- */

function dailyState(u, t = now()) {
  const rewards = settings.get('daily_rewards');
  const len = rewards.length;
  const today = dayIndex(t);
  const last = u.last_daily_at ? dayIndex(u.last_daily_at) : null;
  const claimedToday = last === today;
  const continues = last !== null && last === today - 1;
  const streak = claimedToday || continues ? u.daily_streak : 0;
  // How many cells of the current cycle are already ticked, and which one is "today".
  const done = claimedToday ? ((streak - 1) % len) + 1 : streak % len;
  const todayIdx = claimedToday ? done - 1 : done;
  return {
    rewards,
    streak,
    claimed_today: claimedToday,
    done,
    today_index: todayIdx,
    next_amount: rewards[claimedToday ? done % len : todayIdx],
    next_claim_at: claimedToday ? (today + 1) * DAY_MS : t,
  };
}

const claimDaily = db.transaction((userId) => {
  const u = users.get(userId);
  const t = now();
  const st = dailyState(u, t);
  if (st.claimed_today) throw new AppError(400, 'already_claimed', { next_claim_at: st.next_claim_at });
  const newStreak = st.streak + 1;
  const rewards = st.rewards;
  const amount = toCents(rewards[(newStreak - 1) % rewards.length]);
  q.setDaily.run(newStreak, t, userId);
  users.credit(userId, amount, 'daily', { note: `Day ${newStreak}` });
  return { amount: fromCents(amount), streak: newStreak };
});

/* --------------------------------- Mining --------------------------------- */

function farmState(u, t = now()) {
  const duration = Math.round(Number(settings.get('farm_hours')) * 3600 * 1000);
  const reward = Number(settings.get('farm_reward'));
  if (!u.farm_started_at) return { status: 'idle', duration, reward };
  const endsAt = u.farm_started_at + duration;
  return {
    status: t >= endsAt ? 'ready' : 'farming',
    started_at: u.farm_started_at,
    ends_at: endsAt,
    duration,
    reward,
  };
}

const startFarm = db.transaction((userId) => {
  const u = users.get(userId);
  if (u.farm_started_at) throw new AppError(400, 'already_farming');
  q.setFarm.run(now(), userId);
  return farmState(users.get(userId));
});

const claimFarm = db.transaction((userId) => {
  const u = users.get(userId);
  const st = farmState(u);
  if (st.status === 'idle') throw new AppError(400, 'not_farming');
  if (st.status !== 'ready') throw new AppError(400, 'farm_not_ready', { ends_at: st.ends_at });
  const amount = toCents(st.reward);
  q.setFarm.run(null, userId);
  users.credit(userId, amount, 'farm');
  return { amount: fromCents(amount) };
});

/* ------------------------------- Milestones ------------------------------- */

function milestones(u) {
  const claimed = new Map(q.claimedMilestones.all(u.id).map((r) => [r.friends, r]));
  return settings.get('milestones').map((m) => {
    const c = claimed.get(m.friends);
    return {
      friends: m.friends,
      reward: c ? fromCents(c.reward) : m.reward,
      claimed: !!c,
      claimable: !c && u.referral_count >= m.friends,
    };
  });
}

const claimMilestone = db.transaction((userId, friends) => {
  const u = users.get(userId);
  const m = settings.get('milestones').find((x) => x.friends === Number(friends));
  if (!m) throw new AppError(404, 'milestone_not_found');
  if (u.referral_count < m.friends) throw new AppError(400, 'milestone_locked');
  const cents = toCents(m.reward);
  const res = q.insertMilestone.run(userId, m.friends, cents, now());
  if (!res.changes) throw new AppError(400, 'already_claimed');
  users.credit(userId, cents, 'milestone', { note: `${m.friends} friends` });
  return { amount: fromCents(cents) };
});

module.exports = { dailyState, claimDaily, farmState, startFarm, claimFarm, milestones, claimMilestone };
