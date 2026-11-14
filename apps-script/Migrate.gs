/* =====================================================================
   MY STEPS – move the Google Sheet data to Supabase (one time)
   + optional daily backup from Supabase back into this sheet.

   Put this file in the SAME Apps Script project as Api.gs / Scheduler.gs.
   Before running:
   1. Every person must have signed in once in the NEW app (so their account exists).
   2. Project Settings (gear) → Script properties → add:
        SUPABASE_URL          https://YOUR-PROJECT-REF.supabase.co
        SUPABASE_SERVICE_KEY  the "secret" (service_role) key from Supabase → Project Settings → API Keys
      These stay private in Apps Script. Never put them in GitHub or in the app.
   3. Run  mgExportToSupabase  (select it in the toolbar, then Run). Read the log.
      Safe to run again: existing rows are updated, not duplicated.
   4. Optional: run  mgSetupDailyBackup  once → every night the Supabase data is copied
      into "Backup …" tabs of this sheet.
   ===================================================================== */

function mg_cfg_() {
  const p = PropertiesService.getScriptProperties();
  const url = (p.getProperty('SUPABASE_URL') || '').replace(/\/+$/, ''), key = p.getProperty('SUPABASE_SERVICE_KEY') || '';
  if (!url || !key) throw new Error('Add SUPABASE_URL and SUPABASE_SERVICE_KEY in Project Settings → Script properties.');
  return { url: url, key: key };
}
function mg_req_(method, path, body, prefer) {
  const c = mg_cfg_();
  const headers = { apikey: c.key, Prefer: prefer || 'return=minimal' };
  if (c.key.indexOf('eyJ') === 0) headers.Authorization = 'Bearer ' + c.key;
  const r = UrlFetchApp.fetch(c.url + '/rest/v1/' + path, { method: method, headers: headers, contentType: 'application/json',
    payload: body === undefined ? undefined : JSON.stringify(body), muteHttpExceptions: true });
  const code = r.getResponseCode(), text = r.getContentText();
  if (code >= 300) throw new Error(method + ' ' + path.split('?')[0] + ' → ' + code + ': ' + text.slice(0, 300));
  return text ? JSON.parse(text) : null;
}
function mg_upsert_(table, rows, conflict) {
  for (let i = 0; i < rows.length; i += 500)
    mg_req_('post', table + '?on_conflict=' + conflict, rows.slice(i, i + 500), 'resolution=merge-duplicates,return=minimal');
  return rows.length;
}
function mg_rows_(name) {                       // [{header: value}] including Owner
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  const v = sh.getDataRange().getValues(), h = v.shift().map(x => String(x).trim());
  return v.map(r => { const o = {}; h.forEach((k, i) => { o[k] = r[i]; }); return o; });
}
const mg_s_ = v => (v === null || v === undefined) ? '' : String(v).trim();
const mg_bool_ = v => v === true || ['TRUE', 'YES', '1'].indexOf(mg_s_(v).toUpperCase()) > -1;
function mg_date_(v, tz) {
  if (v instanceof Date) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  const s = mg_s_(v); return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}
function mg_ts_(v) {
  if (v instanceof Date) return v.toISOString();
  const s = mg_s_(v); if (!s) return null; const d = new Date(s); return isNaN(d) ? null : d.toISOString();
}
function mg_num_(v) { const s = mg_s_(v); if (s === '') return null; const n = Number(s.replace(',', '.')); return isNaN(n) ? null : n; }

