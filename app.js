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
  editing: null, form: null
};
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
const HUES = [174, 205, 24, 268, 336, 128, 45, 230, 0];
function hue(goal) {
  const i = S.data.goals.findIndex(g => g.Name === goal);
  return HUES[(i < 0 ? S.data.goals.length : i) % HUES.length];
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

  return `<div class="hero"><div class="greet">${hello}${name ? ', ' + esc(name) : ''}</div><div class="date">${dateTxt}</div></div>
    <div class="card progress">
      <div class="ring"><svg width="108" height="108" viewBox="0 0 108 108"><circle class="bg" cx="54" cy="54" r="46" fill="none" stroke-width="10"/>
        <circle class="fg" cx="54" cy="54" r="46" fill="none" stroke-width="10" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - pct / 100)}"/></svg>
        <div class="pct">${pct}%</div></div>
      <div class="txt"><div class="big">${B.doneToday.length} of ${total} tasks done</div>
        <div class="small">${hAll ? `${hDone.toFixed(1)} of ${hAll.toFixed(1)} h` : 'No hours estimated yet'}</div>
        <div class="badges">${st ? `<span class="badge hot">🔥 ${st}-day streak</span>` : ''}${B.overdue.length ? `<span class="badge">${B.overdue.length} overdue</span>` : ''}</div></div>
    </div>
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
  return `<div class="ptitle">Tasks</div>
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
  return `<div class="ptitle">Projects</div>${html || '<div class="empty">No goals yet.</div>'}`;
}

/* =====================================================================
   Me
   ===================================================================== */
