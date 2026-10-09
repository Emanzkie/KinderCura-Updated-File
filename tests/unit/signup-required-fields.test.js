// Required-field validation for parent and pediatrician sign-up.
//
// Every field on a sign-up step is required unless its label says "(optional)".
// Before this, go() moved between steps without looking at the fields, so a
// parent could reach Login Credentials with no child or name, and the
// pediatrician Professional Information step let Clinic Name, Clinic Address and
// Specialization through empty. These lock down:
//   1. each Continue button blocks on a missing, whitespace-only or invalid field,
//      keeps the user on the step, says what is wrong and keeps everything typed;
//   2. optional fields never block; Back is never blocked; go() cannot skip a step;
//   3. /api/auth/register refuses the same omissions when the page is bypassed.
//
// Fake DOM for the page script (same approach as child-age.test.js); the real
// /register route with the models mocked, so no database and no network.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const vm = require('vm');

process.env.USE_BLOB = 'false';   // uploads stay on local disk in this test

const ROOT = path.join(__dirname, '..', '..');
const AGE_JS = fs.readFileSync(path.join(ROOT, 'js', 'shared', 'child-age.js'), 'utf8');
const SIGNUP_JS = fs.readFileSync(path.join(ROOT, 'js', 'auth', 'signup.js'), 'utf8');
const childAge = require('../../js/shared/child-age');

const results = [];
const log = console.log;   // routeTests() silences console.log while the route runs
const ok = (label) => { results.push(label); log(`  ✓ ${label}`); };

// ── Fake DOM ─────────────────────────────────────────────────────────────────
const STEPS = ['s1', 'sp2', 'sp3', 'sp4', 'sp5', 'sd2', 'sd3', 'sd4', 'sd5'];

function makeEnv() {
  const els = {}; const focused = []; const fetchCalls = [];
  const el = (id) => (els[id] ||= {
    id, value: '', textContent: '', checked: false, disabled: false, files: [], min: '', max: '', open: false, style: {}, attrs: {}, listeners: {},
    classes: new Set(id === 's1' ? ['active'] : []),
    get classList() {
      const s = this.classes;
      return { add: (c) => s.add(c), remove: (c) => s.delete(c), contains: (c) => s.has(c) };
    },
    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k]; }, removeAttribute(k) { delete this.attrs[k]; },
    focus() { focused.push(id); }, scrollIntoView() {},
    addEventListener(type, cb) { this.listeners[type] = cb; },
    showModal() { this.open = true; }, close() { this.open = false; },
  });
  let domReady = null;
  const document = {
    getElementById: (id) => el(id),
    querySelector: () => null,
    querySelectorAll: (sel) => (sel === '.form-step' ? STEPS.map(el) : []),
    addEventListener(type, cb) { if (type === 'DOMContentLoaded') domReady = cb; },
    createElement: () => ({ setAttribute() {}, appendChild() {}, scrollIntoView() {} }), createTextNode: (t) => ({ t }),
  };
  const window = { location: { href: '' } };
  const ctx = vm.createContext({
    document, window, localStorage: { setItem() {} }, FormData,
    fetch: async (url, opts) => {
      fetchCalls.push({ url, opts });
      await new Promise((r) => setTimeout(r, 5));
      return { ok: true, status: 201, json: async () => ({ success: true, token: 't', user: {} }) };
    },
    console: { log() {}, warn() {}, error() {} }, setTimeout, Promise, JSON, Intl, Date,
  });
  vm.runInContext(AGE_JS, ctx, { filename: 'child-age.js' });
  vm.runInContext(SIGNUP_JS, ctx, { filename: 'signup.js' });
  domReady();
  return {
    els, el, focused, fetchCalls, run: (expr) => vm.runInContext(expr, ctx),
    active: () => STEPS.filter((s) => el(s).classes.has('active')),
    fill(values) { Object.entries(values).forEach(([k, v]) => { el(k).value = v; }); },
    type(id, value) { el(id).value = value; if (el(id).listeners.input) el(id).listeners.input(); },
    invalid: () => Object.values(els).filter((e) => e.attrs['aria-invalid'] === 'true').map((e) => e.id).sort(),
  };
}

