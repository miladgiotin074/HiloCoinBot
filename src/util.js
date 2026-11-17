const DAY_MS = 24 * 60 * 60 * 1000;

class AppError extends Error {
  constructor(status, code, extra = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const now = () => Date.now();
const dayIndex = (ms) => Math.floor(ms / DAY_MS); // UTC day number
const startOfDay = (ms = Date.now()) => dayIndex(ms) * DAY_MS;

// Money is stored as integer cents in the database and exposed as dollars in the API.
const toCents = (dollars) => Math.round((Number(dollars) || 0) * 100);
const fromCents = (cents) => Math.round(Number(cents) || 0) / 100;

const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const displayName = (u) => {
  if (!u) return '';
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ').trim();
  return name || (u.username ? '@' + u.username : 'User ' + u.id);
};

module.exports = { DAY_MS, AppError, now, dayIndex, startOfDay, toCents, fromCents, asyncH, sleep, escapeHtml, displayName };
