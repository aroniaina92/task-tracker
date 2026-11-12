/* Task Tracker – phone app (GitHub Pages) talking to the Apps Script API.
   Sheet -> Google Tasks -> Reclaim is handled by the sync script in the sheet. */
(() => {
'use strict';

/* =====================================================================
   State, storage, API
   ===================================================================== */
const CFG = window.TT_CONFIG || {};
const DEMO = !CFG.API_URL;
const S = {
  token: null, user: null, data: null, view: 'home',
  f: { q: '', scope: 'open', goal: '', obj: '' },
  editing: null, form: null,
  easy: { max: 2, q: '', open: new Set() },
  plan: { cat: null }
};
const REQUIRED = ['Main goal', 'Category', 'Objective', 'Due date', 'Est hours', 'Priority', 'Energy'];
const DEFAULT_STATUSES = ['Not Started', 'In Progress', 'Waiting', 'Completed'];
const PRIO = { High: 0, Medium: 1, Low: 2, '': 3 };

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} }
};

async function api(action, payload = {}) {
  if (DEMO) return Demo.call(action, payload);
  const res = await fetch(CFG.API_URL, {
    method: 'POST',
    body: JSON.stringify(Object.assign({ action, token: S.token }, payload)) // text/plain: no CORS preflight
  });
  const j = await res.json();
  if (!j.ok) {
    if (j.error === 'AUTH') { logout(true); throw new Error('Session expired, please log in again'); }
    throw new Error(j.error || 'Server error');
  }
  return j;
}

/* =====================================================================
   Helpers
   ===================================================================== */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
const lead = s => (String(s ?? '').match(/^[^\p{L}\p{N}]+/u) || [''])[0].replace(/\s+/g, '');
const d10 = v => String(v || '').slice(0, 10);
const isDone = t => t.Status === 'Completed';
const isTrue = v => v === true || String(v).toUpperCase() === 'TRUE';
const inReclaim = t => String(t.Reclaim || '').trim().toUpperCase() === 'YES';
const isDoNow = t => String(t['Start now'] || '').trim().toLowerCase() === 'do now';
const isAdmin = () => S.user && S.user.role === 'admin';
const hrs = t => Number(t['Est hours']) || 0;
const today = () => S.data.today;
function addDays(iso, n) { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }
function dayDiff(a, b) { return Math.round((new Date(a + 'T12:00:00') - new Date(b + 'T12:00:00')) / 864e5); }
function niceDate(iso) {
  if (!iso) return '';
  const n = dayDiff(d10(iso), today());
  if (n === 0) return 'today'; if (n === 1) return 'tomorrow'; if (n === -1) return 'yesterday';
  return new Date(d10(iso) + 'T12:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
// Reef palette: lagoon, coral, sand-gold, anemone, sea-grass, deep blue, sponge, pink coral
const HUES = [178, 8, 40, 278, 150, 205, 24, 335];
function hue(goal) {
  const i = S.data.goals.findIndex(g => g.Name === goal);
  return HUES[(i < 0 ? S.data.goals.length : i) % HUES.length];
}
const REEF_ART = `<svg class="art" viewBox="0 0 400 84" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
  <path d="M0 84V58Q30 44 62 55T124 50T186 57T248 46T310 54T372 45T400 50V84Z" fill="rgba(255,255,255,.10)"/>
  <g fill="none" stroke-linecap="round" stroke-linejoin="round">
    <path d="M62 84V60M62 70L50 56L45 45M50 56L57 47M62 65L75 51L73 40M75 51L84 45" stroke="#ff8f78" stroke-width="5"/>
    <path d="M206 84C200 74 212 66 205 56C199 47 209 41 204 32" stroke="#6fdcae" stroke-width="4" opacity=".85"/>
    <path d="M352 84C346 75 357 69 351 60C346 53 354 47 350 40" stroke="#6fdcae" stroke-width="4" opacity=".7"/>
    <path d="M300 84L286 56M300 84L294 52M300 84L302 50M300 84L310 53M300 84L318 58" stroke="#c9a7ff" stroke-width="3" opacity=".8"/>
  </g>
  <ellipse cx="128" cy="82" rx="24" ry="15" fill="#f3dfb5" opacity=".9"/>
  <path d="M110 80q6-8 12 0t12 0t12 0" fill="none" stroke="#d9bd86" stroke-width="2"/>
  <circle cx="252" cy="80" r="9" fill="#ffb0a0" opacity=".9"/><circle cx="264" cy="82" r="6" fill="#ff8f78" opacity=".8"/>
  <path d="M0 84V74Q100 66 200 75T400 71V84Z" fill="rgba(243,223,181,.35)"/>
</svg>`;
const BUBBLES = `<svg class="bubbles" viewBox="0 0 60 70" aria-hidden="true" fill="none" stroke="#fff" stroke-width="1.5">
  <circle cx="40" cy="58" r="7"/><circle cx="26" cy="36" r="4.5"/><circle cx="44" cy="22" r="3"/><circle cx="30" cy="8" r="2"/></svg>`;
function initial() { return esc(((S.user && (S.user.name || S.user.email)) || '?').trim()[0].toUpperCase()); }
function pageTop(title) {
  return `<div class="ptop"><h1 class="ptitle">${esc(title)}</h1><button class="avatar-btn" data-view="me" aria-label="My account">${initial()}</button></div>`;
}
function statuses() { const s = new Set(DEFAULT_STATUSES); S.data.tasks.forEach(t => t.Status && s.add(t.Status)); return [...s]; }
function openStatus() { return statuses().includes('Not Started') ? 'Not Started' : statuses()[0]; }
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2600); }
let busy = 0;
function syncing(on, text) {
  busy += on ? 1 : -1; if (busy < 0) busy = 0;
  $('#syncdot').classList.toggle('hidden', busy === 0);
  if (text) $('#synctext').textContent = text;
}
function blockers(t) {
  if (!t.Dependencies) return [];
  return String(t.Dependencies).split(/[;,\n]/).map(norm).filter(Boolean)
    .map(dn => S.data.tasks.find(x => x.ID !== t.ID && (norm(x.Task) === dn || norm(x.ID) === dn)))
    .filter(x => x && !isDone(x));
}
const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

/* =====================================================================
   Task card
   ===================================================================== */
