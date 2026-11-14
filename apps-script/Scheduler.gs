/**
 * MY STEPS – AUTOMATIC SCHEDULER
 * ==============================
 * Add this file to the Apps Script project INSIDE Task_Tracker_AppSheet
 * (same project as Api.gs). It replaces Reclaim for task scheduling.
 *
 * - Tasks with "Auto schedule" = YES get time blocks in a Google Calendar
 *   called "My Steps", inside the hours of their time category
 *   (Working / Personal / Spafi ...), ordered by priority, then due date.
 * - Only your MAIN calendar counts as busy.
 * - Stable plan: existing blocks stay where they are unless they become
 *   invalid; freed time is filled by the next most urgent task.
 * - Runs: right after a change in the app, when your main calendar changes,
 *   every hour, and a full re-plan every night.
 *
 * One-time setup: run  ttSetupScheduler  from the editor (see the guide).
 */

const TS = {
  CAL_NAME: 'My Steps',
  STEP: 15 * 60000,                  // 15-minute grid
  TAG: 'mysteps_task', PIN: 'mysteps_pin', NOW: 'mysteps_now',
  PAST_DAYS: 45,                     // how far back past blocks count as time spent
  PULL_LIMIT: 3,                     // max blocks pulled earlier per run
  DAILY_TRIGGER_BUDGET_S: 60 * 60    // above this, calendar-change runs pause until tomorrow
};
const TS_COLORS = ['CYAN', 'ORANGE', 'MAUVE', 'PALE_GREEN', 'YELLOW', 'PALE_RED', 'BLUE', 'GRAY'];

/* =====================================================================
   Settings (stored in Script Properties as JSON, edited from the app)
   ===================================================================== */
function ts_defaultSettings_() {
  const wk = [1, 2, 3, 4, 5];
  const slots = (days, ranges) => { const o = {}; days.forEach(d => { o[d] = ranges.slice(); }); return o; };
  const personal = slots(wk, [['04:00', '08:30'], ['12:30', '14:30'], ['17:30', '21:30']]); personal[6] = [['04:00', '06:00']];
  const spafi = slots([1, 2, 3, 4, 5, 6], [['04:00', '06:00']]); spafi[6] = [['04:00', '06:00'], ['16:00', '17:00']]; spafi[0] = [['15:00', '18:00']];
  return {
    categories: [
      { name: 'Working', color: '#0a8f8a', slots: slots(wk, [['08:30', '12:30'], ['14:30', '17:30']]) },
      { name: 'Personal', color: '#f2654f', slots: personal },
      { name: 'Spafi', color: '#8e6cf0', slots: spafi }
    ],
    goalMap: {}, catMap: {}, defaultCategory: 'Working',
    minBlock: 30, maxBlock: 120, horizonDays: 7,
    booking: { enabled: true, category: 'Working', noticeHours: 24, daysAhead: 21, durations: [15, 30, 60],
      title: 'Meeting with Aroo', ownerName: 'Aroo', bookingUrl: '' },
    calendarId: '', reclaimSync: false
  };
}
function ts_settings_() {
  const raw = PropertiesService.getScriptProperties().getProperty('ts_settings');
  const d = ts_defaultSettings_();
  if (!raw) return d;
  const s = JSON.parse(raw);
  Object.keys(d).forEach(k => { if (s[k] === undefined) s[k] = d[k]; });
  s.booking = Object.assign({}, d.booking, s.booking || {});
  return s;
}
function ts_saveSettings_(s) { PropertiesService.getScriptProperties().setProperty('ts_settings', JSON.stringify(s)); }

/* Guess goal -> time category the first time (you can change it in the app) */
function ts_seedGoalMap_(s) {
  const G = tt_read_(TT.SHEETS.goals);
  G.rows.forEach(r => {
    const g = String(r[0]).trim(); if (!g || s.goalMap[g]) return;
    s.goalMap[g] = /family|famille|perso/i.test(g) ? 'Personal' : 'Working';
  });
}

