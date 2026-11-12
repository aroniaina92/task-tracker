/**
 * TASK TRACKER API
 * ================
 * Add this file to the Apps Script project INSIDE Task_Tracker_AppSheet
 * (the one that already contains your Google Tasks / Reclaim sync).
 *
 * The phone app (GitHub Pages) talks to this file through doPost().
 * Because it runs in the same project, as you, it can start your sync
 * (sendTasksToGoogleTasks) directly after a change.
 *
 * Deploy: Deploy > Manage deployments > Edit > New version
 *         (Execute as: Me, Who has access: Anyone)
 * The /exec URL goes into config.js of the app.
 *
 * Accounts: use the sheet menu "Task Tracker > Add or reset a user".
 */

const TT = {
  // Tasks/goals/categories/objectives with an EMPTY Owner belong to this account.
  ADMIN_EMAIL: 'aroofalinirina@gmail.com', // <- put your email here (in Apps Script only, not in GitHub)
  SESSION_DAYS: 90,
  HASH_ROUNDS: 400,
  SHEETS: { tasks: 'Tasks', goals: 'Goals', categories: 'Categories', objectives: 'Objectives', users: 'Users', ideas: 'Ideas' },
  DATE_COLS: ['Scheduled date', 'Due date'],
  NUM_COLS: ['Energy', 'Est hours'],
  BOOL_COLS: ['Today'],
  WRITABLE: ['Main goal', 'Category', 'Objective', 'Task', 'Priority', 'Energy', 'Context',
    'Scheduled date', 'Due date', 'Est hours', 'Status', 'Notes', 'Dependencies', 'Waiting on',
    'Today', 'Reclaim', 'Start now'],
  // Only admins may use these (your sync runs as YOU: other users' tasks
  // would otherwise land in your Google Tasks / Reclaim).
  ADMIN_ONLY: ['Reclaim', 'Start now']
};

/* =====================================================================
   HTTP entry point
   ===================================================================== */
