/* Public booking page: shows free time in the owner's booking hours and sends a request. */
(() => {
'use strict';
const CFG = window.TT_CONFIG || {};
const API = CFG.SUPABASE_URL ? CFG.SUPABASE_URL.replace(/\/+$/, '') + '/functions/v1/booking' : CFG.API_URL;
const ACTIONS = CFG.SUPABASE_URL ? { bookingSlots: 'slots', bookingRequest: 'request' } : {};
const OWNER_TZ = 'Indian/Antananarivo';
const ME_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const B = { data: null, minutes: 30, day: null, slot: null, sending: false };

async function call(action, payload) {
  if (!API) return demo(action, payload);
  const r = CFG.SUPABASE_URL
    ? await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: CFG.SUPABASE_ANON_KEY }, body: JSON.stringify(Object.assign({ action: ACTIONS[action] }, payload || {})) })
    : await fetch(API, { method: 'POST', body: JSON.stringify(Object.assign({ action }, payload || {})) });
  const j = await r.json(); if (!j.ok) throw new Error(j.error || 'Server error'); return j;
}
const fmt = (ms, tz, opts) => new Intl.DateTimeFormat(undefined, Object.assign({ timeZone: tz }, opts)).format(new Date(ms));
const dayKey = ms => fmt(ms, OWNER_TZ, { year: 'numeric', month: '2-digit', day: '2-digit' });
const hm = (ms, tz) => fmt(ms, tz, { hour: '2-digit', minute: '2-digit', hour12: false });