const today = childAge.localToday();
const fiveYearsAgo = childAge.formatDateOnly({ year: today.year - 5, month: today.month, day: Math.min(today.day, 28) });

const CHILD = { childFirst: 'Luz', childLast: 'Reyes', childMiddle: '', dob: fiveYearsAgo, childGender: 'female' };
const PARENT = { pFirst: 'Ana', pMiddle: '', pLast: 'Reyes', relationship: 'mother' };
const PARENT_LOGIN = { pUsername: 'ana_reyes', pEmail: 'ana.reyes@example.invalid', pPassword: 'pw-long-enough', pConfirm: 'pw-long-enough' };
const DOCTOR = { dFirst: 'Ben', dMiddle: '', dLast: 'Cruz' };
const DOCTOR_LOGIN = { dUsername: 'dr_cruz', dEmail: 'dr.cruz@example.invalid', dPassword: 'pw-long-enough', dConfirm: 'pw-long-enough' };
const PROFESSIONAL = {
  license: '0123456', institution: '', clinicName: 'Cruz Pediatric Clinic', clinicAddress: '1 Rizal St, Manila',
  pediaPhone: '09123456789', licenseExpiry: '2099-01-01', specialization: 'General Pediatrician', customSpecialization: '',
};

function parentAt(stepNo) {
  const env = makeEnv();
  env.run("selectedRole = 'parent'");
  env.run('go(2)');
  if (stepNo >= 3) { env.fill(CHILD); env.run('go(3)'); }
  if (stepNo >= 4) { env.fill(PARENT); env.run('go(4)'); }
  assert.deepStrictEqual(env.active(), [['s1', 's1', 'sp2', 'sp3', 'sp4'][stepNo]]);
  return env;
}

function doctorAt(stepNo) {
  const env = makeEnv();
  env.run("selectedRole = 'pediatrician'");
  env.run('go(2)');
  if (stepNo >= 3) { env.fill(DOCTOR); env.run('go(3)'); }
  assert.deepStrictEqual(env.active(), [['s1', 's1', 'sd2', 'sd3'][stepNo]]);
  return env;
}