function doPost(e) {
  let out;
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    out = tt_route_(req);
  } catch (err) {
    out = { ok: false, error: String((err && err.message) || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

function tt_route_(req) {
  if (req.action === 'login') return tt_login_(req.email, req.password);
  const user = tt_session_(req.token);
  if (!user) return { ok: false, error: 'AUTH' };
  switch (req.action) {
    case 'data':     return { ok: true, data: tt_data_(user) };
    case 'save':     return { ok: true, data: tt_save_(user, req.task || {}) };
    case 'delete':   return { ok: true, data: tt_delete_(user, req.id) };
    case 'addItem':  return { ok: true, data: tt_addItem_(user, req.kind, req.item || {}) };
    case 'saveIdea': return { ok: true, data: tt_saveIdea_(user, req.idea || {}) };
    case 'deleteIdea': return { ok: true, data: tt_deleteIdea_(user, req.id) };
    case 'resetPreview': return { ok: true, text: ttResetPreview(req.kind, JSON.stringify({ name: req.name, owner: user.email })) };
    case 'reset': {
      if (['objective', 'category', 'goal'].indexOf(req.kind) < 0) return { ok: false, error: 'Unknown reset' };
      const msg = tt_reset_(req.kind, req.name, user.email, user.role === 'admin');
      return { ok: true, text: msg, data: tt_data_(user) };
    }
    case 'resetAll': {
      const n = tt_resetAll_(user.email, !!req.alsoGoals, user.role === 'admin');
      return { ok: true, text: n + ' task(s) removed' + (req.alsoGoals ? ', goals removed too.' : '. Goals kept.'), data: tt_data_(user) };
    }
    case 'sync':
      if (user.role !== 'admin') return { ok: false, error: 'Only the owner can sync with Reclaim' };
      sendTasksToGoogleTasks(); // from your sync script
      return { ok: true };
    case 'password': tt_changePassword_(user, req.oldPassword, req.newPassword); return { ok: true };
    case 'logout':   PropertiesService.getScriptProperties().deleteProperty('tt_s_' + req.token); return { ok: true };
    default:         return { ok: false, error: 'Unknown action' };
  }
}

/* =====================================================================
   Accounts & sessions
   ===================================================================== */
function tt_usersSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(TT.SHEETS.users);
  if (!sh) {
    sh = ss.insertSheet(TT.SHEETS.users);
    sh.getRange(1, 1, 1, 6).setValues([['Email', 'Name', 'Role', 'Salt', 'Hash', 'Created']]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function tt_findUser_(email) {
  email = String(email || '').trim().toLowerCase();
  const sh = tt_usersSheet_();
  const rows = sh.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim().toLowerCase() === email) {
      return { row: i + 1, email: email, name: rows[i][1], role: String(rows[i][2] || 'user').trim().toLowerCase(), salt: String(rows[i][3]), hash: String(rows[i][4]) };
    }
  }
  return null;
}

function tt_hash_(password, salt) {
  let h = String(password).trim();
  for (let i = 0; i < TT.HASH_ROUNDS; i++) {
    h = Utilities.base64Encode(Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256, salt + ':' + h, Utilities.Charset.UTF_8));
  }
  // "h_" prefix: a value starting with + or = would be read as a formula by Sheets
  return 'h_' + h;
}

function tt_login_(email, password) {
  const cache = CacheService.getScriptCache();
  const key = 'tt_fail_' + String(email || '').toLowerCase();
  const fails = Number(cache.get(key) || 0);
  if (fails >= 5) return { ok: false, error: 'Too many attempts. Try again in 10 minutes.' };
  const u = tt_findUser_(email);
  if (!u || !u.hash || tt_hash_(password, u.salt) !== u.hash) {
    cache.put(key, String(fails + 1), 600);
    return { ok: false, error: 'Wrong email or password' };
  }
  cache.remove(key);
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  const props = PropertiesService.getScriptProperties();
  tt_cleanSessions_(props);
  props.setProperty('tt_s_' + token, JSON.stringify({ email: u.email, exp: Date.now() + TT.SESSION_DAYS * 864e5 }));
  return { ok: true, token: token, user: { email: u.email, name: u.name, role: u.role } };
}

function tt_session_(token) {
  if (!token) return null;
  const raw = PropertiesService.getScriptProperties().getProperty('tt_s_' + token);
  if (!raw) return null;
  const s = JSON.parse(raw);
  if (s.exp < Date.now()) return null;
  const u = tt_findUser_(s.email);
  return u ? { email: u.email, name: u.name, role: u.role } : null;
}

function tt_cleanSessions_(props) {
  const all = props.getProperties();
  Object.keys(all).forEach(k => {
    if (k.indexOf('tt_s_') === 0) {
      try { if (JSON.parse(all[k]).exp < Date.now()) props.deleteProperty(k); } catch (e) { props.deleteProperty(k); }
    }
  });
}

function tt_setPassword_(email, name, role, password) {
  const sh = tt_usersSheet_();
  const salt = 's_' + Utilities.getUuid();
  const hash = tt_hash_(password, salt);
  const u = tt_findUser_(email);
  const row = [String(email).trim().toLowerCase(), name || (u && u.name) || '', role || (u && u.role) || 'user', salt, hash, new Date()];
  const r = u ? u.row : sh.getLastRow() + 1;
  sh.getRange(r, 1, 1, 5).setNumberFormat('@');   // store as plain text, never as formula
  sh.getRange(r, 1, 1, 6).setValues([row]);
  SpreadsheetApp.flush();
}

/* Menu: check a login directly in the sheet, to find out why it fails */
function ttMenuTestLogin() {
  const ui = SpreadsheetApp.getUi();
  const e = ui.prompt('Test a login', 'Email:', ui.ButtonSet.OK_CANCEL); if (e.getSelectedButton() !== ui.Button.OK) return;
  const p = ui.prompt('Test a login', 'Password:', ui.ButtonSet.OK_CANCEL); if (p.getSelectedButton() !== ui.Button.OK) return;
  const u = tt_findUser_(e.getResponseText());
  if (!u) { ui.alert('No user with this email in the Users tab.'); return; }
  if (String(u.hash).indexOf('h_') !== 0) { ui.alert('This user was saved with the old format. Use "Add or reset a user" to set the password again.'); return; }
  ui.alert(tt_hash_(p.getResponseText(), u.salt) === u.hash ? 'OK: this email and password work.' : 'Wrong password for ' + u.email + '.');
}

function tt_changePassword_(user, oldPw, newPw) {
  const u = tt_findUser_(user.email);
  if (!u || tt_hash_(oldPw, u.salt) !== u.hash) throw new Error('Current password is wrong');
  if (!newPw || String(newPw).length < 8) throw new Error('New password: at least 8 characters');
  tt_setPassword_(u.email, u.name, u.role, newPw);
}

/* Sheet menu to add users (no password is ever stored in plain text) */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Task Tracker')
    .addItem('Add or reset a user', 'ttMenuAddUser')
    .addItem('Test a login', 'ttMenuTestLogin')
    .addSeparator()
    .addItem('Reset the tasks of an objective…', 'ttMenuResetObjective')
    .addItem('Reset the objectives of a category…', 'ttMenuResetCategory')
    .addItem('Reset the categories of a goal…', 'ttMenuResetGoal')
    .addItem('Reset everything…', 'ttMenuResetAll')
    .addToUi();
}

function ttMenuAddUser() {
  const ui = SpreadsheetApp.getUi();
  const ask = (q) => { const r = ui.prompt('Task Tracker', q, ui.ButtonSet.OK_CANCEL); return r.getSelectedButton() === ui.Button.OK ? r.getResponseText().trim() : null; };
  const email = ask('Email of the user:'); if (!email) return;
  const name = ask('Name (shown in the app):'); if (name === null) return;
  const role = ask('Role: type "admin" (you, uses Reclaim) or "user":'); if (role === null) return;
  const pw = ask('Temporary password (at least 8 characters). They can change it in the app:'); if (!pw) return;
  if (pw.length < 8) { ui.alert('Password too short.'); return; }
  tt_setPassword_(email, name, role === 'admin' ? 'admin' : 'user', pw);
  ui.alert('Saved. ' + email + ' can now log in.');
}

/* =====================================================================
   Data
   ===================================================================== */
function tt_read_(name) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error('Sheet "' + name + '" not found');
  const values = sh.getDataRange().getValues();
  const headers = values.shift().map(h => String(h).trim());
  if (headers.indexOf('Owner') < 0) {           // add the Owner column once, at the end
    sh.getRange(1, headers.length + 1).setValue('Owner');
    headers.push('Owner');
    values.forEach(r => r.push(''));
  }
  return { sh: sh, headers: headers, rows: values };
}

