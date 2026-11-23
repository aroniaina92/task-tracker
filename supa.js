/* My Steps – Supabase connection.
   Gives app.js the same answers the old Apps Script API gave, so the screens stay unchanged.
   Only the public "anon / publishable" key is used here; every person only sees their own rows
   (Row Level Security in the database). Google tokens never reach the phone after sign-in. */
(() => {
'use strict';
const CFG = window.TT_CONFIG || {};
if (!CFG.SUPABASE_URL || !window.supabase) return;
const URL0 = CFG.SUPABASE_URL.replace(/\/+$/, '');
/* offline handling: a weak signal makes requests hang instead of failing, so every call gets a time limit */
const OFFLINE_RX = /Failed to fetch|NetworkError|Load failed|network|offline|timed? ?out|aborted|ERR_INTERNET/i;
const isNet = e => !navigator.onLine || OFFLINE_RX.test(String((e && (e.message || e.error_description || e)) || ''));
const offlineErr = () => Object.assign(new Error('You are offline'), { offline: true });
function fetchWithTimeout(input, init = {}, ms = 20000) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
  if (init.signal) init.signal.addEventListener('abort', () => ctl.abort());
  return fetch(input, Object.assign({}, init, { signal: ctl.signal })).finally(() => clearTimeout(t));
}
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(offlineErr()), ms))]);
const sb = window.supabase.createClient(URL0, CFG.SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
  global: { fetch: (i, o) => fetchWithTimeout(i, o) }
});
const SCOPES = 'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/gmail.send';
const here = () => location.origin + location.pathname;
let me = null;                           // { id, email, name, role }

