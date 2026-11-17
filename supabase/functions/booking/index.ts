// @ts-nocheck
/**
 * MY STEPS – "booking" Edge Function (public, no login)
 *   slots    free time in your booking hours (only free/busy, never event titles)
 *   request  save a meeting request + email you and the visitor
 *
 * Secrets needed: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, OWNER_ID (your user id in Supabase)
 * Deploy with "Verify JWT" turned OFF (visitors are not logged in).
 */

const SB_URL = Deno.env.get('SUPABASE_URL') || '';
// server key: the legacy service_role key, or the new "secret" key on newer projects
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ||
  (() => { try { const k = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}'); return k.default || Object.values(k)[0] || ''; } catch (_) { return ''; } })();
const GID = Deno.env.get('GOOGLE_CLIENT_ID') || '';
const GSECRET = Deno.env.get('GOOGLE_CLIENT_SECRET') || '';
const OWNER = Deno.env.get('OWNER_ID') || '';
const MIN = 60000, HOUR = 3600000;
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const enc = s => encodeURIComponent(s);
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function sbHeaders(extra = {}) { const h = { apikey: SERVICE, 'Content-Type': 'application/json', ...extra }; if (SERVICE.startsWith('eyJ')) h.Authorization = 'Bearer ' + SERVICE; return h; }
async function db(path, opts = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { method: opts.method || 'GET', headers: sbHeaders({ Prefer: opts.prefer || 'return=representation' }),
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`Database ${r.status}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}
let tok = null;
async function gToken() {
  if (tok && tok.exp > Date.now() + MIN) return tok.v;
  const rows = await db(`google_tokens?owner_id=eq.${OWNER}&select=refresh_token`);
  if (!rows.length) throw new Error('Booking is not available yet.');
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: GID, client_secret: GSECRET, refresh_token: rows[0].refresh_token, grant_type: 'refresh_token' }) });
  const j = await r.json();
  if (!r.ok) throw new Error('Booking is temporarily unavailable.');
  tok = { v: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return tok.v;
}
async function g(url, opts = {}) {
  const r = await fetch(url, { method: opts.method || 'GET', headers: { Authorization: 'Bearer ' + await gToken(), 'Content-Type': 'application/json' },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`Google ${r.status}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}
function b64(str) { const bytes = new TextEncoder().encode(str); let bin = ''; bytes.forEach(b => { bin += String.fromCharCode(b); }); return btoa(bin); }
async function sendMail(fromName, fromEmail, to, subject, html) {
  const mime = [`From: =?UTF-8?B?${b64(fromName)}?= <${fromEmail}>`, `To: ${to}`, `Subject: =?UTF-8?B?${b64(subject)}?=`,
    'MIME-Version: 1.0', 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(html)].join('\r\n');
  await g('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST',
    body: { raw: b64(mime).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') } });
}

/* time zone helpers (same as the owner function) */
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
function windowsOf(cat, fromMs, toMs, tz) {
  const out = [];
  for (let d = dayStartUtc(tz, fromMs); d < toMs; d = addLocalDays(tz, d, 1)) {
    const p = parts(tz, d + 12 * HOUR), dow = new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
    (((cat || {}).slots || {})[dow] || []).forEach(r => {
      const a = hm(r[0]), b = hm(r[1]);
      const s = localToUtc(tz, p.y, p.m, p.d, Math.floor(a / 60), a % 60), e = localToUtc(tz, p.y, p.m, p.d, Math.floor(b / 60), b % 60);
      if (e > s && e > fromMs && s < toMs) out.push([Math.max(s, fromMs), Math.min(e, toMs)]);
    });
  }
  return out;
}
const fmt = (tz, ms, o) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, ...o }).format(new Date(ms));
function whenText(tz, ms, minutes) {
  return fmt(tz, ms, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) + ', ' + fmt(tz, ms, { hour: '2-digit', minute: '2-digit', hour12: false }) +
    '–' + fmt(tz, ms + minutes * MIN, { hour: '2-digit', minute: '2-digit', hour12: false }) + ' (Madagascar time, UTC+3)';
}

async function settings() {
  const rows = await db(`settings?owner_id=eq.${OWNER}&select=data,status,google_connected`);
  const s = (rows[0] || {}).data || {}; s._status = (rows[0] || {}).status || {};
  const B = Object.assign({ enabled: true, category: 'Working', noticeHours: 24, daysAhead: 21, durations: [15, 30, 60], title: 'Meeting', ownerName: 'Aroo' }, s.booking || {});
  return { s, B, tz: s.tz || 'Indian/Antananarivo', connected: (rows[0] || {}).google_connected };
}
/* "My Steps" task blocks that cannot be booked: blocks you placed by hand (pinned), tasks at risk,
   and tasks due within 2 days. Other task blocks and habits stay bookable (they move if you accept). */
async function protectedBlocks(s, tz, from, to) {
  if (!s.calendarId) return [];
  try {
    let items = [], page = '';
    do {
      const r = await g(`https://www.googleapis.com/calendar/v3/calendars/${enc(s.calendarId)}/events?singleEvents=true&maxResults=2500&timeMin=${enc(new Date(from).toISOString())}&timeMax=${enc(new Date(to).toISOString())}${page ? '&pageToken=' + enc(page) : ''}`);
      items = items.concat(r.items || []); page = r.nextPageToken || '';
    } while (page);
    const pr = e => ((e.extendedProperties || {}).private || {});
    const blocks = items.filter(e => e.status !== 'cancelled' && e.start && e.start.dateTime && pr(e).mysteps_task && pr(e).mysteps_done !== '1');
    if (!blocks.length) return [];
    const soonDay = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(addLocalDays(tz, dayStartUtc(tz, Date.now()), 2) + 12 * HOUR));
    const ids = [...new Set(blocks.map(e => pr(e).mysteps_task))];
    let soon = new Set();
    try { soon = new Set((await db(`tasks?owner_id=eq.${OWNER}&status=neq.Completed&due_date=lte.${soonDay}&id=in.(${ids.map(enc).join(',')})&select=id`)).map(t => t.id)); } catch (_) { /* keep pinned protection */ }
    const risk = new Set(((s._status || {}).atRisk || []).map(String));
    return blocks.filter(e => pr(e).mysteps_pin === '1' || soon.has(pr(e).mysteps_task) || risk.has(pr(e).mysteps_task))
      .map(e => [Date.parse(e.start.dateTime), Date.parse(e.end.dateTime)]);
  } catch (_) { return []; }
}
async function freeTime() {
  const { s, B, tz } = await settings();
  const cat = (s.categories || []).find(c => c.name === B.category) || (s.categories || [])[0];
  const from = Math.ceil((Date.now() + B.noticeHours * HOUR) / (15 * MIN)) * 15 * MIN;
  const to = addLocalDays(tz, dayStartUtc(tz, Date.now()), B.daysAhead + 1);
  const fb = await g('https://www.googleapis.com/calendar/v3/freeBusy', { method: 'POST',
    body: { timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString(), items: [{ id: 'primary' }] } });
  const bks = await db(`bookings?owner_id=eq.${OWNER}&status=in.(Pending,Accepted)&end_at=gt.${enc(new Date(from).toISOString())}&select=start_at,end_at`);
  const busy = ((fb.calendars || {}).primary || {}).busy || [];
  const occ = busy.map(b => [Date.parse(b.start), Date.parse(b.end)]).concat(bks.map(b => [Date.parse(b.start_at), Date.parse(b.end_at)]),
    await protectedBlocks(s, tz, from, to));
  const out = [];
  windowsOf(cat, from, to, tz).forEach(w => {
    let ps = [[Math.ceil(w[0] / (15 * MIN)) * 15 * MIN, w[1]]];
    occ.forEach(o => {
      const nx = [];
      ps.forEach(p => {
        if (o[1] <= p[0] || o[0] >= p[1]) { nx.push(p); return; }
        if (o[0] > p[0]) nx.push([p[0], o[0]]);
        if (o[1] < p[1]) nx.push([o[1], p[1]]);
      });
      ps = nx;
    });
    ps.forEach(p => { if (p[1] - p[0] >= 15 * MIN) out.push(p); });
  });
  return { free: out.sort((a, b) => a[0] - b[0]), B, tz };
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    if (!OWNER) throw new Error('Booking is not configured yet.');
    const body = await req.json().catch(() => ({}));
    if (body.action === 'slots') {
      const { B } = await settings();
      if (!B.enabled) return json({ ok: true, enabled: false });
      const { free } = await freeTime();
      return json({ ok: true, enabled: true, ownerName: B.ownerName, title: B.title, durations: B.durations,
        free: free.map(f => [new Date(f[0]).toISOString(), new Date(f[1]).toISOString()]) });
    }
    if (body.action === 'request') {
      const q = body.booking || {};
      if (q.website) return json({ ok: true });                                   // hidden field filled = bot
      const { B, tz } = await settings();
      if (!B.enabled) throw new Error('Booking is closed for now.');
      const name = String(q.name || '').trim().slice(0, 80), email = String(q.email || '').trim().toLowerCase().slice(0, 120);
      const topic = String(q.topic || '').trim().slice(0, 600), minutes = Number(q.minutes), start = Date.parse(q.start), end = start + minutes * MIN;
      if (!name) throw new Error('Please enter your name.');
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Please enter a valid email address.');
      if (!B.durations.includes(minutes)) throw new Error('Please choose a meeting length.');
      if (!(start > 0)) throw new Error('Please choose a time.');
      const pending = await db(`bookings?owner_id=eq.${OWNER}&email=eq.${enc(email)}&status=eq.Pending&select=id`);
      if (pending.length >= 3) throw new Error('You already have pending requests. Please wait for an answer.');
      const todayCount = await db(`bookings?owner_id=eq.${OWNER}&created_at=gt.${enc(new Date(Date.now() - 24 * HOUR).toISOString())}&select=id`);
      if (todayCount.length >= 30) throw new Error('Too many requests today. Please try again tomorrow.');
      const { free } = await freeTime();
      if (!free.some(f => f[0] <= start && end <= f[1])) throw new Error('Sorry, this time is no longer available. Please choose another one.');
      const row = (await db('bookings', { method: 'POST', body: { owner_id: OWNER, name, email, minutes, topic,
        start_at: new Date(start).toISOString(), end_at: new Date(end).toISOString() } }))[0];
      const me = (await db(`profiles?id=eq.${OWNER}&select=email,name`))[0] || {};
      const when = whenText(tz, start, minutes), from = B.ownerName || me.name || 'My Steps';
      try {
        await sendMail('My Steps', me.email, me.email, `Meeting request: ${name} (${minutes} min)`,
          `<p><b>${esc(name)}</b> (${esc(email)}) asks for a <b>${minutes}-minute</b> meeting.</p><p>${esc(when)}</p>` +
          (topic ? `<p>Topic: ${esc(topic)}</p>` : '') + '<p>Open My Steps → Calendar to accept or decline.</p>');
        await sendMail(from, me.email, email, 'Your meeting request to ' + from,
          `<p>Hello ${esc(name)},</p><p>Thank you for your request for a ${minutes}-minute meeting on <b>${esc(when)}</b>.</p>` +
          `<p>I will confirm it as soon as possible. You will receive the Google Meet link by email once it is confirmed.</p><p>Best regards,<br>${esc(from)}</p>`);
      } catch (_) { /* the request is saved even if an email fails */ }
      return json({ ok: true, id: row.id });
    }
    return json({ ok: false, error: 'Unknown action' });
  } catch (e) {
    return json({ ok: false, error: String((e && e.message) || e) });
  }
});
