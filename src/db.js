const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');

// All money columns are integer cents.
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id                INTEGER PRIMARY KEY,           -- Telegram user id
  username          TEXT,
  first_name        TEXT NOT NULL DEFAULT '',
  last_name         TEXT,
  language_code     TEXT,
  photo_url         TEXT,
  is_premium        INTEGER NOT NULL DEFAULT 0,
  balance           INTEGER NOT NULL DEFAULT 0,
  total_earned      INTEGER NOT NULL DEFAULT 0,
  referrer_id       INTEGER,
  referral_count    INTEGER NOT NULL DEFAULT 0,
  referral_earnings INTEGER NOT NULL DEFAULT 0,
  wallet_address    TEXT,
  daily_streak      INTEGER NOT NULL DEFAULT 0,
  last_daily_at     INTEGER,
  farm_started_at   INTEGER,
  welcome_seen      INTEGER NOT NULL DEFAULT 0,
  bot_started       INTEGER NOT NULL DEFAULT 0,
  bot_blocked       INTEGER NOT NULL DEFAULT 0,
  is_banned         INTEGER NOT NULL DEFAULT 0,
  lang              TEXT,
  created_at        INTEGER NOT NULL,
  last_seen_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_referrer ON users(referrer_id, created_at);
CREATE INDEX IF NOT EXISTS idx_users_balance  ON users(balance DESC, id);
CREATE INDEX IF NOT EXISTS idx_users_created  ON users(created_at);
CREATE INDEX IF NOT EXISTS idx_users_seen     ON users(last_seen_at);

CREATE TABLE IF NOT EXISTS transactions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL,
  amount       INTEGER NOT NULL,
  type         TEXT NOT NULL,       -- welcome, invitee_bonus, referral, commission, daily, farm, task, milestone, admin
  from_user_id INTEGER,
  note         TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_tx_from ON transactions(user_id, from_user_id);
CREATE INDEX IF NOT EXISTS idx_tx_type ON transactions(type, created_at);

CREATE TABLE IF NOT EXISTS tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  title_fa    TEXT,
  type        TEXT NOT NULL DEFAULT 'link',  -- link | telegram
  url         TEXT NOT NULL,
  chat_id     TEXT,                          -- @channel or -100... (telegram tasks)
  reward      INTEGER NOT NULL DEFAULT 0,
  icon        TEXT NOT NULL DEFAULT '🔗',
  is_active   INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_tasks (
  user_id      INTEGER NOT NULL,
  task_id      INTEGER NOT NULL,
  status       TEXT NOT NULL,     -- started | completed
  started_at   INTEGER,
  completed_at INTEGER,
  PRIMARY KEY (user_id, task_id)
);
CREATE INDEX IF NOT EXISTS idx_user_tasks_task ON user_tasks(task_id, status);

CREATE TABLE IF NOT EXISTS user_milestones (
  user_id    INTEGER NOT NULL,
  friends    INTEGER NOT NULL,
  reward     INTEGER NOT NULL,
  claimed_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, friends)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS broadcasts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  text        TEXT NOT NULL,
  button_text TEXT,
  button_url  TEXT,
  target      TEXT NOT NULL DEFAULT 'all',
  status      TEXT NOT NULL,      -- running | done | stopped | failed
  total       INTEGER NOT NULL DEFAULT 0,
  sent        INTEGER NOT NULL DEFAULT 0,
  failed      INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  finished_at INTEGER
);
`);

module.exports = db;
