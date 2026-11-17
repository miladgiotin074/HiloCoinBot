(() => {
  'use strict';

  const tg = window.Telegram && window.Telegram.WebApp;
  const qs = new URLSearchParams(location.search);
  const DEV_USER = qs.get('dev_user');
  const hasTgAuth = !!(tg && tg.initData);

  const S = {
    user: null,
    config: { currency: '$' },
    daily: null,
    farm: null,
    rank: null,
    refLink: '',
    totalUsers: 0,
    welcome: null,
    lang: 'en',
    tab: 'home',
    offset: 0,
    tasks: null,
    friends: null,
    top: null,
    txs: null,
    editWallet: false,
  };

  /* -------------------------------- Helpers -------------------------------- */

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const now = () => Date.now() + S.offset;

  function t(key, vars) {
    const dict = window.I18N[S.lang] || window.I18N.en;
    let s = dict[key] ?? window.I18N.en[key] ?? key;
    if (vars) s = s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
    return s;
  }

  const fmt = (n, dec = 2) =>
    Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  const cur = () => S.config.currency || '$';
  const moneyText = (n, dec) => cur() + fmt(n, dec ?? (Number(n) % 1 ? 2 : 0));
  const money = (n, dec) => `<span class="num">${esc(moneyText(n, dec))}</span>`;
  const short = (n) => {
    n = Number(n) || 0;
    if (n >= 1e6) return cur() + +(n / 1e6).toFixed(1) + 'M';
    if (n >= 1e4) return cur() + +(n / 1e3).toFixed(1) + 'K';
    return moneyText(n);
  };
  const pad = (n) => String(n).padStart(2, '0');
  const fmtDur = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  };
  const fmtDate = (ts) =>
    new Date(ts).toLocaleString(S.lang === 'fa' ? 'fa-IR' : 'en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  const fullName = (u) => [u.first_name, u.last_name].filter(Boolean).join(' ') || 'User';

  function haptic(kind) {
    try {
      const h = tg && tg.HapticFeedback;
      if (!h || !hasTgAuth) return;
      if (kind === 'success' || kind === 'error' || kind === 'warning') h.notificationOccurred(kind);
      else if (kind === 'select') h.selectionChanged();
      else h.impactOccurred(kind || 'light');
    } catch (_) {}
  }

  let toastTimer;
  function toast(msg, kind = '') {
    const el = $('#toast');
    el.className = kind;
    el.innerHTML = msg;
    void el.offsetWidth;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  const COLORS = [
    ['#f59e0b', '#ef4444'],
    ['#8b5cf6', '#3b82f6'],
    ['#10b981', '#0ea5e9'],
    ['#ec4899', '#8b5cf6'],
    ['#f97316', '#eab308'],
    ['#06b6d4', '#6366f1'],
  ];
  function avatar(name, photo, id, cls = '') {
    const [a, b] = COLORS[Math.abs(Number(id) || 0) % COLORS.length];
    const initial = esc((String(name || '?').trim()[0] || '?').toUpperCase());
    const img = photo
      ? `<img src="${esc(photo)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`
      : '';
    return `<div class="avatar ${cls}" style="background:linear-gradient(135deg,${a},${b})">${initial}${img}</div>`;
  }

  function openLink(url) {
    try {
      if (hasTgAuth && /^https:\/\/t\.me\//i.test(url) && tg.openTelegramLink) return tg.openTelegramLink(url);
      if (hasTgAuth && tg.openLink) return tg.openLink(url);
    } catch (_) {}
    window.open(url, '_blank', 'noopener');
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } catch (_) {}
      ta.remove();
    }
    toast('✅ ' + t('copied'), 'ok');
    haptic('success');
  }

  /* ---------------------------------- API ---------------------------------- */

  async function api(path, { method = 'GET', body } = {}) {
    // The ngrok header skips ngrok's free-plan warning page for API calls (ignored elsewhere).
    const headers = { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': '1' };
    if (hasTgAuth) headers.Authorization = 'tma ' + tg.initData;
    else if (DEV_USER) {
      headers.Authorization = 'dev ' + DEV_USER;
      if (qs.get('start')) headers['X-Dev-Start'] = qs.get('start');
    }
    let res;
    try {
      res = await fetch('api' + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    } catch (_) {
      const e = new Error('network');
      e.data = { error: 'network' };
      throw e;
    }
    let data = {};
    try {
      data = await res.json();
    } catch (_) {}
    if (!res.ok) {
      const e = new Error(data.error || 'request_failed');
      e.status = res.status;
      e.data = data;
      throw e;
    }
    return data;
  }

  function errMsg(e) {
    const code = (e && e.data && e.data.error) || 'generic';
    if (code === 'too_soon') return t('err_too_soon', { s: e.data.seconds });
    const key = 'err_' + code;
    return window.I18N.en[key] ? t(key) : t('err_generic');
  }

  function handleAuthErrors(e) {
    if (e.status === 401) return showScreen('expired'), true;
    if (e.status === 403) return showScreen('banned'), true;
    if (e.status === 503) return showScreen('maintenance'), true;
    return false;
  }

  // Applies a server snapshot (user, daily, farm, rank, server time).
  function apply(d) {
    if (d.user) S.user = d.user;
    if (d.daily) S.daily = d.daily;
    if (d.farm) S.farm = d.farm;
    if (d.rank !== undefined) S.rank = d.rank;
    if (d.now) S.offset = d.now - Date.now();
    renderHeader();
    const rk = $('#chip-rank');
    if (rk) rk.textContent = '#' + (S.rank ?? '—');
    const fr = $('#chip-friends');
    if (fr) fr.textContent = S.user.referral_count;
  }

  /* -------------------------------- Balance -------------------------------- */

  let shownBalance = 0;
  const balHTML = (v) => `<span class="cur">${esc(cur())}</span>${fmt(v)}`;

  function setBalance(target, animate = true) {
    const el = $('#balance');
    const from = shownBalance;
    shownBalance = target;
    if (!el) return;
    if (!animate || from === target) {
      el.innerHTML = balHTML(target);
      return;
    }
    const start = performance.now();
    const dur = 1000;
    const step = (ts) => {
      const p = Math.min(1, (ts - start) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      el.innerHTML = balHTML(from + (target - from) * e);
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    const coin = $('#coin');
    if (coin) {
      coin.classList.remove('pop');
      void coin.offsetWidth;
      coin.classList.add('pop');
    }
  }

  function rewardFx(amount, msg) {
    toast(msg || '🎉 ' + t('reward_toast', { amount: moneyText(amount) }), 'ok');
    haptic('success');
    if (amount >= 50) confetti(amount >= 500 ? 180 : 90);
    setBalance(S.user.balance);
  }

  /* --------------------------------- Header -------------------------------- */

  function renderHeader() {
    const u = S.user;
    if (!u) return;
    const name = fullName(u);
    $('#me').innerHTML = `${avatar(name, u.photo_url, u.id)}
      <div style="min-width:0">
        <div class="me-name">${esc(name)}${u.is_premium ? ' ⭐' : ''}</div>
        <div class="me-sub">${t('rank')} <span class="num">#${S.rank ?? '—'}</span> · <span class="num">${esc(S.config.token_name || 'HILO')}</span> ${t('airdrop_word')}</div>
      </div>`;
  }

  function applyLang() {
    const html = document.documentElement;
    html.lang = S.lang;
    html.dir = S.lang === 'fa' ? 'rtl' : 'ltr';
    $$('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n)));
    $('#lang-btn').innerHTML = S.lang === 'fa' ? '🌐 EN' : '🌐 فا';
  }

  /* ---------------------------------- Home --------------------------------- */

  function renderHome() {
    const u = S.user;
    const c = S.config;
    $('#tab-home').innerHTML = `
      <div class="hero">
        <div class="coin-wrap"><img src="logo.svg" class="coin" id="coin" alt=""></div>
        <div class="hero-label">${t('your_balance')}</div>
        <div class="hero-balance num" id="balance">${balHTML(shownBalance)}</div>
        <div class="chips">
          <button class="chip" data-go="top">🏆 ${t('rank')} <span class="num" id="chip-rank">#${S.rank ?? '—'}</span></button>
          <button class="chip" data-go="friends">👥 <span class="num" id="chip-friends">${u.referral_count}</span> ${t('friends_word')}</button>
        </div>
      </div>
      <div class="card" id="mine-card"></div>
      <div class="card" id="daily-card"></div>
      <button class="banner" data-go="friends">
        <div class="emoji">🎁</div>
        <div><b>${t('invite_banner_title')}</b><span>${t('invite_banner_sub', { amount: moneyText(c.referral_bonus) })}</span></div>
        <div class="arrow">›</div>
      </button>
      <button class="banner" data-go="tasks" style="background:linear-gradient(135deg,rgba(255,201,60,.2),rgba(245,158,11,.08));border-color:rgba(255,201,60,.3)">
        <div class="emoji">✅</div>
        <div><b>${t('tasks_banner_title')}</b><span>${t('tasks_banner_sub')}</span></div>
        <div class="arrow">›</div>
      </button>`;
    renderMine();
    renderDaily();
  }

  function renderMine() {
    const el = $('#mine-card');
    const f = S.farm;
    if (!el || !f) return;
    const hours = +(f.duration / 3600000).toFixed(2);
    const head = `<div class="card-head">
        <div class="card-icon">⛏️</div>
        <div><div class="card-title">${t('mining')}</div>
        <div class="card-sub">${t('mining_sub', { amount: moneyText(f.reward), hours })}</div></div>
      </div>`;
    let body;
    if (f.status === 'idle') {
      body = `<div class="mine-amount">${money(0, 2)}</div>
        <div class="progress"><i style="width:0%"></i></div>
        <div class="mine-meta"><span>${t('mining_idle')}</span><span class="num">${fmtDur(f.duration)}</span></div>
        <button class="btn btn-primary glow" data-act="farm-start">⚡ ${t('start_mining')}</button>`;
    } else {
      const ready = f.status === 'ready';
      body = `<div class="mine-amount" id="mine-amount"></div>
        <div class="progress"><i id="mine-bar"></i></div>
        <div class="mine-meta"><span id="mine-left"></span><span class="num">${money(f.reward)}</span></div>
        ${
          ready
            ? `<button class="btn btn-primary glow" data-act="farm-claim">💰 ${t('claim')} ${money(f.reward)}</button>`
            : `<button class="btn" disabled>⛏️ ${t('mining_active')}</button>`
        }`;
    }
    el.innerHTML = head + body;
    tickMine();
  }

  function tickMine() {
    const f = S.farm;
    if (!f || f.status === 'idle') return;
    const amountEl = $('#mine-amount');
    if (!amountEl) return;
    const elapsed = Math.max(0, Math.min(f.duration, now() - f.started_at));
    const p = elapsed / f.duration;
    if (p >= 1 && f.status !== 'ready') {
      f.status = 'ready';
      renderMine();
      return;
    }
    amountEl.innerHTML = `<span class="num">+${esc(cur())}${fmt(f.reward * p, p >= 1 ? 2 : 4)}</span>`;
    $('#mine-bar').style.width = (p * 100).toFixed(2) + '%';
    $('#mine-left').textContent = p >= 1 ? t('mining_ready') : t('time_left', { time: fmtDur(f.ends_at - now()) });
  }

  function renderDaily() {
    const el = $('#daily-card');
    const d = S.daily;
    if (!el || !d) return;
    const cells = d.rewards
      .map((amt, i) => {
        const done = i < d.done;
        const today = !d.claimed_today && i === d.today_index;
        return `<div class="day ${done ? 'done' : ''} ${today ? 'today' : ''}">${t('day_n', { n: i + 1 })}<b class="num">${esc(short(amt))}</b>${done ? '<span class="ck">✓</span>' : ''}</div>`;
      })
      .join('');
    const btn = d.claimed_today
      ? `<button class="btn" disabled>⏳ ${t('come_back_in')} <span class="num" id="daily-left">${fmtDur(d.next_claim_at - now())}</span></button>`
      : `<button class="btn btn-violet" data-act="daily">🎁 ${t('claim')} ${money(d.next_amount)}</button>`;
    el.innerHTML = `<div class="card-head">
        <div class="card-icon violet">📅</div>
        <div><div class="card-title">${t('daily_title')}</div>
        <div class="card-sub">${d.streak ? t('daily_streak', { n: d.streak }) : t('daily_sub')}</div></div>
      </div>
      <div class="days">${cells}</div>${btn}`;
  }

  let refreshing = false;
  function tickDaily() {
    const el = $('#daily-left');
    if (!el || !S.daily) return;
    const left = S.daily.next_claim_at - now();
    if (left <= 0) {
      if (!refreshing) refreshMe();
      return;
    }
    el.textContent = fmtDur(left);
  }

  async function refreshMe() {
    refreshing = true;
    try {
      const d = await api('/me');
      apply(d);
      renderMine();
      renderDaily();
      if (shownBalance !== S.user.balance && !S.welcome) setBalance(S.user.balance);
    } catch (e) {
      handleAuthErrors(e);
    } finally {
      setTimeout(() => (refreshing = false), 3000);
    }
  }

  /* ---------------------------------- Tasks -------------------------------- */

  const skeleton = (n) => `<div class="list">${'<div class="sk"></div>'.repeat(n)}</div>`;

  async function loadTasks() {
    try {
      S.tasks = (await api('/tasks')).tasks;
      renderTasks();
      updateTasksDot();
    } catch (e) {
      if (!handleAuthErrors(e) && S.tab === 'tasks') toast(errMsg(e), 'err');
    }
  }

  function updateTasksDot() {
    $('#tasks-dot').hidden = !(S.tasks && S.tasks.some((x) => x.status !== 'completed'));
  }

  function renderTasks() {
    const el = $('#tab-tasks');
    const head = `<div class="page-head center"><div class="page-emoji">🎯</div><h1>${t('tasks_title')}</h1><p>${t('tasks_sub')}</p></div>`;
    if (!S.tasks) return (el.innerHTML = head + skeleton(4));
    if (!S.tasks.length) return (el.innerHTML = head + `<div class="empty"><div class="e">🗂️</div>${t('tasks_empty')}</div>`);

    const total = S.tasks.length;
    const done = S.tasks.filter((x) => x.status === 'completed').length;
    const left = S.tasks.filter((x) => x.status !== 'completed').reduce((a, x) => a + x.reward, 0);
    const pct = total ? done / total : 0;
    const C = 2 * Math.PI * 25;
    const sorted = [...S.tasks].sort((a, b) => (a.status === 'completed') - (b.status === 'completed'));

    el.innerHTML =
      head +
      `<div class="card tasks-progress">
        <svg class="ring" viewBox="0 0 58 58"><circle cx="29" cy="29" r="25" stroke="rgba(255,255,255,.08)"/>
          <circle cx="29" cy="29" r="25" stroke="#ffc93c" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - pct)}" transform="rotate(-90 29 29)"/>
          <text x="29" y="33" text-anchor="middle" fill="#f4f6fb" font-size="13" font-weight="700">${Math.round(pct * 100)}%</text></svg>
        <div><b>${t('tasks_done', { done, total })}</b><div class="card-sub">${left > 0 ? t('tasks_more', { amount: moneyText(left) }) : t('tasks_all_done')}</div></div>
      </div>
      <div class="list">${sorted.map(taskItem).join('')}</div>
      <p class="card-sub" style="text-align:center;margin-top:14px">${t('task_hint')}</p>`;
  }

  function taskItem(tk) {
    const title = S.lang === 'fa' && tk.title_fa ? tk.title_fa : tk.title;
    let action;
    if (tk.status === 'completed') action = `<div class="check-badge">✓</div>`;
    else if (tk.status === 'started')
      action = `<button class="btn btn-sm btn-primary" data-act="task-check" data-id="${tk.id}">${t('check')}</button>`;
    else action = `<button class="btn btn-sm" data-act="task-go" data-id="${tk.id}">${t('start')}</button>`;
    return `<div class="item ${tk.status === 'completed' ? 'done' : ''}">
      <div class="item-icon">${esc(tk.icon)}</div>
      <div class="item-main" ${tk.status === 'started' ? `data-act="task-open" data-id="${tk.id}"` : ''}>
        <div class="item-title">${esc(title)}</div>
        <div class="item-sub gold">+${money(tk.reward)}</div>
      </div>${action}</div>`;
  }

  /* --------------------------------- Friends ------------------------------- */

  async function loadFriends() {
    try {
      S.friends = await api('/friends');
      renderFriends();
    } catch (e) {
      if (!handleAuthErrors(e)) toast(errMsg(e), 'err');
    }
  }

  function renderFriends() {
    const c = S.config;
    const f = S.friends;
    const count = f ? f.count : S.user.referral_count;
    const earned = f ? f.earned : S.user.referral_earnings;
    const copyIcon =
      '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>';

    let html = `<div class="page-head center"><div class="page-emoji">🤝</div><h1>${t('friends_title')}</h1><p>${t('friends_sub')}</p></div>
      <div class="card perks">
        <div class="perk"><div class="perk-icon">🎁</div><div><b>${t('perk_invite_title')}</b><span>${
          c.invitee_bonus > 0
            ? t('perk_invite_sub', { you: `<em>${money(c.referral_bonus)}</em>`, friend: `<em>${money(c.invitee_bonus)}</em>` })
            : t('perk_invite_sub_solo', { you: `<em>${money(c.referral_bonus)}</em>` })
        }</span></div></div>
        <div class="perk"><div class="perk-icon">⭐</div><div><b>${t('perk_premium_title')}</b><span>${t('perk_premium_sub', {
          amount: `<em>${money(c.referral_bonus_premium)}</em>`,
        })}</span></div></div>
        ${
          c.commission_percent > 0
            ? `<div class="perk"><div class="perk-icon">💸</div><div><b>${t('perk_commission_title')}</b><span>${t(
                'perk_commission_sub',
                { pct: `<em class="num">${c.commission_percent}%</em>` }
              )}</span></div></div>`
            : ''
        }
      </div>
      <div class="stats">
        <div class="stat"><span>${t('stat_friends')}</span><b class="num">${count}</b></div>
        <div class="stat"><span>${t('stat_earned')}</span><b>${money(earned)}</b></div>
      </div>
      <div class="row">
        <button class="btn btn-primary grow" data-act="share">🚀 ${t('invite_btn')}</button>
        <button class="btn btn-icon" data-act="copy" aria-label="${t('copy')}">${copyIcon}</button>
      </div>
      <div class="ref-link">${esc(S.refLink)}</div>`;

    html += `<div class="section-title">🏅 ${t('milestones')}</div>`;
    if (!f) html += skeleton(3);
    else
      html += `<div class="list">${f.milestones
        .map((m) => {
          const pct = Math.min(100, (count / m.friends) * 100);
          const end = m.claimed
            ? '<div class="check-badge">✓</div>'
            : m.claimable
            ? `<button class="btn btn-sm btn-primary" data-act="ms-claim" data-n="${m.friends}">${t('claim')}</button>`
            : `<span class="item-sub num">${Math.min(count, m.friends)}/${m.friends}</span>`;
          return `<div class="item ms ${m.claimed ? 'done' : ''}">
            <div class="item-icon">${m.claimed ? '🏆' : '🏅'}</div>
            <div class="item-main"><div class="item-title">${t(m.friends === 1 ? 'ms_title_one' : 'ms_title', { n: m.friends })}</div>
              <div class="ms-reward">+${money(m.reward)}</div>
              <div class="progress violet"><i style="width:${pct}%"></i></div></div>${end}</div>`;
        })
        .join('')}</div>`;

    html += `<div class="section-title">👥 ${t('friends_list')} <small class="num">${count}</small></div>`;
    if (!f) html += skeleton(2);
    else if (!f.friends.length) html += `<div class="empty"><div class="e">🫂</div>${t('friends_empty')}</div>`;
    else
      html += `<div class="list">${f.friends
        .map(
          (fr) => `<div class="item">${avatar(fr.name, fr.photo_url, fr.id)}
            <div class="item-main"><div class="item-title">${esc(fr.name)}${fr.is_premium ? ' ⭐' : ''}</div>
            <div class="item-sub">${t('joined')} ${esc(fmtDate(fr.joined_at))}</div></div>
            <div class="item-end amount-pos">+${money(fr.earned)}</div></div>`
        )
        .join('')}</div>`;

    $('#tab-friends').innerHTML = html;
  }

  function share() {
    const text = t('share_text', { amount: moneyText(S.config.welcome_bonus) });
    const url = `https://t.me/share/url?url=${encodeURIComponent(S.refLink)}&text=${encodeURIComponent(text)}`;
    haptic('medium');
    openLink(url);
  }

  /* ------------------------------- Leaderboard ----------------------------- */

  async function loadTop() {
    try {
      S.top = await api('/leaderboard');
      renderTop();
    } catch (e) {
      if (!handleAuthErrors(e)) toast(errMsg(e), 'err');
    }
  }

  function renderTop() {
    const el = $('#tab-top');
    const head = (n) =>
      `<div class="page-head center"><div class="page-emoji">🏆</div><h1>${t('top_title')}</h1><p>${t('top_sub', {
        n: `<span class="num">${fmt(n, 0)}</span>`,
      })}</p></div>`;
    if (!S.top) return (el.innerHTML = head(S.totalUsers) + skeleton(5));
    const { top, total, me } = S.top;
    const u = S.user;
    const medals = ['🥇', '🥈', '🥉'];
    let html =
      head(total) +
      `<div class="card my-rank">${avatar(fullName(u), u.photo_url, u.id)}
        <div class="item-main"><div class="item-title">${esc(fullName(u))} <span class="card-sub">(${t('you')})</span></div>
        <div class="item-sub gold">${money(me.balance)}</div></div>
        <div class="rk num">#${me.rank ?? '—'}</div></div>`;
    if (!top.length) return (el.innerHTML = html + `<div class="empty"><div class="e">🏁</div>${t('top_empty')}</div>`);

    const pod = [top[1], top[0], top[2]];
    html += `<div class="podium">${pod
      .map((p, i) => {
        if (!p) return '<div></div>';
        const place = [2, 1, 3][i];
        return `<div class="pod p${place}"><span class="medal">${medals[place - 1]}</span>${avatar(p.name, p.photo_url, p.id, place === 1 ? 'lg' : '')}
          <div class="nm">${esc(p.name)}</div><div class="bal">${esc(short(p.balance))}</div></div>`;
      })
      .join('')}</div>`;
    html += `<div class="list">${top
      .slice(3)
      .map(
        (p, i) => `<div class="item"><div class="rank-num num">${i + 4}</div>${avatar(p.name, p.photo_url, p.id, 'sm')}
          <div class="item-main"><div class="item-title">${esc(p.name)}${p.is_premium ? ' ⭐' : ''}</div></div>
          <div class="item-end">${money(p.balance)}</div></div>`
      )
      .join('')}</div>`;
    el.innerHTML = html;
  }

  /* --------------------------------- Wallet -------------------------------- */

  const TON_RE = /^(?:[EUk0]Q[A-Za-z0-9_-]{46}|-?[01]:[0-9a-fA-F]{64})$/;
  const TX_ICON = {
    welcome: '🎁',
    invitee_bonus: '🤝',
    referral: '👥',
    commission: '💸',
    daily: '📅',
    farm: '⛏️',
    task: '✅',
    milestone: '🏅',
    admin: '🛠️',
  };

  async function loadTxs() {
    try {
      S.txs = (await api('/transactions')).transactions;
      renderWallet();
    } catch (e) {
      if (!handleAuthErrors(e)) toast(errMsg(e), 'err');
    }
  }

  function renderWallet() {
    const c = S.config;
    const u = S.user;
    const airdropText = S.lang === 'fa' ? c.airdrop_text_fa || c.airdrop_text_en : c.airdrop_text_en;
    const editing = S.editWallet || !u.wallet_address;

    let html = `<div class="page-head center"><div class="page-emoji">🪂</div><h1>${t('wallet_title', {
      token: esc(c.token_name),
    })}</h1><p>${t('wallet_sub')}</p></div>
      <div class="card airdrop-card">
        <div class="card-head" style="margin-bottom:10px"><img src="logo.svg" width="42" height="42" alt="">
          <div><div class="card-title">${t('your_allocation')}</div><div class="card-sub" style="color:#ffd76a;font-weight:700;font-size:18px">${money(u.balance)}</div></div></div>
        <p>${esc(airdropText)}</p>
      </div>
      <div class="card">
        <div class="card-head"><div class="card-icon blue">💎</div><div><div class="card-title">${t('wallet_card_title')}</div>
          <div class="card-sub">${t('wallet_card_sub')}</div></div></div>
        ${
          editing
            ? `<input class="input" id="wallet-input" placeholder="UQ… / EQ…" autocomplete="off" spellcheck="false" value="${esc(u.wallet_address || '')}">
               <div class="row" style="margin-top:10px">
                 ${u.wallet_address ? `<button class="btn" data-act="wallet-cancel">${t('cancel')}</button>` : ''}
                 <button class="btn btn-primary grow" data-act="wallet-save">${t('save')}</button>
               </div>`
            : `<div class="addr"><span>✅</span><code>${esc(u.wallet_address)}</code></div>
               <button class="btn" data-act="wallet-edit">✏️ ${t('change')}</button>`
        }
      </div>
      <div class="card">
        <div class="card-head" style="margin-bottom:12px"><div class="card-icon violet">🌐</div><div class="card-title">${t('language')}</div></div>
        <div class="seg"><button class="${S.lang === 'en' ? 'on' : ''}" data-act="lang" data-lang="en">English</button><button class="${
          S.lang === 'fa' ? 'on' : ''
        }" data-act="lang" data-lang="fa">فارسی</button></div>
      </div>`;

    if (c.channel_url || c.support_url) {
      html += `<div class="links">
        ${c.channel_url ? `<button class="btn" data-act="open-url" data-url="${esc(c.channel_url)}">📢 ${t('channel')}</button>` : ''}
        ${c.support_url ? `<button class="btn" data-act="open-url" data-url="${esc(c.support_url)}">💬 ${t('support')}</button>` : ''}
      </div>`;
    }

    html += `<div class="section-title">🧾 ${t('history')}</div>`;
    if (!S.txs) html += skeleton(3);
    else if (!S.txs.length) html += `<div class="empty"><div class="e">🧾</div>${t('history_empty')}</div>`;
    else
      html += `<div class="list">${S.txs
        .map(
          (x) => `<div class="item"><div class="item-icon">${TX_ICON[x.type] || '💰'}</div>
            <div class="item-main"><div class="item-title">${esc(t('tx_' + x.type))}</div>
            <div class="item-sub">${esc(txNote(x))}${txNote(x) ? ' · ' : ''}${esc(fmtDate(x.created_at))}</div></div>
            <div class="item-end ${x.amount >= 0 ? 'amount-pos' : 'amount-neg'}">${x.amount >= 0 ? '+' : '−'}${money(Math.abs(x.amount))}</div></div>`
        )
        .join('')}</div>`;

    $('#tab-wallet').innerHTML = html;
  }

  function txNote(x) {
    if (!x.note) return '';
    const m = /^Day (\d+)$/.exec(x.note);
    if (m) return t('day_n', { n: m[1] });
    const f = /^(\d+) friends$/.exec(x.note);
    if (f) return t('ms_title', { n: f[1] });
    if (x.type === 'task' && S.tasks) {
      const tk = S.tasks.find((k) => k.title === x.note);
      if (tk && S.lang === 'fa' && tk.title_fa) return tk.title_fa;
    }
    return x.note;
  }

  /* --------------------------------- Modals -------------------------------- */

  function closeModal() {
    $('#modal-root').innerHTML = '';
  }

  function showWelcome() {
    const w = S.welcome;
    const total = w.amount + w.bonus;
    $('#modal-root').innerHTML = `<div class="modal-bg"><div class="modal">
      <img src="logo.svg" class="gift" alt="">
      <h2>${t('welcome_title')}</h2>
      <p>${t('welcome_sub')}</p>
      <div class="amount num" id="welcome-amount">${esc(cur())}0.00</div>
      ${w.bonus > 0 ? `<div class="bonus">🤝 ${t('welcome_ref', { amount: moneyText(w.bonus), name: esc(w.inviter || '') })}</div>` : ''}
      <button class="btn btn-primary glow" data-act="welcome-claim">🎁 ${t('collect')}</button>
    </div></div>`;
    haptic('success');
    const el = $('#welcome-amount');
    const start = performance.now();
    const step = (ts) => {
      const p = Math.min(1, (ts - start) / 1400);
      const e = 1 - Math.pow(1 - p, 3);
      el.textContent = cur() + fmt(total * e);
      if (p < 1) requestAnimationFrame(step);
    };
    setTimeout(() => requestAnimationFrame(step), 250);
    setTimeout(() => confetti(160), 300);
  }

  /* -------------------------------- Confetti ------------------------------- */

  function confetti(count = 120) {
    const cv = $('#confetti');
    const ctx = cv.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const W = window.innerWidth;
    const H = window.innerHeight;
    cv.width = W * dpr;
    cv.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const colors = ['#ffc93c', '#f59e0b', '#8b5cf6', '#3b82f6', '#22c55e', '#f43f5e', '#ffffff'];
    const parts = Array.from({ length: count }, () => ({
      x: W / 2 + (Math.random() - 0.5) * 60,
      y: H * 0.42,
      vx: (Math.random() - 0.5) * 14,
      vy: -Math.random() * 15 - 5,
      w: 6 + Math.random() * 5,
      h: 9 + Math.random() * 7,
      r: Math.random() * 6.28,
      vr: (Math.random() - 0.5) * 0.35,
      c: colors[(Math.random() * colors.length) | 0],
    }));
    const t0 = performance.now();
    const frame = (ts) => {
      ctx.clearRect(0, 0, W, H);
      let alive = 0;
      for (const p of parts) {
        p.vy += 0.38;
        p.vx *= 0.985;
        p.x += p.vx;
        p.y += p.vy;
        p.r += p.vr;
        if (p.y < H + 30) alive++;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.r);
        ctx.fillStyle = p.c;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.r * 1.5)));
        ctx.restore();
      }
      if (alive && ts - t0 < 4500) requestAnimationFrame(frame);
      else ctx.clearRect(0, 0, W, H);
    };
    requestAnimationFrame(frame);
  }

  /* ---------------------------- Full-page screens --------------------------- */

  function showScreen(kind) {
    const bot = (S.config && S.config.bot_username) || 'HiloCoinBot';
    const map = {
      open_in_tg: ['📱', 'screen_tg_title', 'screen_tg_sub', `<a class="btn btn-primary" style="max-width:280px;text-decoration:none" href="https://t.me/${esc(bot)}">🚀 ${t('open_bot')}</a>`],
      banned: ['⛔️', 'banned_title', 'banned_sub', ''],
      maintenance: ['🛠️', 'maint_title', 'maint_sub', `<button class="btn" style="max-width:220px" data-act="reload">${t('retry')}</button>`],
      expired: ['⏰', 'expired_title', 'expired_sub', hasTgAuth ? `<button class="btn btn-primary" style="max-width:220px" data-act="close">${t('close')}</button>` : ''],
      error: ['⚠️', 'error_title', 'error_sub', `<button class="btn btn-primary" style="max-width:220px" data-act="reload">${t('retry')}</button>`],
    };
    const [icon, title, sub, btn] = map[kind] || map.error;
    const el = $('#screen');
    el.innerHTML = `<div class="big">${icon}</div><h2>${t(title)}</h2><p>${t(sub)}</p><div style="height:8px"></div>${btn}`;
    el.hidden = false;
    $('#app').hidden = true;
    $('#splash').classList.add('out');
  }

  /* --------------------------------- Actions ------------------------------- */

  const findTask = (id) => (S.tasks || []).find((x) => x.id === Number(id));

  const actions = {
    async 'farm-start'() {
      apply(await api('/farm/start', { method: 'POST' }));
      renderMine();
      haptic('medium');
      toast('⛏️ ' + t('mining_started'), 'ok');
    },
    async 'farm-claim'() {
      const d = await api('/farm/claim', { method: 'POST' });
      apply(d);
      renderMine();
      rewardFx(d.amount);
    },
    async daily() {
      const d = await api('/daily/claim', { method: 'POST' });
      apply(d);
      renderDaily();
      rewardFx(d.amount, '🎉 ' + t('daily_claimed', { amount: moneyText(d.amount), n: d.streak }));
    },
    async 'task-go'(btn) {
      const tk = findTask(btn.dataset.id);
      if (!tk) return;
      openLink(tk.url);
      await api(`/tasks/${tk.id}/start`, { method: 'POST' });
      tk.status = 'started';
      renderTasks();
    },
    'task-open'(btn) {
      const tk = findTask(btn.dataset.id);
      if (tk) openLink(tk.url);
    },
    async 'task-check'(btn) {
      const tk = findTask(btn.dataset.id);
      const d = await api(`/tasks/${btn.dataset.id}/check`, { method: 'POST' });
      apply(d);
      if (tk) tk.status = 'completed';
      renderTasks();
      updateTasksDot();
      rewardFx(d.amount);
    },
    async 'ms-claim'(btn) {
      const d = await api(`/milestones/${btn.dataset.n}/claim`, { method: 'POST' });
      apply(d);
      if (S.friends) {
        S.friends.milestones = d.milestones;
        S.friends.earned = S.user.referral_earnings;
      }
      renderFriends();
      rewardFx(d.amount);
    },
    share,
    copy: () => copyText(S.refLink),
    'wallet-edit'() {
      S.editWallet = true;
      renderWallet();
      const i = $('#wallet-input');
      if (i) i.focus();
    },
    'wallet-cancel'() {
      S.editWallet = false;
      renderWallet();
    },
    async 'wallet-save'() {
      const addr = ($('#wallet-input').value || '').trim();
      if (!TON_RE.test(addr)) {
        haptic('error');
        return toast('⚠️ ' + t('err_invalid_wallet'), 'err');
      }
      const d = await api('/wallet', { method: 'POST', body: { address: addr } });
      S.user.wallet_address = d.wallet_address;
      S.editWallet = false;
      renderWallet();
      haptic('success');
      toast('✅ ' + t('wallet_saved'), 'ok');
    },
    lang(btn) {
      setLang(btn.dataset.lang);
    },
    'open-url'(btn) {
      openLink(btn.dataset.url);
    },
    'welcome-claim'() {
      closeModal();
      S.welcome = null;
      api('/welcome/seen', { method: 'POST' }).catch(() => {});
      confetti(200);
      haptic('success');
      setBalance(S.user.balance);
    },
    reload: () => location.reload(),
    close: () => tg && tg.close(),
  };

  document.addEventListener('click', async (ev) => {
    const go = ev.target.closest('[data-go]');
    if (go) return switchTab(go.dataset.go);
    const nav = ev.target.closest('.nav-btn');
    if (nav) return switchTab(nav.dataset.tab);
    const el = ev.target.closest('[data-act]');
    if (!el || el.disabled || el.classList.contains('loading')) return;
    const fn = actions[el.dataset.act];
    if (!fn) return;
    const isBtn = el.classList.contains('btn');
    if (isBtn) el.classList.add('loading');
    try {
      await fn(el);
    } catch (e) {
      if (!handleAuthErrors(e)) {
        haptic('error');
        toast('⚠️ ' + errMsg(e), 'err');
        // Resync state after a rejected action (e.g. already claimed in another tab).
        if (['already_claimed', 'farm_not_ready', 'not_farming', 'already_farming'].includes(e.data && e.data.error)) refreshMe();
        if (e.data && e.data.error === 'already_completed') loadTasks();
      }
    } finally {
      if (isBtn && el.isConnected) el.classList.remove('loading');
    }
  });

  $('#lang-btn').addEventListener('click', () => setLang(S.lang === 'fa' ? 'en' : 'fa'));

  function setLang(lang) {
    if (lang === S.lang) return;
    S.lang = lang;
    haptic('select');
    applyLang();
    renderAll();
    api('/lang', { method: 'POST', body: { lang } }).catch(() => {});
  }

  /* ---------------------------------- Tabs --------------------------------- */

  const tabs = {
    home: { render: renderHome, load: refreshMe },
    tasks: { render: renderTasks, load: loadTasks },
    friends: { render: renderFriends, load: loadFriends },
    top: { render: renderTop, load: loadTop },
    wallet: { render: renderWallet, load: loadTxs },
  };

  function switchTab(tab) {
    if (!tabs[tab]) return;
    if (S.tab !== tab) {
      S.tab = tab;
      $$('.tab').forEach((el) => el.classList.toggle('active', el.id === 'tab-' + tab));
      $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
      window.scrollTo(0, 0);
      haptic('select');
    }
    tabs[tab].render();
    tabs[tab].load();
  }

  function renderAll() {
    renderHeader();
    renderHome();
    if (S.tab !== 'home') tabs[S.tab].render();
  }

  /* ---------------------------------- Boot --------------------------------- */

  function detectLang() {
    const code = (tg && tg.initDataUnsafe && tg.initDataUnsafe.user && tg.initDataUnsafe.user.language_code) || navigator.language || '';
    return /^fa/i.test(code) ? 'fa' : 'en';
  }

  async function boot() {
    if (tg) {
      try {
        tg.ready();
        tg.expand();
        tg.setHeaderColor('#0b0f1c');
        tg.setBackgroundColor('#0b0f1c');
        if (tg.setBottomBarColor) tg.setBottomBarColor('#0b0f1c');
        if (tg.disableVerticalSwipes) tg.disableVerticalSwipes();
      } catch (_) {}
    }
    S.lang = detectLang();
    applyLang();

    if (!hasTgAuth && !DEV_USER) return showScreen('open_in_tg');

    let d;
    try {
      d = await api('/init', { method: 'POST' });
    } catch (e) {
      if (!handleAuthErrors(e)) showScreen('error');
      return;
    }
    S.config = d.config;
    S.refLink = d.ref_link;
    S.totalUsers = d.total_users;
    S.welcome = d.welcome && d.welcome.amount + d.welcome.bonus > 0 ? d.welcome : null;
    S.user = d.user;
    if (d.user.lang) S.lang = d.user.lang;
    applyLang();
    apply(d);

    shownBalance = S.welcome ? Math.max(0, S.user.balance - S.welcome.amount - S.welcome.bonus) : S.user.balance;
    renderAll();

    $('#app').hidden = false;
    $('#splash').classList.add('out');
    setTimeout(() => $('#splash').remove(), 400);
    if (S.welcome) setTimeout(showWelcome, 450);

    loadTasks(); // for the nav badge
    setInterval(() => {
      tickMine();
      tickDaily();
    }, 200);

    // Refresh when the user comes back (e.g. after opening a task link).
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && S.tab === 'home') refreshMe();
    });
  }

  boot();
})();
