/**
 * MY STEPS – MEETING REQUESTS (public booking page)
 * =================================================
 * Add this file to the same Apps Script project as Api.gs and Scheduler.gs.
 *
 * - book.html (GitHub Pages) shows your free time inside your booking hours
 *   (Working time by default), with 24 h notice and 3 weeks ahead.
 * - People request 15 / 30 / 60 min. The request is saved in the "Bookings"
 *   sheet (status Pending) and you get an email.
 * - In the app (Calendar page) you Accept or Decline:
 *     Accept  -> event in your main calendar with a Google Meet link,
 *                invitation + confirmation email to the person.
 *     Decline -> polite email: the slot looked free but urgent work came up.
 *
 * Needs the advanced service "Google Calendar API" (Services > + > Google Calendar API)
 * to create the Google Meet link.
 */

const BK = { SHEET: 'Bookings', MAX_PENDING_PER_EMAIL: 3, MAX_NEW_PER_DAY: 30 };
const BK_HEAD = ['ID', 'Created', 'Name', 'Email', 'Minutes', 'Start', 'End', 'Topic', 'Status', 'Event ID', 'Meet link'];

function bk_sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(BK.SHEET);
  if (!sh) { sh = ss.insertSheet(BK.SHEET); sh.getRange(1, 1, 1, BK_HEAD.length).setValues([BK_HEAD]); sh.setFrozenRows(1); }
  return sh;
}
function bk_rows_() {
  const sh = bk_sheet_(), v = sh.getDataRange().getValues(); v.shift();
  return v.map((r, i) => ({ row: i + 2, id: String(r[0]), created: r[1], name: r[2], email: r[3], minutes: Number(r[4]),
    start: r[5] instanceof Date ? r[5].getTime() : new Date(r[5]).getTime(), end: r[6] instanceof Date ? r[6].getTime() : new Date(r[6]).getTime(),
    topic: r[7], status: String(r[8]), eventId: r[9], meet: r[10] })).filter(b => b.id);
}
function bk_esc_(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function bk_when_(ms, minutes) {
  const tz = Session.getScriptTimeZone();
  return Utilities.formatDate(new Date(ms), tz, "EEEE d MMMM yyyy, HH:mm") + '–' +
    Utilities.formatDate(new Date(ms + minutes * 60000), tz, 'HH:mm') + ' (Madagascar time, UTC+3)';
}

/* Free time people can book: booking hours minus your busy time and other requests */
function bk_free_() {
  const s = ts_settings_(), B = s.booking;
  const cat = s.categories.find(c => c.name === B.category) || s.categories[0];
  const from = new Date(Date.now() + B.noticeHours * 3600000);
  const to = ts_addDays_(ts_dayStart_(new Date()), B.daysAhead + 1);
  const busy = CalendarApp.getDefaultCalendar().getEvents(from, to)
    .filter(e => !e.isAllDayEvent() && e.getMyStatus() !== CalendarApp.GuestStatus.NO)
    .map(e => [e.getStartTime().getTime(), e.getEndTime().getTime()])
    .concat(bk_rows_().filter(b => b.status === 'Pending' || b.status === 'Accepted').map(b => [b.start, b.end]));
  const out = [];
  ts_windows_(cat, from, to).forEach(w => {
    let parts = [[Math.ceil(w[0] / 900000) * 900000, w[1]]];
    busy.forEach(o => {
      const next = [];
      parts.forEach(p => {
        if (o[1] <= p[0] || o[0] >= p[1]) { next.push(p); return; }
        if (o[0] > p[0]) next.push([p[0], o[0]]);
        if (o[1] < p[1]) next.push([o[1], p[1]]);
      });
      parts = next;
    });
    parts.forEach(p => { if (p[1] - p[0] >= 15 * 60000) out.push(p); });
  });
  return out.sort((a, b) => a[0] - b[0]);
}
function bk_publicSlots_() {
  const s = ts_settings_(), B = s.booking;
  if (!B.enabled) return { enabled: false };
  return { enabled: true, ownerName: B.ownerName, title: B.title, durations: B.durations, tz: Session.getScriptTimeZone(),
    noticeHours: B.noticeHours, daysAhead: B.daysAhead, free: bk_free_().map(f => [ts_iso_(f[0]), ts_iso_(f[1])]) };
}

/* A visitor sends a request */
function bk_request_(req) {
  const s = ts_settings_(), B = s.booking;
  if (!B.enabled) throw new Error('Booking is closed for now.');
  if (req.website) return { ok: true };                                   // honeypot: bots fill hidden fields
  const name = String(req.name || '').trim().slice(0, 80), email = String(req.email || '').trim().toLowerCase().slice(0, 120);
  const topic = String(req.topic || '').trim().slice(0, 600), minutes = Number(req.minutes);
  if (!name) throw new Error('Please enter your name.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Please enter a valid email address.');
  if (B.durations.indexOf(minutes) < 0) throw new Error('Please choose a meeting length.');
  const start = new Date(req.start).getTime(), end = start + minutes * 60000;
  if (!(start > 0)) throw new Error('Please choose a time.');
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const rows = bk_rows_(), today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
    if (rows.filter(b => b.email === email && b.status === 'Pending').length >= BK.MAX_PENDING_PER_EMAIL) throw new Error('You already have pending requests. Please wait for an answer.');
    if (rows.filter(b => b.created instanceof Date && Utilities.formatDate(b.created, Session.getScriptTimeZone(), 'yyyy-MM-dd') === today).length >= BK.MAX_NEW_PER_DAY) throw new Error('Too many requests today. Please try again tomorrow.');
    if (!bk_free_().some(f => f[0] <= start && end <= f[1])) throw new Error('Sorry, this time is no longer available. Please choose another one.');
    const id = Utilities.getUuid().replace(/-/g, '').slice(0, 10);
    const safe = x => (typeof x === 'string' && /^[=+\-@]/.test(x)) ? "'" + x : x;
    bk_sheet_().appendRow([id, new Date(), safe(name), email, minutes, new Date(start), new Date(end), safe(topic), 'Pending', '', '']);
    const when = bk_when_(start, minutes);
    MailApp.sendEmail({ to: TT.ADMIN_EMAIL, subject: 'Meeting request: ' + name + ' (' + minutes + ' min)', name: 'My Steps',
      htmlBody: '<p><b>' + bk_esc_(name) + '</b> (' + bk_esc_(email) + ') asks for a <b>' + minutes + '-minute</b> meeting.</p><p>' + bk_esc_(when) + '</p>' +
        (topic ? '<p>Topic: ' + bk_esc_(topic) + '</p>' : '') + '<p>Open My Steps → Calendar to accept or decline.</p>' });
    MailApp.sendEmail({ to: email, subject: 'Your meeting request to ' + B.ownerName, name: B.ownerName,
      htmlBody: '<p>Hello ' + bk_esc_(name) + ',</p><p>Thank you for your request for a ' + minutes + '-minute meeting on <b>' + bk_esc_(when) + '</b>.</p>' +
        '<p>I will confirm it as soon as possible. You will receive the Google Meet link by email once it is confirmed.</p><p>Best regards,<br>' + bk_esc_(B.ownerName) + '</p>' });
    return { ok: true, id: id };
  } finally { lock.releaseLock(); }
}

