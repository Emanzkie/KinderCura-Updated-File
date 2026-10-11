// Unit tests for the Pay at Clinic QR -> Cashier page workflow.
//
// The QR used to encode only the bare KC-PAY reference, so a phone camera
// showed text instead of opening anything. It now encodes the secretary
// Cashier page URL with ?ref=, and the Cashier page looks that reference up.
//
// No DB and no network: models are monkey-patched, controller handlers are
// called with fake req/res objects, and js/secretary/secretary-cashier.js runs
// in a fake DOM (node vm).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const mongoose = require('mongoose');

const ROOT = path.join(__dirname, '..', '..');
const QRCode = require('qrcode');
const Appointment = require('../../models/Appointment');
const Payment = require('../../models/Payment');
const Child = require('../../models/Child');
const User = require('../../models/User');
const Notification = require('../../models/Notification');
const SystemSetting = require('../../models/SystemSetting');
const receiptService = require('../../services/receiptService');
const controller = require('../../controllers/paymentController');

const REF = 'KC-PAY-2026-000063';
const results = [];
const ok = (label) => results.push(label);

// Query-chain stand-in: supports .sort().select().lean() and await.
const chain = (v) => { const o = { sort: () => o, select: () => o, lean: async () => v, then: (a, b) => Promise.resolve(v).then(a, b) }; return o; };
const fakeRes = () => {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};
const fakeReq = (user, params = {}, extra = {}) => ({
  user, params, body: {}, protocol: 'http', get: (h) => (h === 'host' ? (extra.host || 'localhost:3001') : undefined), ...extra,
});

const ids = {
  appt: new mongoose.Types.ObjectId(), parent: new mongoose.Types.ObjectId(), child: new mongoose.Types.ObjectId(),
  pedia: new mongoose.Types.ObjectId(), secretary: new mongoose.Types.ObjectId(), payment: new mongoose.Types.ObjectId(),
};