function tt_owner_(v) { return String(v || '').trim().toLowerCase() || TT.ADMIN_EMAIL.toLowerCase(); }
function tt_mine_(user, ownerValue) { return tt_owner_(ownerValue) === user.email; }

function tt_fmt_(v, tz, withTime) {
  if (v instanceof Date) return Utilities.formatDate(v, tz, withTime ? "yyyy-MM-dd'T'HH:mm:ss" : 'yyyy-MM-dd');
  return v;
}

function tt_list_(user, name) {
  const t = tt_read_(name);
  const oc = t.headers.indexOf('Owner');
  return t.rows
    .filter(r => String(r[0]).trim() !== '' && tt_mine_(user, r[oc]))
    .map(r => { const o = {}; t.headers.forEach((h, i) => { if (h !== 'Owner') o[h] = r[i]; }); return o; });
}

function tt_data_(user) {
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const t = tt_read_(TT.SHEETS.tasks);
  const oc = t.headers.indexOf('Owner');
  const tasks = [];
  t.rows.forEach(r => {
    if (!tt_mine_(user, r[oc])) return;
    const o = {};
    t.headers.forEach((h, i) => { if (h !== 'Owner') o[h] = tt_fmt_(r[i], tz, h === 'Completed on'); });
    if (String(o.ID || '').trim() === '' || String(o.Task || '').trim() === '') return;
    tasks.push(o);
  });
  return {
    tasks: tasks,
    goals: tt_list_(user, TT.SHEETS.goals),
    categories: tt_list_(user, TT.SHEETS.categories),
    objectives: tt_list_(user, TT.SHEETS.objectives),
    ideas: tt_ideas_(user, tz),
    user: user,
    today: Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd'),
    serverTime: Utilities.formatDate(new Date(), tz, "yyyy-MM-dd'T'HH:mm:ss")
  };
}