/* ---------- shapes: database row <-> app task ---------- */
const pad = n => String(n).padStart(2, '0');
const localIso = v => { if (!v) return ''; const d = new Date(v); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const today = () => localIso(new Date()).slice(0, 10);
const s = v => v === null || v === undefined ? '' : v;
const toTask = r => ({
  ID: r.id, 'Main goal': s(r.main_goal), Category: s(r.category), Objective: s(r.objective), Task: r.task, Priority: s(r.priority),
  Energy: s(r.energy), Context: s(r.context), 'Scheduled date': s(r.scheduled_date), 'Due date': s(r.due_date), 'Est hours': r.est_hours === null ? '' : Number(r.est_hours),
  Status: r.status, Notes: s(r.notes), Dependencies: s(r.dependencies), 'Waiting on': s(r.waiting_on), Today: !!r.today, 'Today set': s(r.today_set),
  'Completed on': localIso(r.completed_on), 'Start now': s(r.start_now), 'Auto schedule': r.auto_schedule ? 'YES' : '', 'Time category': s(r.time_category),
  Repeat: s(r.repeat)
});
const COLS = { 'Main goal': 'main_goal', Category: 'category', Objective: 'objective', Task: 'task', Priority: 'priority', Energy: 'energy', Context: 'context',
  'Scheduled date': 'scheduled_date', 'Due date': 'due_date', 'Est hours': 'est_hours', Status: 'status', Notes: 'notes', Dependencies: 'dependencies',
  'Waiting on': 'waiting_on', Today: 'today', 'Start now': 'start_now', 'Auto schedule': 'auto_schedule', 'Time category': 'time_category', Repeat: 'repeat' };
const OWNER_ONLY = ['Start now', 'Auto schedule', 'Time category'];
function toRow(t, admin) {
  const row = {};
  Object.keys(COLS).forEach(k => {
    if (!(k in t) || (!admin && OWNER_ONLY.includes(k))) return;
    let v = t[k];
    if (k === 'Today') v = v === true || String(v).toUpperCase() === 'TRUE';
    else if (k === 'Auto schedule') v = String(v || '').toUpperCase() === 'YES' || v === true;
    else if (k === 'Start now' || k === 'Time category' || k === 'Repeat') v = String(v || '');
    else if (k === 'Energy' || k === 'Est hours') v = v === '' || v === null || v === undefined ? null : Number(v);
    else if (k === 'Scheduled date' || k === 'Due date') v = v ? String(v).slice(0, 10) : null;
    else if (k === 'Status') v = v || 'Not Started';
    else v = v === '' || v === undefined ? null : v;
    row[COLS[k]] = v;
  });
  return row;
}
const toIdea = r => ({ ID: r.id, Text: r.text, Title: r.title, Color: r.color, Pinned: r.pinned, Goal: r.goal, Created: localIso(r.created_at), Updated: localIso(r.updated_at) });
const toHabit = h => ({ ID: h.id, Name: h.name, Minutes: h.minutes, Days: h.days || [], Ideal: h.ideal, Flex: h.flex, Active: h.active });
const toBooking = b => ({ id: b.id, name: b.name, email: b.email, minutes: b.minutes, start: b.start_at, end: b.end_at, topic: b.topic, status: b.status, meet: b.meet_link });

/* default time categories (same as the server) – shown until the first save */
function defaults() {
  const wk = [1, 2, 3, 4, 5], sl = (days, r) => { const o = {}; days.forEach(d => { o[d] = r.slice(); }); return o; };
  const personal = sl(wk, [['04:00', '08:30'], ['12:30', '14:30'], ['17:30', '21:30']]); personal[6] = [['04:00', '06:00']];
  const spafi = sl([1, 2, 3, 4, 5, 6], [['04:00', '06:00']]); spafi[6] = [['04:00', '06:00'], ['16:00', '17:00']]; spafi[0] = [['15:00', '18:00']];
  return { categories: [{ name: 'Working', color: '#0a8f8a', slots: sl(wk, [['08:30', '12:30'], ['14:30', '17:30']]) },
    { name: 'Personal', color: '#f2654f', slots: personal }, { name: 'Spafi', color: '#8e6cf0', slots: spafi }],
    goalMap: {}, catMap: {}, defaultCategory: 'Working', minBlock: 30, maxBlock: 120, horizonDays: 7,
    booking: { enabled: true, category: 'Working', noticeHours: 24, daysAhead: 21, durations: [15, 30, 60], title: 'Meeting with Aroo', ownerName: 'Aroo' },
    extra: { category: 'Working', slots: [['08:30', '12:30'], ['14:30', '17:30']], dates: [] } };
}

/* ---------- helpers ---------- */
const must = ({ data, error }) => { if (error) { if (isNet(error)) throw offlineErr(); throw new Error(error.message || String(error)); } return data; };
async function getSession() {
  const r = await withTimeout(sb.auth.getSession(), 10000);
  if (r.error && isNet(r.error)) throw offlineErr();
  return r.data.session;
}
async function profile() {
  const session = await getSession();
  if (!session) return null;
  const u = session.user;
  const res = await sb.from('profiles').select('email,name,role').eq('id', u.id).maybeSingle();
  if (res.error) { if (isNet(res.error)) throw offlineErr(); throw new Error(res.error.message); }
  const p = res.data || {};
  me = { id: u.id, email: (p.email || u.email || '').toLowerCase(), name: p.name || (u.user_metadata || {}).full_name || '', role: p.role || 'user' };
  return me;
}
async function fn(name, body) {
  const session = await getSession();
  if (!session) throw Object.assign(new Error('AUTH'), { auth: true });
  let r;
  try {
    r = await fetchWithTimeout(`${URL0}/functions/v1/${name}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: CFG.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + session.access_token }, body: JSON.stringify(body) }, 90000);
  } catch (e) { throw offlineErr(); }
  const j = await r.json().catch(() => ({ ok: false, error: 'Server error (' + r.status + ')' }));
  if (r.status === 401 || j.error === 'AUTH') throw Object.assign(new Error('AUTH'), { auth: true });
  if (!j.ok) throw new Error(j.error || 'Server error');
  return j;
}

async function data() {
  if (!me) await profile();
  const admin = me.role === 'admin';
  const q = [
    sb.from('tasks').select('*').order('created_at'),
    sb.from('goals').select('name').order('sort').order('created_at'),
    sb.from('categories').select('name,main_goal').order('created_at'),
    sb.from('objectives').select('name,category').order('created_at'),
    sb.from('ideas').select('*').order('updated_at', { ascending: false }),
    admin ? sb.from('settings').select('data,status,google_connected').maybeSingle() : Promise.resolve({ data: null }),
    admin ? sb.from('bookings').select('id', { count: 'exact', head: true }).eq('status', 'Pending').gt('end_at', new Date().toISOString()) : Promise.resolve({ count: 0 }),
    admin ? sb.from('habits').select('*').order('created_at') : Promise.resolve({ data: [] })
  ];
  const [t, g, c, o, i, st, bk, hb] = await Promise.all(q);
  if (hb.error && isNet(hb.error)) throw offlineErr();
  [t, g, c, o, i].forEach(must);
  let sched = null;
  if (admin) {
    const row = st.data || {}, d = Object.assign(defaults(), row.data || {});
    sched = { status: row.status || {}, extra: Object.assign({ category: 'Working', slots: [], dates: [] }, d.extra || {}), categories: d.categories.map(x => ({ name: x.name, color: x.color })), goalMap: d.goalMap || {}, catMap: d.catMap || {},
      defaultCategory: d.defaultCategory, pendingBookings: bk.count || 0, ready: !!row.google_connected, connected: !!row.google_connected };
  }
  return {
    tasks: t.data.map(toTask), goals: g.data.map(x => ({ Name: x.name })), categories: c.data.map(x => ({ Name: x.name, 'Main goal': s(x.main_goal) })),
    objectives: o.data.map(x => ({ Name: x.name, Category: s(x.category) })), ideas: i.data.map(toIdea), sched,
    habits: hb.error ? [] : (hb.data || []).map(toHabit),          // empty until the 17 Nov database update is run
    user: { email: me.email, name: me.name, role: me.role }, today: today()
  };
}

/* ---------- the actions app.js calls ---------- */
async function call(action, p = {}) {
  if (!me) { const x = await profile(); if (!x) throw Object.assign(new Error('AUTH'), { auth: true }); }
  const admin = me.role === 'admin', D = async extra => Object.assign({ ok: true, data: await data() }, extra || {});
  switch (action) {
    case 'data': return D();
    case 'save': {
      const t = p.task || {}, row = toRow(t, admin);
      if (t.ID && !t._new) must(await sb.from('tasks').update(row).eq('id', t.ID));
      else {
        if (!String(t.Task || '').trim()) throw new Error('Task name is required');
        if (t.ID) row.id = t.ID;
        const ins = await sb.from('tasks').insert(row);
        if (ins.error && /duplicate|23505/.test(ins.error.message + ins.error.code)) must(await sb.from('tasks').update(row).eq('id', t.ID));  // sent twice
        else must(ins);
      }
      return D();
    }
    case 'delete': must(await sb.from('tasks').delete().eq('id', p.id)); return D();
    case 'addItem': {
      const it = p.item || {}, name = String(it.Name || '').trim(); if (!name) throw new Error('Name is required');
      const row = { name }; if (p.kind === 'categories') row.main_goal = it['Main goal'] || null; if (p.kind === 'objectives') row.category = it.Category || null;
      if (!['goals', 'categories', 'objectives'].includes(p.kind)) throw new Error('Unknown list');
      must(await sb.from(p.kind).upsert(row, { onConflict: 'owner_id,name', ignoreDuplicates: true }));
      return D();
    }
    case 'saveIdea': {
      const x = p.idea || {}, row = {};
      if ('Text' in x) row.text = x.Text; if ('Color' in x) row.color = x.Color || 'sand'; if ('Goal' in x) row.goal = x.Goal || '';
      if ('Pinned' in x) row.pinned = x.Pinned === true || String(x.Pinned).toUpperCase() === 'TRUE';
      row.updated_at = new Date().toISOString();
      const exists = x.ID && (await sb.from('ideas').select('id').eq('id', x.ID).maybeSingle()).data;
      if (exists) must(await sb.from('ideas').update(row).eq('id', x.ID));
      else { if (!row.text) throw new Error('The idea is empty'); if (x.ID && /^[a-z0-9]{6,20}$/i.test(x.ID)) row.id = x.ID; must(await sb.from('ideas').insert(row)); }
      return D();
    }
    case 'deleteIdea': must(await sb.from('ideas').delete().eq('id', p.id)); return D();
    case 'saveHabit': {
      const h = p.habit || {}, row = { name: String(h.Name || '').trim(), minutes: Number(h.Minutes) || 30, days: (h.Days || []).map(Number),
        ideal: h.Ideal || '06:00', flex: Number(h.Flex) || 0, active: h.Active !== false };
      if (!row.name) throw new Error('Give the habit a name');
      const exists = h.ID && (await sb.from('habits').select('id').eq('id', h.ID).maybeSingle()).data;
      if (exists) must(await sb.from('habits').update(row).eq('id', h.ID));
      else must(await sb.from('habits').insert(Object.assign(row, h.ID ? { id: h.ID } : {})));
      return D();
    }
    case 'deleteHabit': must(await sb.from('habits').delete().eq('id', p.id)); return D();
    case 'resetMany': return D({ text: must(await sb.rpc('reset_many', { kind: p.kind, names: p.names || [], itself: !!p.itself })) });
    case 'resetAll': return D({ text: must(await sb.rpc('reset_all', { also_goals: !!p.alsoGoals })) });
    case 'bookings': {
      const rows = must(await sb.from('bookings').select('*').in('status', ['Pending', 'Accepted']).gt('end_at', new Date(Date.now() - 86400000).toISOString()).order('start_at'));
      return { ok: true, bookings: rows.filter(b => b.status === 'Accepted' || Date.parse(b.end_at) > Date.now()).map(toBooking) };
    }
    case 'bookingDecide': { const r = await fn('owner', { action, id: p.id, accept: !!p.accept, bookingUrl: p.bookingUrl || '' }); return Object.assign(r, { bookings: (await call('bookings')).bookings }); }
    case 'settingsGet': { const r = await fn('owner', { action }); return { ok: true, settings: r.settings, usage: r.status || {} }; }
    case 'sync': case 'schedule': case 'calendar': case 'moveBlock': case 'unpinBlock': case 'settingsSave': case 'skipMissed': case 'extraDay':
      return fn('owner', Object.assign({}, p, { action: action === 'sync' ? 'schedule' : action }));
    case 'password': {
      if (!p.newPassword || p.newPassword.length < 8) throw new Error('The new password needs 8+ characters');
      if (!p.recovery) { const chk = await sb.auth.signInWithPassword({ email: me.email, password: p.oldPassword || '' }); if (chk.error) throw new Error('The current password is not right'); }
      must(await sb.auth.updateUser({ password: p.newPassword })); return { ok: true };
    }
    case 'logout': await sb.auth.signOut(); me = null; return { ok: true };
    default: throw new Error('Unknown action');
  }
}

/* ---------- sign-in ---------- */
async function signIn(email, password) {
  const r = await sb.auth.signInWithPassword({ email, password });
  if (r.error) throw new Error(/invalid/i.test(r.error.message) ? 'Wrong email or password' : r.error.message);
  return profile();
}
function signInGoogle() {                 // plain sign-in (no calendar access asked)
  return sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: here() } });
}
function connectGoogle() {                // owner: give My Steps access to Calendar + sending email
  try { localStorage.setItem('ms_connecting', '1'); } catch (e) {}
  return sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: here(), scopes: SCOPES,
    queryParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' } } });
}
function resetPassword(email) {
  return sb.auth.resetPasswordForEmail(email, { redirectTo: here() }).then(must);
}
/* Called once at start: finishes a Google sign-in, stores the calendar token on the server */
async function boot() {
  let recovery = false;
  sb.auth.onAuthStateChange(ev => { if (ev === 'PASSWORD_RECOVERY') recovery = true; });
  const session = await getSession();          // throws when offline
  if (location.search.includes('code=') || location.hash.includes('access_token')) history.replaceState(null, '', here());
  if (!session) return { user: null };
  const u = await withTimeout(profile(), 15000);
  let connected = null, connectError = null, flagged = false;
  try { flagged = localStorage.getItem('ms_connecting') === '1'; localStorage.removeItem('ms_connecting'); } catch (e) {}
  if (session.provider_refresh_token && u.role === 'admin') {
    try { await fn('owner', { action: 'saveGoogleToken', refreshToken: session.provider_refresh_token }); connected = true; }
    catch (e) { connectError = e.message; }
  } else if (flagged) connectError = 'Google did not give calendar access. Please try again and tick all the boxes.';
  if (/type=recovery/.test(location.hash)) recovery = true;
  return { user: u, connected, connectError, recovery };
}

window.MyStepsSupa = { call, signIn, signInGoogle, connectGoogle, resetPassword, boot, isNet, client: sb };
})();
