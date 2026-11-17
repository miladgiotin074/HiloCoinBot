const db = require('../db');
const settings = require('../settings');
const users = require('./users');
const telegram = require('../telegram');
const { AppError, now, toCents, fromCents } = require('../util');

const q = {
  count: db.prepare('SELECT COUNT(*) AS c FROM tasks'),
  insert: db.prepare(`
    INSERT INTO tasks (title, title_fa, type, url, chat_id, reward, icon, is_active, sort_order, created_at)
    VALUES (@title, @title_fa, @type, @url, @chat_id, @reward, @icon, @is_active, @sort_order, @created_at)`),
  update: db.prepare(`
    UPDATE tasks SET title = @title, title_fa = @title_fa, type = @type, url = @url, chat_id = @chat_id,
      reward = @reward, icon = @icon, is_active = @is_active, sort_order = @sort_order
    WHERE id = @id`),
  remove: db.prepare('DELETE FROM tasks WHERE id = ?'),
  removeProgress: db.prepare('DELETE FROM user_tasks WHERE task_id = ?'),
  get: db.prepare('SELECT * FROM tasks WHERE id = ?'),
  allAdmin: db.prepare(`
    SELECT t.*, (SELECT COUNT(*) FROM user_tasks ut WHERE ut.task_id = t.id AND ut.status = 'completed') AS completions
    FROM tasks t ORDER BY t.sort_order ASC, t.id ASC`),
  forUser: db.prepare(`
    SELECT t.id, t.title, t.title_fa, t.type, t.url, t.reward, t.icon, ut.status, ut.started_at
    FROM tasks t LEFT JOIN user_tasks ut ON ut.task_id = t.id AND ut.user_id = ?
    WHERE t.is_active = 1 ORDER BY t.sort_order ASC, t.id ASC`),
  progress: db.prepare('SELECT * FROM user_tasks WHERE user_id = ? AND task_id = ?'),
  start: db.prepare(`
    INSERT INTO user_tasks (user_id, task_id, status, started_at) VALUES (?, ?, 'started', ?)
    ON CONFLICT(user_id, task_id) DO NOTHING`),
  complete: db.prepare(
    "UPDATE user_tasks SET status = 'completed', completed_at = ? WHERE user_id = ? AND task_id = ? AND status != 'completed'"
  ),
};

// A few example tasks so the app isn't empty on first run — edit them in the admin panel.
if (q.count.get().c === 0) {
  const seed = [
    { title: 'Join the HiloCoin Telegram channel', title_fa: 'عضویت در کانال تلگرام HiloCoin', type: 'link', url: 'https://t.me/telegram', icon: '📢', reward: 100 },
    { title: 'Follow HiloCoin on X', title_fa: 'HiloCoin را در X دنبال کنید', type: 'link', url: 'https://x.com', icon: '🐦', reward: 75 },
    { title: 'Subscribe on YouTube', title_fa: 'در یوتیوب سابسکرایب کنید', type: 'link', url: 'https://youtube.com', icon: '▶️', reward: 75 },
    { title: 'Visit the HiloCoin website', title_fa: 'از وب‌سایت HiloCoin دیدن کنید', type: 'link', url: 'https://ton.org', icon: '🌐', reward: 50 },
  ];
  seed.forEach((s, i) =>
    q.insert.run({ ...s, chat_id: null, reward: toCents(s.reward), is_active: 1, sort_order: i + 1, created_at: now() })
  );
}

/* --------------------------------- Admin --------------------------------- */

function normalize(input) {
  const title = String(input.title || '').trim();
  const url = String(input.url || '').trim();
  const type = input.type === 'telegram' ? 'telegram' : 'link';
  if (!title || title.length > 120) throw new AppError(400, 'invalid_title');
  if (!/^https:\/\/\S+$/i.test(url)) throw new AppError(400, 'invalid_url');
  let chatId = String(input.chat_id || '').trim() || null;
  if (type === 'telegram' && !chatId) {
    // Derive @username from a public t.me link when possible.
    const m = url.match(/^https:\/\/t\.me\/([A-Za-z0-9_]{4,})\/?$/i);
    if (m) chatId = '@' + m[1];
  }
  if (chatId && !/^(@[A-Za-z0-9_]{4,}|-?\d{5,20})$/.test(chatId)) throw new AppError(400, 'invalid_chat_id');
  const reward = Number(input.reward);
  if (!Number.isFinite(reward) || reward < 0 || reward > 1e9) throw new AppError(400, 'invalid_reward');
  return {
    title,
    title_fa: String(input.title_fa || '').trim().slice(0, 120) || null,
    type,
    url,
    chat_id: type === 'telegram' ? chatId : null,
    reward: toCents(reward),
    icon: String(input.icon || '🔗').trim().slice(0, 8) || '🔗',
    is_active: input.is_active === false || input.is_active === 0 ? 0 : 1,
    sort_order: Math.round(Number(input.sort_order) || 0),
  };
}

const adminTask = (t) => ({ ...t, reward: fromCents(t.reward), is_active: !!t.is_active });

const admin = {
  list: () => q.allAdmin.all().map(adminTask),
  create(input) {
    const id = q.insert.run({ ...normalize(input), created_at: now() }).lastInsertRowid;
    return adminTask(q.get.get(id));
  },
  update(id, input) {
    if (!q.get.get(id)) throw new AppError(404, 'task_not_found');
    q.update.run({ ...normalize(input), id });
    return adminTask(q.get.get(id));
  },
  remove: db.transaction((id) => {
    q.removeProgress.run(id);
    q.remove.run(id);
  }),
};

/* ---------------------------------- User ---------------------------------- */

function listForUser(userId) {
  return q.forUser.all(userId).map((t) => ({
    id: t.id,
    title: t.title,
    title_fa: t.title_fa,
    type: t.type,
    url: t.url,
    icon: t.icon,
    reward: fromCents(t.reward),
    status: t.status || 'new',
  }));
}

function activeTask(id) {
  const task = q.get.get(id);
  if (!task || !task.is_active) throw new AppError(404, 'task_not_found');
  return task;
}

function start(userId, taskId) {
  activeTask(taskId);
  q.start.run(userId, taskId, now());
  return q.progress.get(userId, taskId).status;
}

const finish = db.transaction((userId, task) => {
  const res = q.complete.run(now(), userId, task.id);
  if (!res.changes) throw new AppError(400, 'already_completed');
  users.credit(userId, task.reward, 'task', { note: task.title });
  return { amount: fromCents(task.reward) };
});

async function check(userId, taskId) {
  const task = activeTask(taskId);
  const p = q.progress.get(userId, taskId);
  if (!p) throw new AppError(400, 'not_started');
  if (p.status === 'completed') throw new AppError(400, 'already_completed');

  let verified = null;
  if (task.type === 'telegram' && task.chat_id) {
    verified = await telegram.isMember(task.chat_id, userId);
    if (verified === false) throw new AppError(400, 'not_joined');
  }
  if (verified !== true) {
    // Link tasks (or channels the bot can't check) need the user to spend a few seconds there.
    const wait = Number(settings.get('task_link_wait_seconds')) * 1000;
    const left = p.started_at + wait - now();
    if (left > 0) throw new AppError(400, 'too_soon', { seconds: Math.ceil(left / 1000) });
  }
  return finish(userId, task);
}

module.exports = { admin, listForUser, start, check };