function viewMe() {
  const u = S.user, theme = store.get('tt_theme') || 'auto';
  const last = store.get('tt_last_' + u.email);
  return `<div class="ptitle">Me</div>
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
const VIEWS = { home: viewHome, tasks: viewTasks, projects: viewProjects, me: viewMe };
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
function openEditor(t) {
  const D = S.data; S.editing = t || null;
  const goal = t ? t['Main goal'] : (S.f.goal || ''), cat = t ? t.Category : '', obj = t ? t.Objective : (S.f.obj || '');
  const cats = D.categories.filter(c => !goal || c['Main goal'] === goal).map(c => c.Name);
  const objs = D.objectives.filter(o => !cat || o.Category === cat).map(o => o.Name);
  const ctx = [...new Set(D.tasks.map(x => x.Context).filter(Boolean))];
  const deps = D.tasks.filter(x => !isDone(x) && (!t || x.ID !== t.ID)).map(x => String(x.Task).replace(/^[^\p{L}\p{N}]+/u, ''));
  const v = k => esc(t ? (t[k] ?? '') : '');
  S.form = { Energy: t ? t.Energy : '', Priority: t ? (t.Priority || '') : '' };
  const body = `<form id="ed" autocomplete="off" onsubmit="return false">
    <div class="fs"><label class="field">Task<input name="Task" value="${v('Task')}" placeholder="What needs doing?" required></label>
      <label class="field">Goal${selectHTML('Main goal', D.goals.map(g => g.Name), goal)}</label>
      <div class="row2"><label class="field">Category${selectHTML('Category', cats, cat)}</label>
      <label class="field">Objective${selectHTML('Objective', objs, obj)}</label></div>
      <button type="button" class="addlink" data-act="new-obj">+ New objective</button>
      ${t ? '' : '<label class="switch">Start the name with the objective\'s emoji<input type="checkbox" name="prefix" checked></label>'}</div>
    <div class="fs"><div class="lg">When</div>
      <label class="switch"><span>☀️ Do today</span><input type="checkbox" name="Today" ${t && isTrue(t.Today) ? 'checked' : ''}></label>
      <div class="row2"><label class="field">Due date<input type="date" name="Due date" value="${d10(t && t['Due date'])}"></label>
      <label class="field">Scheduled<input type="date" name="Scheduled date" value="${d10(t && t['Scheduled date'])}"></label></div></div>
    <div class="fs"><div class="lg">Effort</div>
      <div class="row2"><label class="field">Hours<input type="number" name="Est hours" min="0" step="0.25" value="${v('Est hours')}" placeholder="e.g. 1.5"></label>
      <label class="field">Status${selectHTML('Status', statuses(), t ? t.Status : openStatus(), '—').replace('<option value="">—</option>', '')}</label></div>
      <div class="field">Priority${seg('Priority', [['', 'None'], ['Low', 'Low'], ['Medium', 'Medium'], ['High', 'High']], S.form.Priority)}</div>
      <div class="field">Energy (1 easy → 5 demanding)${seg('Energy', [['', '–'], [1, '1'], [2, '2'], [3, '3'], [4, '4'], [5, '5']], S.form.Energy)}</div></div>
    ${isAdmin() ? `<div class="fs"><div class="lg">Reclaim</div>
      <label class="switch"><span>Send to Reclaim<small>Goes to Google Tasks and gets scheduled in your calendar</small></span><input type="checkbox" name="Reclaim" ${t && inReclaim(t) ? 'checked' : ''}></label>
      <label class="switch"><span>▶ Do now<small>Moves its Reclaim block to start now</small></span><input type="checkbox" name="Start now" ${t && isDoNow(t) ? 'checked' : ''}></label></div>` : ''}
    <div class="fs"><div class="lg">Details</div>
      <label class="field">Context<input name="Context" list="ctxL" value="${v('Context')}"></label>
      <label class="field">Depends on<input name="Dependencies" list="depL" value="${v('Dependencies')}" placeholder="Another task (optional)"></label>
      <label class="field">Waiting on<input name="Waiting on" value="${v('Waiting on')}" placeholder="Person or event"></label>
      <label class="field">Notes<textarea name="Notes">${v('Notes')}</textarea></label>
      <datalist id="ctxL">${ctx.map(c => `<option value="${esc(c)}">`).join('')}</datalist>
      <datalist id="depL">${deps.map(c => `<option value="${esc(c)}">`).join('')}</datalist></div>
    ${t ? '<button type="button" class="btn danger block" data-act="delete">Delete task</button>' : ''}
  </form>`;
  openSheet(t ? 'Edit task' : 'New task', body, saveEditor);
  const f = $('#ed');
  f['Main goal'].onchange = () => { refill(f.Category, D.categories.filter(c => !f['Main goal'].value || c['Main goal'] === f['Main goal'].value).map(c => c.Name)); refill(f.Objective, []); };
  f.Category.onchange = () => {
    const c = D.categories.find(x => x.Name === f.Category.value); if (c && !f['Main goal'].value) f['Main goal'].value = c['Main goal'];
    refill(f.Objective, D.objectives.filter(o => o.Category === f.Category.value).map(o => o.Name));
  };
  if (!t) setTimeout(() => f.Task.focus(), 260);
}
function refill(sel, list) { sel.innerHTML = '<option value="">—</option>' + list.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join(''); }

async function saveEditor() {
  const f = $('#ed'), t = S.editing;
  const name = f.Task.value.trim(); if (!name) { f.Task.focus(); return toast('Give the task a name'); }
  const p = {};
  ['Task', 'Main goal', 'Category', 'Objective', 'Status', 'Est hours', 'Due date', 'Scheduled date', 'Context', 'Dependencies', 'Waiting on', 'Notes']
    .forEach(k => p[k] = f[k].value.trim());
  p.Today = f.Today.checked; p.Priority = S.form.Priority; p.Energy = S.form.Energy;
  if (isAdmin()) {
    p.Reclaim = f.Reclaim.checked ? 'YES' : 'NOT YET';
    p['Start now'] = f.Reclaim.checked && f['Start now'].checked ? 'do now' : '';
    if (f.Reclaim.checked && !(t && inReclaim(t)) && !(Number(p['Est hours']) > 0) &&
        !confirm('No hours set: Reclaim will use its default duration. Send anyway?')) return;
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

function openPlan() {
  const td = today();
  const cands = S.data.tasks.filter(t => !isDone(t)).sort((a, b) => {
    const s = t => (isTrue(t.Today) ? -10 : 0) + (d10(t['Due date']) && d10(t['Due date']) <= td ? -5 : 0) + (t.Status === 'In Progress' ? -3 : 0) + PRIO[t.Priority || ''];
    return s(a) - s(b) || (d10(a['Due date']) || '9999').localeCompare(d10(b['Due date']) || '9999');
  }).slice(0, 40);
  const rows = cands.map(t => `<div class="plan-row" data-id="${esc(t.ID)}" style="--h:${hue(t['Main goal'])}">
      <button class="ibtn sun ${isTrue(t.Today) ? 'on' : ''}" data-act="today" aria-label="Plan for today">☀️</button>
      <div class="tmain"><div class="ttitle">${esc(t.Task)}</div><div class="tmeta"><span class="cat"><i></i>${esc(t.Category || '')}</span>
      ${d10(t['Due date']) ? `<span class="${d10(t['Due date']) < td ? 'over' : ''}">Due ${niceDate(t['Due date'])}</span>` : ''}${hrs(t) ? `<span>${hrs(t)} h</span>` : ''}</div></div></div>`).join('');
  openSheet('Plan my day', `<p class="note" style="margin-top:0">Tap ☀️ to add a task to today. Overdue and high-priority tasks are listed first.</p>${rows || '<div class="empty">No open tasks.</div>'}`, closeSheet, 'Done');
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
  if (segBtn) { const n = segBtn.parentElement.dataset.seg; S.form[n] = segBtn.dataset.v; segBtn.parentElement.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b === segBtn)); return; }
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
document.addEventListener('input', e => { if (e.target.dataset && e.target.dataset.f) { S.f[e.target.dataset.f] = e.target.value; render(); } });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });
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
