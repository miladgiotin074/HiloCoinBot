const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { webhookCallback } = require('grammy');
const config = require('./config');
const telegram = require('./telegram');
const { createBot, setupBot } = require('./bot');
const apiRouter = require('./routes/api');
const adminRouter = require('./routes/admin');
const { AppError } = require('./util');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
app.use(express.json({ limit: '64kb' }));

app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/api', apiRouter);
app.use('/admin/api', adminRouter);

const pub = path.join(__dirname, '..', 'public');
// Telegram's webview caches aggressively: always revalidate (cheap 304s via ETag) so updates show up.
const staticOpts = { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') };
app.use(
  '/admin',
  (req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Robots-Tag', 'noindex');
    next();
  },
  express.static(path.join(pub, 'admin'), staticOpts)
);
app.use('/', express.static(path.join(pub, 'app'), staticOpts));

// Telegram webhook (only used when BOT_MODE=webhook).
const bot = createBot();
const hookPath = `/telegram/${crypto.createHash('sha256').update(config.botToken || 'x').digest('hex').slice(0, 32)}`;
if (bot && config.botMode === 'webhook') app.post(hookPath, webhookCallback(bot, 'express'));

// 404 for unknown API routes
app.use(['/api', '/admin/api'], (req, res) => res.status(404).json({ error: 'not_found' }));

// Error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof AppError) return res.status(err.status).json({ error: err.code, ...err.extra });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json' });
  console.error('[http] error:', err);
  res.status(500).json({ error: 'server_error' });
});

app.listen(config.port, () => {
  console.log(`[http] HiloCoin server listening on http://localhost:${config.port}`);
  console.log(`[http] Mini App: ${config.webAppUrl || '(WEBAPP_URL not set)'}  |  Admin panel: /admin/`);
  if (!config.adminPassword) console.warn('[http] ADMIN_PASSWORD is not set — the admin panel is locked.');
  if (config.devMode) console.warn('[http] DEV_MODE is ON — open /?dev_user=123 in a browser. Never use this in production!');
});

async function startBot() {
  if (!bot) {
    console.warn('[bot] BOT_TOKEN is not set — running the web server only.');
    return;
  }
  try {
    await setupBot(bot);
    telegram.setBot(bot);
    if (config.botMode === 'webhook') {
      if (!/^https:\/\//.test(config.webAppUrl)) throw new Error('BOT_MODE=webhook needs an https WEBAPP_URL');
      await bot.api.setWebhook(config.webAppUrl + hookPath, {
        allowed_updates: ['message', 'my_chat_member'],
        drop_pending_updates: false,
      });
      console.log('[bot] webhook set');
    } else {
      await bot.api.deleteWebhook();
      bot.start({ allowed_updates: ['message', 'my_chat_member'], onStart: () => console.log('[bot] polling started') });
    }
  } catch (err) {
    console.error('[bot] failed to start:', err.message || err);
  }
}
startBot();

const shutdown = () => {
  if (bot && config.botMode !== 'webhook') bot.stop().finally(() => process.exit(0));
  else process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