function mgExportToSupabase() {
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const me = TT.ADMIN_EMAIL.toLowerCase();
  const profiles = mg_req_('get', 'profiles?select=id,email,role', undefined, 'return=representation');
  const idOf = {}; profiles.forEach(p => { idOf[String(p.email || '').toLowerCase()] = p.id; });
  if (!idOf[me]) throw new Error('No Supabase account for ' + me + ' yet. Sign in once in the new app, then run this again.');
  const missing = {};
  const owner = v => { const e = mg_s_(v).toLowerCase() || me; if (!idOf[e]) { missing[e] = true; return null; } return idOf[e]; };
  const log = [];

  // goals, categories, objectives
  const lists = [['Goals', 'goals', r => ({})], ['Categories', 'categories', r => ({ main_goal: mg_s_(r['Main goal']) || null })],
    ['Objectives', 'objectives', r => ({ category: mg_s_(r['Category']) || null })]];
  lists.forEach(L => {
    const seen = {}, rows = [];
    mg_rows_(L[0]).forEach(r => {
      const o = owner(r.Owner), name = mg_s_(r.Name || r[Object.keys(r)[0]]);
      if (!o || !name || seen[o + '|' + name]) return; seen[o + '|' + name] = true;
      rows.push(Object.assign({ owner_id: o, name: name }, L[2](r)));
    });
    log.push(L[0] + ': ' + mg_upsert_(L[1], rows, 'owner_id,name'));
  });

  // tasks
  const usedIds = {}, tasks = [];
  mg_rows_('Tasks').forEach(r => {
    const o = owner(r.Owner), task = mg_s_(r.Task);
    if (!o || !task) return;
    let id = mg_s_(r.ID) || Utilities.getUuid().slice(0, 8);
    while (usedIds[id]) id = Utilities.getUuid().slice(0, 8);
    usedIds[id] = true;
    const energy = mg_num_(r.Energy), status = mg_s_(r.Status) || 'Not Started';
    tasks.push({
      id: id, owner_id: o, main_goal: mg_s_(r['Main goal']) || null, category: mg_s_(r.Category) || null, objective: mg_s_(r.Objective) || null,
      task: task, priority: mg_s_(r.Priority) || null, energy: energy >= 1 && energy <= 5 ? Math.round(energy) : null,
      context: mg_s_(r.Context) || null, scheduled_date: mg_date_(r['Scheduled date'], tz), due_date: mg_date_(r['Due date'], tz),
      est_hours: mg_num_(r['Est hours']), status: status, notes: mg_s_(r.Notes) || null, dependencies: mg_s_(r.Dependencies) || null,
      waiting_on: mg_s_(r['Waiting on']) || null, today: mg_bool_(r.Today), completed_on: mg_ts_(r['Completed on']),
      start_now: mg_s_(r['Start now']).toLowerCase() === 'do now' ? 'do now' : '',
      auto_schedule: mg_bool_(r['Auto schedule']), time_category: mg_s_(r['Time category'])
    });
  });
  log.push('Tasks: ' + mg_upsert_('tasks', tasks, 'id'));

  // ideas
  const ideas = [];
  mg_rows_('Ideas').forEach(r => {
    const o = owner(r.Owner), text = mg_s_(r.Text) || mg_s_(r.Title);
    if (!o || !text || !mg_s_(r.ID)) return;
    ideas.push({ id: mg_s_(r.ID), owner_id: o, text: text, color: mg_s_(r.Color) || 'sand', pinned: mg_bool_(r.Pinned), goal: mg_s_(r.Goal),
      created_at: mg_ts_(r.Created) || new Date().toISOString(), updated_at: mg_ts_(r.Updated) || new Date().toISOString() });
  });
  log.push('Ideas: ' + mg_upsert_('ideas', ideas, 'id'));

  // meeting requests (all belong to you)
  const bks = [];
  mg_rows_('Bookings').forEach(r => {
    const st = mg_ts_(r.Start), en = mg_ts_(r.End);
    if (!mg_s_(r.ID) || !st || !en) return;
    bks.push({ id: mg_s_(r.ID), owner_id: idOf[me], name: mg_s_(r.Name) || '?', email: mg_s_(r.Email) || '?', minutes: mg_num_(r.Minutes) || 30,
      start_at: st, end_at: en, topic: mg_s_(r.Topic), status: ['Pending', 'Accepted', 'Declined'].indexOf(mg_s_(r.Status)) > -1 ? mg_s_(r.Status) : 'Pending',
      event_id: mg_s_(r['Event ID']) || null, meet_link: mg_s_(r['Meet link']) || null, created_at: mg_ts_(r.Created) || new Date().toISOString() });
  });
  log.push('Meeting requests: ' + mg_upsert_('bookings', bks, 'id'));

  // scheduler settings (time categories, goal map, booking options, the existing "My Steps" calendar)
  if (typeof ts_settings_ === 'function') {
    const s = ts_settings_(); delete s.reclaimSync; delete (s.booking || {}).bookingUrl; s.tz = 'Indian/Antananarivo';
    mg_upsert_('settings', [{ owner_id: idOf[me], data: s }], 'owner_id');
    log.push('Scheduler settings: copied (calendar ' + (s.calendarId ? 'kept' : 'will be created') + ')');
  }
  const miss = Object.keys(missing);
  if (miss.length) log.push('SKIPPED rows of ' + miss.join(', ') + ': sign in once in the new app, then run again.');
  Logger.log(log.join('\n'));
  return log.join('\n');
}