function tt_coerce_(h, v) {
  if (v === null || v === undefined) return '';
  if (TT.DATE_COLS.indexOf(h) > -1) {
    if (!v) return '';
    const p = String(v).slice(0, 10).split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2]);
  }
  if (TT.NUM_COLS.indexOf(h) > -1) return v === '' ? '' : Number(v);
  if (TT.BOOL_COLS.indexOf(h) > -1) return v === true || String(v).toUpperCase() === 'TRUE';
  return v;
}

function tt_save_(user, task) {
  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    const t = tt_read_(TT.SHEETS.tasks);
    const col = h => t.headers.indexOf(h);
    const idCol = col('ID'), taskCol = col('Task'), oc = col('Owner');
    let rowIdx = task.ID ? t.rows.findIndex(r => String(r[idCol]) === String(task.ID)) : -1;
    if (rowIdx > -1 && !tt_mine_(user, t.rows[rowIdx][oc])) throw new Error('Not your task');
    const isNew = rowIdx < 0;
    const updates = {};

    TT.WRITABLE.forEach(h => {
      if (!Object.prototype.hasOwnProperty.call(task, h) || col(h) < 0) return;
      if (TT.ADMIN_ONLY.indexOf(h) > -1 && user.role !== 'admin') return;
      updates[h] = tt_coerce_(h, task[h]);
    });

    if (isNew) {
      if (!String(task.Task || '').trim()) throw new Error('Task name is required');
      const ids = {}; t.rows.forEach(r => { ids[String(r[idCol])] = 1; });
      let id; do { id = Utilities.getUuid().replace(/-/g, '').slice(0, 8); } while (ids[id]);
      updates.ID = id;
      updates.Owner = user.email === TT.ADMIN_EMAIL.toLowerCase() ? '' : user.email;
      if (col('Reclaim') > -1 && !updates.Reclaim) updates.Reclaim = 'NOT YET';
      if (col('Today') > -1 && !('Today' in updates)) updates.Today = false;
      if (col('Status') > -1 && !updates.Status) updates.Status = 'Not Started';
      rowIdx = t.rows.findIndex(r => String(r[idCol]).trim() === '' && String(r[taskCol]).trim() === '');
      if (rowIdx < 0) rowIdx = t.rows.length;
    }

    const prevStatus = isNew ? '' : String(t.rows[rowIdx][col('Status')]);
    if ('Status' in updates && col('Completed on') > -1) {
      if (updates.Status === 'Completed' && prevStatus !== 'Completed') {
        updates['Completed on'] = new Date();
        if (col('Start now') > -1) updates['Start now'] = '';
        if (col('Today') > -1) updates.Today = false;
      }
      if (updates.Status !== 'Completed' && prevStatus === 'Completed') updates['Completed on'] = '';
    }

    const sheetRow = rowIdx + 2;
    Object.keys(updates).forEach(h => t.sh.getRange(sheetRow, col(h) + 1).setValue(updates[h]));
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  return tt_data_(user);
}

function tt_delete_(user, id) {
  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    const t = tt_read_(TT.SHEETS.tasks);
    const idCol = t.headers.indexOf('ID'), oc = t.headers.indexOf('Owner');
    const i = t.rows.findIndex(r => String(r[idCol]) === String(id));
    if (i < 0) throw new Error('Task not found');
    if (!tt_mine_(user, t.rows[i][oc])) throw new Error('Not your task');
    tt_clearTaskRows_(t.sh, [i + 2], t.headers.length);
  } finally {
    lock.releaseLock();
  }
  return tt_data_(user);
}

