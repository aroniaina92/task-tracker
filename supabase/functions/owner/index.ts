// @ts-nocheck
/**
 * MY STEPS – "owner" Edge Function (Supabase)
 * Everything that needs your Google account:
 *   schedule      plan task blocks in the "My Steps" Google Calendar
 *   calendar      events for the Calendar page
 *   moveBlock / unpinBlock
 *   bookingDecide accept (Google Meet invite) or decline a meeting request
 *   saveGoogleToken  called once after "Continue with Google"
 *   settingsGet / settingsSave
 *   cron          hourly / nightly run (called by Supabase Cron with x-cron-secret)
 *
 * Secrets needed (Edge Functions → Secrets): GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, CRON_SECRET
 * Deploy with "Verify JWT" turned OFF (this function checks the login itself).
 */

const SB_URL = Deno.env.get('SUPABASE_URL') || '';
// server key: the legacy service_role key, or the new "secret" key on newer projects
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ||
  (() => { try { const k = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}'); return k.default || Object.values(k)[0] || ''; } catch (_) { return ''; } })();
const GID = Deno.env.get('GOOGLE_CLIENT_ID') || '';
const GSECRET = Deno.env.get('GOOGLE_CLIENT_SECRET') || '';
const CRON_SECRET = Deno.env.get('CRON_SECRET') || '';

const MIN = 60000, HOUR = 3600000, DAY = 86400000, STEP = 15 * MIN;
const CAL_NAME = 'My Steps';
const EVENT_COLORS = ['7', '6', '3', '2', '5', '11', '9', '8'];   // peacock, tangerine, grape, sage, banana, tomato, blueberry, graphite
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

/* ---------------- database (PostgREST, service role) ---------------- */
function sbHeaders(extra = {}) {
  const h = { apikey: SERVICE, 'Content-Type': 'application/json', ...extra };
  if (SERVICE.startsWith('eyJ')) h.Authorization = 'Bearer ' + SERVICE;   // legacy JWT key
  return h;
}
async function db(path, opts = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method: opts.method || 'GET', headers: sbHeaders({ Prefer: opts.prefer || 'return=representation' }),
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`Database ${r.status}: ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : null;
}
async function userFromReq(req) {
  const auth = req.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const r = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: SERVICE, Authorization: auth } });
  return r.ok ? r.json() : null;
}

/* ---------------- Google ---------------- */
const tokCache = {};
async function gToken(owner) {
  const c = tokCache[owner];
  if (c && c.exp > Date.now() + MIN) return c.tok;
  const rows = await db(`google_tokens?owner_id=eq.${owner}&select=refresh_token`);
  if (!rows.length) throw new Error('Google Calendar is not connected yet. In the app: Me → Connect Google.');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: GID, client_secret: GSECRET, refresh_token: rows[0].refresh_token, grant_type: 'refresh_token' })
  });
  const j = await r.json();
  if (!r.ok) {
    if (j.error === 'invalid_grant') await db(`settings?owner_id=eq.${owner}`, { method: 'PATCH', body: { google_connected: false } });
    throw new Error('Google refused access (' + (j.error || r.status) + '). In the app: Me → Connect Google again.');
  }
  tokCache[owner] = { tok: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return j.access_token;
}
async function g(owner, url, opts = {}) {
  const tok = await gToken(owner);
  const full = url.startsWith('http') ? url : 'https://www.googleapis.com/calendar/v3/' + url;
  const r = await fetch(full, { method: opts.method || 'GET', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  if (r.status === 204) return null;
  const t = await r.text();
  if (!r.ok) { const e = new Error(`Google ${r.status}: ${t.slice(0, 300)}`); e.status = r.status; throw e; }
  return t ? JSON.parse(t) : null;
}
const enc = s => encodeURIComponent(s);
async function listEvents(owner, calId, fromMs, toMs) {
  let out = [], page = '';
  do {
    const r = await g(owner, `calendars/${enc(calId)}/events?singleEvents=true&orderBy=startTime&maxResults=2500&timeMin=${enc(new Date(fromMs).toISOString())}&timeMax=${enc(new Date(toMs).toISOString())}${page ? '&pageToken=' + enc(page) : ''}`);
    out = out.concat(r.items || []); page = r.nextPageToken || '';
  } while (page);
  return out.filter(e => e.status !== 'cancelled');
}
const evStart = e => Date.parse(e.start.dateTime || e.start.date);
const evEnd = e => Date.parse(e.end.dateTime || e.end.date);
const isBusy = e => !!e.start.dateTime && e.transparency !== 'transparent' &&
  !(e.attendees || []).some(a => a.self && a.responseStatus === 'declined');

/* Gmail (UTF-8 safe) */
function b64(str) { const bytes = new TextEncoder().encode(str); let bin = ''; bytes.forEach(b => { bin += String.fromCharCode(b); }); return btoa(bin); }
async function sendMail(owner, fromName, fromEmail, to, subject, html) {
  const mime = [`From: =?UTF-8?B?${b64(fromName)}?= <${fromEmail}>`, `To: ${to}`, `Subject: =?UTF-8?B?${b64(subject)}?=`,
    'MIME-Version: 1.0', 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(html)].join('\r\n');
  await g(owner, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST',
    body: { raw: b64(mime).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') } });
}
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* ---------------- time zone helpers ---------------- */
function parts(tz, ms) {
  const p = {}; new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    .formatToParts(new Date(ms)).forEach(x => { p[x.type] = Number(x.value); });
  return { y: p.year, m: p.month, d: p.day, h: p.hour % 24, mi: p.minute, s: p.second };
}
function offset(tz, ms) { const p = parts(tz, ms); return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000; }
function localToUtc(tz, y, m, d, h = 0, mi = 0) { const guess = Date.UTC(y, m - 1, d, h, mi); return guess - offset(tz, guess - offset(tz, guess)); }
function dayStartUtc(tz, ms) { const p = parts(tz, ms); return localToUtc(tz, p.y, p.m, p.d); }
function addLocalDays(tz, ms, n) { const p = parts(tz, ms); const x = new Date(Date.UTC(p.y, p.m - 1, p.d + n)); return localToUtc(tz, x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate()); }
const hm = s => { const q = String(s).split(':').map(Number); return q[0] * 60 + (q[1] || 0); };
function fmtLocal(tz, ms, opts) { return new Intl.DateTimeFormat('en-GB', { timeZone: tz, ...opts }).format(new Date(ms)); }

/* windows of one time category: [[startMs, endMs], ...] */
function windowsOf(cat, fromMs, toMs, tz) {
  const out = [];
  if (!cat) return out;
  for (let d = dayStartUtc(tz, fromMs); d < toMs; d = addLocalDays(tz, d, 1)) {
    const p = parts(tz, d + 12 * HOUR), dow = new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
    ((cat.slots || {})[dow] || []).forEach(r => {
      const a = hm(r[0]), b = hm(r[1]);
      const s = localToUtc(tz, p.y, p.m, p.d, Math.floor(a / 60), a % 60), e = localToUtc(tz, p.y, p.m, p.d, Math.floor(b / 60), b % 60);
      if (e > s && e > fromMs && s < toMs) out.push([Math.max(s, fromMs), Math.min(e, toMs)]);
    });
  }
  return out;
}

/* ---------------- settings ---------------- */
function defaultSettings() {
  const wk = [1, 2, 3, 4, 5], sl = (days, r) => { const o = {}; days.forEach(d => { o[d] = r.slice(); }); return o; };
  const personal = sl(wk, [['04:00', '08:30'], ['12:30', '14:30'], ['17:30', '21:30']]); personal[6] = [['04:00', '06:00']];
  const spafi = sl([1, 2, 3, 4, 5, 6], [['04:00', '06:00']]); spafi[6] = [['04:00', '06:00'], ['16:00', '17:00']]; spafi[0] = [['15:00', '18:00']];
  return {
    tz: 'Indian/Antananarivo',
    categories: [{ name: 'Working', color: '#0a8f8a', slots: sl(wk, [['08:30', '12:30'], ['14:30', '17:30']]) },
      { name: 'Personal', color: '#f2654f', slots: personal }, { name: 'Spafi', color: '#8e6cf0', slots: spafi }],
    goalMap: {}, catMap: {}, defaultCategory: 'Working', minBlock: 30, maxBlock: 120, horizonDays: 7, calendarId: '',
    booking: { enabled: true, category: 'Working', noticeHours: 24, daysAhead: 21, durations: [15, 30, 60], title: 'Meeting with Aroo', ownerName: 'Aroo' }
  };
}
async function loadSettings(owner) {
  let rows = await db(`settings?owner_id=eq.${owner}&select=data,status,google_connected`);
  if (!rows.length) rows = await db('settings', { method: 'POST', body: { owner_id: owner, data: {} } });
  const d = defaultSettings(), s = Object.assign({}, d, rows[0].data || {});
  s.booking = Object.assign({}, d.booking, s.booking || {});
  return { s, status: rows[0].status || {}, connected: rows[0].google_connected };
}
const saveSettingsData = (owner, s) => db(`settings?owner_id=eq.${owner}`, { method: 'PATCH', body: { data: s, updated_at: new Date().toISOString() } });
function catFor(s, t) {
  const name = t.time_category || s.catMap[t.category] || s.goalMap[t.main_goal] || s.defaultCategory;
  return s.categories.find(c => c.name === name) || s.categories[0];
}

async function ensureCalendar(owner, s) {
  if (s.calendarId) {
    try { await g(owner, `calendars/${enc(s.calendarId)}`); return s.calendarId; } catch (e) { if (e.status !== 404 && e.status !== 403) throw e; }
  }
  const list = await g(owner, 'users/me/calendarList?maxResults=250');
  const found = (list.items || []).find(c => c.summary === CAL_NAME && c.accessRole === 'owner');
  const cal = found || await g(owner, 'calendars', { method: 'POST', body: { summary: CAL_NAME, description: 'Task blocks planned by My Steps', timeZone: s.tz } });
  s.calendarId = cal.id; await saveSettingsData(owner, s);
  return cal.id;
}

/* ================= PURE PLANNER (same rules as tested before) =================
   tasks are sorted most urgent first. Returns blocks to update / create / remove. */
function plan(input) {
  const step = input.step || STEP;
  const occ = input.busy.map(b => [b[0], b[1]]);
  const overlaps = (s, e) => occ.some(o => o[0] < e && s < o[1]);
  const inWindows = (w, s, e) => w.some(x => x[0] <= s && e <= x[1]);
  const free = (windows, from) => {
    const segs = [];
    windows.forEach(w => {
      let ps = [[Math.max(w[0], from), w[1]]];
      occ.forEach(o => {
        const nx = [];
        ps.forEach(p => {
          if (o[1] <= p[0] || o[0] >= p[1]) { nx.push(p); return; }
          if (o[0] > p[0]) nx.push([p[0], o[0]]);
          if (o[1] < p[1]) nx.push([o[1], p[1]]);
        });
        ps = nx;
      });
      ps.forEach(p => { if (p[1] - p[0] >= step) segs.push(p); });
    });
    return segs.sort((a, b) => a[0] - b[0]);
  };
  const ceilStep = ms => Math.ceil(ms / step) * step, floorStep = ms => Math.floor(ms / step) * step;
  const byTask = {}; (input.existing || []).forEach(ev => { (byTask[ev.taskId] = byTask[ev.taskId] || []).push(ev); });
  const leftover = [], blocks = {}, unplaced = {}, atRisk = [], taskIds = {};
  input.tasks.forEach(t => { taskIds[t.id] = true; });
  Object.keys(byTask).forEach(tid => { if (!taskIds[tid]) byTask[tid].forEach(ev => leftover.push(ev)); });

  input.tasks.forEach(t => {                                   // 1. keep valid blocks
    blocks[t.id] = []; let kept = 0;
    (byTask[t.id] || []).slice().sort((a, b) => a.start - b.start).forEach(ev => {
      const dur = ev.end - ev.start;
      if (input.mode !== 'full' && ev.start >= input.now && inWindows(t.windows, ev.start, ev.end) && !overlaps(ev.start, ev.end) && kept + dur <= t.remaining + step / 2) {
        occ.push([ev.start, ev.end]); kept += dur; blocks[t.id].push([ev.start, ev.end, ev.id]);
      } else leftover.push(ev);
    });
    t._need = Math.max(0, t.remaining - kept);
  });
  const created = [];
  input.tasks.forEach(t => {                                   // 2. place what is still needed
    let need = t._need, guard = 0;
    while (need > 0 && guard++ < 200) {
      const want = Math.min(ceilStep(need), t.maxBlock), minLen = Math.min(t.minBlock, ceilStep(need));
      const seg = free(t.windows, ceilStep(input.now)).find(p => p[1] - p[0] >= minLen);
      if (!seg) break;
      const len = Math.min(want, floorStep(seg[1] - seg[0]));
      occ.push([seg[0], seg[0] + len]); created.push({ taskId: t.id, start: seg[0], end: seg[0] + len });
      blocks[t.id].push([seg[0], seg[0] + len, null]); need -= len;
    }
    if (need > 0) unplaced[t.id] = need;
  });
  const updates = [];
  if (input.mode !== 'full') {                                 // 3. fill free time in the next 24 h
    let pulls = 0; const horizon = input.now + DAY;
    input.tasks.forEach(t => {
      if (pulls >= (input.pullLimit || 0)) return;
      const segs = free(t.windows, ceilStep(input.now)).filter(p => p[0] < horizon);
      let later = null, seg = null;
      blocks[t.id].filter(b => b[2]).sort((a, b) => a[0] - b[0]).some(b => {
        seg = segs.find(p => b[0] >= p[0] + HOUR && b[1] - b[0] <= p[1] - p[0]); if (seg) { later = b; return true; } return false;
      });
      if (!later) return;
      const len = later[1] - later[0];
      const i = occ.findIndex(o => o[0] === later[0] && o[1] === later[1]); if (i > -1) occ.splice(i, 1);
      occ.push([seg[0], seg[0] + len]); updates.push({ id: later[2], start: seg[0], end: seg[0] + len });
      later[0] = seg[0]; later[1] = seg[0] + len; pulls++;
    });
  }
  const create = [], remove = [], pool = leftover.filter(ev => ev.start >= input.now);
  created.forEach(c => {                                       // 4. reuse events of the same task
    const i = pool.findIndex(ev => ev.taskId === c.taskId);
    if (i > -1) { const ev = pool.splice(i, 1)[0]; updates.push({ id: ev.id, start: c.start, end: c.end }); } else create.push(c);
  });
  pool.forEach(ev => remove.push(ev.id));
  input.tasks.forEach(t => {                                   // 5. at risk
    const lastEnd = Math.max(0, ...blocks[t.id].map(b => b[1]));
    // at risk = a block ends after the due date, or time is missing although the due date is inside the planning window
    if (t.dueEnd && (lastEnd > t.dueEnd || (unplaced[t.id] && (!input.horizon || t.dueEnd <= input.horizon)))) atRisk.push(t.id);
  });
  return { update: updates, create, remove, atRisk, unplaced, blocks };
}

/* ================= HABITS: reserved time, as close as possible to the ideal time =================
   occs: [{key, habitId, name, day, ideal, winStart, winEnd, dur}] · busy: [[s,e]] · existing: {key: {id, start, end}}
   Returns {placed: [{...occ, start, end, existingId}], skipped: [keys]} */
function placeHabits(occs, busy, existing, now, mode) {
  const occ = busy.map(b => [b[0], b[1]]), free = (s, e) => !occ.some(o => o[0] < e && s < o[1]);
  const placed = [], skipped = [];
  occs.slice().sort((a, b) => a.ideal - b.ideal).forEach(h => {
    const ex = existing[h.key];
    if (ex && mode !== 'full' && ex.start >= h.winStart && ex.end <= h.winEnd && ex.end - ex.start === h.dur && (ex.start >= now || ex.end > now) && free(ex.start, ex.end)) {
      occ.push([ex.start, ex.end]); placed.push({ ...h, start: ex.start, end: ex.end, existingId: ex.id }); return;
    }
    let best = null;
    for (let k = 0; k <= 96 && best === null; k++) {                      // ideal, then 15, 30, 45 … minutes earlier/later
      for (const st of k ? [h.ideal - k * STEP, h.ideal + k * STEP] : [h.ideal]) {
        if (st < h.winStart || st + h.dur > h.winEnd || st < now) continue;
        if (free(st, st + h.dur)) { best = st; break; }
      }
      if (h.ideal - k * STEP < h.winStart && h.ideal + k * STEP + h.dur > h.winEnd) break;
    }
    if (best === null) { skipped.push(h.key); return; }
    occ.push([best, best + h.dur]); placed.push({ ...h, start: best, end: best + h.dur, existingId: ex ? ex.id : null });
  });
  return { placed, skipped };
}
function habitOccurrences(habits, tz, today, horizonEnd, now) {
  const out = [];
  for (let d = today; d < horizonEnd; d = addLocalDays(tz, d, 1)) {
    const p = parts(tz, d + 12 * HOUR), dow = new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
    const dayKey = `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
    habits.forEach(h => {
      if (!(h.days || []).map(Number).includes(dow)) return;
      const [hh, mm] = String(h.ideal).split(':').map(Number), ideal = localToUtc(tz, p.y, p.m, p.d, hh, mm), dur = h.minutes * MIN;
      const winStart = Math.max(d, ideal - h.flex * MIN), winEnd = Math.min(addLocalDays(tz, d, 1), ideal + h.flex * MIN + dur);
      if (winEnd - dur < now) return;                                      // window already over
      out.push({ key: h.id + '|' + dayKey, habitId: h.id, name: h.name, day: d, ideal, winStart, winEnd, dur });
    });
  }
  return out;
}

/* ================= scheduling run ================= */
async function withLock(owner, fn) {
  for (let i = 0; i < 6; i++) {
    const now = new Date().toISOString(), until = new Date(Date.now() + 90000).toISOString();
    const got = await db(`settings?owner_id=eq.${owner}&or=${enc(`(sched_lock.is.null,sched_lock.lt.${now})`)}`, { method: 'PATCH', body: { sched_lock: until } });
    if (got && got.length) {
      try { return await fn(); } finally { await db(`settings?owner_id=eq.${owner}`, { method: 'PATCH', body: { sched_lock: null } }); }
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  return { skipped: true };
}
function rank(t) {
  const pr = { High: 0, Medium: 1, Low: 2 }[t.priority];
  // order: Do now first, then earliest due date (no due date last), then priority
  return [t.start_now === 'do now' ? 0 : 1, t.due_date ? Date.parse(t.due_date) : 9e15, pr === undefined ? 3 : pr];
}
const cmp = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
const prop = (e, k) => ((e.extendedProperties || {}).private || {})[k];
function evBody(s, t, start, end, extra = {}) {
  const i = Math.max(0, s.categories.indexOf(catFor(s, t)));
  return {
    summary: t.task, colorId: EVENT_COLORS[i % EVENT_COLORS.length],
    description: 'My Steps task' + (t.objective ? '\nObjective: ' + t.objective : '') + (t.category ? '\nCategory: ' + t.category : '') +
      (t.due_date ? '\nDue: ' + t.due_date : '') + '\nPriority: ' + (t.priority || '-') + ' · ' + (t.est_hours || '?') + ' h',
    start: { dateTime: new Date(start).toISOString() }, end: { dateTime: new Date(end).toISOString() },
    reminders: { useDefault: false, overrides: [] },
    extendedProperties: { private: { mysteps_task: String(t.id), ...extra } }
  };
}

async function schedule(owner, mode = 'incremental') {
  await loadSettings(owner);                                   // makes sure the settings row exists (needed for the lock)
  await gToken(owner);                                         // clear message if Google is not connected
  return withLock(owner, async () => {
    const { s } = await loadSettings(owner);
    const tz = s.tz, cal = await ensureCalendar(owner, s);
    const nowExact = Date.now(), now = Math.ceil(nowExact / (5 * MIN)) * 5 * MIN;
    const today = dayStartUtc(tz, nowExact), horizonEnd = addLocalDays(tz, today, s.horizonDays + 1);
    let writes = 0;

    const [mainEv, myEv, tasks, habits] = await Promise.all([
      listEvents(owner, 'primary', now - HOUR, horizonEnd),
      listEvents(owner, cal, today - 45 * DAY, horizonEnd),
      db(`tasks?owner_id=eq.${owner}&status=neq.Completed&auto_schedule=is.true&est_hours=gt.0&select=*`),
      db(`habits?owner_id=eq.${owner}&active=is.true&select=*`).catch(() => [])     // table missing = no habits yet
    ]);
    const busy = mainEv.filter(isBusy).map(e => [evStart(e), evEnd(e)]);
    const all = myEv.filter(e => prop(e, 'mysteps_task') && e.start.dateTime).map(e => ({
      id: e.id, taskId: prop(e, 'mysteps_task'), pinned: prop(e, 'mysteps_pin') === '1', now: prop(e, 'mysteps_now') === '1',
      done: prop(e, 'mysteps_done') === '1', summary: e.summary || '', start: evStart(e), end: evEnd(e) }));
    const open = {}; tasks.forEach(t => { open[t.id] = t; });

    // Blocks of tasks that are no longer open. Completed tasks keep their history in the calendar:
    // past blocks stay (marked ✓), an ongoing block ends now, only future blocks are removed.
    // If a task was finished before any of its blocks started, one block is kept, ending when it was completed.
    const closedIds = [...new Set(all.filter(b => !open[b.taskId]).map(b => b.taskId))];
    const finished = {};
    if (closedIds.length) (await db(`tasks?owner_id=eq.${owner}&status=eq.Completed&id=in.(${closedIds.map(enc).join(',')})&select=id,completed_on`))
      .forEach(t => { finished[t.id] = t.completed_on ? Math.min(Date.parse(t.completed_on), nowExact) : nowExact; });
    const evUrl = id => `calendars/${enc(cal)}/events/${id}`;
    const doneBody = b => ({ summary: b.summary.startsWith('✓ ') ? b.summary : '✓ ' + b.summary,
      extendedProperties: { private: { mysteps_task: String(b.taskId), mysteps_done: '1', mysteps_pin: '1', mysteps_now: '0' } } });
    for (const id of closedIds) {
      const blocks = all.filter(b => b.taskId === id).sort((a, b) => a.start - b.start);
      const doneAt = finished[id];
      if (doneAt !== undefined && !blocks.some(b => b.start < now)) {          // finished early: keep one block as a record
        const b = blocks[0], end = Math.floor(doneAt / (5 * MIN)) * 5 * MIN, start = end - (b.end - b.start);
        await g(owner, evUrl(b.id), { method: 'PATCH', body: { ...doneBody(b), start: { dateTime: new Date(start).toISOString() }, end: { dateTime: new Date(end).toISOString() } } }); writes++;
        b.start = start; b.end = end; b.done = true;
      }
      for (const b of blocks) {
        if (b.done && b.end <= now) continue;
        if (b.start < now && b.end > now) {                                    // ongoing: stop it now
          await g(owner, evUrl(b.id), { method: 'PATCH', body: { ...(doneAt !== undefined ? doneBody(b) : {}), end: { dateTime: new Date(now).toISOString() } } }); writes++;
          b.end = now; if (doneAt !== undefined) b.done = true;
        } else if (b.start >= now) {                                           // future: free the time
          await g(owner, evUrl(b.id), { method: 'DELETE' }); writes++; b.gone = true;
        } else if (doneAt !== undefined && !b.done) {                          // past: mark as done (once)
          await g(owner, evUrl(b.id), { method: 'PATCH', body: doneBody(b) }); writes++; b.done = true;
        }
      }
    }
    for (const t of tasks.filter(x => x.start_now === 'do now')) {   // Do now
      if (!all.some(b => b.taskId === t.id && b.start <= nowExact && b.end > nowExact)) {
        const spent = all.filter(b => b.taskId === t.id && b.end <= nowExact).reduce((a, b) => a + b.end - b.start, 0);
        const len = Math.min(Math.max(Number(t.est_hours) * HOUR - spent, s.minBlock * MIN), s.maxBlock * MIN);
        const start = Math.floor(nowExact / (5 * MIN)) * 5 * MIN;
        const e = await g(owner, `calendars/${enc(cal)}/events`, { method: 'POST', body: evBody(s, t, start, start + len, { mysteps_pin: '1', mysteps_now: '1' }) });
        all.push({ id: e.id, taskId: t.id, pinned: true, now: true, start, end: start + len }); writes++;
      }
      await db(`tasks?id=eq.${t.id}`, { method: 'PATCH', body: { start_now: '' }, prefer: 'return=minimal' }); t.start_now = '';
    }
    const live = all.filter(b => !b.gone);
    live.filter(b => b.pinned || (b.start < now && b.end > now)).forEach(b => { if (b.end > now) busy.push([b.start, b.end]); });
    const items = tasks.map(t => {
      const used = live.filter(b => b.taskId === t.id && (b.start < now || b.pinned)).reduce((a, b) => a + b.end - b.start, 0);
      const due = t.due_date ? (p => localToUtc(tz, p[0], p[1], p[2], 23, 59))(t.due_date.split('-').map(Number)) : null;
      // Planned time passed but the task is not ticked done: plan its estimated time again.
      // (Time is counted per round of the estimate, so a round that is half done keeps only its rest.)
      const est = Math.round(Number(t.est_hours) * 60) * MIN, inRound = est > 0 ? Math.round(used / MIN) * MIN % est : 0;
      const replanned = used > 0 && inRound === 0;
      return { id: t.id, t, rank: rank(t), remaining: est - inRound, replanned, dueEnd: due,
        windows: windowsOf(catFor(s, t), now, horizonEnd, tz), minBlock: s.minBlock * MIN, maxBlock: s.maxBlock * MIN };
    }).sort((a, b) => cmp(a.rank, b.rank));
    const existing = live.filter(b => !b.pinned && b.start >= now).map(b => ({ id: b.id, taskId: b.taskId, start: b.start, end: b.end }));

    // habits first: they reserve time near their ideal time, tasks are planned around them
    const habitEv = myEv.filter(e => prop(e, 'mysteps_habit') && e.start.dateTime)
      .map(e => ({ id: e.id, key: prop(e, 'mysteps_habit') + '|' + prop(e, 'mysteps_day'), start: evStart(e), end: evEnd(e) }));
    const exHabit = {}; habitEv.forEach(e => { if (!exHabit[e.key]) exHabit[e.key] = e; });
    const occs = habitOccurrences(habits, tz, today, horizonEnd, now);
    let H = placeHabits(occs, busy, exHabit, now, mode);
    let p = plan({ now, step: STEP, tasks: items, busy: busy.concat(H.placed.map(h => [h.start, h.end])), existing, mode, pullLimit: 3, horizon: horizonEnd });
    // if a task due today or tomorrow would miss its due date, habits up to that day give way
    const urgentEnd = addLocalDays(tz, today, 2);
    const urgent = items.filter(x => x.dueEnd && x.dueEnd < urgentEnd && p.atRisk.includes(x.id));
    if (urgent.length && H.placed.length) {
      const until = Math.max(...urgent.map(x => x.dueEnd));
      const locked = H.placed.filter(h => h.day > until), released = occs.filter(o => o.day <= until);
      p = plan({ now, step: STEP, tasks: items, busy: busy.concat(locked.map(h => [h.start, h.end])), existing, mode, pullLimit: 0, horizon: horizonEnd });
      const taskBlocks = []; Object.values(p.blocks).forEach(bs => bs.forEach(b => taskBlocks.push([b[0], b[1]])));
      const H2 = placeHabits(released, busy.concat(locked.map(h => [h.start, h.end]), taskBlocks), exHabit, now, 'full');
      H = { placed: locked.concat(H2.placed), skipped: H.skipped.filter(k => !released.some(o => o.key === k)).concat(H2.skipped) };
    }

    const byId = {}; items.forEach(x => { byId[x.id] = x.t; });
    for (const u of p.update) { await g(owner, `calendars/${enc(cal)}/events/${u.id}`, { method: 'PATCH', body: { start: { dateTime: new Date(u.start).toISOString() }, end: { dateTime: new Date(u.end).toISOString() } } }); writes++; }
    for (const c of p.create) { await g(owner, `calendars/${enc(cal)}/events`, { method: 'POST', body: evBody(s, byId[c.taskId], c.start, c.end) }); writes++; }
    for (const id of p.remove) { await g(owner, `calendars/${enc(cal)}/events/${id}`, { method: 'DELETE' }); writes++; }
    // habit events: create / move / remove (past ones stay as history)
    const keepHabit = new Set();
    for (const h of H.placed) {
      const ex = h.existingId ? habitEv.find(e => e.id === h.existingId) : null;
      if (ex) { keepHabit.add(ex.id); if (ex.start !== h.start || ex.end !== h.end) { await g(owner, evUrl(ex.id), { method: 'PATCH', body: { start: { dateTime: new Date(h.start).toISOString() }, end: { dateTime: new Date(h.end).toISOString() } } }); writes++; } }
      else {
        const e = await g(owner, `calendars/${enc(cal)}/events`, { method: 'POST', body: { summary: h.name, colorId: '2', transparency: 'transparent',
          description: 'My Steps habit · reserved time (shown as free, so people can still book it)', reminders: { useDefault: false, overrides: [] },
          start: { dateTime: new Date(h.start).toISOString() }, end: { dateTime: new Date(h.end).toISOString() },
          extendedProperties: { private: { mysteps_habit: String(h.habitId), mysteps_day: h.key.split('|')[1] } } } });
        keepHabit.add(e.id); writes++;
      }
    }
    for (const e of habitEv) if (!keepHabit.has(e.id) && e.start >= now) { await g(owner, evUrl(e.id), { method: 'DELETE' }); writes++; }

    const next = {};
    Object.keys(p.blocks).forEach(id => { const f = p.blocks[id].map(b => b[0]).filter(x => x >= now).sort((a, b) => a - b)[0]; if (f) next[id] = new Date(f).toISOString(); });
    live.filter(b => b.pinned && b.end > now).forEach(b => { const st = new Date(Math.max(b.start, now)).toISOString(); if (!next[b.taskId] || st < next[b.taskId]) next[b.taskId] = st; });
    const status = { lastRun: new Date().toISOString(), mode, writes, atRisk: p.atRisk,
      unplaced: Object.fromEntries(Object.entries(p.unplaced).map(([k, v]) => [k, Math.round(v / MIN)])), next,
      doingNow: live.filter(b => b.now && b.start <= nowExact && b.end > nowExact).map(b => b.taskId),
      overTime: [], replanned: items.filter(x => x.replanned).map(x => x.id), habitsSkipped: H.skipped };
    await db(`settings?owner_id=eq.${owner}`, { method: 'PATCH', body: { status }, prefer: 'return=minimal' });
    return status;
  });
}

/* ================= other actions ================= */
async function calendarData(owner, fromIso, toIso) {
  const { s } = await loadSettings(owner);
  const from = Date.parse(fromIso), to = Date.parse(toIso), cal = await ensureCalendar(owner, s);
  const [mainEv, myEv, bks] = await Promise.all([listEvents(owner, 'primary', from, to), listEvents(owner, cal, from, to),
    db(`bookings?owner_id=eq.${owner}&status=in.(Pending,Accepted)&end_at=gt.${enc(new Date(from).toISOString())}&start_at=lt.${enc(new Date(to).toISOString())}&select=*`)]);
  const iso = ms => new Date(ms).toISOString();
  const windows = [];
  s.categories.forEach(c => windowsOf(c, from, to, s.tz).forEach(w => windows.push({ cat: c.name, color: c.color, start: iso(w[0]), end: iso(w[1]) })));
  return {
    main: mainEv.filter(e => !(e.attendees || []).some(a => a.self && a.responseStatus === 'declined'))
      .map(e => ({ title: e.summary || '(busy)', start: e.start.dateTime || e.start.date, end: e.end.dateTime || e.end.date, allDay: !e.start.dateTime })),
    blocks: myEv.filter(e => prop(e, 'mysteps_task') && e.start.dateTime).map(e => ({ id: e.id, taskId: prop(e, 'mysteps_task'), title: e.summary,
      pinned: prop(e, 'mysteps_pin') === '1', start: e.start.dateTime, end: e.end.dateTime })),
    habits: myEv.filter(e => prop(e, 'mysteps_habit') && e.start.dateTime).map(e => ({ id: e.id, habitId: prop(e, 'mysteps_habit'), title: e.summary, start: e.start.dateTime, end: e.end.dateTime })),
    windows, bookings: bks.map(bookingOut)
  };
}
const bookingOut = b => ({ id: b.id, name: b.name, email: b.email, minutes: b.minutes, start: b.start_at, end: b.end_at, topic: b.topic, status: b.status, meet: b.meet_link });

async function moveBlock(owner, id, startIso, endIso, pin = true) {
  const { s } = await loadSettings(owner), cal = await ensureCalendar(owner, s);
  const e = await g(owner, `calendars/${enc(cal)}/events/${id}`);
  const priv = { ...((e.extendedProperties || {}).private || {}), mysteps_pin: pin ? '1' : '0', mysteps_now: '0' };
  const body = { extendedProperties: { private: priv } };
  if (startIso) { body.start = { dateTime: startIso }; body.end = { dateTime: endIso }; }
  await g(owner, `calendars/${enc(cal)}/events/${id}`, { method: 'PATCH', body });
  return schedule(owner, 'incremental');
}

async function ownerProfile(owner) { return (await db(`profiles?id=eq.${owner}&select=email,name`))[0] || {}; }
function whenText(tz, startIso, minutes) {
  const st = Date.parse(startIso);
  return fmtLocal(tz, st, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) + ', ' +
    fmtLocal(tz, st, { hour: '2-digit', minute: '2-digit', hour12: false }) + '–' + fmtLocal(tz, st + minutes * MIN, { hour: '2-digit', minute: '2-digit', hour12: false }) + ' (Madagascar time, UTC+3)';
}
async function bookingDecide(owner, id, accept, bookingUrl) {
  const { s } = await loadSettings(owner), B = s.booking, me = await ownerProfile(owner);
  const b = (await db(`bookings?id=eq.${enc(id)}&owner_id=eq.${owner}&select=*`))[0];
  if (!b) throw new Error('Request not found');
  if (b.status !== 'Pending') throw new Error('This request was already ' + b.status.toLowerCase());
  const when = whenText(s.tz, b.start_at, b.minutes), from = B.ownerName || me.name || 'My Steps';
  if (accept) {
    const ev = await g(owner, `calendars/primary/events?conferenceDataVersion=1&sendUpdates=all`, { method: 'POST', body: {
      summary: B.title + ' – ' + b.name, description: (b.topic ? 'Topic: ' + b.topic + '\n\n' : '') + 'Booked through My Steps.',
      start: { dateTime: b.start_at }, end: { dateTime: b.end_at }, attendees: [{ email: b.email }],
      conferenceData: { createRequest: { requestId: b.id + '-' + Date.now(), conferenceSolutionKey: { type: 'hangoutsMeet' } } } } });
    const meet = ev.hangoutLink || ((ev.conferenceData || {}).entryPoints || [{}])[0].uri || '';
    await db(`bookings?id=eq.${enc(id)}`, { method: 'PATCH', body: { status: 'Accepted', event_id: ev.id, meet_link: meet }, prefer: 'return=minimal' });
    await sendMail(owner, from, me.email, b.email, 'Confirmed: meeting with ' + from,
      `<p>Hello ${esc(b.name)},</p><p>Our ${b.minutes}-minute meeting is confirmed for <b>${esc(when)}</b>.</p>` +
      (meet ? `<p>Google Meet link: <a href="${meet}">${meet}</a></p>` : '') + `<p>You will also receive a calendar invitation.</p><p>See you soon,<br>${esc(from)}</p>`);
    try { await schedule(owner, 'incremental'); } catch (_) { /* next run will move task blocks */ }
    return { status: 'Accepted', meet };
  }
  await db(`bookings?id=eq.${enc(id)}`, { method: 'PATCH', body: { status: 'Declined' }, prefer: 'return=minimal' });
  await sendMail(owner, from, me.email, b.email, 'About your meeting request to ' + from,
    `<p>Hello ${esc(b.name)},</p><p>Thank you for your request for a ${b.minutes}-minute meeting on <b>${esc(when)}</b>.</p>` +
    `<p>Although this time appeared available in my schedule, I am unfortunately not able to meet then, because of urgent work that needs my attention.</p>` +
    (bookingUrl ? `<p>Please feel free to choose another time here: <a href="${bookingUrl}">${bookingUrl}</a></p>` : '') +
    `<p>Thank you for your understanding,<br>${esc(from)}</p>`);
  return { status: 'Declined' };
}

function cleanSettings(cur, n) {
  const time = /^([01]\d|2[0-3]):[0-5]\d$/, s = { ...cur };
  if (Array.isArray(n.categories) && n.categories.length) {
    s.categories = n.categories.slice(0, 8).map(c => {
      const slots = {};
      for (let d = 0; d < 7; d++) slots[d] = (((c.slots || {})[d]) || []).filter(r => time.test(r[0]) && time.test(r[1]) && r[0] < r[1]).slice(0, 6);
      return { name: String(c.name || '').trim().slice(0, 30) || 'Time', color: /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : '#0a8f8a', slots };
    });
  }
  ['goalMap', 'catMap'].forEach(k => { if (n[k] && typeof n[k] === 'object') s[k] = n[k]; });
  if (n.defaultCategory) s.defaultCategory = String(n.defaultCategory);
  if (n.minBlock) s.minBlock = Math.max(15, Math.min(240, Number(n.minBlock)));
  if (n.maxBlock) s.maxBlock = Math.max(s.minBlock, Math.min(480, Number(n.maxBlock)));
  if (n.horizonDays) s.horizonDays = Math.max(1, Math.min(14, Number(n.horizonDays)));
  if (n.booking) {
    const B = n.booking;
    s.booking = { ...s.booking, enabled: !!B.enabled, category: String(B.category || s.booking.category),
      noticeHours: Math.max(0, Math.min(168, Number(B.noticeHours) || 24)), daysAhead: Math.max(1, Math.min(60, Number(B.daysAhead) || 21)),
      durations: (B.durations || [15, 30, 60]).map(Number).filter(x => [15, 30, 45, 60, 90].includes(x)),
      title: String(B.title || s.booking.title).slice(0, 80), ownerName: String(B.ownerName || s.booking.ownerName).slice(0, 60) };
  }
  return s;
}

/* ================= router ================= */
Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    if (body.action === 'cron') {
      if (!CRON_SECRET || req.headers.get('x-cron-secret') !== CRON_SECRET) return json({ ok: false, error: 'forbidden' }, 403);
      const owners = await db('settings?google_connected=is.true&select=owner_id');
      const out = [];
      for (const o of owners) { try { out.push(await schedule(o.owner_id, body.mode === 'full' ? 'full' : 'incremental')); } catch (e) { out.push({ error: String(e.message || e) }); } }
      return json({ ok: true, runs: out.length });
    }
    const user = await userFromReq(req);
    if (!user) return json({ ok: false, error: 'AUTH' }, 401);
    const prof = (await db(`profiles?id=eq.${user.id}&select=role`))[0];
    if (!prof || prof.role !== 'admin') return json({ ok: false, error: 'Only the owner account can use scheduling' });
    const owner = user.id;
    switch (body.action) {
      case 'saveGoogleToken': {
        if (!body.refreshToken) throw new Error('No Google token received. Please try "Connect Google" again.');
        await db('google_tokens?on_conflict=owner_id', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal',
          body: { owner_id: owner, refresh_token: body.refreshToken, updated_at: new Date().toISOString() } });
        await loadSettings(owner);
        await db(`settings?owner_id=eq.${owner}`, { method: 'PATCH', body: { google_connected: true }, prefer: 'return=minimal' });
        delete tokCache[owner];
        let status = null; try { status = await schedule(owner, 'full'); } catch (e) { status = { error: String(e.message || e) }; }
        return json({ ok: true, status });
      }
      case 'schedule': return json({ ok: true, status: await schedule(owner, body.mode === 'full' ? 'full' : 'incremental') });
      case 'calendar': return json({ ok: true, cal: await calendarData(owner, body.from, body.to) });
      case 'moveBlock': return json({ ok: true, status: await moveBlock(owner, body.id, body.start, body.end, true) });
      case 'unpinBlock': return json({ ok: true, status: await moveBlock(owner, body.id, null, null, false) });
      case 'settingsGet': { const { s, status } = await loadSettings(owner); return json({ ok: true, settings: s, status }); }
      case 'settingsSave': {
        const { s } = await loadSettings(owner); const ns = cleanSettings(s, body.settings || {});
        await saveSettingsData(owner, ns);
        let status = null; try { status = await schedule(owner, 'full'); } catch (e) { status = { error: String(e.message || e) }; }
        return json({ ok: true, settings: ns, status });
      }
      case 'bookingDecide': return json({ ok: true, ...(await bookingDecide(owner, body.id, !!body.accept, body.bookingUrl || '')) });
      default: return json({ ok: false, error: 'Unknown action' });
    }
  } catch (e) {
    return json({ ok: false, error: String((e && e.message) || e) });
  }
});