/* ---------- old scheduler off (after the import works) ---------- */
function mgStopOldScheduler() {
  ScriptApp.getProjectTriggers().forEach(t => {
    const f = t.getHandlerFunction();
    if (/^ts_|^tt_|^bk_/.test(f)) { ScriptApp.deleteTrigger(t); Logger.log('Removed trigger ' + f); }
  });
}

/* ---------- daily backup: Supabase → "Backup …" tabs ---------- */
function mgBackupFromSupabase() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const emailOf = {}; mg_req_('get', 'profiles?select=id,email', undefined, 'return=representation').forEach(p => { emailOf[p.id] = p.email; });
  const tables = [['tasks', 'id,owner_id,main_goal,category,objective,task,priority,energy,context,scheduled_date,due_date,est_hours,status,notes,dependencies,waiting_on,today,completed_on,auto_schedule,time_category,created_at,updated_at'],
    ['goals', 'owner_id,name'], ['categories', 'owner_id,name,main_goal'], ['objectives', 'owner_id,name,category'],
    ['ideas', 'id,owner_id,title,text,color,pinned,goal,created_at,updated_at'], ['bookings', 'id,name,email,minutes,start_at,end_at,topic,status,meet_link,created_at']];
  tables.forEach(T => {
    let rows = [], off = 0, page;
    do { page = mg_req_('get', T[0] + '?select=' + T[1] + '&order=' + (T[0] === 'goals' || T[0] === 'categories' || T[0] === 'objectives' ? 'name' : 'created_at') + '&limit=1000&offset=' + off, undefined, 'return=representation');
      rows = rows.concat(page); off += 1000; } while (page.length === 1000);
    const cols = T[1].split(','), name = 'Backup ' + T[0];
    const sh = ss.getSheetByName(name) || ss.insertSheet(name);
    sh.clearContents();
    const out = [cols.map(c => c === 'owner_id' ? 'owner' : c)].concat(rows.map(r => cols.map(c => {
      const v = c === 'owner_id' ? emailOf[r[c]] || r[c] : r[c]; return v === null || v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : v);
    })));
    sh.getRange(1, 1, out.length, cols.length).setNumberFormat('@').setValues(out);
    sh.getRange(1, 1, 1, cols.length).setFontWeight('bold'); sh.setFrozenRows(1);
  });
  ss.getSheetByName('Backup tasks').getRange(1, tables[0][1].split(',').length + 2).setValue('Last backup: ' + new Date());
}
function mgSetupDailyBackup() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'mgBackupFromSupabase').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('mgBackupFromSupabase').timeBased().everyDays(1).atHour(3).create();
  mgBackupFromSupabase();
  Logger.log('Daily backup set (around 03:00). First backup done.');
}