/* kind: 'goals' | 'categories' | 'objectives' */
function tt_addItem_(user, kind, item) {
  if (['goals', 'categories', 'objectives'].indexOf(kind) < 0) throw new Error('Unknown list');
  const t = tt_read_(TT.SHEETS[kind]);
  const name = String(item.Name || '').trim();
  if (!name) throw new Error('Name is required');
  const oc = t.headers.indexOf('Owner');
  const exists = t.rows.some(r => String(r[0]).trim() === name && tt_mine_(user, r[oc]));
  if (!exists) {
    item.Owner = user.email === TT.ADMIN_EMAIL.toLowerCase() ? '' : user.email;
    t.sh.appendRow(t.headers.map(h => item[h] || ''));
  }
  return tt_data_(user);
}

/* =====================================================================
   Ideas (brainstorming page)
   ===================================================================== */
function tt_ideasSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(TT.SHEETS.ideas);
  if (!sh) {
    sh = ss.insertSheet(TT.SHEETS.ideas);
    sh.getRange(1, 1, 1, 9).setValues([['ID', 'Owner', 'Title', 'Text', 'Color', 'Pinned', 'Goal', 'Created', 'Updated']]);
    sh.setFrozenRows(1);
  }
  return sh;
}
function tt_ideas_(user, tz) {
  const sh = tt_ideasSheet_(), v = sh.getDataRange().getValues(), H = v.shift();
  return v.filter(r => String(r[0]).trim() && tt_mine_(user, r[1])).map(r => {
    const o = {}; H.forEach((h, i) => { if (h !== 'Owner') o[h] = tt_fmt_(r[i], tz, true); }); return o;
  });
}
function tt_saveIdea_(user, idea) {
  const lock = LockService.getScriptLock(); lock.waitLock(25000);
  try {
    const sh = tt_ideasSheet_(), v = sh.getDataRange().getValues(), H = v[0];
    const text = String(idea.Text || '').trim();
    if (!text) throw new Error('The idea is empty');
    const now = new Date();
    let r = idea.ID ? v.findIndex((row, i) => i > 0 && String(row[0]) === String(idea.ID)) : -1;
    if (r > 0 && !tt_mine_(user, v[r][1])) throw new Error('Not your idea');
    const row = r > 0 ? v[r].slice() : H.map(() => '');
    const set = (h, val) => { const c = H.indexOf(h); if (c > -1) row[c] = val; };
    if (r < 0) {
      set('ID', Utilities.getUuid().replace(/-/g, '').slice(0, 8));
      set('Owner', user.email === TT.ADMIN_EMAIL.toLowerCase() ? '' : user.email);
      set('Created', now);
    }
    set('Text', text); set('Title', text.split('\n')[0].slice(0, 120));
    if ('Color' in idea) set('Color', idea.Color || '');
    if ('Pinned' in idea) set('Pinned', idea.Pinned === true || String(idea.Pinned).toUpperCase() === 'TRUE');
    if ('Goal' in idea) set('Goal', idea.Goal || '');
    set('Updated', now);
    const rowNum = r > 0 ? r + 1 : sh.getLastRow() + 1;
    // a leading apostrophe stops Sheets reading text that starts with = + - @ as a formula
    const safe = row.map(x => (typeof x === 'string' && /^[=+\-@]/.test(x)) ? "'" + x : x);
    sh.getRange(rowNum, 1, 1, H.length).setValues([safe]);
  } finally { lock.releaseLock(); }
  return tt_data_(user);
}
function tt_deleteIdea_(user, id) {
  const sh = tt_ideasSheet_(), v = sh.getDataRange().getValues();
  const r = v.findIndex((row, i) => i > 0 && String(row[0]) === String(id));
  if (r < 0) throw new Error('Idea not found');
  if (!tt_mine_(user, v[r][1])) throw new Error('Not your idea');
  sh.deleteRow(r + 1);
  return tt_data_(user);
}

/* =====================================================================
   Reset tools (sheet menu "Task Tracker")
   Task rows are CLEARED, not deleted, so the "reclaim" sheet formulas stay
   aligned; the cleared rows are reused for new tasks. Your sync then removes
   the matching Google Tasks (needs the PART 3 patch).
   Objective / category / goal rows are deleted, except the one you keep.
   ===================================================================== */