function card(t, opts = {}) {
  const td = today(), due = d10(t['Due date']), m = [];
  m.push(`<span class="cat"><i></i>${esc(t.Category || 'No category')}</span>`);
  if (!isDone(t)) {
    if (due && due < td) m.push(`<span class="over">Overdue · ${niceDate(due)}</span>`);
    else if (due && dayDiff(due, td) <= 2) m.push(`<span class="soon">Due ${niceDate(due)}</span>`);
    else if (due) m.push(`<span>Due ${niceDate(due)}</span>`);
    if (hrs(t)) m.push(`<span>${hrs(t)} h</span>`); else m.push('<span class="nohrs">no hours</span>');
    if (t.Energy) { const e = Math.min(5, Number(t.Energy) || 0); m.push(`<span class="energy" title="Energy ${e}/5">${'<b>●</b>'.repeat(e)}${'<i>●</i>'.repeat(5 - e)}</span>`); }
    if (blockers(t).length) m.push('<span class="wait">⛓ waiting on a task</span>');
    if (t['Waiting on']) m.push(`<span class="wait">⏳ ${esc(t['Waiting on'])}</span>`);
  } else if (t['Completed on']) m.push(`<span>Done ${niceDate(t['Completed on'])}</span>`);

  const side = [];
  if (!isDone(t)) {
    if (isAdmin() && inReclaim(t) && !opts.noNow)
      side.push(`<button class="now ${isDoNow(t) ? 'on' : ''}" data-act="donow" title="Move the Reclaim block to start now">${isDoNow(t) ? '▶ now' : '▶'}</button>`);
    side.push(`<button class="ibtn sun ${isTrue(t.Today) ? 'on' : ''}" data-act="today" aria-label="Plan for today" title="Plan for today">☀️</button>`);
  }
  return `<article class="task ${isDone(t) ? 'done' : ''}" style="--h:${hue(t['Main goal'])}" data-id="${esc(t.ID)}">
    <button class="tick" data-act="done" aria-label="${isDone(t) ? 'Mark as not done' : 'Mark as done'}">${CHECK}</button>
    <div class="tmain" data-act="open"><div class="ttitle">${esc(t.Task)}</div><div class="tmeta">${m.join('')}</div></div>
    <div class="tside">${side.join('')}</div></article>`;
}
const list = arr => `<div class="list">${arr.map(t => card(t)).join('')}</div>`;
function sortTasks(arr, by = 'due') {
  const k = t => d10(t['Due date']) || '9999';
  return arr.slice().sort((a, b) => by === 'prio'
    ? (PRIO[a.Priority || ''] - PRIO[b.Priority || '']) || k(a).localeCompare(k(b))
    : k(a).localeCompare(k(b)) || (PRIO[a.Priority || ''] - PRIO[b.Priority || '']));
}

/* =====================================================================
   Home
   ===================================================================== */
function todayBuckets() {
  const td = today(), T = S.data.tasks;
  const open = T.filter(t => !isDone(t));
  const planned = open.filter(t => isTrue(t.Today) || d10(t['Due date']) === td || d10(t['Scheduled date']) === td);
  const ids = new Set(planned.map(t => t.ID));
  const overdue = sortTasks(open.filter(t => !ids.has(t.ID) && d10(t['Due date']) && d10(t['Due date']) < td));
  const progress = open.filter(t => !ids.has(t.ID) && !overdue.includes(t) && t.Status === 'In Progress');
  const doneToday = T.filter(t => isDone(t) && d10(t['Completed on']) === td);
  return { planned: sortTasks(planned, 'prio'), overdue, progress, doneToday };
}
function streak() {
  const days = new Set(S.data.tasks.filter(isDone).map(t => d10(t['Completed on'])));
  let d = days.has(today()) ? today() : addDays(today(), -1), n = 0;
  while (days.has(d)) { n++; d = addDays(d, -1); }
  return n;
}
function viewHome() {
  const td = today(), B = todayBuckets();
  const total = B.planned.length + B.doneToday.length;
  const pct = total ? Math.round(100 * B.doneToday.length / total) : 0;
  const hDone = B.doneToday.reduce((s, t) => s + hrs(t), 0), hAll = hDone + B.planned.reduce((s, t) => s + hrs(t), 0);
  const h = new Date().getHours();
  const hello = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  const name = String(S.user.name || '').split(' ')[0];
  const dateTxt = new Date(td + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  const C = 2 * Math.PI * 46;
  const st = streak();

  // week strip (Monday first)
  const dow = (new Date(td + 'T12:00:00').getDay() + 6) % 7;
  const mon = addDays(td, -dow);
  const days = [...Array(7)].map((_, i) => addDays(mon, i));
  const counts = days.map(d => S.data.tasks.filter(t => isDone(t) && d10(t['Completed on']) === d).length);
  const max = Math.max(3, ...counts);
  const week = days.map((d, i) => `<div class="day ${d === td ? 'today' : ''} ${d > td ? 'future' : ''}">
      <div class="num">${counts[i] || ''}</div><div class="bar"><span style="height:${counts[i] / max * 100}%"></span></div>
      <div class="lbl">${new Date(d + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'narrow' })}</div></div>`).join('');

  return `<section class="reef">
      ${BUBBLES}
      <div class="top"><div><div class="greet">${hello}${name ? ', ' + esc(name) : ''}</div><div class="date">${dateTxt}</div></div>
        <button class="avatar-btn" data-view="me" aria-label="My account">${initial()}</button></div>
      <div class="prog">
        <div class="ring"><svg width="104" height="104" viewBox="0 0 108 108"><circle class="bg" cx="54" cy="54" r="46" fill="none" stroke-width="10"/>
          <circle class="fg" cx="54" cy="54" r="46" fill="none" stroke-width="10" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - pct / 100)}"/></svg>
          <div class="pct">${pct}%</div></div>
        <div><div class="big">${B.doneToday.length} of ${total} tasks done</div>
          <div class="small">${hAll ? `${hDone.toFixed(1)} of ${hAll.toFixed(1)} h` : 'No hours estimated yet'}</div>
          <div class="badges">${st ? `<span class="badge hot">🔥 ${st}-day streak</span>` : ''}${B.overdue.length ? `<span class="badge">${B.overdue.length} overdue</span>` : ''}</div></div>
      </div>
      ${REEF_ART}
    </section>
    <div class="card week" aria-label="Tasks completed this week">${week}</div>

    <div class="sec-h"><h2>Today <span class="n">${B.planned.length}</span></h2><button class="link" data-act="plan">Plan my day</button></div>
    ${B.planned.length ? list(B.planned) : `<div class="empty">Nothing planned yet.<br><button class="btn primary" data-act="plan">Plan my day</button></div>`}
    ${B.overdue.length ? `<div class="sec-h danger"><h2>Overdue <span class="n">${B.overdue.length}</span></h2></div>${list(B.overdue)}` : ''}
    ${B.progress.length ? `<div class="sec-h"><h2>In progress <span class="n">${B.progress.length}</span></h2></div>${list(B.progress)}` : ''}
    ${B.doneToday.length ? `<details class="done-list"><summary>Done today (${B.doneToday.length})</summary>${list(B.doneToday)}</details>` : ''}`;
}

/* =====================================================================
   Tasks
   ===================================================================== */
function filtered() {
  const f = S.f, q = norm(f.q);
  return S.data.tasks.filter(t =>
    (f.scope === 'all' || (f.scope === 'open' ? !isDone(t) : isDone(t))) &&
    (!f.goal || t['Main goal'] === f.goal) && (!f.obj || t.Objective === f.obj) &&
    (!q || norm([t.Task, t.Objective, t.Category, t.Notes].join(' ')).includes(q)));
}
function viewTasks() {
  const f = S.f, arr = filtered(), groups = new Map();
  sortTasks(arr).forEach(t => { const k = t.Objective || 'No objective'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); });
  const chip = (lbl, on, act, val) => `<button class="chip" aria-pressed="${on}" data-act="${act}" data-v="${esc(val)}">${esc(lbl)}</button>`;
  const goalChips = S.data.goals.map(g => chip(g.Name, f.goal === g.Name, 'fgoal', g.Name)).join('');
  return `${pageTop('Tasks')}
    <div class="toolbar"><input class="search" type="search" placeholder="Search tasks" value="${esc(f.q)}" data-f="q" aria-label="Search tasks">
      <div class="chips">${chip('Open', f.scope === 'open', 'fscope', 'open')}${chip('Done', f.scope === 'done', 'fscope', 'done')}${chip('All', f.scope === 'all', 'fscope', 'all')}
        ${f.obj ? `<button class="chip filter" data-act="fobj-clear">${esc(f.obj)} ✕</button>` : ''}</div>
      <div class="chips">${chip('All goals', !f.goal, 'fgoal', '')}${goalChips}</div></div>
    ${groups.size ? [...groups].map(([o, ts]) => `<div class="group"><div class="group-h"><b>${esc(o)}</b><small>${esc(ts[0].Category || '')} · ${ts.length}</small></div>${list(ts)}</div>`).join('')
      : '<div class="empty">No tasks here.</div>'}`;
}

