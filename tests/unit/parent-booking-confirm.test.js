// Parent booking confirmation (js/parent/appointments.js).
//
// - The selected pediatrician's fee is shown prominently, from their data.
// - Book Appointment only opens a confirmation; nothing is booked yet.
// - Go Back sends nothing; Confirm and Continue books once, then goes to payment.
// - The booking sent is the one the parent reviewed, even if the form changes.
//
// The page script runs in a vm with stubbed browser globals; apiFetch is
// captured, so nothing reaches a server.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const src = fs.readFileSync(path.join(ROOT, 'js/parent/appointments.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'PARENT/appointments.html'), 'utf8');
const ok = (m) => console.log('  ok -', m);

const PED = {
  id: 'p1', firstName: 'Adrian', lastName: 'Dela Cruz', clinicName: 'Marquez Pediatric Center',
  consultationFee: 950, availabilityConfigured: true,
};

function makePage({ failCreate = false, holdCreate = false } = {}) {
  const calls = [];
  const els = {};
  const el = (id) => (els[id] ||= { id, value: '', innerHTML: '', textContent: '', disabled: false, style: {}, focus() {} });
  let release;
  const apiFetch = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    if (url === '/appointments/create') {
      if (holdCreate) await new Promise((r) => { release = r; });
      if (failCreate) throw new Error('That time was just booked.');
      return { appointmentId: 77 };
    }
    return {};
  };
  const ctx = vm.createContext({
    requireAuth() {}, KC: { user: () => ({ id: 'u1' }), childId: () => null },
    apiFetch, fmtDate: (d) => `date(${d})`, fmtTime: (t) => `time(${t})`,
    escapeHtml: (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { addEventListener() {}, getElementById: el, querySelectorAll: () => [], querySelector: () => null },
    console: { log() {}, warn() {}, error() {} },
  });
  ctx.window = { addEventListener() {}, location: { href: '' } };
  vm.runInContext(src, ctx, { filename: 'appointments.js' });
  const run = (code) => vm.runInContext(code, ctx);
  run(`allPediatricians = ${JSON.stringify([PED])}; allChildren = [{ id: 'c1', firstName: 'Kemri', lastName: 'Soto' }]`);
  Object.assign(el('childSelect'), { value: 'c1' });
  Object.assign(el('pedSelect'), { value: 'p1' });
  Object.assign(el('apptDate'), { value: '2026-11-02' });
  Object.assign(el('apptTime'), { value: '13:00' });
  Object.assign(el('apptReason'), { value: 'Follow-up Assessment' });
  Object.assign(el('apptNotes'), { value: 'Speech <worries>' });
  return { ctx, calls, el, run, release: () => release() };
}

(async () => {
  // 1. The modal and its two buttons exist on the page.
  for (const id of ['bookConfirmModal', 'bookConfirmSummary', 'bookConfirmFee', 'bookConfirmBtn', 'bookBackBtn']) {
    assert.ok(html.includes(`id="${id}"`), `${id} is on the page`);
  }
  assert.match(html, /onclick="confirmBooking\(\)">Confirm and Continue</);
  assert.match(html, /onclick="closeBookConfirm\(\)">Go Back</);
  ok('the page has the confirmation modal with Confirm and Continue / Go Back');

  // 2. The fee comes from the pediatrician's data and is highlighted.
  {
    const p = makePage();
    assert.match(p.run('consultationFeeHtml(allPediatricians[0])'), /fee-highlight__amount">₱950\.00</);
    const unset = p.run(`consultationFeeHtml({ consultationFee: null })`);
    assert.ok(!unset.includes('₱0') && unset.includes('Fee not set yet'), 'no fee shows a note, never ₱0');
    ok('fee is read from the pediatrician and highlighted; an unset fee is not shown as ₱0');
  }

  // 3. Book Appointment opens the summary and books nothing.
  const p = makePage();
  await p.run('bookAppointment()');
  assert.strictEqual(p.calls.length, 0, 'no request before confirmation');
  assert.strictEqual(p.el('bookConfirmModal').style.display, 'flex');
  const summary = p.el('bookConfirmSummary').innerHTML;
  for (const text of ['Dr. Adrian Dela Cruz — Marquez Pediatric Center', 'Kemri Soto', 'date(2026-11-02T00:00:00) at time(13:00)', 'Follow-up Assessment', 'Speech &lt;worries&gt;']) {
    assert.ok(summary.includes(text), `summary shows ${text}`);
  }
  assert.match(p.el('bookConfirmFee').innerHTML, /Total Consultation Fee[\s\S]*₱950\.00/);
  ok('Book Appointment shows pediatrician, child, schedule, reason, notes and total fee without booking');

  // 4. Go Back closes it and sends nothing.
  p.run('closeBookConfirm()');
  assert.strictEqual(p.el('bookConfirmModal').style.display, 'none');
  assert.strictEqual(p.calls.length, 0);
  await p.run('confirmBooking()');
  assert.strictEqual(p.calls.length, 0, 'confirming after Go Back does nothing');
  ok('Go Back sends no request');

  // 5. Confirm books the reviewed snapshot once, then opens the payment page.
  {
    const q = makePage({ holdCreate: true });
    await q.run('bookAppointment()');
    q.el('apptReason').value = 'Changed after opening';
    const first = q.run('confirmBooking()');
    q.run('confirmBooking()');
    q.run('closeBookConfirm()');
    assert.strictEqual(q.el('bookConfirmModal').style.display, 'flex', 'cannot close while booking');
    q.release();
    await first;
    assert.strictEqual(q.calls.length, 1, 'a double click books once');
    assert.deepStrictEqual(q.calls[0].body, {
      childId: 'c1', pediatricianId: 'p1', appointmentDate: '2026-11-02', appointmentTime: '13:00',
      reason: 'Follow-up Assessment', notes: 'Speech <worries>',
    });
    assert.strictEqual(q.ctx.window.location.href, '/PARENT/payment.html?appointmentId=77');
    ok('Confirm and Continue books the reviewed details once and goes to the payment page');
  }

  // 6. A server refusal closes the modal and shows the error on the form.
  {
    const q = makePage({ failCreate: true });
    await q.run('bookAppointment()');
    await q.run('confirmBooking()');
    assert.strictEqual(q.el('bookConfirmModal').style.display, 'none');
    assert.strictEqual(q.el('bookError').textContent, 'That time was just booked.');
    assert.strictEqual(q.el('bookBtn').textContent, 'Book Appointment');
    assert.strictEqual(q.ctx.window.location.href, '');
    ok('a refused booking returns to the form with the error');
  }

  console.log('Parent booking confirmation tests OK');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
