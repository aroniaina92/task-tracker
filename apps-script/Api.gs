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
  SHEETS: { tasks: 'Tasks', goals: 'Goals', categories: 'Categories', objectives: 'Objectives', users: 'Users' },
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
      return { row: i + 1, email: email, name: rows[i][1], role: String(rows[i][2] || 'user').toLowerCase(), salt: rows[i][3], hash: rows[i][4] };
    }
  }
  return null;
}

function tt_hash_(password, salt) {
  let h = String(password);
  for (let i = 0; i < TT.HASH_ROUNDS; i++) {
    h = Utilities.base64Encode(Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256, salt + ':' + h, Utilities.Charset.UTF_8));
  }
  return h;
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
  const salt = Utilities.getUuid();
  const hash = tt_hash_(password, salt);
  const u = tt_findUser_(email);
  const row = [String(email).trim().toLowerCase(), name || (u && u.name) || '', role || (u && u.role) || 'user', salt, hash, new Date()];
  if (u) sh.getRange(u.row, 1, 1, 6).setValues([row]);
  else sh.appendRow(row);
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
    t.sh.deleteRow(i + 2);
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