/* =====================================================================
   Projects
   ===================================================================== */
function stat(ts) { const d = ts.filter(isDone).length; return { d, n: ts.length, p: ts.length ? Math.round(100 * d / ts.length) : 0, h: ts.filter(t => !isDone(t)).reduce((s, t) => s + hrs(t), 0) }; }
function viewProjects() {
  const D = S.data, goals = D.goals.map(g => g.Name);
  D.tasks.forEach(t => { if (t['Main goal'] && !goals.includes(t['Main goal'])) goals.push(t['Main goal']); });
  const html = goals.map(g => {
    const gt = D.tasks.filter(t => t['Main goal'] === g), gs = stat(gt), h = hue(g);
    const cats = D.categories.filter(c => c['Main goal'] === g).map(c => c.Name);
    gt.forEach(t => { if (t.Category && !cats.includes(t.Category)) cats.push(t.Category); });
    const catHTML = cats.map(c => {
      const ct = gt.filter(t => t.Category === c), cs = stat(ct);
      const objs = D.objectives.filter(o => o.Category === c).map(o => o.Name);
      ct.forEach(t => { if (t.Objective && !objs.includes(t.Objective)) objs.push(t.Objective); });
      const rows = objs.map(o => { const s = stat(ct.filter(t => t.Objective === o)); return { s, html:
        `<div class="obj ${s.n && s.d === s.n ? 'complete' : ''}" data-act="fobj" data-v="${esc(o)}"><span class="on">${esc(o)}</span><div class="pbar"><span style="width:${s.p}%"></span></div><span class="c">${s.d}/${s.n}</span></div>` }; });
      const active = rows.filter(r => !(r.s.n && r.s.d === r.s.n)), closed = rows.filter(r => r.s.n && r.s.d === r.s.n);
      return `<div class="cat-b"><div class="ch"><span>${esc(c)}</span><small>${cs.h ? cs.h.toFixed(1) + ' h left' : ''}</small></div>
        ${active.map(r => r.html).join('') || '<div class="note">All objectives done.</div>'}
        ${closed.length ? `<details class="closed"><summary>${closed.length} finished</summary>${closed.map(r => r.html).join('')}</details>` : ''}</div>`;
    }).join('');
    return `<section class="card goal" style="--h:${h}"><div class="goal-h"><span class="name">${esc(g)}</span><span class="pct">${gs.p}%</span></div>
      <div class="pbar"><span style="width:${gs.p}%"></span></div><div class="note" style="margin:8px 0 0">${gs.d} of ${gs.n} tasks · ${gs.h.toFixed(1)} h left</div>${catHTML}</section>`;
  }).join('');
  return `${pageTop('Projects')}${html || '<div class="empty">No goals yet.</div>'}`;
}

/* =====================================================================
   Easy: low-energy tasks grouped by category
   ===================================================================== */
function catOrder() {
  // categories in goal order, then any category only found in tasks
  const D = S.data, out = [];
  D.goals.forEach(g => D.categories.filter(c => c['Main goal'] === g.Name).forEach(c => out.push({ name: c.Name, goal: g.Name })));
  D.categories.forEach(c => { if (!out.some(o => o.name === c.Name)) out.push({ name: c.Name, goal: c['Main goal'] }); });
  D.tasks.forEach(t => { if (t.Category && !out.some(o => o.name === t.Category)) out.push({ name: t.Category, goal: t['Main goal'] }); });
  return out;
}
function viewEasy() {
  const E = S.easy, q = norm(E.q);
  const open = S.data.tasks.filter(t => !isDone(t));
  const pool = open.filter(t => Number(t.Energy) > 0 && Number(t.Energy) <= E.max &&
    (!q || norm([t.Task, t.Objective, t.Category].join(' ')).includes(q)));
  const unrated = open.filter(t => !(Number(t.Energy) > 0)).length;
  const groups = catOrder().map(c => ({ c, ts: sortTasks(pool.filter(t => t.Category === c.name)).sort((a, b) => Number(a.Energy) - Number(b.Energy)) }))
    .filter(g => g.ts.length);
  const segBtn = (v, l) => `<button type="button" data-act="easy-max" data-v="${v}" aria-pressed="${E.max === v}">${l}</button>`;
  return `${pageTop('Easy tasks')}
    <p class="psub">Low-energy tasks for tired moments, grouped by category.</p>
    <div class="toolbar"><input class="search" type="search" placeholder="Search easy tasks" value="${esc(E.q)}" data-f="easyq" aria-label="Search easy tasks">
      <div class="field" style="margin:12px 0 0">Energy up to<div class="seg">${segBtn(1, '1 · very easy')}${segBtn(2, '≤ 2')}${segBtn(3, '≤ 3')}</div></div></div>
    ${groups.length ? groups.map(g => {
      const h = g.ts.reduce((s, t) => s + hrs(t), 0);
      const isOpen = q || E.open.has(g.c.name);
      return `<details class="card acc" data-cat="${esc(g.c.name)}" ${isOpen ? 'open' : ''} style="--h:${hue(g.c.goal)}">
        <summary><span class="dot"></span><span class="nm">${esc(g.c.name)}<small>${esc(g.c.goal || '')}${h ? ' · ' + h.toFixed(1) + ' h' : ''}</small></span><span class="cnt">${g.ts.length}</span></summary>
        ${list(g.ts)}</details>`; }).join('')
      : '<div class="empty">No open task at this energy level.</div>'}
    ${unrated ? `<p class="note">${unrated} open task${unrated > 1 ? 's have' : ' has'} no energy rating and ${unrated > 1 ? 'are' : 'is'} not shown.</p>` : ''}`;
}

