// Registered clinics (models/Clinic.js, routes/admin-clinics.js):
//   - identity: same name + same address is one clinic (case, spacing and
//     punctuation ignored); another address is a separate clinic (branch)
//   - field validation for create and update
//   - transaction rows split per clinic, with unlinked payments kept apart
//     and the parts adding up to the whole (nothing counted twice)
//   - every route is behind authMiddleware + adminOnly
//   - User.clinicId / Appointment.clinicId exist, and booking records the
//     pediatrician's clinic
//   - the Reports page and its clinic script agree on element ids
// No database.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const Clinic = require('../../models/Clinic');
const User = require('../../models/User');
const Appointment = require('../../models/Appointment');
const adminOps = require('../../services/adminOperationsAnalytics');
const { authMiddleware, adminOnly } = require('../../middleware/auth');
const router = require('../../routes/admin-clinics');
const { readClinicFields, rowsPerClinic, missingAppointmentCount, pediatricianNameFilter, COMPLETENESS } = router._internals;

const root = path.join(__dirname, '..', '..');

async function testIdentity() {
  const key = Clinic.clinicIdentityKey;
  assert.strictEqual(key('Sta. Rosa  Pediatrics', '12 Rizal St., Laguna'), key('sta rosa pediatrics', '12 rizal st laguna'));
  assert.notStrictEqual(key('Sta. Rosa Pediatrics', '12 Rizal St'), key('Sta. Rosa Pediatrics', 'Balibago Branch'));
  assert.notStrictEqual(key('Sta. Rosa Pediatrics', '12 Rizal St'), key('Sta. Rosa Pediatric Center', '12 Rizal St'));
  // validate() runs the pre('validate') hook that save() runs.
  const doc = new Clinic({ name: 'A Clinic', address: 'Addr 1' });
  await doc.validate();
  assert.strictEqual(doc.identityKey, key('A Clinic', 'Addr 1'));
  assert.strictEqual(doc.status, 'active');
  await assert.rejects(new Clinic({ name: 'A', address: 'B', status: 'approved' }).validate(), 'unknown status rejected');
  const unique = Clinic.schema.indexes().find(([fields]) => fields.identityKey === 1);
  assert.ok(Clinic.schema.path('identityKey').options.unique || (unique && unique[1].unique), 'identityKey is unique');
}

function testValidation() {
  const ok = readClinicFields({ name: ' N ', address: ' A ', contactEmail: 'X@Y.example', contactPhone: '+63 (49) 555-0101' }, { partial: false });
  assert.deepStrictEqual(ok.values, { name: 'N', address: 'A', contactEmail: 'x@y.example', contactPhone: '+63 (49) 555-0101' });
  for (const body of [{}, { name: 'N' }, { address: 'A' }, { name: '  ', address: 'A' }, { name: ['N'], address: 'A' },
    { name: 'a'.repeat(121), address: 'A' }, { name: 'N', address: 'a'.repeat(301) },
    { name: 'N', address: 'A', contactEmail: 'nope' }, { name: 'N', address: 'A', contactPhone: 'call me' },
    { name: 'N', address: 'A', contactPhone: 5 }, { name: 'N', address: 'A', status: 'deleted' }]) {
    assert.ok(readClinicFields(body, { partial: false }).error, JSON.stringify(body));
  }
  assert.deepStrictEqual(readClinicFields({ status: 'inactive' }, { partial: true }).values, { status: 'inactive' });
  assert.deepStrictEqual(readClinicFields({ contactPhone: '' }, { partial: true }).values, { contactPhone: null });
  assert.ok(readClinicFields({ name: '' }, { partial: true }).error, 'a supplied name may not be blank');
}

function testTransactionSplit() {
  const a = '0123456789abcdef01234567';
  const b = 'fedcba9876543210fedcba98';
  const rows = [
    { _id: { clinicId: a, status: 'Paid', currency: 'PHP' }, count: 2, amount: 1000 },
    { _id: { clinicId: a, status: 'Pending', currency: 'PHP' }, count: 1, amount: 500 },
    { _id: { clinicId: b, status: 'Expired', currency: 'PHP' }, count: 1, amount: 700 },
    { _id: { clinicId: null, status: 'Paid', currency: 'PHP', noAppointment: false }, count: 3, amount: 900 },
    { _id: { clinicId: null, status: 'Failed', currency: 'PHP', noAppointment: true }, count: 2, amount: 0 },
  ];
  assert.strictEqual(missingAppointmentCount(rows), 2, 'only no-clinic payments whose appointment is missing');
  const split = rowsPerClinic(rows);
  const sumA = adminOps.summarizePayments(split.get(a));
  const none = adminOps.summarizePayments(split.get('none'));
  assert.strictEqual(sumA.totalCount, 3);
  assert.strictEqual(sumA.groups.find((g) => g.key === 'collected').amount, 1000, 'collected = money received, not pending');
  assert.strictEqual(none.totalCount, 5, 'unlinked payments kept apart');
  const total = [...split.values()].reduce((n, r) => n + adminOps.summarizePayments(r).totalCount, 0);
  assert.strictEqual(total, rows.reduce((n, r) => n + r.count, 0), 'parts add up to the whole');
}