function tt_clearTaskRows_(sh, rowNums, width) {
  rowNums.sort((a, b) => b - a).forEach(r => sh.getRange(r, 1, 1, width).clearContent());
  SpreadsheetApp.flush();
}
function tt_deleteRows_(sh, rowNums) { rowNums.sort((a, b) => b - a).forEach(r => sh.deleteRow(r)); }
function tt_ownerLabel_(o) { const e = tt_owner_(o); return e === TT.ADMIN_EMAIL.toLowerCase() ? '' : ' (' + e + ')'; }

/* What a reset would remove. kind: objective | category | goal */
function tt_resetPlan_(kind, name, owner) {
  const T = tt_read_(TT.SHEETS.tasks), O = tt_read_(TT.SHEETS.objectives), C = tt_read_(TT.SHEETS.categories);
  const col = (t, h) => t.headers.indexOf(h);
  const same = (t, r) => tt_owner_(r[col(t, 'Owner')]) === owner;
  let cats = [], objs = [];
  if (kind === 'goal') cats = C.rows.map((r, i) => ({ r, i })).filter(x => same(C, x.r) && String(x.r[col(C, 'Main goal')]) === name);
  const catNames = kind === 'category' ? [name] : cats.map(x => String(x.r[0]));
  if (kind !== 'objective') objs = O.rows.map((r, i) => ({ r, i })).filter(x => same(O, x.r) && catNames.indexOf(String(x.r[col(O, 'Category')])) > -1);
  const field = { objective: 'Objective', category: 'Category', goal: 'Main goal' }[kind];
  const tasks = T.rows.map((r, i) => ({ r, i })).filter(x => String(x.r[col(T, 'ID')]).trim() && same(T, x.r) && String(x.r[col(T, field)]) === name);
  return { T, O, C, tasks, objs, cats };
}
function ttResetPreview(kind, key) {
  const k = JSON.parse(key), p = tt_resetPlan_(kind, k.name, k.owner);
  return p.tasks.length + ' task(s)' + (kind !== 'objective' ? ', ' + p.objs.length + ' objective(s)' : '') + (kind === 'goal' ? ', ' + p.cats.length + ' categor(ies)' : '');
}
function ttDoReset(kind, key) { const k = JSON.parse(key); return tt_reset_(kind, k.name, k.owner, true); }
function tt_reset_(kind, name, owner, runSync) {
  const k = { name: name, owner: owner };
  const lock = LockService.getScriptLock(); lock.waitLock(25000);
  let p;
  try {
    p = tt_resetPlan_(kind, k.name, k.owner);
    tt_clearTaskRows_(p.T.sh, p.tasks.map(x => x.i + 2), p.T.headers.length);
    tt_deleteRows_(p.O.sh, p.objs.map(x => x.i + 2));
    tt_deleteRows_(p.C.sh, p.cats.map(x => x.i + 2));
  } finally { lock.releaseLock(); }
  if (runSync) { try { sendTasksToGoogleTasks(); } catch (e) { /* the 10-minute timer will catch up */ } }
  return 'Done: removed ' + p.tasks.length + ' task(s)' +
    (kind !== 'objective' ? ', ' + p.objs.length + ' objective(s)' : '') +
    (kind === 'goal' ? ', ' + p.cats.length + ' categor(ies)' : '') + '. "' + k.name + '" is kept.';
}
function tt_resetDialog_(kind, sheetName, title, explain) {
  const L = tt_read_(sheetName), oc = L.headers.indexOf('Owner');
  const opts = L.rows.filter(r => String(r[0]).trim()).map(r => {
    const key = JSON.stringify({ name: String(r[0]), owner: tt_owner_(r[oc]) });
    return '<option value="' + key.replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '">' +
      String(r[0]).replace(/&/g, '&amp;').replace(/</g, '&lt;') + tt_ownerLabel_(r[oc]) + '</option>';
  }).join('');
  const html = '<div style="font:14px/1.5 Arial,sans-serif;color:#0b2a3a">' +
    '<p style="margin-top:0">' + explain + '</p>' +
    '<select id="s" style="width:100%;padding:8px;font-size:14px">' + opts + '</select>' +
    '<p id="pv" style="color:#a85d00;min-height:20px"></p>' +
    '<button id="go" style="background:#d2452c;color:#fff;border:0;border-radius:8px;padding:10px 16px;font-weight:bold;cursor:pointer">Reset</button> ' +
    '<button onclick="google.script.host.close()" style="border:1px solid #ccc;background:#fff;border-radius:8px;padding:10px 16px;cursor:pointer">Cancel</button>' +
    '<p id="out" style="font-weight:bold"></p></div><script>' +
    'var s=document.getElementById("s"),pv=document.getElementById("pv");' +
    'function prev(){pv.textContent="Will remove: …";google.script.run.withSuccessHandler(function(t){pv.textContent="Will remove: "+t}).ttResetPreview("' + kind + '",s.value)}' +
    's.onchange=prev;prev();' +
    'document.getElementById("go").onclick=function(){if(!confirm("This cannot be undone. Continue?"))return;this.disabled=true;' +
    'document.getElementById("out").textContent="Working…";google.script.run.withSuccessHandler(function(m){document.getElementById("out").textContent=m})' +
    '.withFailureHandler(function(e){document.getElementById("out").textContent="Error: "+e.message}).ttDoReset("' + kind + '",s.value)}' +
    '</script>';
  SpreadsheetApp.getUi().showModalDialog(HtmlService.createHtmlOutput(html).setWidth(460).setHeight(300), title);
}
function ttMenuResetObjective() { tt_resetDialog_('objective', TT.SHEETS.objectives, 'Reset the tasks of an objective', 'Removes <b>all tasks</b> of the objective you choose. The objective itself is kept.'); }
function ttMenuResetCategory()  { tt_resetDialog_('category', TT.SHEETS.categories, 'Reset the objectives of a category', 'Removes <b>all objectives and their tasks</b> in the category you choose. The category itself is kept.'); }
function ttMenuResetGoal()      { tt_resetDialog_('goal', TT.SHEETS.goals, 'Reset the categories of a goal', 'Removes <b>all categories, objectives and tasks</b> of the goal you choose. The goal itself is kept.'); }