/* =====================================================================
   Time helpers (all in the script time zone: set it to Indian/Antananarivo)
   ===================================================================== */
function ts_hm_(s) { const p = String(s).split(':').map(Number); return p[0] * 60 + (p[1] || 0); }
function ts_dayStart_(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function ts_addDays_(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
function ts_iso_(ms) { return Utilities.formatDate(new Date(ms), Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ssXXX"); }

/* Windows of one time category between two dates: [[startMs, endMs], ...] */
function ts_windows_(cat, from, to) {
  const out = [];
  if (!cat) return out;
  for (let d = ts_dayStart_(from); d < to; d = ts_addDays_(d, 1)) {
    (cat.slots[d.getDay()] || []).forEach(r => {
      const a = ts_hm_(r[0]), b = ts_hm_(r[1]);
      const s = new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(a / 60), a % 60).getTime();
      const e = new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(b / 60), b % 60).getTime();
      if (e > s && e > from.getTime() && s < to.getTime()) out.push([Math.max(s, from.getTime()), Math.min(e, to.getTime())]);
    });
  }
  return out;
}
function ts_catFor_(s, t) {
  const name = String(t['Time category'] || '').trim() || s.catMap[t.Category] || s.goalMap[t['Main goal']] || s.defaultCategory;
  return s.categories.find(c => c.name === name) || s.categories[0];
}

/* =====================================================================
   PURE PLANNER (no Google services: tested outside Apps Script)
   input = { now, step, tasks:[{id, remaining (ms), dueEnd, windows, minBlock, maxBlock}] (already sorted by rank),
             busy:[[s,e]], existing:[{id (event), taskId, start, end}], mode:'incremental'|'full', pullLimit }
   output = { update:[{id,start,end}], create:[{taskId,start,end}], remove:[eventId], atRisk:[taskId],
              unplaced:{taskId:ms}, blocks:{taskId:[[s,e]]} }
   ===================================================================== */
function ts_plan_(input) {
  const step = input.step || 15 * 60000;
  const occ = input.busy.map(b => [b[0], b[1]]);
  const overlaps = (s, e) => occ.some(o => o[0] < e && s < o[1]);
  const inWindows = (w, s, e) => w.some(x => x[0] <= s && e <= x[1]);
  const free = (windows, from) => {             // free segments of windows after `from`, minus occupied
    const segs = [];
    windows.forEach(w => {
      let parts = [[Math.max(w[0], from), w[1]]];
      occ.forEach(o => {
        const next = [];
        parts.forEach(p => {
          if (o[1] <= p[0] || o[0] >= p[1]) { next.push(p); return; }
          if (o[0] > p[0]) next.push([p[0], o[0]]);
          if (o[1] < p[1]) next.push([o[1], p[1]]);
        });
        parts = next;
      });
      parts.forEach(p => { if (p[1] - p[0] >= step) segs.push(p); });
    });
    return segs.sort((a, b) => a[0] - b[0]);
  };
  const ceilStep = ms => Math.ceil(ms / step) * step;
  const floorStep = ms => Math.floor(ms / step) * step;

  const byTask = {}; (input.existing || []).forEach(ev => { (byTask[ev.taskId] = byTask[ev.taskId] || []).push(ev); });
  const keep = {}, leftover = [], blocks = {}, unplaced = {}, atRisk = [];
  const taskIds = {}; input.tasks.forEach(t => { taskIds[t.id] = true; });
  Object.keys(byTask).forEach(tid => { if (!taskIds[tid]) byTask[tid].forEach(ev => leftover.push(ev)); });

  // 1. keep valid existing blocks (incremental mode)
  input.tasks.forEach(t => {
    blocks[t.id] = [];
    let kept = 0;
    (byTask[t.id] || []).slice().sort((a, b) => a.start - b.start).forEach(ev => {
      const dur = ev.end - ev.start;
      if (input.mode !== 'full' && ev.start >= input.now && inWindows(t.windows, ev.start, ev.end) &&
          !overlaps(ev.start, ev.end) && kept + dur <= t.remaining + step / 2) {
        occ.push([ev.start, ev.end]); kept += dur; keep[ev.id] = true; blocks[t.id].push([ev.start, ev.end, ev.id]);
      } else leftover.push(ev);
    });
    t._need = Math.max(0, t.remaining - kept);
  });

  // 2. place what is still needed, most urgent task first, earliest free time first
  const created = [];
  input.tasks.forEach(t => {
    let need = t._need, guard = 0;
    while (need > 0 && guard++ < 200) {
      const want = Math.min(Math.max(ceilStep(need), 0), t.maxBlock);
      const minLen = Math.min(t.minBlock, ceilStep(need));
      const seg = free(t.windows, ceilStep(input.now)).find(p => p[1] - p[0] >= minLen);
      if (!seg) break;
      const len = Math.min(want, floorStep(seg[1] - seg[0]));
      occ.push([seg[0], seg[0] + len]);
      created.push({ taskId: t.id, start: seg[0], end: seg[0] + len });
      blocks[t.id].push([seg[0], seg[0] + len, null]);
      need -= len;
    }
    if (need > 0) unplaced[t.id] = need;
  });

  // 3. fill free time in the next 24 h (e.g. left by a finished task) by pulling a later block
  //    of the most urgent task that fits; at most `pullLimit` moves per run, so the plan stays stable
  const updates = [];
  if (input.mode !== 'full') {
    let pulls = 0;
    const horizon = input.now + 24 * 3600000;
    input.tasks.forEach(t => {
      if (pulls >= (input.pullLimit || 0)) return;
      const segs = free(t.windows, ceilStep(input.now)).filter(p => p[0] < horizon);
      let later = null, seg = null;
      blocks[t.id].filter(b => b[2]).sort((a, b) => a[0] - b[0]).some(b => {
        seg = segs.find(p => b[0] >= p[0] + 3600000 && b[1] - b[0] <= p[1] - p[0]);
        if (seg) { later = b; return true; } return false;
      });
      if (!later) return;
      const len = later[1] - later[0];
      const i = occ.findIndex(o => o[0] === later[0] && o[1] === later[1]); if (i > -1) occ.splice(i, 1);
      occ.push([seg[0], seg[0] + len]);
      updates.push({ id: later[2], start: seg[0], end: seg[0] + len });
      later[0] = seg[0]; later[1] = seg[0] + len; pulls++;
    });
  }

  // 4. reuse leftover events for new blocks (update instead of delete + create)
  const create = [], remove = [];
  const pool = leftover.filter(ev => ev.start >= input.now);
  created.forEach(c => {
    const i = pool.findIndex(ev => ev.taskId === c.taskId);       // same task: just move it (1 write)
    if (i > -1) { const ev = pool.splice(i, 1)[0]; updates.push({ id: ev.id, start: c.start, end: c.end, taskId: c.taskId }); }
    else create.push(c);
  });
  pool.forEach(ev => remove.push(ev.id));

  // 5. at risk = cannot be finished before the end of the due day
  input.tasks.forEach(t => {
    const lastEnd = Math.max.apply(null, [0].concat(blocks[t.id].map(b => b[1])));
    if (t.dueEnd && (unplaced[t.id] || lastEnd > t.dueEnd)) atRisk.push(t.id);
  });
  return { update: updates, create, remove, atRisk, unplaced, blocks };
}

/* =====================================================================
   Calendar side
   ===================================================================== */
function ts_myCal_(s) {
  let cal = s.calendarId ? CalendarApp.getCalendarById(s.calendarId) : null;
  if (!cal) {
    cal = CalendarApp.getCalendarsByName(TS.CAL_NAME)[0] ||
      CalendarApp.createCalendar(TS.CAL_NAME, { color: CalendarApp.Color.TURQUOISE, summary: 'Task blocks planned by My Steps' });
    s.calendarId = cal.getId(); ts_saveSettings_(s);
  }
  return cal;
}
function ts_rank_(t) {
  const pr = { High: 0, Medium: 1, Low: 2 }[t.Priority]; const due = t['Due date'] instanceof Date ? t['Due date'].getTime() : 9e15;
  return [String(t['Start now'] || '').toLowerCase() === 'do now' ? 0 : 1, pr === undefined ? 3 : pr, due];
}
function ts_cmp_(a, b) { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; }

/** Main entry: plan and write the "My Steps" calendar. mode: 'incremental' | 'full' */
function ts_schedule_(mode, source) {
  const t0 = Date.now();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) { CacheService.getScriptCache().put('ts_rerun', '1', 600); return { skipped: true }; }
  let writes = 0, status;
  try {
    const s = ts_settings_(), me = TT.ADMIN_EMAIL.toLowerCase();
    const cal = ts_myCal_(s), main = CalendarApp.getDefaultCalendar();
    const now = Math.ceil(Date.now() / 300000) * 300000;               // next 5 minutes
    const today = ts_dayStart_(new Date());
    const horizonEnd = ts_addDays_(today, s.horizonDays + 1);

    // busy time = main calendar (not all-day, not declined)
    const busy = main.getEvents(new Date(now - 3600000), horizonEnd)
      .filter(e => !e.isAllDayEvent() && e.getMyStatus() !== CalendarApp.GuestStatus.NO)
      .map(e => [e.getStartTime().getTime(), e.getEndTime().getTime()]);

    // my blocks
    const all = cal.getEvents(ts_addDays_(today, -TS.PAST_DAYS), horizonEnd).map(e => ({
      ev: e, id: e.getId(), taskId: e.getTag(TS.TAG) || '', pinned: e.getTag(TS.PIN) === '1', now: e.getTag(TS.NOW) === '1',
      start: e.getStartTime().getTime(), end: e.getEndTime().getTime()
    })).filter(x => x.taskId);

    // tasks to schedule
    const T = tt_read_(TT.SHEETS.tasks), H = T.headers, c = h => H.indexOf(h);
    const rows = T.rows.map((r, i) => { const o = { _row: i + 2 }; H.forEach((h, j) => { o[h] = r[j]; }); return o; });
    const open = rows.filter(t => String(t.ID).trim() && tt_owner_(t.Owner) === me && t.Status !== 'Completed' &&
      String(t['Auto schedule'] || '').toUpperCase() === 'YES' && Number(t['Est hours']) > 0);
    const openIds = {}; open.forEach(t => { openIds[t.ID] = t; });

    // blocks of tasks that are done / switched off: shorten the running one, drop future ones
    all.forEach(b => {
      if (openIds[b.taskId]) return;
      if (b.start < now && b.end > now) { b.ev.setTime(new Date(b.start), new Date(now)); writes++; }
      else if (b.start >= now) { b.ev.deleteEvent(); writes++; b.gone = true; }
    });

    // "Do now": a pinned block starting now, pushing everything else
    open.filter(t => String(t['Start now'] || '').toLowerCase() === 'do now').forEach(t => {
      const running = all.some(b => b.taskId === t.ID && b.start <= now && b.end > now);
      if (running) return;
      const spent = all.filter(b => b.taskId === t.ID && b.end <= now).reduce((a, b) => a + b.end - b.start, 0);
      const len = Math.min(Math.max(Number(t['Est hours']) * 3600000 - spent, s.minBlock * 60000), s.maxBlock * 60000);
      const start = Math.floor(Date.now() / 300000) * 300000;
      const e = cal.createEvent(String(t.Task), new Date(start), new Date(start + len), { description: ts_desc_(t) });
      e.setTag(TS.TAG, String(t.ID)); e.setTag(TS.PIN, '1'); e.setTag(TS.NOW, '1'); ts_color_(e, s, t); writes++;
      all.push({ ev: e, id: e.getId(), taskId: String(t.ID), pinned: true, now: true, start, end: start + len });
      T.sh.getRange(t._row, c('Start now') + 1).setValue(''); t['Start now'] = '';   // one block per tap
    });

    // remaining time per task = estimate - time of past / running blocks
    const live = all.filter(b => !b.gone);
    live.filter(b => b.pinned || (b.start < now && b.end > now)).forEach(b => { if (b.end > now) busy.push([b.start, b.end]); });
    const tasks = open.map(t => {
      const used = live.filter(b => b.taskId === t.ID && (b.start < now || b.pinned)).reduce((a, b) => a + (b.end - b.start), 0);
      const cat = ts_catFor_(s, t);
      const due = t['Due date'] instanceof Date ? new Date(t['Due date'].getFullYear(), t['Due date'].getMonth(), t['Due date'].getDate(), 23, 59).getTime() : null;
      return { id: String(t.ID), t, rank: ts_rank_(t), remaining: Math.max(0, Number(t['Est hours']) * 3600000 - used),
        dueEnd: due, windows: ts_windows_(cat, new Date(now), horizonEnd), minBlock: s.minBlock * 60000, maxBlock: s.maxBlock * 60000 };
    }).sort((a, b) => ts_cmp_(a.rank, b.rank));

    const existing = live.filter(b => !b.pinned && b.start >= now).map(b => ({ id: b.id, taskId: b.taskId, start: b.start, end: b.end }));
    const plan = ts_plan_({ now, step: TS.STEP, tasks, busy, existing, mode: mode || 'incremental', pullLimit: TS.PULL_LIMIT });

    // write the differences
    const evById = {}; live.forEach(b => { evById[b.id] = b.ev; });
    const taskById = {}; tasks.forEach(x => { taskById[x.id] = x.t; });
    plan.update.forEach(u => {
      const e = evById[u.id]; if (!e) return;
      e.setTime(new Date(u.start), new Date(u.end)); writes++;
    });
    plan.create.forEach(c2 => {
      const t = taskById[c2.taskId];
      const e = cal.createEvent(String(t.Task), new Date(c2.start), new Date(c2.end), { description: ts_desc_(t) });
      e.setTag(TS.TAG, c2.taskId); ts_color_(e, s, t); writes += 2;
    });
    plan.remove.forEach(id => { const e = evById[id]; if (e) { e.deleteEvent(); writes++; } });

    // status for the app
    const next = {};
    Object.keys(plan.blocks).forEach(id => { const f = plan.blocks[id].map(b => b[0]).filter(x => x >= now).sort()[0]; if (f) next[id] = ts_iso_(f); });
    live.filter(b => b.pinned && b.end > now).forEach(b => { if (!next[b.taskId] || ts_iso_(b.start) < next[b.taskId]) next[b.taskId] = ts_iso_(Math.max(b.start, now)); });
    const doingNow = live.filter(b => b.now && b.start <= Date.now() && b.end > Date.now()).map(b => b.taskId);
    const overTime = tasks.filter(x => x.remaining === 0).map(x => x.id);   // planned time all used, task still open
    status = { lastRun: ts_iso_(Date.now()), mode: mode || 'incremental', atRisk: plan.atRisk, doingNow: doingNow, overTime: overTime,
      unplaced: Object.keys(plan.unplaced).reduce((o, k) => { o[k] = Math.round(plan.unplaced[k] / 60000); return o; }, {}),
      next: next, writes: writes };
    PropertiesService.getScriptProperties().setProperty('ts_status', JSON.stringify(status));
  } finally { lock.releaseLock(); }
  ts_logUsage_(source || 'app', (Date.now() - t0) / 1000, writes);
  if (CacheService.getScriptCache().get('ts_rerun')) { CacheService.getScriptCache().remove('ts_rerun'); return ts_schedule_('incremental', 'rerun'); }
  return status;
}
function ts_desc_(t) {
  return 'My Steps task' + (t.Objective ? '\nObjective: ' + t.Objective : '') + (t.Category ? '\nCategory: ' + t.Category : '') +
    (t['Due date'] instanceof Date ? '\nDue: ' + Utilities.formatDate(t['Due date'], Session.getScriptTimeZone(), 'EEE d MMM') : '') +
    '\nPriority: ' + (t.Priority || '-') + ' · ' + (t['Est hours'] || '?') + ' h';
}
function ts_color_(e, s, t) {
  const i = Math.max(0, s.categories.indexOf(ts_catFor_(s, t)));
  try { e.setColor(CalendarApp.EventColor[TS_COLORS[i % TS_COLORS.length]]); } catch (err) {}
}
function ts_status_() { try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('ts_status') || '{}'); } catch (e) { return {}; } }