// ── 1. Parent: Child Information (sp2) ───────────────────────────────────────
{
  // All required fields empty.
  let env = parentAt(2);
  env.run('go(3)');
  assert.deepStrictEqual(env.active(), ['sp2'], 'all empty: blocked');
  assert.strictEqual(env.els.ep2.textContent, 'Please complete all required fields before continuing.');
  assert.deepStrictEqual(env.invalid(), ['childFirst', 'childGender', 'childLast', 'dob'], 'every required field marked, optional ones not');
  assert.strictEqual(env.focused[env.focused.length - 1], 'childFirst', 'first invalid field focused');
  assert.strictEqual(env.els.ageDialog.open, false, 'no age notice for an empty form');

  // One field empty, each in turn; and whitespace-only text.
  for (const [id, value, message] of [
    ['childFirst', '', "Please enter your child's first name."],
    ['childFirst', '    ', "Please enter your child's first name."],
    ['childLast', '\t ', "Please enter your child's last name."],
    ['dob', '', childAge.MESSAGES.missing],
    ['childGender', '', "Please select your child's gender."],
  ]) {
    env = parentAt(2);
    env.fill({ ...CHILD, [id]: value });
    env.run('go(3)');
    assert.deepStrictEqual(env.active(), ['sp2'], `${id}=${JSON.stringify(value)}: blocked`);
    assert.strictEqual(env.els.ep2.textContent, message, `${id}: its own message`);
    assert.deepStrictEqual(env.invalid(), [id]);
    assert.strictEqual(env.focused[env.focused.length - 1], id);
    Object.entries({ ...CHILD, [id]: value }).forEach(([k, v]) => assert.strictEqual(env.els[k].value, v, `${k} not cleared`));
  }

  // Correcting the field updates the message as the user types, then Continue works.
  env = parentAt(2);
  env.fill({ ...CHILD, childFirst: '', childGender: '' });
  env.run('go(3)');
  assert.strictEqual(env.els.ep2.textContent, 'Please complete all required fields before continuing.');
  env.type('childFirst', 'Luz');
  assert.strictEqual(env.els.ep2.textContent, "Please select your child's gender.", 'message follows what is still missing');
  assert.deepStrictEqual(env.invalid(), ['childGender']);
  env.type('childGender', 'female');
  assert.strictEqual(env.els.ep2.textContent, '', 'message cleared once corrected');
  assert.deepStrictEqual(env.invalid(), []);
  env.run('go(3)');
  assert.deepStrictEqual(env.active(), ['sp3'], 'continues once everything is filled in');

  // Optional middle name and no photo do not block; the age rule still runs after.
  env = parentAt(2);
  env.fill({ ...CHILD, dob: childAge.formatDateOnly({ year: today.year - 1, month: today.month, day: Math.min(today.day, 28) }) });
  env.run('go(3)');
  assert.deepStrictEqual(env.active(), ['sp2']);
  assert.strictEqual(env.els.ageDialog.open, true, 'filled-in form with an under-3 child: the existing age notice');
  assert.strictEqual(env.els.ep2.textContent, '');
  ok('parent Child Information: empty / whitespace / placeholder / missing date block with a message, the field marked and focused, nothing cleared; middle name + photo optional; age rule unchanged');
}

// ── 2. Parent: Your Information (sp3), Back, and no skipping ─────────────────
{
  let env = parentAt(3);
  env.run('go(4)');
  assert.deepStrictEqual(env.active(), ['sp3'], 'all empty: blocked');
  assert.strictEqual(env.els.ep3.textContent, 'Please complete all required fields before continuing.');
  assert.deepStrictEqual(env.invalid(), ['pFirst', 'pLast', 'relationship']);

  for (const [id, value, message] of [
    ['pFirst', '   ', 'Please enter your first name.'],
    ['pLast', '', 'Please enter your last name.'],
    ['relationship', '', 'Please select your relationship to the child.'],
  ]) {
    env = parentAt(3);
    env.fill({ ...PARENT, [id]: value });
    env.run('go(4)');
    assert.deepStrictEqual(env.active(), ['sp3'], `${id}: blocked`);
    assert.strictEqual(env.els.ep3.textContent, message);
  }

  // Back is never blocked, and keeps what was typed.
  env = parentAt(3);
  env.fill({ pFirst: 'Ana' });
  env.run('go(2)');
  assert.deepStrictEqual(env.active(), ['sp2'], 'Back from an incomplete step');
  assert.strictEqual(env.els.pFirst.value, 'Ana');
  Object.entries(CHILD).forEach(([k, v]) => assert.strictEqual(env.els[k].value, v));
  env.run('go(1)');
  assert.deepStrictEqual(env.active(), ['s1']);

  // Middle name optional: proceeds.
  env = parentAt(3);
  env.fill(PARENT);
  env.run('go(4)');
  assert.deepStrictEqual(env.active(), ['sp4']);

  // go() cannot jump past a step: from Child Information straight to go(4) stops on sp3.
  env = parentAt(2);
  env.fill(CHILD);
  env.run('go(4)');
  assert.deepStrictEqual(env.active(), ['sp3'], 'jump stopped on the incomplete step');
  assert.strictEqual(env.els.ep3.textContent, 'Please complete all required fields before continuing.');
  // ...and a jump from Role straight past an empty Child Information.
  env = makeEnv();
  env.run("selectedRole = 'parent'");
  env.run('go(5)');
  assert.deepStrictEqual(env.active(), ['sp2']);
  // Rapid repeated Continue on an invalid step: still blocked, one step at a time when valid.
  env = parentAt(2);
  for (let i = 0; i < 5; i += 1) env.run('go(3)');
  assert.deepStrictEqual(env.active(), ['sp2']);
  env.fill(CHILD);
  for (let i = 0; i < 5; i += 1) env.run('go(3)');
  assert.deepStrictEqual(env.active(), ['sp3'], 'repeated clicks never move further than the next step');
  ok('parent Your Information: names / relationship required, middle name optional; Back never blocked and keeps values; go() cannot skip an incomplete step; repeated clicks do not over-advance');
}