function ttMenuResetAll() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('Reset everything', 'This removes ALL your tasks, objectives and categories (ideas are kept).\nType RESET to continue:', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK || r.getResponseText().trim() !== 'RESET') { ui.alert('Nothing was changed.'); return; }
  const alsoGoals = ui.alert('Also remove your goals?', 'Yes = remove goals too. No = keep your goals.', ui.ButtonSet.YES_NO) === ui.Button.YES;
  const n = tt_resetAll_(TT.ADMIN_EMAIL.toLowerCase(), alsoGoals, true);
  ui.alert('Done: ' + n + ' task(s) removed' + (alsoGoals ? ', goals removed too.' : '. Goals kept.'));
}
function tt_resetAll_(me, alsoGoals, runSync) {
  const lock = LockService.getScriptLock(); lock.waitLock(25000);
  let n = 0;
  try {
    const T = tt_read_(TT.SHEETS.tasks), toc = T.headers.indexOf('Owner');
    const rows = T.rows.map((x, i) => ({ x, i })).filter(o => String(o.x[T.headers.indexOf('ID')]).trim() && tt_owner_(o.x[toc]) === me).map(o => o.i + 2);
    n = rows.length; tt_clearTaskRows_(T.sh, rows, T.headers.length);
    [TT.SHEETS.objectives, TT.SHEETS.categories].concat(alsoGoals ? [TT.SHEETS.goals] : []).forEach(name => {
      const L = tt_read_(name), oc = L.headers.indexOf('Owner');
      tt_deleteRows_(L.sh, L.rows.map((x, i) => ({ x, i })).filter(o => String(o.x[0]).trim() && tt_owner_(o.x[oc]) === me).map(o => o.i + 2));
    });
  } finally { lock.releaseLock(); }
  if (runSync) { try { sendTasksToGoogleTasks(); } catch (e) {} }
  return n;
}