function testRouterGuards() {
  const guards = router.stack.filter((l) => !l.route).map((l) => l.handle);
  assert.ok(guards.includes(authMiddleware) && guards.includes(adminOnly), 'router.use(authMiddleware, adminOnly)');
  assert.ok(guards.indexOf(authMiddleware) < guards.indexOf(adminOnly));
  const firstRoute = router.stack.findIndex((l) => l.route);
  assert.ok(router.stack.findIndex((l) => l.handle === adminOnly) < firstRoute, 'guards run before every route');
  const routes = router.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);
  for (const r of ['GET /summary', 'GET /', 'GET /pediatricians', 'PUT /pediatricians/:userId', 'POST /', 'GET /:id', 'PATCH /:id']) {
    assert.ok(routes.includes(r), `${r} exists`);
  }
  // Static paths are declared before /:id so they are never read as an id.
  assert.ok(routes.indexOf('GET /summary') < routes.indexOf('GET /:id'));
  assert.ok(routes.indexOf('GET /pediatricians') < routes.indexOf('GET /:id'));
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.ok(server.includes("app.use('/api/admin/clinics', require('./routes/admin-clinics'))"));
}

function testSchemasAndBooking() {
  assert.strictEqual(User.schema.path('clinicId').options.ref, 'Clinic');
  assert.strictEqual(new User({}).clinicId, null);
  assert.strictEqual(Appointment.schema.path('clinicId').options.ref, 'Clinic');
  const appts = fs.readFileSync(path.join(root, 'routes', 'appointments.js'), 'utf8');
  assert.ok(appts.includes('clinicId: pediatrician.clinicId || null,'), 'booking records the pediatrician clinic');
  // Pediatricians cannot set their own clinic link through profile updates.
  const auth = fs.readFileSync(path.join(root, 'routes', 'auth.js'), 'utf8');
  assert.ok(!/user\.clinicId\s*=/.test(auth));
}

function testPageScriptContract() {
  const html = fs.readFileSync(path.join(root, 'ADMIN', 'admin-reports.html'), 'utf8');
  const js = fs.readFileSync(path.join(root, 'js', 'admin', 'admin-clinics.js'), 'utf8');
  const ids = new Set([...js.matchAll(/byId\('([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]));
  for (const m of js.matchAll(/byId\(`\$\{prefix\}(\w+)`\)/g)) {
    ids.add(`clinicNew${m[1]}`); ids.add(`clinicEdit${m[1]}`);
  }
  assert.ok(ids.size > 25, `found ${ids.size} ids`);
  const missing = [...ids].filter((id) => !html.includes(`id="${id}"`));
  assert.deepStrictEqual(missing, [], `script uses ids the page lacks: ${missing.join(', ')}`);
  assert.ok(/<script src="\/js\/admin\/admin-clinics\.js(\?v=[0-9a-f]+)?"><\/script>/.test(html), 'the page loads admin-clinics.js');
  assert.ok(js.trim().startsWith('//') && js.includes('(function () {'), 'script is wrapped so it adds no globals');
}

function testListFilters() {
  // Pediatrician-name search only ever looks at pediatrician accounts, and
  // matches first, last or "first last" with the user's text taken literally.
  const rx = new RegExp('Ana C\\.', 'i');
  const f = pediatricianNameFilter(rx);
  assert.strictEqual(f.role, 'pediatrician');
  assert.deepStrictEqual(f.$or.slice(0, 2), [{ firstName: rx }, { lastName: rx }]);
  const full = f.$or[2].$expr.$regexMatch;
  assert.strictEqual(full.regex, rx.source);
  assert.strictEqual(full.options, 'i');

  // "Incomplete" = no phone or no email (null, missing or ''); "complete" is
  // its exact complement on the same two fields.
  assert.deepStrictEqual(Object.keys(COMPLETENESS).sort(), ['complete', 'incomplete']);
  assert.deepStrictEqual(COMPLETENESS.incomplete.$or[0].contactPhone, { $in: [null, ''] });
  assert.deepStrictEqual(COMPLETENESS.complete.contactPhone, { $nin: [null, ''] });
  assert.deepStrictEqual(COMPLETENESS.incomplete.$or.map((c) => Object.keys(c)[0]), ['contactPhone', 'contactEmail']);
  assert.deepStrictEqual(Object.keys(COMPLETENESS.complete), ['contactPhone', 'contactEmail']);
}

function testReportModules() {
  // The report-modules nav was removed; the category sections it pointed at
  // remain, so existing #cat-* links still land.
  const html = fs.readFileSync(path.join(root, 'ADMIN', 'admin-reports.html'), 'utf8');
  assert.ok(!html.includes('class="report-modules"'), 'report-modules nav should be gone');
  const categories = ['cat-clinics', 'cat-patients', 'cat-assessments', 'cat-appointments', 'cat-system'];
  const missing = categories.filter((id) => !html.includes(`id="${id}"`));
  assert.deepStrictEqual(missing, [], `report categories missing: ${missing.join(', ')}`);
  // The status legend reads band colours from the shared scoring module. The
  // page script carries a ?v= content version (pedia-reports-asset-versions
  // test), so match it by path.
  const scoringAt = html.indexOf('<script src="/constants/scoring.js');
  const reportsAt = html.indexOf('<script src="/js/admin/admin-reports.js');
  assert.ok(scoringAt >= 0 && reportsAt >= 0, 'both scripts are loaded');
  assert.ok(scoringAt < reportsAt, 'scoring.js loads before admin-reports.js');
}

(async () => {
  await testIdentity();
  testListFilters();
  testReportModules();
  testValidation();
  testTransactionSplit();
  testRouterGuards();
  testSchemasAndBooking();
  testPageScriptContract();
  console.log('Admin clinics OK — name+address identity with branches kept apart, field validation, per-clinic transaction split with unlinked payments kept apart, admin-only router, clinic links on users and appointments, page and script agree');
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