function withEnv(vars, fn) {
  const keys = ['APP_URL', 'VERCEL_PROJECT_PRODUCTION_URL', 'VERCEL_URL'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  keys.forEach((k) => delete process.env[k]);
  Object.assign(process.env, vars);
  const restore = () => keys.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
  let out;
  try { out = fn(); } catch (e) { restore(); throw e; }
  if (out && typeof out.then === 'function') return out.finally(restore);
  restore();
  return out;
}

// ── 1. QR payload URL ────────────────────────────────────────────────────────
{
  const req = fakeReq(null, {}, { host: '192.168.1.20:3001' });
  withEnv({ APP_URL: 'https://kindercura.com/' }, () => {
    assert.strictEqual(controller.clinicCounterUrl(req, REF), `https://kindercura.com/secretary/secretary-cashier.html?ref=${REF}`, 'APP_URL wins, trailing slash trimmed');
  });
  withEnv({ VERCEL_PROJECT_PRODUCTION_URL: 'kindercura.com', VERCEL_URL: 'kindercura-abc123.vercel.app' }, () => {
    assert.strictEqual(controller.clinicCounterUrl(req, REF), `https://kindercura.com/secretary/secretary-cashier.html?ref=${REF}`, 'Vercel production host, https');
  });
  withEnv({}, () => {
    assert.strictEqual(controller.clinicCounterUrl(req, REF), `http://192.168.1.20:3001/secretary/secretary-cashier.html?ref=${REF}`, 'local development: the host the parent used');
  });
  ok('QR URL: APP_URL, then Vercel production host (https), then the request host; points at the Cashier page with ?ref=');
}

// ── Model mocks shared by the handler tests ─────────────────────────────────
const orig = {
  apptFindOne: Appointment.findOne, apptFindById: Appointment.findById, payFindOne: Payment.findOne, payCreate: Payment.create,
  userFindById: User.findById, childFindById: Child.findById, getClinic: SystemSetting.getClinic, settle: receiptService.settlePayment,
  notifCreate: Notification.create, toDataURL: QRCode.toDataURL, warn: console.warn, error: console.error,
};
const state = {};
function resetState() {
  state.saves = 0; state.created = 0; state.settleCalls = []; state.notifications = []; state.qrPayloads = [];
  state.secretary = { _id: ids.secretary, status: 'active', linkedPediatricianId: ids.pedia, secretaryPermissions: { managePayments: true } };
  state.appointment = {
    _id: ids.appt, id: 107, parentId: ids.parent, childId: ids.child, pediatricianId: ids.pedia, status: 'approved',
    paymentStatus: 'Pending Payment', totalAmount: 400, appointmentDate: new Date(), appointmentTime: '14:00', reason: 'Consultation',
    save: async () => { state.saves += 1; },
  };
  state.payment = {
    _id: ids.payment, appointmentId: ids.appt, paymentRef: REF, paymentMethod: 'pay_at_clinic', status: 'Pending',
    totalAmount: 400, currency: 'PHP', save: async () => { state.saves += 1; },
  };
}
function installMocks() {
  Appointment.findOne = () => chain(state.appointment);
  Appointment.findById = () => chain(state.appointment);
  Payment.findOne = (q) => chain(q && q.paymentRef && q.paymentRef !== state.payment?.paymentRef ? null : state.payment);
  Payment.create = async () => { state.created += 1; return state.payment; };
  User.findById = (id) => chain(String(id) === String(ids.secretary) ? state.secretary
    : String(id) === String(ids.parent) ? { firstName: 'Ana', lastName: 'Reyes', email: 'ana@example.invalid' }
      : { firstName: 'Gold', lastName: 'Deluna' });
  Child.findById = () => chain({ firstName: 'Luz', lastName: 'Reyes' });
  SystemSetting.getClinic = async () => ({ payAtClinicEnabled: true, clinicName: 'Test Clinic', phoneNumber: '', address: '' });
  receiptService.settlePayment = async (args) => {
    state.settleCalls.push(args);
    return { alreadySettled: false, emailed: true, payment: { ...state.payment, status: 'Paid', amount: state.payment.totalAmount, receiptNumber: 'KC-RCPT-TEST', paidAt: new Date() } };
  };
  Notification.create = async (doc) => { state.notifications.push(doc); return doc; };
  QRCode.toDataURL = async (payload, opts) => { state.qrPayloads.push(payload); return orig.toDataURL.call(QRCode, payload, opts); };
  console.warn = () => {}; console.error = () => {};
}
function restoreMocks() {
  Appointment.findOne = orig.apptFindOne; Appointment.findById = orig.apptFindById; Payment.findOne = orig.payFindOne; Payment.create = orig.payCreate;
  User.findById = orig.userFindById; Child.findById = orig.childFindById; SystemSetting.getClinic = orig.getClinic;
  receiptService.settlePayment = orig.settle; Notification.create = orig.notifCreate; QRCode.toDataURL = orig.toDataURL;
  console.warn = orig.warn; console.error = orig.error;
}

const parentUser = { userId: String(ids.parent), role: 'parent' };
const secretaryUser = { userId: String(ids.secretary), role: 'secretary' };

async function handlerTests() {
  installMocks();
  try {
    // ── 2. startPayAtClinic: the QR encodes the Cashier URL, nothing personal ──
    resetState();
    let res = fakeRes();
    await withEnv({ APP_URL: 'https://kindercura.com' }, () => controller.startPayAtClinic(fakeReq(parentUser, { appointmentId: '107' }), res));
    assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
    assert.deepStrictEqual(state.qrPayloads, [`https://kindercura.com/secretary/secretary-cashier.html?ref=${REF}`], 'QR payload is the Cashier page URL');
    assert.ok(!/Ana|Reyes|Luz|400|Deluna|ana@/.test(state.qrPayloads[0]), 'no names, email or amount in the QR');
    assert.match(res.body.qrDataUrl, /^data:image\/png;base64,/, 'a real QR image is returned');
    assert.strictEqual(res.body.paymentRef, REF, 'the reference shown under the QR is unchanged');
    assert.strictEqual(res.body.amount, 400, 'amount comes from the appointment');
    assert.strictEqual(state.created, 0, 'the existing pending payment is reused (no duplicate on refresh)');
    assert.notStrictEqual(state.payment.status, 'Paid', 'generating the QR never marks the payment paid');
    ok('startPayAtClinic: QR = https Cashier URL for the existing reference; no personal data; existing payment reused; not paid');

    // ── 3. lookup: staff only, read-only ─────────────────────────────────────
    resetState();
    let lookups = 0; const pf = Payment.findOne; Payment.findOne = (q) => { lookups += 1; return pf(q); };
    res = fakeRes();
    await controller.lookupClinicPayment(fakeReq(parentUser, { paymentRef: REF }), res);
    assert.strictEqual(res.statusCode, 403, 'a parent (e.g. scanning their own QR) cannot read the payment');
    assert.strictEqual(lookups, 0, 'refused before any payment lookup');
    Payment.findOne = pf;

    resetState(); state.secretary.secretaryPermissions = { managePayments: false };
    res = fakeRes(); await controller.lookupClinicPayment(fakeReq(secretaryUser, { paymentRef: REF }), res);
    assert.strictEqual(res.statusCode, 403, 'a secretary without payment permission is refused');

    resetState();
    res = fakeRes(); await controller.lookupClinicPayment(fakeReq(secretaryUser, { paymentRef: 'https://evil.example/x' }), res);
    assert.strictEqual(res.statusCode, 400); assert.strictEqual(res.body.code, 'INVALID_QR', 'non-reference input is rejected safely');
    res = fakeRes(); await controller.lookupClinicPayment(fakeReq(secretaryUser, { paymentRef: 'KC-PAY-2026-999999' }), res);
    assert.strictEqual(res.statusCode, 404); assert.strictEqual(res.body.code, 'NOT_FOUND');

    resetState();
    res = fakeRes(); await controller.lookupClinicPayment(fakeReq(secretaryUser, { paymentRef: REF.toLowerCase() }), res);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.canConfirm, true);
    assert.strictEqual(res.body.payment.paymentRef, REF);
    assert.strictEqual(res.body.payment.amountDue, 400);
    assert.strictEqual(res.body.appointment.parentName, 'Ana Reyes');
    assert.strictEqual(res.body.appointment.childName, 'Luz Reyes');
    assert.strictEqual(state.saves, 0, 'lookup writes nothing');
    assert.strictEqual(state.settleCalls.length, 0, 'scanning/looking up never settles the payment');
    assert.strictEqual(state.payment.status, 'Pending');

    resetState(); state.appointment.status = 'cancelled';
    res = fakeRes(); await controller.lookupClinicPayment(fakeReq(secretaryUser, { paymentRef: REF }), res);
    assert.strictEqual(res.body.canConfirm, false); assert.ok(res.body.blockers.some((b) => b.code === 'APPOINTMENT_CANCELLED'));
    ok('lookup: parents and unpermitted secretaries refused before any read; bad/unknown refs handled; valid lookup returns the real record and writes nothing');

    // ── 4. confirm: explicit, once ───────────────────────────────────────────
    resetState();
    res = fakeRes(); await controller.confirmClinicPayment(fakeReq(secretaryUser, { paymentRef: REF }, { body: { amount: 1 } }), res);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(state.settleCalls.length, 1, 'settled exactly once');
    assert.strictEqual(state.settleCalls[0].method, 'pay_at_clinic');
    assert.strictEqual(String(state.settleCalls[0].paymentId), String(ids.payment));
    assert.ok(!('amount' in state.settleCalls[0]), 'no client amount is passed through');
    assert.ok(state.notifications.some((n) => String(n.userId) === String(ids.parent)), 'parent notified through the existing mechanism');

    resetState(); state.payment.status = 'Paid'; state.payment.receiptNumber = 'KC-RCPT-OLD';
    res = fakeRes(); await controller.confirmClinicPayment(fakeReq(secretaryUser, { paymentRef: REF }), res);
    assert.strictEqual(res.statusCode, 409); assert.strictEqual(res.body.code, 'ALREADY_PAID');
    assert.strictEqual(state.settleCalls.length, 0, 'an already-paid payment is not confirmed again');

    resetState();
    res = fakeRes(); await controller.confirmClinicPayment(fakeReq(parentUser, { paymentRef: REF }), res);
    assert.strictEqual(res.statusCode, 403); assert.strictEqual(state.settleCalls.length, 0, 'a parent cannot confirm');
    ok('confirm: staff-only explicit step settles once (server amount), notifies the parent; already-paid -> 409, nothing settled');
  } finally {
    restoreMocks();
  }
}

