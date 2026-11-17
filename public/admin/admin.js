(() => {
  'use strict';

  /* -------------------------------- Helpers -------------------------------- */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const n = (v, d = 0) => Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const usd = (v) => `<span class="num">${esc(currency)}${n(v, Number(v) % 1 ? 2 : 0)}</span>`;
  const date = (ts) =>
    ts ? new Date(ts).toLocaleString('fa-IR', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
  const name = (u) => [u.first_name, u.last_name].filter(Boolean).join(' ') || 'بدون نام';
  let currency = '$';

  const store = {
    get: (k) => {
      try {
        return localStorage.getItem(k);
      } catch (_) {
        return null;
      }
    },
    set: (k, v) => {
      try {
        v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v);
      } catch (_) {}
    },
  };
  let token = store.get('hilo_admin_token');

  const ERR = {
    wrong_password: 'رمز عبور اشتباه است',
    too_many_attempts: 'تلاش‌های ناموفق زیاد؛ ۱۵ دقیقه دیگر دوباره امتحان کنید',
    admin_password_not_set: 'ADMIN_PASSWORD در فایل ‎.env تنظیم نشده است',
    invalid_setting: 'مقدار یکی از تنظیمات نامعتبر است',
    invalid_title: 'عنوان تسک نامعتبر است',
    invalid_url: 'لینک باید با https:// شروع شود',
    invalid_chat_id: 'شناسه کانال نامعتبر است (مثال: ‎@mychannel یا ‎-100123456789)',
    invalid_reward: 'مقدار پاداش نامعتبر است',
    invalid_amount: 'مبلغ نامعتبر است',
    insufficient_balance: 'موجودی کاربر برای کسر این مبلغ کافی نیست',
    user_not_found: 'کاربر پیدا نشد',
    task_not_found: 'تسک پیدا نشد',
    bot_not_running: 'ربات در حال اجرا نیست (BOT_TOKEN را بررسی کنید)',
    no_admin_ids: 'ADMIN_IDS در فایل ‎.env تنظیم نشده است',
    broadcast_running: 'یک ارسال همگانی در حال اجراست',
    invalid_text: 'متن پیام خالی یا بیش از حد طولانی است',
    invalid_html: 'HTML پیام نامعتبر است',
    send_failed: 'ارسال ناموفق بود (ممکن است کاربر ربات را بلاک کرده باشد)',
    network: 'خطای شبکه',
  };
  const errText = (e) => ERR[e.code] || 'خطا: ' + (e.code || 'نامشخص');

  let toastT;
  function toast(msg, kind = 'ok') {
    const el = $('#toast');
    el.className = kind;
    el.textContent = msg;
    void el.offsetWidth;
    el.classList.add('show');
    clearTimeout(toastT);
    toastT = setTimeout(() => el.classList.remove('show'), 2800);
  }

  async function api(path, { method = 'GET', body, raw } = {}) {
    let res;
    try {
      res = await fetch('api' + path, {
        method,
        headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': '1', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (_) {
      throw Object.assign(new Error('network'), { code: 'network' });
    }
    if (raw && res.ok) return res;
    let data = {};
    try {
      data = await res.json();
    } catch (_) {}
    if (res.status === 401 && path !== '/login') {
      logout();
      throw Object.assign(new Error('unauthorized'), { code: 'unauthorized' });
    }
    if (!res.ok) throw Object.assign(new Error(data.error), { code: data.error, data });
    return data;
  }

  function modal(html, cls = '') {
    $('#modal-root').innerHTML = `<div class="modal-bg"><div class="modal ${cls}">${html}</div></div>`;
    const bg = $('#modal-root .modal-bg');
    bg.addEventListener('mousedown', (e) => {
      if (e.target === bg) closeModal();
    });
    return $('#modal-root .modal');
  }
  const closeModal = () => ($('#modal-root').innerHTML = '');
  document.addEventListener('keydown', (e) => e.key === 'Escape' && closeModal());

  async function busy(btn, fn) {
    if (btn) btn.disabled = true;
    try {
      return await fn();
    } catch (e) {
      if (e.code !== 'unauthorized') toast(errText(e), 'err');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /* ---------------------------------- Auth --------------------------------- */

  function showLogin() {
    $('#panel').hidden = true;
    $('#login').hidden = false;
    $('#login-pass').focus();
  }
  function logout() {
    token = null;
    store.set('hilo_admin_token', null);
    stopPolling();
    showLogin();
  }
  $('#logout').addEventListener('click', logout);

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter || $('#login-form button');
    $('#login-err').textContent = '';
    btn.disabled = true;
    try {
      const d = await api('/login', { method: 'POST', body: { password: $('#login-pass').value } });
      token = d.token;
      store.set('hilo_admin_token', token);
      $('#login-pass').value = '';
      start();
    } catch (err) {
      $('#login-err').textContent = errText(err);
    } finally {
      btn.disabled = false;
    }
  });

  /* --------------------------------- Router -------------------------------- */

  const views = { dashboard, users, tasks, settings, broadcast };
  let current = 'dashboard';

  $('#menu').addEventListener('click', (e) => {
    const b = e.target.closest('[data-view]');
    if (b) go(b.dataset.view);
  });

  function go(view) {
    current = view;
    stopPolling();
    $$('#menu button').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
    location.hash = view;
    $('#view').innerHTML = '<div class="empty">در حال بارگذاری…</div>';
    views[view]().catch((e) => {
      if (e.code !== 'unauthorized') $('#view').innerHTML = `<div class="empty">⚠️ ${esc(errText(e))}</div>`;
    });
  }

  window.addEventListener('hashchange', () => {
    const v = location.hash.slice(1);
    if (token && views[v] && v !== current) {
      closeModal();
      go(v);
    }
  });

  function start() {
    $('#login').hidden = true;
    $('#panel').hidden = false;
    const v = location.hash.slice(1);
    go(views[v] ? v : 'dashboard');
  }

  /* -------------------------------- Dashboard ------------------------------ */

  const av = (u) => `<div class="av">${esc((name(u)[0] || '?').toUpperCase())}</div>`;

  async function dashboard() {
    const s = await api('/stats');
    const max = Math.max(1, ...s.signups.map((d) => d.count));
    const notices = [];
    if (!s.bot_running) notices.push('ربات تلگرام در حال اجرا نیست. BOT_TOKEN را در فایل ‎.env بررسی کنید و سرور را ری‌استارت کنید.');
    if (!/^https:\/\//.test(s.webapp_url || ''))
      notices.push('WEBAPP_URL تنظیم نشده یا https نیست؛ دکمه باز کردن مینی‌اپ در ربات نمایش داده نمی‌شود.');

    const stat = (icon, label, value, sub = '') =>
      `<div class="card stat"><div class="ic">${icon}</div><span>${label}</span><b class="num">${value}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;

    $('#view').innerHTML = `
      <div class="vh"><div><h1>داشبورد</h1><p>خلاصه وضعیت ربات ${s.bot_username ? `<span class="ltr">@${esc(s.bot_username)}</span>` : ''}</p></div>
        <button class="btn" id="refresh">🔄 بروزرسانی</button></div>
      ${notices.map((x) => `<div class="notice warn">⚠️ ${esc(x)}</div>`).join('')}
      <div class="grid g4">
        ${stat('👥', 'کل کاربران', n(s.total_users), `+${n(s.new_today)} امروز · +${n(s.new_week)} این هفته`)}
        ${stat('🔥', 'کاربران فعال امروز', n(s.active_today), `${n(s.active_week)} در ۷ روز اخیر`)}
        ${stat('🤝', 'عضو شده با رفرال', n(s.referred), s.total_users ? `${Math.round((s.referred / s.total_users) * 100)}% از کاربران` : '')}
        ${stat('💰', 'مجموع موجودی کاربران', usd(s.total_balance))}
        ${stat('👛', 'کیف پول ثبت‌شده', n(s.wallets))}
        ${stat('✅', 'تسک‌های انجام‌شده', n(s.tasks_completed))}
        ${stat('📅', 'جایزه روزانه امروز', n(s.daily_claims_today))}
        ${stat('📨', 'قابل ارسال پیام', n(s.reachable), `${n(s.premium)} پرمیوم · ${n(s.banned)} مسدود`)}
      </div>

      <h2 class="sec">📈 ثبت‌نام ۱۴ روز اخیر</h2>
      <div class="card"><div class="chart">${s.signups
        .map(
          (d) => `<div class="bar" title="${esc(d.date)}: ${d.count}"><b class="num">${d.count || ''}</b><i style="height:${
            (d.count / max) * 100
          }%"></i><em class="num">${esc(d.date.slice(5))}</em></div>`
        )
        .join('')}</div></div>

      <div class="grid g2" style="margin-top:12px">
        <div><h2 class="sec">🏆 برترین معرف‌ها</h2>${table(
          ['کاربر', 'دعوت‌ها', 'درآمد رفرال'],
          s.top_referrers.map((u) => ({
            id: u.id,
            cells: [userCell(u), `<span class="num">${n(u.referral_count)}</span>`, usd(u.referral_earnings)],
          })),
          'هنوز دعوتی ثبت نشده'
        )}</div>
        <div><h2 class="sec">🆕 کاربران جدید</h2>${table(
          ['کاربر', 'موجودی', 'عضویت'],
          s.recent_users.map((u) => ({ id: u.id, cells: [userCell(u), usd(u.balance), date(u.created_at)] })),
          'هنوز کاربری ثبت نشده'
        )}</div>
      </div>`;
    $('#refresh').onclick = () => go('dashboard');
    bindUserRows();
  }

  const userCell = (u) =>
    `<div class="uname">${av(u)}<div><div>${esc(name(u))}</div><div class="muted ltr" style="font-size:12px">${
      u.username ? '@' + esc(u.username) : u.id
    }</div></div></div>`;

  function table(headers, rows, emptyText = 'موردی یافت نشد', min = '') {
    if (!rows.length) return `<div class="card empty">${emptyText}</div>`;
    return `<div class="table-wrap"><table ${min ? `style="min-width:${min}"` : ''}><thead><tr>${headers
      .map((h) => `<th>${h}</th>`)
      .join('')}</tr></thead><tbody>${rows
      .map((r) => `<tr ${r.id ? `class="click" data-user="${r.id}"` : ''}>${r.cells.map((c) => `<td>${c}</td>`).join('')}</tr>`)
      .join('')}</tbody></table></div>`;
  }

  function bindUserRows(root = document) {
    $$('[data-user]', root).forEach((tr) => (tr.onclick = () => openUser(tr.dataset.user)));
  }

  /* ---------------------------------- Users -------------------------------- */

  const uq = { q: '', filter: '', sort: 'newest', page: 1 };

  async function users() {
    $('#view').innerHTML = `
      <div class="vh"><div><h1>کاربران</h1><p id="users-count">…</p></div>
        <button class="btn" id="export">⬇️ خروجی CSV</button></div>
      <div class="toolbar">
        <input class="input" id="uq" placeholder="جستجو: نام، یوزرنیم، شناسه یا کیف پول" style="flex:1;min-width:220px" value="${esc(uq.q)}">
        <select class="select" id="uf">
          <option value="">همه کاربران</option>
          <option value="wallet">دارای کیف پول</option>
          <option value="referred">دعوت‌شده</option>
          <option value="premium">پرمیوم</option>
          <option value="banned">مسدود</option>
        </select>
        <select class="select" id="us">
          <option value="newest">جدیدترین</option>
          <option value="oldest">قدیمی‌ترین</option>
          <option value="balance">بیشترین موجودی</option>
          <option value="referrals">بیشترین دعوت</option>
          <option value="active">آخرین فعالیت</option>
        </select>
      </div>
      <div id="users-table"></div>`;
    $('#uf').value = uq.filter;
    $('#us').value = uq.sort;
    let t;
    $('#uq').oninput = (e) => {
      clearTimeout(t);
      t = setTimeout(() => {
        uq.q = e.target.value;
        uq.page = 1;
        loadUsers();
      }, 300);
    };
    $('#uf').onchange = (e) => ((uq.filter = e.target.value), (uq.page = 1), loadUsers());
    $('#us').onchange = (e) => ((uq.sort = e.target.value), (uq.page = 1), loadUsers());
    $('#export').onclick = (e) =>
      busy(e.currentTarget, async () => {
        const res = await api('/users.csv?' + new URLSearchParams({ q: uq.q, filter: uq.filter }), { raw: true });
        const blob = await res.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'hilocoin-users.csv';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      });
    await loadUsers();
  }

  async function loadUsers() {
    const d = await api('/users?' + new URLSearchParams(uq));
    $('#users-count').innerHTML = `<span class="num">${n(d.total)}</span> کاربر`;
    const rows = d.users.map((u) => ({
      id: u.id,
      cells: [
        userCell(u) ,
        `<span class="num muted">${u.id}</span>`,
        usd(u.balance),
        `<span class="num">${n(u.referral_count)}</span>`,
        u.wallet_address ? '<span class="badge green">ثبت شده</span>' : '<span class="muted">—</span>',
        date(u.created_at),
        u.is_banned
          ? '<span class="badge red">مسدود</span>'
          : u.is_premium
          ? '<span class="badge violet">⭐ پرمیوم</span>'
          : '<span class="badge">فعال</span>',
      ],
    }));
    $('#users-table').innerHTML =
      table(['کاربر', 'شناسه', 'موجودی', 'دعوت‌ها', 'کیف پول', 'عضویت', 'وضعیت'], rows) +
      (d.pages > 1
        ? `<div class="pager"><button class="btn btn-sm" id="prev" ${d.page <= 1 ? 'disabled' : ''}>قبلی</button>
           <span>صفحه <span class="num">${d.page}</span> از <span class="num">${d.pages}</span></span>
           <button class="btn btn-sm" id="next" ${d.page >= d.pages ? 'disabled' : ''}>بعدی</button></div>`
        : '');
    bindUserRows($('#users-table'));
    if ($('#prev')) $('#prev').onclick = () => (uq.page--, loadUsers());
    if ($('#next')) $('#next').onclick = () => (uq.page++, loadUsers());
  }

  const TX = {
    welcome: 'جایزه خوش‌آمد',
    invitee_bonus: 'جایزه دعوت‌شدن',
    referral: 'رفرال',
    commission: 'پورسانت',
    daily: 'روزانه',
    farm: 'ماینینگ',
    task: 'تسک',
    milestone: 'پله‌ای رفرال',
    admin: 'ادمین',
  };

  async function openUser(id) {
    const d = await api('/users/' + id).catch((e) => toast(errText(e), 'err'));
    if (!d) return;
    const u = d.user;
    const kv = (k, v) => `<div><span>${k}</span><b>${v}</b></div>`;
    const m = modal(`
      <div class="modal-head"><h3>${esc(name(u))} ${u.is_premium ? '⭐' : ''} ${u.is_banned ? '<span class="badge red">مسدود</span>' : ''}</h3><button class="x" data-close>×</button></div>
      <div class="kv">
        ${kv('شناسه تلگرام', `<span class="num">${u.id}</span>`)}
        ${kv('یوزرنیم', u.username ? `<span class="ltr">@${esc(u.username)}</span>` : '—')}
        ${kv('موجودی', usd(u.balance))}
        ${kv('رتبه', d.rank ? `<span class="num">#${d.rank}</span>` : '—')}
        ${kv('کل درآمد', usd(u.total_earned))}
        ${kv('دعوت‌ها', `<span class="num">${n(u.referral_count)}</span>`)}
        ${kv('درآمد رفرال', usd(u.referral_earnings))}
        ${kv('معرف', d.referrer ? `<a href="#" data-open="${d.referrer.id}">${esc(d.referrer.first_name || d.referrer.id)}</a>` : '—')}
        ${kv('تسک‌های انجام‌شده', `<span class="num">${n(d.tasks_completed)}</span>`)}
        ${kv('زنجیره روزانه', `<span class="num">${n(u.daily_streak)}</span> روز`)}
        ${kv('عضویت', date(u.created_at))}
        ${kv('آخرین بازدید', date(u.last_seen_at))}
        ${kv('زبان', esc(u.lang || u.language_code || '—'))}
        ${kv('وضعیت ربات', u.bot_blocked ? '<span class="neg">بلاک کرده</span>' : u.bot_started ? '<span class="pos">فعال</span>' : 'استارت نکرده')}
        ${kv('کیف پول', u.wallet_address ? `<span class="ltr" title="${esc(u.wallet_address)}">${esc(u.wallet_address)}</span>` : '—')}
      </div>

      <div class="box"><h4>💰 تغییر موجودی</h4>
        <div class="actions">
          <input class="input num" id="adj-amount" type="number" step="0.01" placeholder="مبلغ (منفی برای کسر)" style="width:200px">
          <input class="input" id="adj-note" placeholder="توضیح (اختیاری)" style="flex:1;min-width:160px">
          <button class="btn btn-primary" id="adj-btn">اعمال</button>
        </div></div>

      <div class="box"><h4>✉️ ارسال پیام به کاربر</h4>
        <div class="actions"><input class="input" id="msg-text" placeholder="متن پیام" style="flex:1;min-width:200px"><button class="btn" id="msg-btn">ارسال</button></div></div>

      <div class="actions" style="margin-bottom:14px">
        ${u.is_banned ? '<button class="btn btn-green" id="ban-btn">✅ رفع مسدودیت</button>' : '<button class="btn btn-danger" id="ban-btn">⛔️ مسدود کردن کاربر</button>'}
      </div>

      <div class="box"><h4>👥 دوستان دعوت‌شده (<span class="num">${d.referrals.length}</span>)</h4><div class="list-mini">${table(
        ['کاربر', 'موجودی', 'عضویت'],
        d.referrals.map((r) => ({ cells: [`<a href="#" data-open="${r.id}">${esc(name(r))}</a> ${r.is_premium ? '⭐' : ''}`, usd(r.balance), date(r.created_at)] })),
        'هنوز کسی را دعوت نکرده'
      )}</div></div>

      <div class="box"><h4>🧾 تراکنش‌ها</h4><div class="list-mini">${table(
        ['نوع', 'مبلغ', 'توضیح', 'زمان'],
        d.transactions.map((x) => ({
          cells: [
            `<span class="badge">${TX[x.type] || esc(x.type)}</span>`,
            `<span class="${x.amount >= 0 ? 'pos' : 'neg'}">${x.amount >= 0 ? '+' : '−'}${usd(Math.abs(x.amount))}</span>`,
            esc(x.note || ''),
            date(x.created_at),
          ],
        })),
        'تراکنشی وجود ندارد'
      )}</div></div>`);

    $('[data-close]', m).onclick = closeModal;
    $$('[data-open]', m).forEach((a) =>
      a.addEventListener('click', (e) => {
        e.preventDefault();
        openUser(a.dataset.open);
      })
    );
    $('#adj-btn').onclick = (e) =>
      busy(e.currentTarget, async () => {
        const amount = Number($('#adj-amount').value);
        if (!amount) return toast('مبلغ را وارد کنید', 'err');
        await api(`/users/${u.id}/balance`, { method: 'POST', body: { amount, note: $('#adj-note').value } });
        toast('موجودی بروزرسانی شد');
        openUser(u.id);
        refreshListIfUsers();
      });
    $('#msg-btn').onclick = (e) =>
      busy(e.currentTarget, async () => {
        await api(`/users/${u.id}/message`, { method: 'POST', body: { text: $('#msg-text').value } });
        $('#msg-text').value = '';
        toast('پیام ارسال شد');
      });
    $('#ban-btn').onclick = (e) =>
      busy(e.currentTarget, async () => {
        if (!u.is_banned && !confirm('این کاربر مسدود شود؟')) return;
        await api(`/users/${u.id}/ban`, { method: 'POST', body: { banned: !u.is_banned } });
        toast(u.is_banned ? 'کاربر رفع مسدودیت شد' : 'کاربر مسدود شد');
        openUser(u.id);
        refreshListIfUsers();
      });
  }

  const refreshListIfUsers = () => current === 'users' && loadUsers().catch(() => {});

  /* ---------------------------------- Tasks -------------------------------- */

  let taskList = [];

  async function tasks() {
    const d = await api('/tasks');
    taskList = d.tasks;
    $('#view').innerHTML = `
      <div class="vh"><div><h1>تسک‌ها</h1><p>تسک‌هایی که کاربران با انجامشان جایزه می‌گیرند</p></div>
        <button class="btn btn-primary" id="new-task">➕ تسک جدید</button></div>
      <div class="notice">💡 برای تسک «عضویت در کانال تلگرام»، نوع را «تلگرام» بگذارید و ربات را در آن کانال <b>ادمین</b> کنید تا عضویت کاربر به‌صورت خودکار بررسی شود. تسک‌های «لینک» پس از چند ثانیه تأیید می‌شوند.</div>
      ${table(
        ['', 'عنوان', 'نوع', 'پاداش', 'انجام‌شده', 'ترتیب', 'وضعیت', ''],
        taskList.map((t) => ({
          cells: [
            `<span style="font-size:20px">${esc(t.icon)}</span>`,
            `<div>${esc(t.title)}</div><div class="muted" style="font-size:12px">${esc(t.title_fa || '')}</div>`,
            t.type === 'telegram' ? `<span class="badge violet">تلگرام</span> <span class="muted ltr">${esc(t.chat_id || '')}</span>` : '<span class="badge">لینک</span>',
            usd(t.reward),
            `<span class="num">${n(t.completions)}</span>`,
            `<span class="num">${t.sort_order}</span>`,
            t.is_active ? '<span class="badge green">فعال</span>' : '<span class="badge red">غیرفعال</span>',
            `<div class="actions"><button class="btn btn-sm" data-edit="${t.id}">ویرایش</button><button class="btn btn-sm btn-danger" data-del="${t.id}">حذف</button></div>`,
          ],
        })),
        'هنوز تسکی ساخته نشده'
      )}`;
    $('#new-task').onclick = () => taskForm();
    $$('[data-edit]').forEach((b) => (b.onclick = () => taskForm(taskList.find((t) => t.id === Number(b.dataset.edit)))));
    $$('[data-del]').forEach(
      (b) =>
        (b.onclick = () =>
          busy(b, async () => {
            if (!confirm('این تسک حذف شود؟ سابقه انجام آن توسط کاربران هم حذف می‌شود.')) return;
            await api('/tasks/' + b.dataset.del, { method: 'DELETE' });
            toast('تسک حذف شد');
            tasks();
          }))
    );
  }

  function taskForm(t) {
    const v = t || { title: '', title_fa: '', type: 'link', url: 'https://', chat_id: '', reward: 100, icon: '📢', is_active: true, sort_order: taskList.length + 1 };
    const m = modal(
      `<div class="modal-head"><h3>${t ? 'ویرایش تسک' : 'تسک جدید'}</h3><button class="x" data-close>×</button></div>
      <form id="task-form" class="form-grid">
        <div class="field"><label>عنوان (انگلیسی)</label><input class="input" name="title" required maxlength="120" value="${esc(v.title)}"></div>
        <div class="field"><label>عنوان (فارسی)</label><input class="input" name="title_fa" maxlength="120" value="${esc(v.title_fa || '')}"></div>
        <div class="field"><label>نوع</label><select class="select" name="type">
          <option value="link" ${v.type === 'link' ? 'selected' : ''}>لینک (بازدید از سایت/شبکه اجتماعی)</option>
          <option value="telegram" ${v.type === 'telegram' ? 'selected' : ''}>تلگرام (عضویت در کانال/گروه)</option></select></div>
        <div class="field"><label>آیکون (ایموجی)</label><input class="input" name="icon" maxlength="8" value="${esc(v.icon)}"></div>
        <div class="field full"><label>لینک</label><input class="input ltr" name="url" required value="${esc(v.url)}"><small>مثال: https://t.me/mychannel یا https://x.com/myaccount</small></div>
        <div class="field full" id="chat-field"><label>شناسه کانال برای بررسی عضویت</label><input class="input ltr" name="chat_id" placeholder="@mychannel یا -1001234567890" value="${esc(v.chat_id || '')}"><small>اگر خالی بماند از لینک t.me استخراج می‌شود. ربات باید در کانال ادمین باشد.</small></div>
        <div class="field"><label>پاداش (${esc(currency)})</label><input class="input num" name="reward" type="number" min="0" step="0.01" value="${v.reward}"></div>
        <div class="field"><label>ترتیب نمایش</label><input class="input num" name="sort_order" type="number" value="${v.sort_order}"></div>
        <label class="check full"><input type="checkbox" name="is_active" ${v.is_active ? 'checked' : ''}> فعال باشد</label>
        <div class="full actions" style="justify-content:flex-end"><button type="button" class="btn" data-close>انصراف</button><button class="btn btn-primary" type="submit">ذخیره</button></div>
      </form>`,
      'sm'
    );
    const f = $('#task-form', m);
    const syncType = () => ($('#chat-field', m).hidden = f.type.value !== 'telegram');
    f.type.onchange = syncType;
    syncType();
    $$('[data-close]', m).forEach((b) => (b.onclick = closeModal));
    f.onsubmit = (e) => {
      e.preventDefault();
      busy(e.submitter, async () => {
        const body = {
          title: f.title.value,
          title_fa: f.title_fa.value,
          type: f.type.value,
          icon: f.icon.value,
          url: f.url.value,
          chat_id: f.chat_id.value,
          reward: Number(f.reward.value),
          sort_order: Number(f.sort_order.value),
          is_active: f.is_active.checked,
        };
        await api(t ? '/tasks/' + t.id : '/tasks', { method: t ? 'PUT' : 'POST', body });
        closeModal();
        toast('تسک ذخیره شد');
        tasks();
      });
    };
  }

  /* --------------------------------- Settings ------------------------------ */

  async function settings() {
    const { settings: s } = await api('/settings');
    currency = s.currency_symbol;
    const num = (key, label, hint = '', step = '0.01') =>
      `<div class="field"><label>${label}</label><input class="input num" type="number" min="0" step="${step}" name="${key}" value="${esc(s[key])}">${hint ? `<small>${hint}</small>` : ''}</div>`;
    const txt = (key, label, hint = '', cls = '') =>
      `<div class="field ${cls}"><label>${label}</label><input class="input ${key.endsWith('url') ? 'ltr' : ''}" name="${key}" value="${esc(s[key])}">${hint ? `<small>${hint}</small>` : ''}</div>`;

    $('#view').innerHTML = `
      <div class="vh"><div><h1>تنظیمات</h1><p>مبالغ به ${esc(s.currency_symbol)} هستند و تغییرات فوراً اعمال می‌شوند</p></div></div>
      <form id="settings-form">
        <div class="card" style="margin-bottom:14px"><h2 class="sec" style="margin-top:0">🎁 جایزه ورود</h2><div class="form-grid">
          ${num('welcome_bonus', 'جایزه خوش‌آمدگویی', 'به محض ورود به هر کاربر جدید داده می‌شود')}
          ${num('invitee_bonus', 'جایزه اضافه برای دعوت‌شده', 'به کاربری که با لینک دعوت وارد می‌شود (۰ = غیرفعال)')}
        </div></div>

        <div class="card" style="margin-bottom:14px"><h2 class="sec" style="margin-top:0">🤝 سیستم رفرال</h2><div class="form-grid">
          ${num('referral_bonus', 'پاداش هر دعوت', 'به معرف برای هر دوست')}
          ${num('referral_bonus_premium', 'پاداش دعوت کاربر پرمیوم', 'به معرف برای هر دوست تلگرام پرمیوم')}
          ${num('referral_commission_percent', 'درصد پورسانت', 'درصدی از درآمد ماینینگ/روزانه/تسک دوستان که به معرف می‌رسد', '0.1')}
          ${num('task_link_wait_seconds', 'زمان انتظار تسک لینک (ثانیه)', 'حداقل فاصله بین «شروع» و «بررسی»', '1')}
          <div class="field full"><label>جوایز پله‌ای دعوت</label>
            <div id="ms-rows" style="display:flex;flex-direction:column;gap:8px"></div>
            <div><button type="button" class="btn btn-sm" id="ms-add" style="margin-top:6px">➕ افزودن پله</button></div>
          </div>
        </div></div>

        <div class="card" style="margin-bottom:14px"><h2 class="sec" style="margin-top:0">⛏️ ماینینگ و جایزه روزانه</h2><div class="form-grid">
          ${num('farm_hours', 'مدت هر دوره ماینینگ (ساعت)', '', '0.25')}
          ${num('farm_reward', 'پاداش هر دوره ماینینگ')}
          <div class="field full"><label>جوایز روزانه (به ترتیب روز، با کاما جدا کنید)</label>
            <input class="input num" name="daily_rewards" value="${esc(s.daily_rewards.join(', '))}">
            <small>بعد از روز آخر، چرخه از روز اول تکرار می‌شود. اگر کاربر یک روز را از دست بدهد زنجیره صفر می‌شود.</small></div>
        </div></div>

        <div class="card" style="margin-bottom:14px"><h2 class="sec" style="margin-top:0">🪂 ایردراپ و برند</h2><div class="form-grid">
          ${txt('token_name', 'نام توکن')}
          ${txt('currency_symbol', 'نماد واحد پول', 'مثلاً $')}
          ${txt('channel_url', 'لینک کانال رسمی', 'در ربات و اپ نمایش داده می‌شود (اختیاری)')}
          ${txt('support_url', 'لینک پشتیبانی', 'اختیاری')}
          <div class="field full"><label>متن ایردراپ (انگلیسی)</label><textarea class="input" name="airdrop_text_en" dir="ltr">${esc(s.airdrop_text_en)}</textarea></div>
          <div class="field full"><label>متن ایردراپ (فارسی)</label><textarea class="input" name="airdrop_text_fa">${esc(s.airdrop_text_fa)}</textarea></div>
        </div></div>

        <div class="card"><label class="check"><input type="checkbox" name="maintenance" ${s.maintenance ? 'checked' : ''}> 🛠 حالت تعمیرات (اپ برای کاربران غیر ادمین بسته می‌شود)</label></div>

        <div class="sticky-save"><button class="btn btn-primary" type="submit" style="min-width:160px">💾 ذخیره تنظیمات</button></div>
      </form>`;

    const msRows = $('#ms-rows');
    const addMs = (m = { friends: '', reward: '' }) => {
      const row = document.createElement('div');
      row.className = 'actions';
      row.innerHTML = `<input class="input num" type="number" min="1" placeholder="تعداد دوست" value="${esc(m.friends)}" data-f style="width:150px">
        <span class="muted">دوست ←</span>
        <input class="input num" type="number" min="0" step="0.01" placeholder="پاداش" value="${esc(m.reward)}" data-r style="width:150px">
        <button type="button" class="btn btn-sm btn-danger">حذف</button>`;
      row.querySelector('button').onclick = () => row.remove();
      msRows.appendChild(row);
    };
    s.milestones.forEach(addMs);
    $('#ms-add').onclick = () => addMs();

    $('#settings-form').onsubmit = (e) => {
      e.preventDefault();
      const f = e.target;
      busy(e.submitter, async () => {
        const body = {};
        ['welcome_bonus', 'invitee_bonus', 'referral_bonus', 'referral_bonus_premium', 'referral_commission_percent', 'task_link_wait_seconds', 'farm_hours', 'farm_reward'].forEach(
          (k) => (body[k] = Number(f[k].value))
        );
        ['token_name', 'currency_symbol', 'channel_url', 'support_url', 'airdrop_text_en', 'airdrop_text_fa'].forEach((k) => (body[k] = f[k].value));
        body.maintenance = f.maintenance.checked;
        body.daily_rewards = f.daily_rewards.value
          .split(/[,،\s]+/)
          .filter(Boolean)
          .map(Number);
        body.milestones = $$('#ms-rows .actions')
          .map((r) => ({ friends: Number($('[data-f]', r).value), reward: Number($('[data-r]', r).value) }))
          .filter((m) => m.friends > 0);
        const d = await api('/settings', { method: 'PUT', body });
        currency = d.settings.currency_symbol;
        toast('تنظیمات ذخیره شد');
      });
    };
  }

  /* -------------------------------- Broadcast ------------------------------ */

  let pollT = null;
  const stopPolling = () => (clearTimeout(pollT), (pollT = null));

  async function broadcast() {
    const st = await api('/stats');
    $('#view').innerHTML = `
      <div class="vh"><div><h1>پیام همگانی</h1><p>ارسال پیام به <span class="num">${n(st.reachable)}</span> کاربری که ربات را استارت کرده‌اند</p></div></div>
      ${st.bot_running ? '' : '<div class="notice warn">⚠️ ربات در حال اجرا نیست؛ ارسال پیام ممکن نیست.</div>'}
      <form class="card" id="bc-form" style="margin-bottom:14px"><div class="form-grid">
        <div class="field full"><label>متن پیام</label><textarea class="input" name="text" maxlength="4000" required placeholder="سلام! 🎉 ..."></textarea>
          <label class="check" style="font-weight:500"><input type="checkbox" name="html"> استفاده از HTML (&lt;b&gt;، &lt;i&gt;، &lt;a href&gt;)</label></div>
        <div class="field"><label>دکمه زیر پیام</label><select class="select" name="btype">
          <option value="none">بدون دکمه</option><option value="app" selected>باز کردن مینی‌اپ</option><option value="url">لینک دلخواه</option></select></div>
        <div class="field" id="bt-field"><label>متن دکمه</label><input class="input" name="button_text" value="🚀 Open HiloCoin" maxlength="64"></div>
        <div class="field full" id="bu-field" hidden><label>لینک دکمه</label><input class="input ltr" name="button_url" placeholder="https://"></div>
        <div class="full actions" style="justify-content:flex-end">
          <button type="button" class="btn" id="bc-test">🧪 ارسال آزمایشی به ادمین‌ها</button>
          <button type="submit" class="btn btn-primary">📣 ارسال به همه</button>
        </div>
      </div></form>
      <h2 class="sec">📜 تاریخچه ارسال‌ها</h2><div id="bc-list"></div>`;

    const f = $('#bc-form');
    const sync = () => {
      $('#bt-field').hidden = f.btype.value === 'none';
      $('#bu-field').hidden = f.btype.value !== 'url';
    };
    f.btype.onchange = sync;
    sync();
    const body = () => ({
      text: f.text.value,
      html: f.html.checked,
      button_text: f.btype.value === 'none' ? '' : f.button_text.value,
      open_app: f.btype.value === 'app',
      button_url: f.btype.value === 'url' ? f.button_url.value : '',
    });
    $('#bc-test').onclick = (e) =>
      busy(e.currentTarget, async () => {
        const d = await api('/broadcasts/test', { method: 'POST', body: body() });
        toast(`ارسال آزمایشی: ${d.sent} از ${d.total}`);
      });
    f.onsubmit = (e) => {
      e.preventDefault();
      busy(e.submitter, async () => {
        if (!confirm(`پیام برای ${n(st.reachable)} کاربر ارسال شود؟`)) return;
        await api('/broadcasts', { method: 'POST', body: body() });
        toast('ارسال همگانی شروع شد');
        f.text.value = '';
        loadBroadcasts();
      });
    };
    await loadBroadcasts();
  }

  const BC_STATUS = {
    running: '<span class="badge gold">در حال ارسال</span>',
    done: '<span class="badge green">تمام شد</span>',
    stopped: '<span class="badge red">متوقف شد</span>',
    failed: '<span class="badge red">خطا</span>',
  };

  async function loadBroadcasts() {
    if (current !== 'broadcast') return;
    const d = await api('/broadcasts');
    const el = $('#bc-list');
    if (!el) return;
    el.innerHTML = table(
      ['#', 'متن', 'وضعیت', 'پیشرفت', 'موفق', 'ناموفق', 'زمان', ''],
      d.broadcasts.map((b) => {
        const done = b.sent + b.failed;
        const pct = b.total ? Math.min(100, (done / b.total) * 100) : 100;
        return {
          cells: [
            `<span class="num">${b.id}</span>`,
            `<span title="${esc(b.text)}">${esc(b.text.slice(0, 40))}${b.text.length > 40 ? '…' : ''}</span>`,
            BC_STATUS[b.status] || esc(b.status),
            `<div class="progress"><i style="width:${pct}%"></i></div>`,
            `<span class="num pos">${n(b.sent)}</span>`,
            `<span class="num neg">${n(b.failed)}</span>`,
            date(b.created_at),
            b.status === 'running' ? '<button class="btn btn-sm btn-danger" id="bc-stop">توقف</button>' : '',
          ],
        };
      }),
      'هنوز پیامی ارسال نشده'
    );
    if ($('#bc-stop'))
      $('#bc-stop').onclick = (e) =>
        busy(e.currentTarget, async () => {
          await api('/broadcasts/stop', { method: 'POST' });
          toast('درخواست توقف ارسال شد');
        });
    stopPolling();
    if (d.running) pollT = setTimeout(() => loadBroadcasts().catch(() => {}), 2000);
  }

  /* ---------------------------------- Boot --------------------------------- */

  if (token) {
    api('/settings')
      .then((d) => {
        currency = d.settings.currency_symbol;
        start();
      })
      .catch((e) => {
        if (e.code === 'unauthorized') return;
        showLogin();
        $('#login-err').textContent = errText(e);
      });
  } else showLogin();
})();