/* =====================================================================
   Me
   ===================================================================== */
function viewMe() {
  const u = S.user, theme = store.get('tt_theme') || 'auto';
  const last = store.get('tt_last_' + u.email);
  return `<div class="ptop"><h1 class="ptitle">Me</h1></div>
    <div class="card me-h"><div class="avatar">${esc((u.name || u.email || '?').trim()[0].toUpperCase())}</div>
      <div><div style="font-weight:700">${esc(u.name || '')}</div><div class="note" style="margin:0">${esc(u.email)}${isAdmin() ? ' · owner' : ''}</div></div></div>
    <div class="card menu">
      ${isAdmin() ? '<button data-act="sync">Sync with Google Tasks / Reclaim now <small>›</small></button>' : ''}
      <button data-act="refresh">Reload from the sheet <small>${last ? 'last ' + new Date(last).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</small></button>
      <button data-act="theme">Theme <small>${theme === 'auto' ? 'Automatic' : theme === 'dark' ? 'Dark' : 'Light'}</small></button>
      <button data-act="password">Change password <small>›</small></button>
      <button data-act="logout" style="color:var(--danger)">Log out</button>
    </div>
    ${DEMO ? '<p class="note">Demo mode: changes are not saved. Add your Apps Script URL in config.js.</p>' : ''}
    ${isAdmin() ? '' : '<p class="note">Your tasks are private to your account. Reclaim scheduling is only available to the owner.</p>'}`;
}

/* =====================================================================
   Login
   ===================================================================== */
function viewLogin(msg = '') {
  $('#nav').classList.add('hidden');
  $('#app').innerHTML = `<div class="login"><form class="card" id="loginForm" autocomplete="on">
    <img class="logo" src="icons/icon-192.png" alt="">
    <h1>Task Tracker</h1><p>Log in to see your day.</p>
    ${DEMO ? '<div class="demo">Demo mode: any email and password work. Sample data only.</div>' : ''}
    <label class="field">Email<input name="email" type="email" required autocomplete="username"></label>
    <label class="field">Password<input name="password" type="password" required autocomplete="current-password"></label>
    <div class="err" id="loginErr">${esc(msg)}</div>
    <button class="btn primary block" id="loginBtn">Log in</button></form></div>`;
  $('#loginForm').onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.target), btn = $('#loginBtn');
    btn.disabled = true; btn.textContent = 'Logging in…';
    try {
      const r = DEMO ? await Demo.call('login', {}) : await (await fetch(CFG.API_URL, { method: 'POST', body: JSON.stringify({ action: 'login', email: fd.get('email'), password: fd.get('password') }) })).json();
      if (!r.ok) throw new Error(r.error);
      S.token = r.token; S.user = r.user; store.set('tt_auth', { token: r.token, user: r.user });
      start();
    } catch (err) { $('#loginErr').textContent = err.message || 'Could not log in'; btn.disabled = false; btn.textContent = 'Log in'; }
  };
}
function logout(expired) {
  if (!expired && !DEMO) api('logout').catch(() => {});
  store.del('tt_auth'); S.token = S.user = S.data = null;
  viewLogin(expired ? 'Your session expired. Please log in again.' : '');
}

/* =====================================================================
   Render & data flow
   ===================================================================== */
const VIEWS = { home: viewHome, tasks: viewTasks, easy: viewEasy, projects: viewProjects, me: viewMe };
function render() {
  if (!S.data) { $('#app').innerHTML = '<div class="page">' + '<div class="skel"></div>'.repeat(4) + '</div>'; return; }
  const focus = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.f : null;
  $('#app').innerHTML = `<main class="page">${VIEWS[S.view]()}</main>`;
  document.querySelectorAll('#nav [data-view]').forEach(b => b.setAttribute('aria-current', b.dataset.view === S.view));
  if (focus) { const i = $(`[data-f="${focus}"]`); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }
}
function setData(d) { S.data = d; store.set('tt_cache_' + S.user.email, d); store.set('tt_last_' + S.user.email, Date.now()); }
async function refresh(showSpinner) {
  if (showSpinner) syncing(true, 'Loading…');
  try { const r = await api('data'); setData(r.data); render(); }
  catch (e) { if (S.user) toast('Offline or server error: showing saved data'); }
  finally { if (showSpinner) syncing(false); }
}
function start() {
  $('#nav').classList.remove('hidden');
  const cached = store.get('tt_cache_' + S.user.email);
  if (cached) { S.data = cached; render(); refresh(false); }
  else { render(); refresh(true); }
}
async function save(partial, msg) {
  const t = S.data.tasks.find(x => x.ID === partial.ID);
  if (t) { // optimistic update
    if ('Status' in partial && partial.Status !== t.Status) {
      t['Completed on'] = partial.Status === 'Completed' ? new Date().toISOString().slice(0, 19) : '';
      if (partial.Status === 'Completed') { t.Today = false; t['Start now'] = ''; }
    }
    Object.assign(t, partial); render();
  }
  syncing(true, 'Saving…');
  try {
    const r = await api('save', { task: partial }); setData(r.data); render(); if (msg) toast(msg);
    const after = S.data.tasks.find(x => x.ID === (partial.ID || '')) || partial;
    if (isAdmin() && ('Reclaim' in partial || 'Start now' in partial || inReclaim(after))) runSync(false);
  } catch (e) { toast('Not saved: ' + e.message); refresh(false); }
  finally { syncing(false); }
}
function runSync(loud) {
  if (loud) syncing(true, 'Syncing with Reclaim…');
  api('sync').then(() => { if (loud) toast('Synced with Google Tasks'); })
    .catch(e => { if (loud) toast('Sync failed: ' + e.message); })
    .finally(() => { if (loud) syncing(false); });
}

