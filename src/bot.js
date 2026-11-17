const { Bot, InlineKeyboard } = require('grammy');
const config = require('./config');
const settings = require('./settings');
const users = require('./services/users');
const telegram = require('./telegram');
const db = require('./db');
const { fromCents, escapeHtml, displayName, startOfDay } = require('./util');

const isFa = (lang) => /^fa|^ps/i.test(String(lang || ''));
const money = (dollars) =>
  settings.get('currency_symbol') +
  Number(dollars).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

const TEXT = {
  en: {
    welcomeNew: (name, bonus) =>
      `🎉 <b>Welcome to HiloCoin, ${name}!</b>\n\n` +
      `🎁 You just received a <b>${bonus}</b> welcome bonus!\n\n` +
      `💰 Mine every few hours, claim daily rewards, complete tasks and invite friends to grow your balance before the <b>${settings.get('token_name')}</b> airdrop.\n\n` +
      `👇 Tap the button below to open the app.`,
    welcomeBack: (name, balance) =>
      `👋 <b>Welcome back, ${name}!</b>\n\n💰 Your balance: <b>${balance}</b>\n\n👇 Open the app to keep earning.`,
    open: '🚀 Open HiloCoin',
    invite: '👥 Invite friends',
    channel: '📢 Our channel',
    shareText: (bonus) => `🎁 Join me on HiloCoin and get a ${bonus} welcome bonus! 🚀`,
    friendJoined: (name, amount, premium) =>
      `🎉 <b>${name}</b> joined HiloCoin with your link${premium ? ' ⭐ (Premium)' : ''}!\n💰 <b>+${amount}</b> added to your balance.`,
    banned: '⛔️ Your account has been suspended.',
    noApp: '⚠️ The Mini App URL is not configured yet (WEBAPP_URL must be an https address).',
    balance: (b, f) => `💰 Balance: <b>${b}</b>\n👥 Friends: <b>${f}</b>`,
    inviteMsg: (link, bonus, prem, pct) =>
      `👥 <b>Invite friends and earn!</b>\n\n• <b>${bonus}</b> for each friend\n• <b>${prem}</b> for each Telegram Premium friend\n• <b>${pct}%</b> of everything your friends earn\n\n🔗 Your link:\n<code>${link}</code>`,
    help:
      '<b>HiloCoin commands</b>\n/start — open the app\n/balance — your balance\n/invite — your referral link\n/help — this message',
  },
  fa: {
    welcomeNew: (name, bonus) =>
      `🎉 <b>${name} عزیز، به HiloCoin خوش آمدید!</b>\n\n` +
      `🎁 شما همین الان <b>${bonus}</b> جایزه خوش‌آمدگویی دریافت کردید!\n\n` +
      `💰 هر چند ساعت ماینینگ کنید، جایزه روزانه بگیرید، تسک‌ها را انجام دهید و دوستانتان را دعوت کنید تا قبل از ایردراپ <b>${settings.get('token_name')}</b> موجودی‌تان را بیشتر کنید.\n\n` +
      `👇 برای باز کردن اپ روی دکمه زیر بزنید.`,
    welcomeBack: (name, balance) =>
      `👋 <b>${name}، خوش برگشتید!</b>\n\n💰 موجودی شما: <b>${balance}</b>\n\n👇 برای ادامه کسب درآمد اپ را باز کنید.`,
    open: '🚀 ورود به HiloCoin',
    invite: '👥 دعوت دوستان',
    channel: '📢 کانال ما',
    shareText: (bonus) => `🎁 با لینک من وارد HiloCoin شو و ${bonus} جایزه خوش‌آمدگویی بگیر! 🚀`,
    friendJoined: (name, amount, premium) =>
      `🎉 <b>${name}</b> با لینک شما وارد HiloCoin شد${premium ? ' ⭐ (پرمیوم)' : ''}!\n💰 <b>${amount}+</b> به موجودی شما اضافه شد.`,
    banned: '⛔️ حساب شما مسدود شده است.',
    noApp: '⚠️ آدرس مینی‌اپ هنوز تنظیم نشده است (WEBAPP_URL باید https باشد).',
    balance: (b, f) => `💰 موجودی: <b>${b}</b>\n👥 دوستان: <b>${f}</b>`,
    inviteMsg: (link, bonus, prem, pct) =>
      `👥 <b>دوستانتان را دعوت کنید و درآمد کسب کنید!</b>\n\n• <b>${bonus}</b> برای هر دوست\n• <b>${prem}</b> برای هر دوست تلگرام پرمیوم\n• <b>${pct}%</b> از تمام درآمد دوستانتان\n\n🔗 لینک شما:\n<code>${link}</code>`,
    help:
      '<b>دستورات HiloCoin</b>\n/start — باز کردن اپ\n/balance — موجودی شما\n/invite — لینک دعوت شما\n/help — همین پیام',
  },
};

const tr = (from) => (isFa(from && from.language_code) ? TEXT.fa : TEXT.en);
const hasWebApp = () => /^https:\/\//i.test(config.webAppUrl);

