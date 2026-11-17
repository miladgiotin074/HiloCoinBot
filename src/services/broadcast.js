// Sends a message to every user who started the bot, respecting Telegram rate limits.
const db = require('../db');
const config = require('../config');
const telegram = require('../telegram');
const { AppError, now, sleep } = require('../util');

let running = null; // { id, stop: boolean }

const q = {
  insert: db.prepare(
    "INSERT INTO broadcasts (text, button_text, button_url, target, status, total, created_at) VALUES (?, ?, ?, ?, 'running', ?, ?)"
  ),
  progress: db.prepare('UPDATE broadcasts SET sent = ?, failed = ? WHERE id = ?'),
  finish: db.prepare('UPDATE broadcasts SET status = ?, sent = ?, failed = ?, finished_at = ? WHERE id = ?'),
  list: db.prepare('SELECT * FROM broadcasts ORDER BY id DESC LIMIT 20'),
  recipients: db.prepare(
    'SELECT id FROM users WHERE bot_started = 1 AND bot_blocked = 0 AND is_banned = 0 AND id > ? ORDER BY id LIMIT 500'
  ),
  count: db.prepare('SELECT COUNT(*) AS c FROM users WHERE bot_started = 1 AND bot_blocked = 0 AND is_banned = 0'),
  markBlocked: db.prepare('UPDATE users SET bot_blocked = 1 WHERE id = ?'),
};

// Mark interrupted broadcasts (server restarted mid-way).
db.prepare("UPDATE broadcasts SET status = 'stopped' WHERE status = 'running'").run();

function buildExtra({ button_text, button_url, open_app, html }) {
  const extra = { link_preview_options: { is_disabled: false } };
  if (html) extra.parse_mode = 'HTML';
  if (button_text) {
    if (open_app && /^https:\/\//.test(config.webAppUrl)) {
      extra.reply_markup = { inline_keyboard: [[{ text: button_text, web_app: { url: config.webAppUrl + '/' } }]] };
    } else if (button_url) {
      extra.reply_markup = { inline_keyboard: [[{ text: button_text, url: button_url }]] };
    }
  }
  return extra;
}

function validate(input) {
  const text = String(input.text || '').trim();
  if (!text || text.length > 4000) throw new AppError(400, 'invalid_text');
  const button_text = String(input.button_text || '').trim().slice(0, 64);
  const button_url = String(input.button_url || '').trim();
  if (button_text && !input.open_app && !/^https:\/\/\S+$/i.test(button_url)) throw new AppError(400, 'invalid_url');
  return { text, button_text, button_url, open_app: !!input.open_app, html: !!input.html };
}

async function sendOne(chatId, msg, extra) {
  const bot = telegram.getBot();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await bot.api.sendMessage(chatId, msg, extra);
      return true;
    } catch (err) {
      if (err && err.error_code === 429) {
        const wait = ((err.parameters && err.parameters.retry_after) || 3) * 1000;
        await sleep(wait);
        continue;
      }
      if (err && err.error_code === 403) q.markBlocked.run(chatId);
      if (err && err.error_code === 400 && /parse entities/i.test(err.description || '')) {
        throw new AppError(400, 'invalid_html');
      }
      return false;
    }
  }
  return false;
}

/** Sends to the admins listed in ADMIN_IDS only. */
async function test(input) {
  if (!telegram.getBot()) throw new AppError(400, 'bot_not_running');
  const v = validate(input);
  if (!config.adminIds.length) throw new AppError(400, 'no_admin_ids');
  const extra = buildExtra(v);
  let sent = 0;
  for (const id of config.adminIds) if (await sendOne(id, v.text, extra)) sent++;
  return { sent, total: config.adminIds.length };
}

function start(input) {
  if (!telegram.getBot()) throw new AppError(400, 'bot_not_running');
  if (running) throw new AppError(409, 'broadcast_running');
  const v = validate(input);
  const total = q.count.get().c;
  const id = q.insert.run(v.text, v.button_text || null, v.button_url || null, 'all', total, now()).lastInsertRowid;
  running = { id, stop: false };
  const extra = buildExtra(v);

  (async () => {
    let sent = 0;
    let failed = 0;
    let lastId = 0;
    let status = 'done';
    try {
      outer: for (;;) {
        const batch = q.recipients.all(lastId);
        if (!batch.length) break;
        for (const r of batch) {
          if (running.stop) {
            status = 'stopped';
            break outer;
          }
          lastId = r.id;
          if (await sendOne(r.id, v.text, extra)) sent++;
          else failed++;
          if ((sent + failed) % 25 === 0) q.progress.run(sent, failed, id);
          await sleep(40); // ~25 messages / second
        }
      }
    } catch (err) {
      console.error('[broadcast] failed:', err);
      status = 'failed';
    }
    q.finish.run(status, sent, failed, now(), id);
    running = null;
  })();

  return { id, total };
}

function stop() {
  if (running) running.stop = true;
  return { ok: true };
}

module.exports = { start, stop, test, list: () => q.list.all(), isRunning: () => !!running };