/* =====================================================================
   Bottom sheet (editor, plan, password)
   ===================================================================== */
function openSheet(title, body, onSave, saveLabel = 'Save') {
  $('#sheetTitle').textContent = title; $('#sheetBody').innerHTML = body;
  const sb = $('#sheetSave'); sb.textContent = saveLabel; sb.classList.toggle('hidden', !onSave); sb.onclick = onSave;
  $('#sheet').classList.add('open'); $('#scrim').classList.add('open');
  $('#sheetBody').scrollTop = 0;
}
function closeSheet() { $('#sheet').classList.remove('open'); $('#scrim').classList.remove('open'); S.editing = null; }

function selectHTML(name, list, val, blank = '—') {
  const all = list.slice(); if (val && !all.includes(val)) all.push(val);
  return `<select name="${name}"><option value="">${blank}</option>${all.map(v => `<option ${v === val ? 'selected' : ''} value="${esc(v)}">${esc(v)}</option>`).join('')}</select>`;
}
function seg(name, opts, val) {
  return `<div class="seg" data-seg="${name}">${opts.map(([v, l]) => `<button type="button" data-v="${esc(v)}" aria-pressed="${String(v) === String(val ?? '')}">${l}</button>`).join('')}</div>`;
}
function fieldReq(label, name, inner) {
  return `<div class="field req" data-name="${esc(name)}"><span class="lab">${label}</span>${inner}</div>`;
}
function inlineAdd(kind, placeholder) {
  return `<div class="inline-add hidden" data-kind="${kind}"><input placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}">
    <button type="button" class="btn primary small" data-act="add-item" data-kind="${kind}">Add</button></div>`;
}
function openEditor(t) {
  const D = S.data; S.editing = t || null;
  const goal = t ? t['Main goal'] : (S.f.goal || ''), cat = t ? t.Category : '', obj = t ? t.Objective : (S.f.obj || '');
  const cats = D.categories.filter(c => !goal || c['Main goal'] === goal).map(c => c.Name);
  const objs = D.objectives.filter(o => !cat || o.Category === cat).map(o => o.Name);
  const ctx = [...new Set(D.tasks.map(x => x.Context).filter(Boolean))];
  const deps = D.tasks.filter(x => !isDone(x) && (!t || x.ID !== t.ID)).map(x => String(x.Task).replace(/^[^\p{L}\p{N}]+/u, ''));
  const v = k => esc(t ? (t[k] ?? '') : '');
  S.form = { Energy: t ? t.Energy : '', Priority: t ? (t.Priority || '') : '' };
  const body = `<form id="ed" autocomplete="off" onsubmit="return false" novalidate>
    <div class="fs"><div class="field req" data-name="Task"><span class="lab">Task</span><input name="Task" value="${v('Task')}" placeholder="What needs doing?"></div>
      ${fieldReq('Goal', 'Main goal', selectHTML('Main goal', D.goals.map(g => g.Name), goal))}
      <button type="button" class="addlink" data-act="show-add" data-kind="goals">+ New goal</button>${inlineAdd('goals', 'New goal, e.g. 🌊 Research')}
      ${fieldReq('Category', 'Category', selectHTML('Category', cats, cat))}
      <button type="button" class="addlink" data-act="show-add" data-kind="categories">+ New category in this goal</button>${inlineAdd('categories', 'New category, e.g. 🐠 Fish survey')}
      ${fieldReq('Objective', 'Objective', selectHTML('Objective', objs, obj))}
      <button type="button" class="addlink" data-act="show-add" data-kind="objectives">+ New objective in this category</button>${inlineAdd('objectives', 'New objective')}
      ${t ? '' : '<label class="switch">Start the name with the objective\'s emoji<input type="checkbox" name="prefix" checked></label>'}</div>
    <div class="fs"><div class="lg">When</div>
      <label class="switch"><span>☀️ Do today</span><input type="checkbox" name="Today" ${t && isTrue(t.Today) ? 'checked' : ''}></label>
      <div class="row2">${fieldReq('Due date', 'Due date', `<input type="date" name="Due date" value="${d10(t && t['Due date'])}">`)}
      <label class="field"><span class="lab">Scheduled</span><input type="date" name="Scheduled date" value="${d10(t && t['Scheduled date'])}"></label></div></div>
    <div class="fs"><div class="lg">Effort</div>
      <div class="row2">${fieldReq('Hours', 'Est hours', `<input type="number" inputmode="decimal" name="Est hours" min="0" step="0.25" value="${v('Est hours')}" placeholder="e.g. 1.5">`)}
      <label class="field"><span class="lab">Status</span>${selectHTML('Status', statuses(), t ? t.Status : openStatus(), '—').replace('<option value="">—</option>', '')}</label></div>
      ${fieldReq('Priority', 'Priority', seg('Priority', [['Low', 'Low'], ['Medium', 'Medium'], ['High', 'High']], S.form.Priority))}
      ${fieldReq('Energy (1 easy → 5 demanding)', 'Energy', seg('Energy', [[1, '1'], [2, '2'], [3, '3'], [4, '4'], [5, '5']], S.form.Energy))}</div>
    ${isAdmin() ? `<div class="fs"><div class="lg">Reclaim</div>
      <label class="switch"><span>Send to Reclaim<small>Goes to Google Tasks and gets scheduled in your calendar</small></span><input type="checkbox" name="Reclaim" ${t && inReclaim(t) ? 'checked' : ''}></label>
      <label class="switch"><span>▶ Do now<small>Moves its Reclaim block to start now</small></span><input type="checkbox" name="Start now" ${t && isDoNow(t) ? 'checked' : ''}></label></div>` : ''}
    <div class="fs"><div class="lg">Details</div>
      <label class="field"><span class="lab">Context</span><input name="Context" list="ctxL" value="${v('Context')}"></label>
      <label class="field"><span class="lab">Depends on</span><input name="Dependencies" list="depL" value="${v('Dependencies')}" placeholder="Another task (optional)"></label>
      <label class="field"><span class="lab">Waiting on</span><input name="Waiting on" value="${v('Waiting on')}" placeholder="Person or event"></label>
      <label class="field"><span class="lab">Notes</span><textarea name="Notes">${v('Notes')}</textarea></label>
      <datalist id="ctxL">${ctx.map(c => `<option value="${esc(c)}">`).join('')}</datalist>
      <datalist id="depL">${deps.map(c => `<option value="${esc(c)}">`).join('')}</datalist></div>
    <p class="note" style="margin:0 0 16px"><span style="color:var(--coral)">*</span> required for new tasks</p>
    ${t ? '<button type="button" class="btn danger block" data-act="delete">Delete task</button>' : ''}
  </form>`;
  openSheet(t ? 'Edit task' : 'New task', body, saveEditor);
  const f = $('#ed');
  f['Main goal'].onchange = () => { refill(f.Category, catsOf(f['Main goal'].value)); refill(f.Objective, []); };
  f.Category.onchange = () => {
    const c = S.data.categories.find(x => x.Name === f.Category.value); if (c && !f['Main goal'].value) f['Main goal'].value = c['Main goal'];
    refill(f.Objective, objsOf(f.Category.value));
  };
  f.addEventListener('input', e => { const fl = e.target.closest('.field'); if (fl) fl.classList.remove('invalid'); });
  f.addEventListener('change', e => { const fl = e.target.closest('.field'); if (fl) fl.classList.remove('invalid'); });
  if (!t) setTimeout(() => f.Task.focus(), 260);
}
const catsOf = g => S.data.categories.filter(c => !g || c['Main goal'] === g).map(c => c.Name);
const objsOf = c => S.data.objectives.filter(o => o.Category === c).map(o => o.Name);
function refill(sel, list, val) { sel.innerHTML = '<option value="">—</option>' + list.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join(''); if (val) sel.value = val; }