// ── 3. Login Credentials (both roles) ────────────────────────────────────────
async function credentialTests() {
  // [override, message, failing ids in on-screen order]
  const cases = (p, who) => [
    [{ [`${p}Username`]: '  ' }, 'Please enter a username.', [`${p}Username`]],
    [{ [`${p}Email`]: '' }, 'Please enter your email address.', [`${p}Email`]],
    [{ [`${p}Email`]: 'not-an-email' }, 'Please enter a valid email address.', [`${p}Email`]],
    [{ [`${p}Password`]: '        ', [`${p}Confirm`]: '        ' }, `Please complete all ${who} login credentials.`, [`${p}Password`, `${p}Confirm`]],
    [{ [`${p}Password`]: 'short', [`${p}Confirm`]: 'short' }, 'Password must be at least 8 characters long.', [`${p}Password`]],
    [{ [`${p}Confirm`]: '' }, 'Please confirm your password.', [`${p}Confirm`]],
    [{ [`${p}Confirm`]: 'pw-different-value' }, 'Passwords do not match.', [`${p}Confirm`]],
  ];
  for (const [kind, p, base, at, errId, login] of [
    ['parent', 'p', PARENT_LOGIN, () => parentAt(4), 'ep4', 'sp4'],
    ['pediatrician', 'd', DOCTOR_LOGIN, () => doctorAt(3), 'ed3', 'sd3'],
  ]) {
    for (const [override, message, ids] of cases(p, kind)) {
      const env = at();
      let opened = 0; env.el(`${p}ConsentDialog`).showModal = () => { opened += 1; };
      env.fill({ ...base, ...override });
      assert.strictEqual(env.run(`continueToConsent('${kind}')`), false, `${kind} ${JSON.stringify(override)}: blocked`);
      assert.strictEqual(env.els[errId].textContent, message);
      assert.deepStrictEqual(env.invalid(), [...ids].sort());
      assert.strictEqual(env.focused[env.focused.length - 1], ids[0], 'first invalid field focused');
      assert.strictEqual(opened, 0, 'consent modal not opened');
      assert.deepStrictEqual(env.active(), [login]);
      assert.strictEqual(env.fetchCalls.length, 0, 'no request');
    }
    const env = at();
    let opened = 0; env.el(`${p}ConsentDialog`).showModal = () => { opened += 1; };
    env.fill(base);
    assert.strictEqual(env.run(`continueToConsent('${kind}')`), true);
    assert.strictEqual(opened, 1, `${kind}: valid credentials reach the existing Terms of Service modal`);
    assert.deepStrictEqual(env.invalid(), []);
    assert.strictEqual(env.fetchCalls.length, 0, 'still nothing sent before I Agree & Continue');
  }

  // Passwords are sent exactly as typed (login.js does not trim them either).
  const env = parentAt(4);
  env.fill({ ...PARENT_LOGIN, pPassword: ' pw with spaces ', pConfirm: ' pw with spaces ' });
  ['o1', 'o2', 'o3', 'o4'].forEach((id, i) => { env.el(id).value = String(i + 1); });
  env.el('pAcceptTerms').checked = true; env.el('pAckPrivacy').checked = true;
  await env.run('verifyAndRegister()');
  const reg = env.fetchCalls.find((f) => f.url.endsWith('/register'));
  assert.ok(reg, 'register sent');
  assert.strictEqual(reg.opts.body.get('password'), ' pw with spaces ', 'password not trimmed');
  assert.strictEqual(reg.opts.body.get('relationship'), 'mother');
  assert.strictEqual(reg.opts.body.get('gender'), 'female');
  assert.strictEqual(reg.opts.body.has('middleName'), false, 'optional middle name still omitted when empty');
  ok('Login Credentials (parent + pediatrician): each field required, whitespace-only rejected, existing email / length / match rules kept; valid credentials open the existing consent modal; passwords sent untrimmed');
}