// ── 5. Cashier page (js/secretary/secretary-cashier.js) in a fake DOM ────────
function makeCashierEnv({ search = '', token = 'tok', role = 'secretary' } = {}) {
  const els = {}; const fetches = [];
  const el = (id) => (els[id] ||= {
    id, value: '', textContent: '', innerHTML: '', disabled: false, style: {}, listeners: {},
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener(t, cb) { this.listeners[t] = cb; }, focus() {}, setAttribute() {}, removeAttribute() {},
  });
  let domReady = null;
  const location = { pathname: '/secretary/secretary-cashier.html', search, href: '' };
  const ctx = vm.createContext({
    document: { getElementById: el, querySelectorAll: () => [], addEventListener: (t, cb) => { if (t === 'DOMContentLoaded') domReady = cb; } },
    window: { location, addEventListener() {}, setTimeout: () => 0, clearTimeout() {} },
    KC: { token: () => token, user: () => (role ? { role } : null) },
    apiFetch: async (url) => {
      fetches.push(url);
      if (url.startsWith('/payments/clinic/lookup/')) {
        const ref = decodeURIComponent(url.split('/').pop());
        if (ref !== REF) throw new Error('Payment reference not found.');
        return { canConfirm: true, blockers: [], isToday: true, payment: { paymentRef: REF, amountDue: 400, paymentMethod: 'pay_at_clinic', status: 'Pending' }, appointment: { date: new Date(), time: '14:00', parentName: 'Ana Reyes', childName: 'Luz Reyes', pediatricianName: 'Dr. Gold Deluna', service: 'Consultation', status: 'approved' } };
      }
      if (url === '/payments/clinic/today') return { appointments: [] };
      return {};
    },
    logout() {}, URL, URLSearchParams, console: { log() {}, warn() {}, error() {} }, setTimeout: () => 0, Promise, String, Number, Date, JSON, RegExp, Object,
  });
  ctx.window.location = location;
  ctx.location = location;
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'secretary', 'secretary-cashier.js'), 'utf8'), ctx, { filename: 'secretary-cashier.js' });
  return { ctx, els, el, fetches, location, run: (e) => vm.runInContext(e, ctx), ready: async () => { domReady(); await new Promise((r) => setImmediate(r)); } };
}