function slotsFor(minutes) {
  const step = minutes >= 60 ? 30 : 15, out = [];
  B.data.free.forEach(([a, b]) => {
    const s = new Date(a).getTime(), e = new Date(b).getTime();
    for (let t = Math.ceil(s / (step * 60000)) * step * 60000; t + minutes * 60000 <= e; t += step * 60000) out.push(t);
  });
  return out;
}
function render() {
  const d = B.data, body = $('#body');
  if (!d.enabled) { $('#sub').textContent = ''; body.innerHTML = '<div class="card empty">Booking is closed for now. Please try again later.</div>'; return; }
  $('#who').textContent = 'Book a meeting with ' + d.ownerName;
  $('#sub').textContent = 'Choose a length and a time. You will get an email once it is confirmed.';
  const all = slotsFor(B.minutes), days = [];
  all.forEach(t => { const k = dayKey(t); if (!days.find(x => x.k === k)) days.push({ k, t }); });
  if (!B.day || !days.find(x => x.k === B.day)) B.day = days.length ? days[0].k : null;
  const daySlots = all.filter(t => dayKey(t) === B.day);
  const showLocal = ME_TZ !== OWNER_TZ;
  body.innerHTML = `
    <div class="card"><h2>Length</h2><div class="seg">${d.durations.map(m => `<button type="button" data-min="${m}" aria-pressed="${m === B.minutes}">${m} min</button>`).join('')}</div></div>
    <div class="card"><h2>Day</h2>${days.length ? `<div class="days">${days.map(x => `<button type="button" class="dayb" data-day="${x.k}" aria-pressed="${x.k === B.day}">
        ${esc(fmt(x.t, OWNER_TZ, { weekday: 'short' }))}<b>${esc(fmt(x.t, OWNER_TZ, { day: 'numeric' }))}</b>${esc(fmt(x.t, OWNER_TZ, { month: 'short' }))}</button>`).join('')}</div>`
      : '<div class="empty">No free time in the coming weeks. Please check again later.</div>'}</div>
    ${days.length ? `<div class="card"><h2>Time</h2><div class="slots">${daySlots.map(t => `<button type="button" class="slot" data-t="${t}" aria-pressed="${t === B.slot}">${hm(t, OWNER_TZ)}${showLocal ? `<small>${hm(t, ME_TZ)} your time</small>` : ''}</button>`).join('')}</div>
      <p class="tz">Times are in Madagascar time (UTC+3)${showLocal ? ` · your time zone: ${esc(ME_TZ)}` : ''}.</p></div>` : ''}
    ${B.slot ? `<form class="card" id="f" autocomplete="on"><h2>Your details</h2>
      <p style="margin:0 0 14px;font-weight:600">${esc(fmt(B.slot, OWNER_TZ, { weekday: 'long', day: 'numeric', month: 'long' }))}, ${hm(B.slot, OWNER_TZ)}–${hm(B.slot + B.minutes * 60000, OWNER_TZ)} · ${B.minutes} min</p>
      <label class="field"><span class="lab">Name</span><input name="name" required autocomplete="name"></label>
      <label class="field"><span class="lab">Email</span><input name="email" type="email" required autocomplete="email"></label>
      <label class="field"><span class="lab">What would you like to discuss? (optional)</span><textarea name="topic" rows="3"></textarea></label>
      <div class="hp" aria-hidden="true"><label>Website<input name="website" tabindex="-1" autocomplete="off"></label></div>
      <div class="err" id="err"></div>
      <button class="btn primary block" id="send">Send request</button></form>` : ''}`;
}
document.addEventListener('click', e => {
  const m = e.target.closest('[data-min]'); if (m) { B.minutes = Number(m.dataset.min); B.slot = null; render(); return; }
  const d = e.target.closest('[data-day]'); if (d) { B.day = d.dataset.day; B.slot = null; render(); return; }
  const t = e.target.closest('[data-t]'); if (t) { B.slot = Number(t.dataset.t); render(); const f = $('#f'); if (f) f.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
});
document.addEventListener('submit', async e => {
  e.preventDefault(); if (B.sending) return;
  const f = e.target, btn = $('#send'); B.sending = true; btn.disabled = true; btn.textContent = 'Sending…'; $('#err').textContent = '';
  try {
    await call('bookingRequest', { booking: { name: f.name.value, email: f.email.value, topic: f.topic.value, website: f.website.value,
      minutes: B.minutes, start: new Date(B.slot).toISOString() } });
    $('#body').innerHTML = `<div class="card done"><div class="big">🐠</div><h2 style="color:var(--text);text-transform:none;font-size:20px">Request sent</h2>
      <p>${esc(fmt(B.slot, OWNER_TZ, { weekday: 'long', day: 'numeric', month: 'long' }))} at ${hm(B.slot, OWNER_TZ)} (Madagascar time), ${B.minutes} min.</p>
      <p>You will receive an email with the Google Meet link once it is confirmed.</p></div>`;
  } catch (err) {
    $('#err').textContent = err.message || 'Could not send. Please try again.'; btn.disabled = false; btn.textContent = 'Send request';
    if (/no longer available/i.test(err.message)) { load(); }
  } finally { B.sending = false; }
});
async function load() {
  try { B.data = await call('bookingSlots'); if (B.data.durations && !B.data.durations.includes(B.minutes)) B.minutes = B.data.durations[0]; render(); }
  catch (e) { $('#sub').textContent = ''; $('#body').innerHTML = '<div class="card empty">Could not load the available times. Please refresh the page.</div>'; }
}

/* Demo (empty config.js): sample free time */
function demo(action) {
  const wait = v => new Promise(r => setTimeout(() => r(v), 300));
  if (action === 'bookingRequest') return wait({ ok: true });
  const free = [];
  for (let n = 1; n <= 21; n++) {
    const d = new Date(); d.setDate(d.getDate() + n); if (d.getDay() === 0 || d.getDay() === 6) continue;
    const ymd = d.toISOString().slice(0, 10);
    [['08:30', '10:00'], ['11:00', '12:30'], ['14:30', '17:30']].forEach(([a, b]) => free.push([ymd + 'T' + a + ':00+03:00', ymd + 'T' + b + ':00+03:00']));
  }
  return wait({ ok: true, enabled: true, ownerName: 'Aroo', title: 'Meeting with Aroo', durations: [15, 30, 60], free });
}
load();
})();