async function addItem(kind) {
  const f = $('#ed'), box = f.querySelector(`.inline-add[data-kind="${kind}"]`), name = box.querySelector('input').value.trim();
  if (!name) return toast('Type a name first');
  const item = { Name: name };
  if (kind === 'categories') { if (!f['Main goal'].value) return toast('Choose or create a goal first'); item['Main goal'] = f['Main goal'].value; }
  if (kind === 'objectives') { if (!f.Category.value) return toast('Choose or create a category first'); item.Category = f.Category.value; }
  syncing(true, 'Saving…');
  try {
    const r = await api('addItem', { kind, item }); setData(r.data);
    if (kind === 'goals') { refill(f['Main goal'], S.data.goals.map(g => g.Name), name); refill(f.Category, []); refill(f.Objective, []); }
    if (kind === 'categories') { refill(f.Category, catsOf(f['Main goal'].value), name); refill(f.Objective, []); }
    if (kind === 'objectives') refill(f.Objective, objsOf(f.Category.value), name);
    box.classList.add('hidden'); box.querySelector('input').value = '';
    f.querySelectorAll('.field.invalid').forEach(x => x.classList.remove('invalid'));
    toast({ goals: 'Goal', categories: 'Category', objectives: 'Objective' }[kind] + ' added');
  } catch (e) { toast('Not added: ' + e.message); } finally { syncing(false); }
}

function missingFields(f, p) {
  const miss = [];
  if (!p.Task) miss.push('Task');
  REQUIRED.forEach(k => {
    const val = p[k];
    if (k === 'Est hours' ? !(Number(val) > 0) : !String(val ?? '').trim()) miss.push(k);
  });
  f.querySelectorAll('.field.req').forEach(x => x.classList.toggle('invalid', miss.includes(x.dataset.name)));
  return miss;
}
const LABELS = { 'Main goal': 'Goal', 'Est hours': 'Hours', 'Due date': 'Due date' };

async function saveEditor() {
  const f = $('#ed'), t = S.editing;
  const p = {};
  ['Task', 'Main goal', 'Category', 'Objective', 'Status', 'Est hours', 'Due date', 'Scheduled date', 'Context', 'Dependencies', 'Waiting on', 'Notes']
    .forEach(k => p[k] = f[k].value.trim());
  p.Today = f.Today.checked; p.Priority = S.form.Priority || ''; p.Energy = S.form.Energy || '';
  const miss = missingFields(f, p);
  if (miss.length) {
    const first = f.querySelector('.field.invalid'); if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const txt = miss.map(k => LABELS[k] || k).join(', ');
    if (!t) return toast('Please fill: ' + txt);
    if (!p.Task || !confirm('Still empty: ' + txt + '. Save anyway?')) return;
  }
  if (isAdmin()) {
    p.Reclaim = f.Reclaim.checked ? 'YES' : 'NOT YET';
    p['Start now'] = f.Reclaim.checked && f['Start now'].checked ? 'do now' : '';
  }
  if (!t && f.prefix && f.prefix.checked && p.Objective) { const pre = lead(p.Objective); if (pre && !lead(p.Task)) p.Task = pre + ' ' + p.Task; }
  closeSheet();
  if (t) { p.ID = t.ID; await save(p, 'Saved'); }
  else {
    syncing(true, 'Saving…');
    try { const r = await api('save', { task: p }); setData(r.data); render(); toast('Task added'); if (isAdmin() && p.Reclaim === 'YES') runSync(false); }
    catch (e) { toast('Not saved: ' + e.message); } finally { syncing(false); }
  }
}