/* Owner: list and decide */
function bk_list_(from, to) {
  return bk_rows_().filter(b => (b.status === 'Pending' && b.end > Date.now()) || (b.status === 'Accepted' && (!from || (b.end > from.getTime() && b.start < to.getTime()))))
    .map(b => ({ id: b.id, name: b.name, email: b.email, minutes: b.minutes, start: ts_iso_(b.start), end: ts_iso_(b.end), topic: b.topic, status: b.status, meet: b.meet }));
}
function bk_decide_(id, accept, bookingUrl) {
  const s = ts_settings_(), B = s.booking, sh = bk_sheet_();
  const b = bk_rows_().find(x => x.id === String(id));
  if (!b) throw new Error('Request not found');
  if (b.status !== 'Pending') throw new Error('This request was already ' + b.status.toLowerCase());
  const when = bk_when_(b.start, b.minutes), col = h => BK_HEAD.indexOf(h) + 1;
  if (accept) {
    const ev = Calendar.Events.insert({
      summary: B.title + ' – ' + b.name, description: (b.topic ? 'Topic: ' + b.topic + '\n\n' : '') + 'Booked through My Steps.',
      start: { dateTime: new Date(b.start).toISOString() }, end: { dateTime: new Date(b.end).toISOString() },
      attendees: [{ email: b.email }],
      conferenceData: { createRequest: { requestId: b.id + '-' + Date.now(), conferenceSolutionKey: { type: 'hangoutsMeet' } } }
    }, 'primary', { conferenceDataVersion: 1, sendUpdates: 'all' });
    const meet = ev.hangoutLink || (ev.conferenceData && ev.conferenceData.entryPoints && ev.conferenceData.entryPoints[0].uri) || '';
    sh.getRange(b.row, col('Status')).setValue('Accepted'); sh.getRange(b.row, col('Event ID')).setValue(ev.id); sh.getRange(b.row, col('Meet link')).setValue(meet);
    MailApp.sendEmail({ to: b.email, subject: 'Confirmed: meeting with ' + B.ownerName, name: B.ownerName,
      htmlBody: '<p>Hello ' + bk_esc_(b.name) + ',</p><p>Our ' + b.minutes + '-minute meeting is confirmed for <b>' + bk_esc_(when) + '</b>.</p>' +
        (meet ? '<p>Google Meet link: <a href="' + meet + '">' + meet + '</a></p>' : '') +
        '<p>You will also receive a calendar invitation.</p><p>See you soon,<br>' + bk_esc_(B.ownerName) + '</p>' });
    try { ts_schedule_('incremental', 'booking'); } catch (e) {}          // move task blocks out of the way
    return { status: 'Accepted', meet: meet };
  }
  sh.getRange(b.row, col('Status')).setValue('Declined');
  MailApp.sendEmail({ to: b.email, subject: 'About your meeting request to ' + B.ownerName, name: B.ownerName,
    htmlBody: '<p>Hello ' + bk_esc_(b.name) + ',</p><p>Thank you for your request for a ' + b.minutes + '-minute meeting on <b>' + bk_esc_(when) + '</b>.</p>' +
      '<p>Although this time appeared available in my schedule, I am unfortunately not able to meet then, because of urgent work that needs my attention.</p>' +
      (bookingUrl ? '<p>Please feel free to choose another time here: <a href="' + bookingUrl + '">' + bookingUrl + '</a></p>' : '') +
      '<p>Thank you for your understanding,<br>' + bk_esc_(B.ownerName) + '</p>' });
  return { status: 'Declined' };
}