/* Drag in the app: move a block and pin it there */
function ts_moveBlock_(eventId, startIso, endIso) {
  const s = ts_settings_(), cal = ts_myCal_(s);
  const e = cal.getEventById(eventId); if (!e) throw new Error('Block not found');
  e.setTime(new Date(startIso), new Date(endIso)); e.setTag(TS.PIN, '1');
  return ts_schedule_('incremental', 'move');
}
function ts_unpinBlock_(eventId) {
  const s = ts_settings_(), e = ts_myCal_(s).getEventById(eventId); if (!e) throw new Error('Block not found');
  e.deleteTag(TS.PIN); e.deleteTag(TS.NOW);
  return ts_schedule_('incremental', 'unpin');
}

/* Events for the app's calendar page (owner only) */
function ts_calendarData_(fromIso, toIso) {
  const s = ts_settings_(), from = new Date(fromIso), to = new Date(toIso);
  const main = CalendarApp.getDefaultCalendar().getEvents(from, to).filter(e => e.getMyStatus() !== CalendarApp.GuestStatus.NO).map(e => ({
    title: e.getTitle(), start: ts_iso_(e.getStartTime().getTime()), end: ts_iso_(e.getEndTime().getTime()), allDay: e.isAllDayEvent(), kind: 'busy' }));
  const blocks = ts_myCal_(s).getEvents(from, to).filter(e => e.getTag(TS.TAG)).map(e => ({
    id: e.getId(), taskId: e.getTag(TS.TAG), title: e.getTitle(), pinned: e.getTag(TS.PIN) === '1',
    start: ts_iso_(e.getStartTime().getTime()), end: ts_iso_(e.getEndTime().getTime()), kind: 'task' }));
  const windows = [];
  s.categories.forEach((c, i) => ts_windows_(c, from, to).forEach(w => windows.push({ cat: c.name, color: c.color, start: ts_iso_(w[0]), end: ts_iso_(w[1]) })));
  return { main, blocks, windows, bookings: bk_list_(from, to) };
}