/* Plan my day: step 1 choose a category, step 2 choose its tasks */
function openPlan() {
  S.plan.cat = null;
  openSheet('Plan my day', planBody(), closeSheet, 'Done');
}
function planBody() {
  const td = today(), open = S.data.tasks.filter(t => !isDone(t));
  if (!S.plan.cat) {
    const urgent = open.filter(t => d10(t['Due date']) && dayDiff(d10(t['Due date']), td) <= 2);
    const urgentPlanned = urgent.filter(t => isTrue(t.Today)).length;
    let lastGoal = null, rows = '';
    catOrder().forEach(c => {
      const ts = open.filter(t => t.Category === c.name); if (!ts.length) return;
      if (c.goal !== lastGoal) { rows += `<div class="goal-lbl">${esc(c.goal || 'No goal')}</div>`; lastGoal = c.goal; }
      const planned = ts.filter(t => isTrue(t.Today)).length;
      rows += `<button class="plan-cat" data-act="plan-cat" data-v="${esc(c.name)}" style="--h:${hue(c.goal)}"><span class="dot"></span>
        <span class="nm">${esc(c.name)}<small>${ts.length} open task${ts.length > 1 ? 's' : ''}</small></span>
        <span class="cnt">${planned ? `<b>☀️ ${planned}</b>` : ''}</span></button>`;
    });
    return `<p class="note" style="margin-top:0">Choose a category, then tap ☀️ on the tasks you want to do today.</p>
      ${urgent.length ? `<button class="plan-cat urgent" data-act="plan-cat" data-v="__urgent"><span>⚠️</span><span class="nm">Overdue &amp; due in 2 days<small>${urgent.length} task${urgent.length > 1 ? 's' : ''}</small></span><span class="cnt">${urgentPlanned ? `<b>☀️ ${urgentPlanned}</b>` : ''}</span></button>` : ''}
      ${rows || '<div class="empty">No open tasks.</div>'}`;
  }
  const isUrgent = S.plan.cat === '__urgent';
  const ts = sortTasks(open.filter(t => isUrgent ? (d10(t['Due date']) && dayDiff(d10(t['Due date']), td) <= 2) : t.Category === S.plan.cat), 'prio');
  const rows = ts.map(t => `<div class="plan-row" data-id="${esc(t.ID)}" style="--h:${hue(t['Main goal'])}">
      <button class="ibtn sun ${isTrue(t.Today) ? 'on' : ''}" data-act="today" aria-label="Plan for today">☀️</button>
      <div class="tmain"><div class="ttitle">${esc(t.Task)}</div><div class="tmeta">
      ${isUrgent ? `<span class="cat"><i></i>${esc(t.Category || '')}</span>` : `<span>${esc(t.Objective || '')}</span>`}
      ${d10(t['Due date']) ? `<span class="${d10(t['Due date']) < td ? 'over' : ''}">Due ${niceDate(t['Due date'])}</span>` : ''}
      ${hrs(t) ? `<span>${hrs(t)} h</span>` : ''}
      ${t.Energy ? `<span class="energy">${'<b>●</b>'.repeat(Math.min(5, Number(t.Energy) || 0))}${'<i>●</i>'.repeat(Math.max(0, 5 - (Number(t.Energy) || 0)))}</span>` : ''}</div></div></div>`).join('');
  return `<button class="plan-back" data-act="plan-back">‹ All categories</button>
    <h4 style="margin:0 0 6px;font-size:18px">${isUrgent ? '⚠️ Overdue &amp; due soon' : esc(S.plan.cat)}</h4>
    ${rows || '<div class="empty">No open tasks here.</div>'}`;
}

function openPassword() {
  openSheet('Change password', `<form id="pw" onsubmit="return false">
    <label class="field">Current password<input type="password" name="old" autocomplete="current-password"></label>
    <label class="field">New password (8+ characters)<input type="password" name="nw" autocomplete="new-password"></label>
    <div class="err" id="pwErr"></div></form>`, async () => {
    const f = $('#pw');
    try { await api('password', { oldPassword: f.old.value, newPassword: f.nw.value }); closeSheet(); toast('Password changed'); }
    catch (e) { $('#pwErr').textContent = e.message; }
  });
}

/* =====================================================================
   Events
   ===================================================================== */
document.addEventListener('click', async e => {
  const nav = e.target.closest('[data-view]');
  if (nav) { S.view = nav.dataset.view; render(); window.scrollTo(0, 0); return; }
  const segBtn = e.target.closest('[data-seg] button');
  if (segBtn) {
    const n = segBtn.parentElement.dataset.seg; S.form[n] = segBtn.dataset.v;
    segBtn.parentElement.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b === segBtn));
    const fl = segBtn.closest('.field'); if (fl) fl.classList.remove('invalid');
    return;
  }
  if (e.target.id === 'scrim') return closeSheet();
  const a = e.target.closest('[data-act]'); if (!a) return;
  const act = a.dataset.act, row = a.closest('[data-id]'), t = row && S.data ? S.data.tasks.find(x => x.ID === row.dataset.id) : null;
  switch (act) {
    case 'done': save({ ID: t.ID, Status: isDone(t) ? openStatus() : 'Completed' }, isDone(t) ? 'Back to open' : 'Done ✓'); break;
    case 'today':
      save({ ID: t.ID, Today: !isTrue(t.Today) });
      if (a.closest('#sheet')) a.classList.toggle('on');
      break;
    case 'donow': save({ ID: t.ID, 'Start now': isDoNow(t) ? '' : 'do now' }, isDoNow(t) ? 'Do now cleared' : 'Moving the Reclaim block to now…'); break;
    case 'open': openEditor(t); break;
    case 'new': openEditor(null); break;
    case 'plan': openPlan(); break;
    case 'plan-cat': S.plan.cat = a.dataset.v; $('#sheetBody').innerHTML = planBody(); $('#sheetBody').scrollTop = 0; break;
    case 'plan-back': S.plan.cat = null; $('#sheetBody').innerHTML = planBody(); $('#sheetBody').scrollTop = 0; break;
    case 'easy-max': S.easy.max = Number(a.dataset.v); render(); break;
    case 'show-add': {
      const box = $(`#ed .inline-add[data-kind="${a.dataset.kind}"]`); box.classList.toggle('hidden');
      if (!box.classList.contains('hidden')) box.querySelector('input').focus();
      break;
    }
    case 'add-item': addItem(a.dataset.kind); break;
    case 'close-sheet': closeSheet(); break;
    case 'fscope': S.f.scope = a.dataset.v; render(); break;
    case 'fgoal': S.f.goal = a.dataset.v; render(); break;
    case 'fobj': Object.assign(S.f, { obj: a.dataset.v, goal: '', scope: 'all', q: '' }); S.view = 'tasks'; render(); window.scrollTo(0, 0); break;
    case 'fobj-clear': S.f.obj = ''; render(); break;
    case 'refresh': refresh(true); break;
    case 'sync': runSync(true); break;
    case 'password': openPassword(); break;
    case 'logout': logout(false); break;
    case 'theme': {
      const order = ['auto', 'light', 'dark'], cur = store.get('tt_theme') || 'auto', next = order[(order.indexOf(cur) + 1) % 3];
      store.set('tt_theme', next); applyTheme(); render(); break;
    }
    case 'delete':
      if (!confirm('Delete "' + S.editing.Task + '"? This removes it from the sheet.')) return;
      { const id = S.editing.ID; closeSheet(); S.data.tasks = S.data.tasks.filter(x => x.ID !== id); render(); syncing(true, 'Deleting…');
        try { const r = await api('delete', { id }); setData(r.data); render(); toast('Deleted'); } catch (err) { toast('Not deleted: ' + err.message); refresh(false); } finally { syncing(false); } }
      break;
    case 'new-obj': {
      const f = $('#ed'), cat = f.Category.value; if (!cat) return toast('Choose a category first');
      const name = prompt('New objective in "' + cat + '":', lead(cat) + ' '); if (!name || !name.trim()) return;
      syncing(true, 'Saving…');
      try { const r = await api('addItem', { kind: 'objectives', item: { Name: name.trim(), Category: cat } }); setData(r.data);
        refill(f.Objective, S.data.objectives.filter(o => o.Category === cat).map(o => o.Name)); f.Objective.value = name.trim(); toast('Objective added'); }
      catch (err) { toast('Not added: ' + err.message); } finally { syncing(false); }
      break;
    }
  }
});
document.addEventListener('input', e => {
  const k = e.target.dataset && e.target.dataset.f; if (!k) return;
  if (k === 'easyq') S.easy.q = e.target.value; else S.f[k] = e.target.value;
  render();
});
// remember which category accordions are open on the Easy page
document.addEventListener('toggle', e => {
  const d = e.target; if (!d.classList || !d.classList.contains('acc') || S.easy.q) return;
  if (d.open) S.easy.open.add(d.dataset.cat); else S.easy.open.delete(d.dataset.cat);
}, true);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeSheet();
  if (e.key === 'Enter' && e.target.closest && e.target.closest('.inline-add')) { e.preventDefault(); addItem(e.target.closest('.inline-add').dataset.kind); }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.user && S.data) refresh(false); });

