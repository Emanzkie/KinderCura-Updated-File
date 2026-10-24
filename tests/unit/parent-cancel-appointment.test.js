// Regression test: parents can cancel an active appointment from the
// Appointments page (js/parent/appointments.js).
//
// The bug: the page offered Reschedule but no Cancel, although the backend has
// POST /api/appointments/:id/cancel. Parents had no way to cancel a booking.
//
// The page script runs in a vm with stubbed browser globals; apiFetch is
// captured, so nothing reaches a server.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const src = fs.readFileSync(path.join(ROOT, 'js/parent/appointments.js'), 'utf8');
const ok = (m) => console.log('  ok -', m);

function makePage({ confirmAnswer = true, failCancel = false } = {}) {
  const calls = [];
  const alerts = [];
  const confirms = [];
  const els = {};
  const el = (id) => (els[id] ||= { id, innerHTML: '', textContent: '', disabled: false, style: {} });
  const apiFetch = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET' });
    if (/\/cancel$/.test(url) && failCancel) throw new Error('A completed appointment cannot be cancelled.');
    if (/^\/appointments\/u1$/.test(url)) return { appointments: [] };
    return { success: true };
  };
  const ctx = vm.createContext({
    requireAuth() {}, KC: { user: () => ({ id: 'u1' }), childId: () => null },
    apiFetch, fmtDate: (d) => String(d), fmtTime: (t) => String(t),
    escapeHtml: (v) => String(v ?? '').replace(/[&<>"']/g, ''),
    alert: (m) => alerts.push(m),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { addEventListener() {}, getElementById: el, querySelectorAll: () => [], querySelector: () => null },
    console: { log() {}, warn() {}, error() {} },
  });
  ctx.window = { addEventListener() {}, confirm: (m) => { confirms.push(m); return confirmAnswer; }, location: { href: '' } };
  vm.runInContext(src, ctx, { filename: 'appointments.js' });
  return { ctx, calls, alerts, confirms, el, run: (code) => vm.runInContext(code, ctx) };
}

const APPTS = [
  { id: 11, status: 'pending', pediatricianName: 'Ana Cruz', pediatricianId: 'p1', appointmentDate: '2030-01-07', appointmentTime: '09:00', paymentStatus: 'Pending Payment', amountPaid: 0 },
  { id: 12, status: 'approved', pediatricianName: 'Ana Cruz', pediatricianId: 'p1', appointmentDate: '2030-01-08', appointmentTime: '10:00', paymentStatus: 'Paid', amountPaid: 1000 },
];

(async () => {
  // 1. Active cards show a Cancel button; past ones never do.
  {
    const p = makePage();
    p.run(`renderActive(${JSON.stringify(APPTS)})`);
    const html = p.el('activeList').innerHTML;
    assert.ok(html.includes('cancelAppointment(11)') && html.includes('cancelAppointment(12)'), 'both active cards have Cancel');
    p.run(`renderPast(${JSON.stringify([{ ...APPTS[0], id: 13, status: 'completed' }])})`);
    assert.ok(!p.el('pastList').innerHTML.includes('cancelAppointment'), 'no Cancel on past appointments');
    ok('pending and approved cards show Cancel; past appointments do not');
  }

  // 2. Confirming cancels through the existing route, then reloads the list.
  {
    const p = makePage();
    p.run(`activeAppointments = ${JSON.stringify(APPTS)}`);
    await p.run('cancelAppointment(11)');
    assert.deepStrictEqual(p.calls.map((c) => `${c.method} ${c.url}`), ['POST /appointments/11/cancel', 'GET /appointments/u1']);
    assert.ok(!/payment stays on record/.test(p.confirms[0]), 'no refund note for an unpaid booking');
    ok('confirming posts /appointments/11/cancel and reloads the list');
  }

  // 3. A paid booking's confirmation explains the payment is kept for a refund.
  {
    const p = makePage();
    p.run(`activeAppointments = ${JSON.stringify(APPTS)}`);
    await p.run('cancelAppointment(12)');
    assert.match(p.confirms[0], /payment stays on record.*refund/);
    ok('a paid booking warns that the payment stays on record for a refund');
  }

  // 4. Declining the confirmation sends nothing.
  {
    const p = makePage({ confirmAnswer: false });
    p.run(`activeAppointments = ${JSON.stringify(APPTS)}`);
    await p.run('cancelAppointment(11)');
    assert.deepStrictEqual(p.calls, []);
    ok('declining the confirmation sends no request');
  }

  // 5. Unknown or inactive ids are ignored; server errors are shown.
  {
    const p = makePage({ failCancel: true });
    p.run(`activeAppointments = ${JSON.stringify(APPTS)}`);
    await p.run('cancelAppointment(999)');
    assert.deepStrictEqual(p.calls, [], 'an id not in the active list does nothing');
    await p.run('cancelAppointment(11)');
    assert.deepStrictEqual(p.alerts, ['A completed appointment cannot be cancelled.']);
    ok('ids outside the active list are ignored; a server refusal is shown to the parent');
  }

  // 6. A double click sends one request.
  {
    const p = makePage();
    p.run(`activeAppointments = ${JSON.stringify(APPTS)}`);
    await Promise.all([p.run('cancelAppointment(11)'), p.run('cancelAppointment(11)')]);
    assert.strictEqual(p.calls.filter((c) => c.url.endsWith('/cancel')).length, 1);
    ok('a double click sends a single cancel request');
  }

  console.log('\nParent cancel appointment tests OK');
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