/* =====================================================================
   Triggers, usage log, budget
   ===================================================================== */
function ttOnCalendarChange() {
  if (ts_overBudget_()) return;
  const c = CacheService.getScriptCache();
  if (c.get('ts_cal_debounce')) { c.put('ts_rerun', '1', 600); return; }
  c.put('ts_cal_debounce', '1', 60);
  ts_schedule_('incremental', 'calendar');
}
function ttHourlySchedule() { ts_schedule_('incremental', 'hourly'); }
function ttNightlySchedule() { ts_schedule_('full', 'nightly'); }

function ts_logUsage_(source, seconds, writes) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName('Usage log');
  if (!sh) { sh = ss.insertSheet('Usage log'); sh.appendRow(['Date', 'Runs', 'Seconds (all)', 'Seconds (triggers)', 'Calendar writes']); sh.setFrozenRows(1); }
  const day = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const last = sh.getLastRow();
  const trig = ['calendar', 'hourly', 'nightly', 'rerun'].indexOf(source) > -1 ? seconds : 0;
  if (last > 1 && String(sh.getRange(last, 1).getDisplayValue()) === day) {
    const v = sh.getRange(last, 2, 1, 4).getValues()[0];
    sh.getRange(last, 2, 1, 4).setValues([[v[0] + 1, Math.round((v[1] + seconds) * 10) / 10, Math.round((v[2] + trig) * 10) / 10, v[3] + writes]]);
  } else sh.appendRow([day, 1, Math.round(seconds * 10) / 10, Math.round(trig * 10) / 10, writes]);
}
function ts_usageToday_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Usage log'); if (!sh || sh.getLastRow() < 2) return { runs: 0, seconds: 0, trigger: 0, writes: 0 };
  const v = sh.getRange(sh.getLastRow(), 1, 1, 5).getDisplayValues()[0];
  if (v[0] !== Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd')) return { runs: 0, seconds: 0, trigger: 0, writes: 0 };
  return { runs: Number(v[1]), seconds: Number(v[2]), trigger: Number(v[3]), writes: Number(v[4]) };
}
function ts_overBudget_() { return ts_usageToday_().trigger > TS.DAILY_TRIGGER_BUDGET_S; }