function applyTheme() { const t = store.get('tt_theme') || 'auto'; if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.dataset.theme = t; }

/* =====================================================================
   Demo backend (only when config.js has no API_URL)
   ===================================================================== */
const Demo = (() => {
  const d = n => { const x = new Date(); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
  const td = d(0);
  const T = (id, g, c, o, task, prio, en, due, h, st, extra = {}) => Object.assign({ ID: id, 'Main goal': g, Category: c, Objective: o, Task: task, Priority: prio, Energy: en,
    Context: '🏪 Office/🏠 Home', 'Scheduled date': '', 'Due date': due, 'Est hours': h, Status: st, Notes: '', Dependencies: '', 'Waiting on': '', Reclaim: 'NOT YET', Today: false, 'Completed on': '', 'Start now': '' }, extra);
  const db = {
    goals: [{ Name: '🌊 Research' }, { Name: '📗 Manuscript' }, { Name: '💼 Consulting' }],
    categories: [{ Name: '🧭 Field survey', 'Main goal': '🌊 Research' }, { Name: '📄 Paper A', 'Main goal': '📗 Manuscript' }, { Name: '📊 Report B', 'Main goal': '💼 Consulting' }],
    objectives: [{ Name: '🧭📋 Questionnaire', Category: '🧭 Field survey' }, { Name: '🧭🚙 Logistics', Category: '🧭 Field survey' },
      { Name: '📄📝 Introduction', Category: '📄 Paper A' }, { Name: '📄💻 Analysis', Category: '📄 Paper A' }, { Name: '📊📈 Figures', Category: '📊 Report B' }],
    tasks: [
      T('a1', '🌊 Research', '🧭 Field survey', '🧭📋 Questionnaire', '🧭📋 Draft question list', 'High', 3, d(1), 2, 'In Progress', { Today: true, Reclaim: 'YES' }),
      T('a2', '🌊 Research', '🧭 Field survey', '🧭📋 Questionnaire', '🧭📋 Build the web form', 'Medium', 4, d(4), 3, 'Not Started', { Dependencies: 'Draft question list' }),
      T('a3', '🌊 Research', '🧭 Field survey', '🧭🚙 Logistics', '🧭🚙 Book the vehicle', '', 1, d(-2), 0.5, 'Not Started', { 'Waiting on': 'Driver' }),
      T('a4', '📗 Manuscript', '📄 Paper A', '📄📝 Introduction', '📄📝 Write the context paragraph', 'High', 5, td, '', 'Not Started', { Today: true }),
      T('a5', '📗 Manuscript', '📄 Paper A', '📄💻 Analysis', '📄💻 Import data', '', 2, '', 1, 'Completed', { 'Completed on': d(-1) + 'T10:00:00' }),
      T('a6', '📗 Manuscript', '📄 Paper A', '📄💻 Analysis', '📄💻 Fit the models', 'High', 5, d(6), 3, 'Not Started'),
      T('a7', '💼 Consulting', '📊 Report B', '📊📈 Figures', '📊📈 Map of sites', 'Medium', 3, d(3), 2, 'Waiting', { Reclaim: 'YES' }),
      T('a8', '💼 Consulting', '📊 Report B', '📊📈 Figures', '📊📈 Boxplots', '', 2, '', 1.5, 'Completed', { 'Completed on': d(-2) + 'T15:00:00' }),
      T('a9', '💼 Consulting', '📊 Report B', '📊📈 Figures', '📊📈 Bar charts', '', 2, '', 1, 'Completed', { 'Completed on': d(-2) + 'T16:00:00' }),
      T('a10', '📗 Manuscript', '📄 Paper A', '📄📝 Introduction', '📄📝 Find references', '', 4, td, 2, 'Completed', { 'Completed on': td + 'T09:00:00' }),
      T('a11', '🌊 Research', '🧭 Field survey', '🧭📋 Questionnaire', '🧭📋 Translate into Malagasy', 'Medium', 3, td, 1.5, 'Not Started', { Reclaim: 'YES', Today: true })
    ]
  };
  const out = () => ({ ok: true, data: JSON.parse(JSON.stringify({ tasks: db.tasks, goals: db.goals, categories: db.categories, objectives: db.objectives, user: S.user, today: td })) });
  const wait = v => new Promise(r => setTimeout(() => r(v), 300));
  return {
    call(action, p) {
      if (action === 'login') return wait({ ok: true, token: 'demo', user: { email: 'demo@example.com', name: 'Aroo', role: 'admin' } });
      if (action === 'data') return wait(out());
      if (action === 'save') {
        let t = db.tasks.find(x => x.ID === p.task.ID);
        if (!t) { t = T(Math.random().toString(16).slice(2, 10), '', '', '', '', '', '', '', '', 'Not Started'); db.tasks.push(t); }
        if ('Status' in p.task && p.task.Status !== t.Status) t['Completed on'] = p.task.Status === 'Completed' ? new Date().toISOString().slice(0, 19) : '';
        Object.assign(t, p.task); return wait(out());
      }
      if (action === 'delete') { db.tasks = db.tasks.filter(x => x.ID !== p.id); return wait(out()); }
      if (action === 'addItem') { db[p.kind].push(p.item); return wait(out()); }
      return wait({ ok: true });
    }
  };
})();

/* =====================================================================
   Boot
   ===================================================================== */
applyTheme();
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
const auth = store.get('tt_auth');
if (auth && auth.token) { S.token = auth.token; S.user = auth.user; start(); } else viewLogin();
})();