// ── 4. Pediatrician: Personal Information (sd2) and Professional Information (sd5)
async function pediatricianTests() {
  let env = doctorAt(2);
  env.run('go(3)');
  assert.deepStrictEqual(env.active(), ['sd2'], 'all empty: blocked');
  assert.strictEqual(env.els.ed2.textContent, 'Please complete all required fields before continuing.');
  assert.deepStrictEqual(env.invalid(), ['dFirst', 'dLast']);
  env.fill({ ...DOCTOR, dLast: '   ' });
  env.run('go(3)');
  assert.strictEqual(env.els.ed2.textContent, 'Please enter your last name.', 'whitespace-only last name');
  env.type('dLast', 'Cruz');
  assert.strictEqual(env.els.ed2.textContent, '');
  env.run('go(3)');
  assert.deepStrictEqual(env.active(), ['sd3'], 'middle name optional; continues');
  env.run('go(2)');
  assert.deepStrictEqual(env.active(), ['sd2'], 'Back from Login Credentials');
  // Parent-only fields never block the pediatrician.
  assert.strictEqual(env.el('ep2').textContent, ''); assert.strictEqual(env.el('ep3').textContent, '');

  const ready = () => {
    const e = makeEnv();
    e.fill({ ...DOCTOR, ...DOCTOR_LOGIN, ...PROFESSIONAL });
    e.el('docIdInput').files = [{ name: 'prc.png', size: 10, type: 'image/png' }];
    e.el('dAcceptTerms').checked = true; e.el('dAckPrivacy').checked = true;
    return e;
  };
  const MISSING = [
    ['docIdInput', { files: [] }, 'Please upload your PRC ID Card for verification.'],
    ['license', { value: '  ' }, 'PRC License Number is required.'],
    ['clinicName', { value: '' }, 'Please enter your clinic name.'],
    ['clinicAddress', { value: ' ' }, 'Please enter your clinic address.'],
    ['pediaPhone', { value: '' }, 'Phone number is required.'],
    ['pediaPhone', { value: '12345' }, 'Please enter a valid Philippine mobile number (e.g., 09123456789).'],
    ['licenseExpiry', { value: '' }, 'PRC License Expiry Date is required.'],
    ['licenseExpiry', { value: '2001-01-01' }, 'License expiry must be a future date.'],
    ['specialization', { value: '' }, 'Please select your specialization.'],
  ];
  for (const [id, patch, message] of MISSING) {
    env = ready();
    Object.assign(env.el(id), patch);
    await env.run('registerPedia()');
    assert.strictEqual(env.fetchCalls.length, 0, `${id} ${JSON.stringify(patch)}: nothing sent`);
    assert.strictEqual(env.els.ed5.textContent, message);
    assert.deepStrictEqual(env.invalid(), [id]);
    assert.strictEqual(env.focused[env.focused.length - 1], id);
    assert.strictEqual(env.els.license.value, id === 'license' ? '  ' : PROFESSIONAL.license, 'typed values kept');
  }
  env = ready();
  env.fill({ specialization: 'Other', customSpecialization: '' });
  await env.run('registerPedia()');
  assert.strictEqual(env.els.ed5.textContent, 'Please specify your specialization.');
  assert.strictEqual(env.fetchCalls.length, 0);
  env = ready();
  env.fill({ clinicName: '', clinicAddress: '' });
  await env.run('registerPedia()');
  assert.strictEqual(env.els.ed5.textContent, 'Please complete all required fields before continuing.');
  assert.deepStrictEqual(env.invalid(), ['clinicAddress', 'clinicName']);

  // Hospital / Institution is optional: empty still submits, with the payload as before.
  env = ready();
  await env.run('registerPedia()');
  const regs = env.fetchCalls.filter((f) => f.url.endsWith('/register'));
  assert.strictEqual(regs.length, 1, 'one registration request');
  const body = regs[0].opts.body;
  assert.strictEqual(body.get('institution'), '', 'optional institution sent empty, as before');
  assert.strictEqual(body.get('clinicName'), PROFESSIONAL.clinicName);
  assert.strictEqual(body.get('specialization'), 'General Pediatrician');
  assert.strictEqual(env.els.ed5.textContent, '');
  assert.deepStrictEqual(env.invalid(), []);
  ok('pediatrician: names required (middle optional); PRC ID, license, clinic name/address, phone (format), future expiry, specialization required; Hospital / Institution optional; payload unchanged');
}