/* =====================================================================
   ONE-TIME SETUP – run from the editor: select ttSetupScheduler, click Run
   ===================================================================== */
function ttSetupScheduler() {
  const s = ts_settings_(); ts_seedGoalMap_(s); ts_saveSettings_(s);
  ts_myCal_(s);
  // add the two task columns if missing
  const T = tt_read_(TT.SHEETS.tasks);
  ['Auto schedule', 'Time category'].forEach(h => {
    if (T.headers.indexOf(h) < 0) { T.sh.getRange(1, T.sh.getLastColumn() + 1).setValue(h); T.headers.push(h); }
  });
  // triggers (replaces any older copies)
  const mine = ['ttOnCalendarChange', 'ttHourlySchedule', 'ttNightlySchedule'];
  ScriptApp.getProjectTriggers().forEach(t => { if (mine.indexOf(t.getHandlerFunction()) > -1) ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('ttOnCalendarChange').forUserCalendar(Session.getEffectiveUser().getEmail()).onEventUpdated().create();
  ScriptApp.newTrigger('ttHourlySchedule').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('ttNightlySchedule').timeBased().atHour(2).everyDays(1).create();
  bk_sheet_();
  Logger.log('My Steps scheduler is set up. Calendar: ' + s.calendarId);
}

/* Stop Reclaim / Google Tasks: copy the Reclaim flags to "Auto schedule",
   take the tasks out of Google Tasks (one last sync), then remove the sync triggers. */
function ttSwitchFromReclaim() {
  const T = tt_read_(TT.SHEETS.tasks), H = T.headers, c = h => H.indexOf(h);
  if (c('Auto schedule') < 0) throw new Error('Run ttSetupScheduler first');
  let n = 0;
  T.rows.forEach((r, i) => {
    if (String(r[c('Reclaim')]).toUpperCase() === 'YES' && r[c('Status')] !== 'Completed') {
      T.sh.getRange(i + 2, c('Auto schedule') + 1).setValue('YES');
      T.sh.getRange(i + 2, c('Reclaim') + 1).setValue('NOT YET'); n++;
    }
  });
  SpreadsheetApp.flush();
  try { sendTasksToGoogleTasks(); } catch (e) { Logger.log('Last Google Tasks sync failed: ' + e); }
  ScriptApp.getProjectTriggers().forEach(t => {
    if (['sendTasksToGoogleTasks', 'retryDoNow'].indexOf(t.getHandlerFunction()) > -1) ScriptApp.deleteTrigger(t);
  });
  const s = ts_settings_(); s.reclaimSync = false; ts_saveSettings_(s);
  ts_schedule_('full', 'switch');
  Logger.log(n + ' task(s) moved from Reclaim to My Steps scheduling. Google Tasks sync triggers removed.');
}
