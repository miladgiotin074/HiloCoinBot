// Thin wrapper around the running bot so services can message users / verify
// channel membership without importing the bot module (avoids circular deps).
const db = require('./db');

let bot = null;

const markBlocked = db.prepare('UPDATE users SET bot_blocked = 1 WHERE id = ?');

function setBot(b) {
  bot = b;
}

function getBot() {
  return bot;
}

/** Sends a message; returns true on success. Never throws. */
async function send(chatId, text, extra = {}) {
  if (!bot) return false;
  try {
    await bot.api.sendMessage(chatId, text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });
    return true;
  } catch (err) {
    if (err && err.error_code === 403) markBlocked.run(chatId);
    return false;
  }
}

/**
 * Checks if a user is a member of a channel/group.
 * Returns true / false, or null when it can't be verified (bot not admin, bad chat id…).
 */
async function isMember(chatId, userId) {
  if (!bot || !chatId) return null;
  try {
    const m = await bot.api.getChatMember(chatId, userId);
    if (['creator', 'administrator', 'member'].includes(m.status)) return true;
    if (m.status === 'restricted') return Boolean(m.is_member);
    return false;
  } catch (err) {
    // "user not found" / "PARTICIPANT_ID_INVALID" mean the user is not in the chat.
    const desc = String((err && err.description) || '');
    if (/user not found|participant_id_invalid|member not found/i.test(desc)) return false;
    console.warn('[telegram] getChatMember failed for', chatId, '-', desc || err.message);
    return null;
  }
}

module.exports = { setBot, getBot, send, isMember };