function mainKeyboard(T, userId) {
  const kb = new InlineKeyboard();
  if (hasWebApp()) kb.webApp(T.open, config.webAppUrl + '/').row();
  const link = users.refLink(userId);
  const share = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(
    T.shareText(money(settings.get('welcome_bonus')))
  )}`;
  kb.url(T.invite, share);
  const channel = settings.get('channel_url');
  if (channel) kb.url(T.channel, channel);
  return kb;
}

/** Called when someone registers through a referral link (bot or Mini App). */
async function notifyReferral(referrer, newUser, bonusCents) {
  if (!referrer || !referrer.bot_started) return;
  const T = isFa(referrer.lang || referrer.language_code) ? TEXT.fa : TEXT.en;
  await telegram.send(
    referrer.id,
    T.friendJoined(escapeHtml(displayName(newUser)), money(fromCents(bonusCents)), !!newUser.is_premium)
  );
}

function adminStats() {
  const today = startOfDay();
  const one = (sql, ...p) => db.prepare(sql).get(...p).c;
  return (
    '📊 <b>HiloCoin stats</b>\n\n' +
    `👥 Users: <b>${one('SELECT COUNT(*) c FROM users')}</b>\n` +
    `🆕 New today: <b>${one('SELECT COUNT(*) c FROM users WHERE created_at >= ?', today)}</b>\n` +
    `🔥 Active today: <b>${one('SELECT COUNT(*) c FROM users WHERE last_seen_at >= ?', today)}</b>\n` +
    `🤝 Referred users: <b>${one('SELECT COUNT(*) c FROM users WHERE referrer_id IS NOT NULL')}</b>\n` +
    `👛 Wallets: <b>${one('SELECT COUNT(*) c FROM users WHERE wallet_address IS NOT NULL')}</b>`
  );
}

function createBot() {
  if (!config.botToken) return null;
  const bot = new Bot(config.botToken);

  // Ignore groups/channels — this bot is used in private chats only.
  bot.use((ctx, next) => (ctx.chat && ctx.chat.type !== 'private' && !ctx.myChatMember ? undefined : next()));

  bot.command('start', async (ctx) => {
    const T = tr(ctx.from);
    const { user, isNew, referrer, referralBonus } = users.register(ctx.from, {
      fromBot: true,
      refPayload: ctx.match,
    });
    if (user.is_banned) return ctx.reply(T.banned);
    const name = escapeHtml(ctx.from.first_name || 'friend');
    const text = isNew
      ? T.welcomeNew(name, money(settings.get('welcome_bonus')))
      : T.welcomeBack(name, money(fromCents(user.balance)));
    await ctx.reply(text + (hasWebApp() ? '' : '\n\n' + T.noApp), {
      parse_mode: 'HTML',
      reply_markup: mainKeyboard(T, user.id),
    });
    if (isNew && referrer) notifyReferral(referrer, user, referralBonus);
  });

  bot.command('balance', async (ctx) => {
    const T = tr(ctx.from);
    const { user } = users.register(ctx.from, { fromBot: true });
    await ctx.reply(T.balance(money(fromCents(user.balance)), user.referral_count), {
      parse_mode: 'HTML',
      reply_markup: mainKeyboard(T, user.id),
    });
  });

  bot.command('invite', async (ctx) => {
    const T = tr(ctx.from);
    const { user } = users.register(ctx.from, { fromBot: true });
    await ctx.reply(
      T.inviteMsg(
        users.refLink(user.id),
        money(settings.get('referral_bonus')),
        money(settings.get('referral_bonus_premium')),
        settings.get('referral_commission_percent')
      ),
      { parse_mode: 'HTML', reply_markup: mainKeyboard(T, user.id) }
    );
  });

  bot.command('help', (ctx) => ctx.reply(tr(ctx.from).help, { parse_mode: 'HTML' }));

  // Admin-only shortcuts
  bot.command(['admin', 'stats'], async (ctx) => {
    if (!config.isAdminId(ctx.from.id)) return;
    const panel = config.webAppUrl ? `\n\n🛠 Admin panel: ${config.webAppUrl}/admin/` : '';
    await ctx.reply(adminStats() + panel, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  });

  // Track users who block / unblock the bot so broadcasts skip them.
  bot.on('my_chat_member', (ctx) => {
    const status = ctx.myChatMember.new_chat_member.status;
    if (ctx.chat.type !== 'private') return;
    db.prepare('UPDATE users SET bot_blocked = ? WHERE id = ?').run(status === 'kicked' ? 1 : 0, ctx.from.id);
  });

  // Any other private message: show the main menu.
  bot.on('message', async (ctx) => {
    const T = tr(ctx.from);
    const { user } = users.register(ctx.from, { fromBot: true });
    if (user.is_banned) return;
    await ctx.reply(T.welcomeBack(escapeHtml(ctx.from.first_name || ''), money(fromCents(user.balance))), {
      parse_mode: 'HTML',
      reply_markup: mainKeyboard(T, user.id),
    });
  });

  bot.catch((err) => console.error('[bot] error:', err.error || err));
  return bot;
}

async function setupBot(bot) {
  const me = await bot.api.getMe();
  config.botUsername = me.username;
  console.log(`[bot] logged in as @${me.username}`);

  await bot.api.setMyCommands([
    { command: 'start', description: 'Open HiloCoin' },
    { command: 'balance', description: 'Your balance' },
    { command: 'invite', description: 'Invite friends' },
    { command: 'help', description: 'Help' },
  ]);
  await bot.api.setMyCommands(
    [
      { command: 'start', description: 'ورود به HiloCoin' },
      { command: 'balance', description: 'موجودی من' },
      { command: 'invite', description: 'دعوت دوستان' },
      { command: 'help', description: 'راهنما' },
    ],
    { language_code: 'fa' }
  );

  if (hasWebApp()) {
    await bot.api.setChatMenuButton({
      menu_button: { type: 'web_app', text: 'HiloCoin', web_app: { url: config.webAppUrl + '/' } },
    });
  } else {
    console.warn('[bot] WEBAPP_URL is not an https URL — the "Open app" buttons are disabled.');
  }
}

module.exports = { createBot, setupBot, notifyReferral };