// ── 5. /api/auth/register when the page is bypassed ──────────────────────────
async function routeTests() {
  process.env.JWT_SECRET = process.env.JWT_SECRET || ('unit-test-only-' + Math.random());
  const express = require('express');
  const User = require('../../models/User');
  const OtpCode = require('../../models/OtpCode');
  const Child = require('../../models/Child');
  const fileStorage = require('../../services/fileStorage');
  const authRouter = require('../../routes/auth');

  const chain = (v) => { const o = { sort: () => o, select: () => o, lean: async () => v, then: (a, b) => Promise.resolve(v).then(a, b) }; return o; };
  const orig = {
    log: console.log, warn: console.warn, error: console.error,
    uFindOne: User.findOne, uCreate: User.create, oFindOne: OtpCode.findOne, cCreate: Child.create, storeFile: fileStorage.storeFile,
  };
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  const calls = { userCreate: [], childCreate: [] };
  User.findOne = () => chain(null);
  OtpCode.findOne = () => chain({ email: 'x', used: true });
  User.create = async (doc) => { calls.userCreate.push(doc); return { ...doc, save: async () => {} }; };
  Child.create = async (doc) => { calls.childCreate.push(doc); return { ...doc, _id: 'child-1', save: async () => {} }; };
  fileStorage.storeFile = async (dir, name) => `${dir}/${name}`;
  const reset = () => { calls.userCreate.length = 0; calls.childCreate.length = 0; };

  // Multer writes uploads to local disk here; anything this test leaves behind is removed.
  const uploadDir = path.join(ROOT, 'uploads', 'profiles');
  const before = new Set(fs.existsSync(uploadDir) ? fs.readdirSync(uploadDir) : []);

  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  const srv = http.createServer(app).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const url = `http://127.0.0.1:${srv.address().port}/api/auth/register`;
  const postJson = async (body) => {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const postMultipart = async (fields) => {
    const fd = new FormData();
    Object.entries(fields).forEach(([k, v]) => { if (v !== undefined) fd.append(k, String(v)); });
    fd.append('prcIdCard', new Blob([Buffer.from('89504e470d0a1a0a', 'hex')], { type: 'image/png' }), 'prc.png');
    const r = await fetch(url, { method: 'POST', body: fd });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  const todayPh = childAge.todayInTimeZone('Asia/Manila');
  const parent = {
    role: 'parent', firstName: 'Ana', lastName: 'Reyes', username: 'ana_reyes', email: 'ana.reyes@example.invalid', password: 'a-long-enough-pw',
    acceptTerms: true, acknowledgePrivacy: true,
    childFirstName: 'Luz', childLastName: 'Reyes', gender: 'female', relationship: 'mother',
    dateOfBirth: childAge.formatDateOnly({ year: todayPh.year - 5, month: todayPh.month, day: Math.min(todayPh.day, 28) }),
  };
  const doctor = {
    role: 'pediatrician', firstName: 'Ben', lastName: 'Cruz', username: 'dr_cruz', email: 'dr.cruz@example.invalid', password: 'a-long-enough-pw',
    acceptTerms: true, acknowledgePrivacy: true,
    licenseNumber: '0123456', prcLicenseNumber: '0123456', phoneNumber: '09123456789', licenseExpiry: '2099-01-01',
    clinicName: 'Cruz Pediatric Clinic', clinicAddress: '1 Rizal St, Manila', specialization: 'General Pediatrician', institution: '',
  };

  try {
    // Parent: required fields missing or whitespace-only, and select values that are not options.
    for (const [field, value, pattern] of [
      ['firstName', '   ', /Missing: firstName\./],
      ['username', '', /Missing: username\./],
      ['childFirstName', ' ', /Missing: childFirstName\./],
      ['childLastName', undefined, /Missing: childLastName\./],
      ['dateOfBirth', '', /Missing: dateOfBirth\./],
      ['gender', '', /Missing: gender\./],
      ['relationship', undefined, /Missing: relationship\./],
      ['gender', 'unknown', /child's gender/],
      ['relationship', 'neighbour', /relationship to the child/],
    ]) {
      reset();
      const body = { ...parent, [field]: value };
      if (value === undefined) delete body[field];
      const r = await postJson(body);
      assert.strictEqual(r.status, 400, `parent ${field}=${JSON.stringify(value)}: refused`);
      assert.match(r.body.error, pattern);
      assert.strictEqual(calls.userCreate.length + calls.childCreate.length, 0, `parent ${field}: nothing created`);
    }
    reset();
    let r = await postJson({ ...parent, middleName: '', childMiddleName: '' });
    assert.strictEqual(r.status, 201, 'complete parent sign-up with empty optional middle names');
    assert.strictEqual(calls.userCreate.length, 1); assert.strictEqual(calls.childCreate.length, 1);
    assert.strictEqual(calls.childCreate[0].relationship, 'mother');

    // Pediatrician: the Professional Information fields.
    for (const [field, value, pattern] of [
      ['clinicName', '', /Missing: clinicName\./],
      ['clinicAddress', '   ', /Missing: clinicAddress\./],
      ['specialization', undefined, /Missing: specialization\./],
      ['phoneNumber', '', /Phone number is required/],
      ['licenseExpiry', '', /Expiry Date is required/],
    ]) {
      reset();
      r = await postMultipart({ ...doctor, [field]: value });
      assert.strictEqual(r.status, 400, `pediatrician ${field}=${JSON.stringify(value)}: refused`);
      assert.match(r.body.error, pattern);
      assert.strictEqual(calls.userCreate.length, 0, `pediatrician ${field}: no account`);
    }
    reset();
    r = await postMultipart(doctor);
    assert.strictEqual(r.status, 201, 'complete pediatrician sign-up with empty optional Hospital / Institution');
    assert.strictEqual(calls.userCreate[0].status, 'pending', 'still pending admin approval');
    assert.strictEqual(calls.childCreate.length, 0, 'pediatrician never creates a child');
    ok('/api/auth/register: missing or whitespace-only required fields refused for parents (incl. child + relationship) and pediatricians (clinic name/address, specialization) with nothing created; optional middle names and Hospital / Institution still optional');
  } finally {
    srv.close();
    console.log = orig.log; console.warn = orig.warn; console.error = orig.error;
    User.findOne = orig.uFindOne; User.create = orig.uCreate; OtpCode.findOne = orig.oFindOne; Child.create = orig.cCreate;
    fileStorage.storeFile = orig.storeFile;
    if (fs.existsSync(uploadDir)) {
      fs.readdirSync(uploadDir).filter((f) => !before.has(f)).forEach((f) => fs.unlinkSync(path.join(uploadDir, f)));
    }
  }
}

(async () => {
  await credentialTests();
  await pediatricianTests();
  await routeTests();
  console.log(`\nsignup-required-fields.test.js: ${results.length} checks passed`);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