async function pageTests() {
  // refFromScan: every way a scan can arrive
  const env = makeCashierEnv();
  const parse = (v) => env.run(`refFromScan(${JSON.stringify(v)})`);
  assert.strictEqual(parse(REF), REF, 'bare reference (older QR / typed)');
  assert.strictEqual(parse(` ${REF.toLowerCase()} `), REF, 'typed lowercase with spaces');
  assert.strictEqual(parse(`https://kindercura.com/secretary/secretary-cashier.html?ref=${REF}`), REF, 'new QR URL (USB scanner types the whole URL)');
  assert.strictEqual(parse(`http://192.168.1.20:3001/secretary/secretary-cashier.html?ref=${REF.toLowerCase()}`), REF, 'local-network URL');
  assert.strictEqual(parse('https://kindercura.com/secretary/secretary-cashier.html'), 'HTTPS://KINDERCURA.COM/SECRETARY/SECRETARY-CASHIER.HTML', 'URL without ref is passed on for the server to reject');
  assert.strictEqual(env.run(`PAYMENT_REF_RE.test(refFromScan(${JSON.stringify(`https://kindercura.com/secretary/secretary-cashier.html?ref=${REF}`)}))`), true, 'camera scanner accepts the new QR');
  ok('Cashier page: bare refs and Cashier-URL scans both resolve to the reference (typed, USB scanner, camera)');

  // Opened from the QR: looks the payment up once, and only looks it up.
  const deep = makeCashierEnv({ search: `?ref=${REF}` });
  await deep.ready();
  const lookups = deep.fetches.filter((u) => u.startsWith('/payments/clinic/lookup/'));
  assert.deepStrictEqual(lookups, [`/payments/clinic/lookup/${REF}`], 'deep link triggers exactly one lookup');
  assert.ok(!deep.fetches.some((u) => /\/confirm$/.test(u)), 'opening the link never confirms');
  assert.strictEqual(deep.els.rPaymentRef.textContent, REF);
  assert.strictEqual(deep.els.refInput.value, REF);

  const plain = makeCashierEnv();
  await plain.ready();
  assert.ok(!plain.fetches.some((u) => u.startsWith('/payments/clinic/lookup/')), 'no ref in the URL: no automatic lookup (unchanged behaviour)');
  ok('Cashier page: ?ref= deep link looks the payment up once and never confirms; plain page unchanged');

  // Signed out on the scanning phone: login, then back to this exact payment.
  const out = makeCashierEnv({ search: `?ref=${REF}`, token: null, role: null });
  assert.strictEqual(out.location.href, `/login.html?next=${encodeURIComponent(`/secretary/secretary-cashier.html?ref=${REF}`)}`);
  await out.ready();
  assert.ok(!out.fetches.some((u) => u.startsWith('/payments/clinic/lookup/')), 'no lookup without a session');
  // A stale stored user (any role) with no token still goes to login, not to a dashboard.
  const stale = makeCashierEnv({ search: `?ref=${REF}`, token: null, role: 'parent' });
  assert.strictEqual(stale.location.href, `/login.html?next=${encodeURIComponent(`/secretary/secretary-cashier.html?ref=${REF}`)}`);

  // Expired session: the 401 message sends the secretary to log in and come back.
  const expired = makeCashierEnv({ search: `?ref=${REF}` });
  expired.ctx.apiFetch = async (url) => { expired.fetches.push(url); if (url.includes('/lookup/')) throw new Error('Token expired. Please log in again.'); return { appointments: [] }; };
  await expired.ready();
  assert.strictEqual(expired.location.href, `/login.html?next=${encodeURIComponent(`/secretary/secretary-cashier.html?ref=${REF}`)}`);

  // Non-staff role keeps the existing redirect to their own dashboard.
  const parentEnv = makeCashierEnv({ search: `?ref=${REF}`, role: 'parent' });
  assert.strictEqual(parentEnv.location.href, '/parent/dashboard.html');
  ok('Cashier page: signed-out or expired sessions go to login with ?next= back to the payment; parents still go to their own dashboard');

  // login.js really honours that ?next= (same-site path only).
  const loginJs = fs.readFileSync(path.join(ROOT, 'js', 'auth', 'login.js'), 'utf8');
  assert.match(loginJs, /get\('next'\)/); assert.match(loginJs, /nextUrl\.startsWith\('\/'\)/);
  ok('login.js supports ?next= for same-site destinations');
}

(async () => {
  await handlerTests();
  await pageTests();
  console.log(results.map((r) => `  ok - ${r}`).join('\n'));
  console.log(`Clinic payment QR tests OK — ${results.length} groups`);
})().catch((err) => { restoreMocks(); console.error(err); process.exit(1); });
