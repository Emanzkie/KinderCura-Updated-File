// Unit tests for the child registration age rule (3 to 8 years old only).
//
// Source of the rule: js/shared/child-age.js, used by the sign-up page and by
// routes/auth.js (/register) + routes/children.js (/register).
//
// Ages are built from the CURRENT date, so the table stays true every day it runs.
// Calendar edge cases (Feb 29, month and year ends) inject a fixed "today".
//
// No DB and no network: models are monkey-patched, the routes run over an
// in-process HTTP server, and js/auth/signup.js runs in a fake DOM (node vm).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');

const ROOT = path.join(__dirname, '..', '..');
const AGE_JS_PATH = path.join(ROOT, 'js', 'shared', 'child-age.js');
const SIGNUP_JS_PATH = path.join(ROOT, 'js', 'auth', 'signup.js');
const HTML_PATH = path.join(ROOT, 'SIGN-UP,LOGIN', 'signup.html');

const childAge = require('../../js/shared/child-age');
const { checkChildAge, eligibleBirthDateRange, parseDateOnly, formatDateOnly, todayInTimeZone, localToday } = childAge;

const results = [];
const ok = (label) => results.push(label);

const D = (s) => parseDateOnly(s);

// A birth date `years`/`months`/`days` before `today` (Feb 29 -> Feb 28 when needed).
function bornAgo(today, { years = 0, months = 0, days = 0 }) {
  const first = new Date(Date.UTC(today.year - years, today.month - 1 - months, 1));
  const dim = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  const d = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(today.day, dim)));
  d.setUTCDate(d.getUTCDate() - days);
  return formatDateOnly({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });
}

// The required test table, for a given "today".
function ageTable(today) {
  return [
    ['2 years old', bornAgo(today, { years: 2 }), 'too_young'],
    ['2 years 11 months old', bornAgo(today, { years: 2, months: 11 }), 'too_young'],
    ['3rd birthday is tomorrow', bornAgo(today, { years: 3, days: -1 }), 'too_young'],
    ['exactly 3 years old', bornAgo(today, { years: 3 }), 'ok'],
    ['3 years 1 month old', bornAgo(today, { years: 3, months: 1 }), 'ok'],
    ['7 years old', bornAgo(today, { years: 7 }), 'ok'],
    ['exactly 8 years old', bornAgo(today, { years: 8 }), 'ok'],
    ['8 years 11 months old', bornAgo(today, { years: 8, months: 11 }), 'ok'],
    ['9th birthday is tomorrow', bornAgo(today, { years: 9, days: -1 }), 'ok'],
    ['exactly 9 years old', bornAgo(today, { years: 9 }), 'too_old'],
    ['12 years old', bornAgo(today, { years: 12 }), 'too_old'],
  ];
}

// ── 1. The rule, against today's date ─────────────────────────────────────────
{
  const today = localToday();
  for (const [label, dob, expected] of ageTable(today)) {
    const r = checkChildAge(dob, today);
    assert.strictEqual(r.ok ? 'ok' : r.reason, expected, `${label} (${dob}) -> ${expected}`);
  }
  // Default "today" is the local date.
  assert.strictEqual(checkChildAge(bornAgo(today, { years: 2 })).reason, 'too_young');
  assert.strictEqual(checkChildAge(bornAgo(today, { years: 5 })).ok, true);

  const young = checkChildAge(bornAgo(today, { years: 2 }), today);
  const old = checkChildAge(bornAgo(today, { years: 9 }), today);
  assert.strictEqual(young.title, 'Age Requirement Not Met');
  assert.strictEqual(old.title, 'Age Requirement Not Met');
  assert.strictEqual(young.message, 'Your child is below the eligible age range. KinderCura registration is only available for children aged 3 to 8 years old.');
  assert.strictEqual(old.message, 'Your child is above the eligible age range. KinderCura registration is only available for children aged 3 to 8 years old.');
  ok(`rule: 2y / 2y11m / day-before-3 blocked, exactly 3 / 3y1m / 7 / exactly 8 / 8y11m allowed, exactly 9 blocked (today = ${formatDateOnly(today)})`);
}

// ── 2. Missing, malformed and future dates ────────────────────────────────────
{
  const today = localToday();
  for (const v of ['', '   ', null, undefined]) {
    assert.strictEqual(checkChildAge(v, today).reason, 'missing', `missing: ${JSON.stringify(v)}`);
  }
  for (const v of ['abc', '10/09/2023', '2023-2-3', '2023-13-01', '2023-00-10', '2023-04-31', '2023-02-29', '2021-02-30', '0000-01-01', '2023-10-09T00:00:00Z', '20231-01-01']) {
    assert.strictEqual(checkChildAge(v, today).reason, 'invalid', `invalid: ${v}`);
  }
  assert.strictEqual(checkChildAge(bornAgo(today, { days: -1 }), today).reason, 'future', 'tomorrow is in the future');
  assert.strictEqual(checkChildAge(bornAgo(today, { years: -1 }), today).reason, 'future');
  assert.strictEqual(checkChildAge(formatDateOnly(today), today).reason, 'too_young', 'born today: valid date, 0 years old');
  assert.match(checkChildAge('', today).message, /^Please enter a valid date of birth before continuing\./);
  assert.match(checkChildAge('bad', today).message, /^Please enter a valid date of birth before continuing\./);
  ok('rule: empty -> missing, impossible dates (Feb 30, Apr 31, Feb 29 in 2023, month 13, wrong format) -> invalid, tomorrow -> future');
}

// ── 3. Calendar edge cases (fixed "today") ────────────────────────────────────
{
  const age = (dob, today) => { const r = checkChildAge(dob, D(today)); return r.ok ? r.age : r.reason; };
  // Leap-day birthday: gains the year on Mar 1 in a non-leap year, on Feb 29 in a leap year.
  assert.strictEqual(age('2020-02-29', '2023-02-28'), 'too_young');
  assert.strictEqual(age('2020-02-29', '2023-03-01'), 3);
  assert.strictEqual(age('2020-02-29', '2024-02-28'), 3);
  assert.strictEqual(age('2020-02-29', '2024-02-29'), 4);
  assert.strictEqual(age('2020-02-29', '2029-02-28'), 8);
  assert.strictEqual(age('2020-02-29', '2029-03-01'), 'too_old');
  assert.strictEqual(age('2020-02-29', '2028-02-29'), 8);
  // Today is Feb 29.
  assert.strictEqual(age('2025-02-28', '2028-02-29'), 3);
  assert.strictEqual(age('2025-03-01', '2028-02-29'), 'too_young');
  assert.strictEqual(age('2019-02-28', '2028-02-29'), 'too_old');
  assert.strictEqual(age('2019-03-01', '2028-02-29'), 8);
  // Year end.
  assert.strictEqual(age('2022-12-31', '2025-12-30'), 'too_young');
  assert.strictEqual(age('2022-12-31', '2025-12-31'), 3);
  assert.strictEqual(age('2023-01-01', '2025-12-31'), 'too_young');
  assert.strictEqual(age('2023-01-01', '2026-01-01'), 3);
  assert.strictEqual(age('2017-01-01', '2025-12-31'), 8);
  assert.strictEqual(age('2017-01-01', '2026-01-01'), 'too_old');
  // Month end.
  assert.strictEqual(age('2022-10-31', '2025-10-30'), 'too_young');
  assert.strictEqual(age('2022-10-31', '2025-10-31'), 3);
  assert.strictEqual(age('2022-11-01', '2025-10-31'), 'too_young');
  assert.strictEqual(age('2022-11-01', '2025-11-01'), 3);
  // The same rule run against the date the screenshots were taken.
  assert.strictEqual(age('2026-10-09', '2026-10-09'), 'too_young');
  ok('rule: Feb 29 birthdays and Feb 29 "today", month ends and year ends');
}

// ── 4. Date picker range matches the rule exactly ─────────────────────────────
{
  assert.deepStrictEqual(eligibleBirthDateRange(D('2026-10-09')), { min: '2017-10-10', max: '2023-10-09' });
  assert.deepStrictEqual(eligibleBirthDateRange(D('2028-02-29')), { min: '2019-03-01', max: '2025-02-28' });
  assert.deepStrictEqual(eligibleBirthDateRange(D('2026-12-31')), { min: '2018-01-01', max: '2023-12-31' });

  const plusDays = (s, n) => {
    const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  // Every day across a leap cycle: min/max are eligible, the day outside each is not.
  let day = new Date(Date.UTC(2027, 0, 1));
  for (let i = 0; i < 366 * 4 + 1; i += 1) {
    const today = { year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate() };
    const { min, max } = eligibleBirthDateRange(today);
    assert.strictEqual(checkChildAge(max, today).ok, true, `${formatDateOnly(today)}: max ${max} eligible`);
    assert.strictEqual(checkChildAge(plusDays(max, 1), today).reason, 'too_young', `${formatDateOnly(today)}: day after max too young`);
    assert.strictEqual(checkChildAge(min, today).ok, true, `${formatDateOnly(today)}: min ${min} eligible`);
    assert.strictEqual(checkChildAge(plusDays(min, -1), today).reason, 'too_old', `${formatDateOnly(today)}: day before min too old`);
    for (const [label, dob, expected] of ageTable(today)) {
      const r = checkChildAge(dob, today);
      assert.strictEqual(r.ok ? 'ok' : r.reason, expected, `${formatDateOnly(today)}: ${label}`);
    }
    day.setUTCDate(day.getUTCDate() + 1);
  }
  ok('picker range: min/max are the first and last eligible birth dates for every day of a 4-year leap cycle; the test table holds on each of those days');
}

// ── 5. Time zones ─────────────────────────────────────────────────────────────
{
  // 01:30 in Manila on Oct 9 is still Oct 8 in UTC.
  const instant = new Date('2026-10-08T17:30:00Z');
  assert.deepStrictEqual(todayInTimeZone('Asia/Manila', instant), { year: 2026, month: 10, day: 9 });
  assert.deepStrictEqual(todayInTimeZone('UTC', instant), { year: 2026, month: 10, day: 8 });
  assert.strictEqual(childAge.CLINIC_TIME_ZONE, 'Asia/Manila');
  // A 3rd birthday on Oct 9 counts from the start of the Philippine day.
  assert.strictEqual(checkChildAge('2023-10-09', todayInTimeZone('Asia/Manila', instant)).ok, true);
  // Parsing is by calendar fields, never new Date(), so the date cannot shift a day.
  assert.deepStrictEqual(parseDateOnly('2023-10-09'), { year: 2023, month: 10, day: 9 });
  assert.ok(!/new Date\(\s*value/.test(fs.readFileSync(AGE_JS_PATH, 'utf8')));
  ok('time zones: server "today" is the Philippine calendar date; YYYY-MM-DD is read as a calendar date');
}

// ── 6. Backend: /api/auth/register and /api/children/register ─────────────────
const chain = (v) => { const o = { sort: () => o, select: () => o, lean: async () => v, then: (a, b) => Promise.resolve(v).then(a, b) }; return o; };

async function routeTests() {
  process.env.JWT_SECRET = process.env.JWT_SECRET || ('unit-test-only-' + Math.random());
  const express = require('express');
  const jwt = require('jsonwebtoken');
  const User = require('../../models/User');
  const Child = require('../../models/Child');
  const OtpCode = require('../../models/OtpCode');
  const authRouter = require('../../routes/auth');
  const childrenRouter = require('../../routes/children');

  const orig = {
    log: console.log, warn: console.warn,
    uFindOne: User.findOne, uCreate: User.create, oFindOne: OtpCode.findOne, cCreate: Child.create, cFindOne: Child.findOne,
  };
  console.log = () => {}; console.warn = () => {};

  const calls = { userFind: 0, userCreate: [], childCreate: [] };
  User.findOne = () => { calls.userFind += 1; return chain(null); };
  OtpCode.findOne = () => chain({ email: 'x', used: true });
  User.create = async (doc) => { calls.userCreate.push(doc); return { ...doc, save: async () => {} }; };
  Child.findOne = () => chain(null);
  Child.create = async (doc) => { calls.childCreate.push(doc); return { ...doc, _id: 'child-1', save: async () => {} }; };
  const reset = () => { calls.userFind = 0; calls.userCreate.length = 0; calls.childCreate.length = 0; };

  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  app.use('/api/children', childrenRouter);
  const srv = http.createServer(app).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const post = async (url, body, headers = {}) => {
    const r = await fetch(`${base}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  // The server's "today" is the Philippine date, so build the ages from it.
  const today = todayInTimeZone('Asia/Manila');
  const parent = {
    role: 'parent', firstName: 'Ana', lastName: 'Reyes', username: 'ana_reyes', email: 'ana.reyes@example.invalid',
    password: 'a-long-enough-pw', acceptTerms: true, acknowledgePrivacy: true,
    childFirstName: 'Justine', childLastName: 'Dayak', gender: 'female', relationship: 'mother',
  };

  try {
    for (const [label, dob, expected] of ageTable(today)) {
      reset();
      const r = await post('/api/auth/register', { ...parent, dateOfBirth: dob });
      if (expected === 'ok') {
        assert.strictEqual(r.status, 201, `register ${label}: allowed`);
        assert.strictEqual(calls.userCreate.length, 1);
        assert.strictEqual(calls.childCreate.length, 1, `register ${label}: child record created`);
        assert.strictEqual(calls.childCreate[0].dateOfBirth.toISOString().slice(0, 10), dob, 'stored date of birth unchanged');
        assert.strictEqual(r.body.needsPreAssessment, true, 'existing pre-assessment hand-off unchanged');
      } else {
        assert.strictEqual(r.status, 400, `register ${label}: refused`);
        assert.strictEqual(r.body.error, childAge.MESSAGES[expected]);
        assert.strictEqual(calls.userCreate.length, 0, `register ${label}: no account created`);
        assert.strictEqual(calls.childCreate.length, 0, `register ${label}: no child created`);
        assert.strictEqual(calls.userFind, 0, `register ${label}: refused before any database work`);
      }
    }
    for (const [label, dob, reason] of [['impossible date', '2023-02-30', 'invalid'], ['wrong format', '10/09/2023', 'invalid'], ['future date', bornAgo(today, { days: -1 }), 'future']]) {
      reset();
      const r = await post('/api/auth/register', { ...parent, dateOfBirth: dob });
      assert.strictEqual(r.status, 400, `register ${label}: refused`);
      assert.strictEqual(r.body.error, childAge.MESSAGES[reason]);
      assert.strictEqual(calls.userCreate.length + calls.childCreate.length, 0, `register ${label}: nothing created`);
    }
    // Parent sign-up requires the child: a request that leaves it out is refused, nothing created.
    reset();
    let r = await post('/api/auth/register', { ...parent, childFirstName: '', childLastName: '' });
    assert.strictEqual(r.status, 400); assert.match(r.body.error, /Missing: childFirstName, childLastName, dateOfBirth\./);
    assert.strictEqual(calls.userCreate.length + calls.childCreate.length, 0);
    // Pediatrician sign-up never carries a child, and the age rule does not apply to it.
    reset();
    r = await post('/api/auth/register', { ...parent, role: 'pediatrician', dateOfBirth: bornAgo(today, { years: 1 }), licenseNumber: '' });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /license number is required/, 'pediatrician reaches its own PRC checks, not the age rule');
    ok('/api/auth/register: ineligible, impossible or future child DOB refused (400, rule message) before any user or child record; eligible ages create both; parent without a child refused; pediatrician path unchanged');

    // /api/children/register (Add Child on the parent profile)
    const token = jwt.sign({ userId: '64b000000000000000000001', role: 'parent', email: 'ana.reyes@example.invalid' }, process.env.JWT_SECRET);
    const auth = { Authorization: `Bearer ${token}` };
    for (const [label, dob, expected] of ageTable(today)) {
      reset();
      r = await post('/api/children/register', { firstName: 'Luz', lastName: 'Reyes', dateOfBirth: dob }, auth);
      if (expected === 'ok') {
        assert.strictEqual(r.status, 201, `add child ${label}: allowed`);
        assert.strictEqual(calls.childCreate.length, 1);
      } else {
        assert.strictEqual(r.status, 400, `add child ${label}: refused`);
        assert.strictEqual(r.body.error, childAge.MESSAGES[expected]);
        assert.strictEqual(calls.childCreate.length, 0, `add child ${label}: no child created`);
      }
    }
    reset();
    r = await post('/api/children/register', { firstName: 'Luz', lastName: 'Reyes' }, auth);
    assert.strictEqual(r.status, 400); assert.match(r.body.error, /required/, 'existing required-field message unchanged');
    r = await post('/api/children/register', { firstName: 'Luz', lastName: 'Reyes', dateOfBirth: bornAgo(today, { years: 5 }) });
    assert.strictEqual(r.status, 401, 'still requires sign-in');
    ok('/api/children/register: same 3-8 rule, no ineligible child created; required-field and auth checks unchanged');
  } finally {
    srv.close();
    console.log = orig.log; console.warn = orig.warn;
    User.findOne = orig.uFindOne; User.create = orig.uCreate; OtpCode.findOne = orig.oFindOne;
    Child.create = orig.cCreate; Child.findOne = orig.cFindOne;
  }
}

// ── 7. signup.html wiring ─────────────────────────────────────────────────────
{
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const iAge = html.indexOf('<script src="/js/shared/child-age.js"></script>');
  const iSignup = html.indexOf('<script src="/js/auth/signup.js"></script>');
  assert.ok(iAge > 0 && iAge < iSignup, 'child-age.js loads before signup.js');
  assert.match(html, /<dialog id="ageDialog"[^>]*aria-labelledby="ageDialogTitle"[^>]*aria-describedby="ageDialogMessage"/);
  assert.match(html, /<h2 id="ageDialogTitle"[^>]*>Age Requirement Not Met<\/h2>/);
  assert.match(html, /<button type="button" class="btn btn-primary" id="ageDialogOkBtn">OK<\/button>/);
  // The Child Information step itself is unchanged: same fields, same buttons.
  const sp2 = html.slice(html.indexOf('id="sp2"'), html.indexOf('id="sp3"'));
  for (const id of ['childPhotoInput', 'childFirst', 'childLast', 'childMiddle', 'dob', 'childGender', 'ep2']) {
    assert.ok(sp2.includes(`id="${id}"`), `${id} still on the Child Information step`);
  }
  assert.match(sp2, /<input type="date" id="dob" aria-describedby="dobHelp">/);
  assert.match(sp2, /onclick="go\(3\)">Continue<\/button>/);
  const allIds = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  assert.strictEqual(allIds.length, new Set(allIds).size, 'no duplicate ids on the page');
  ok('signup.html: age notice dialog present, shared rule loads before signup.js, Child Information fields untouched');
}

// ── 8. js/auth/signup.js in a fake DOM: the Continue button ───────────────────
function makeEnv() {
  const els = {}; const focused = [];
  const el = (id) => (els[id] ||= {
    id, value: '', textContent: '', min: '', max: '', open: false, listeners: {}, style: {},
    classes: new Set(id === 's1' ? ['active'] : []),
    get classList() {
      const s = this.classes;
      return { add: (c) => s.add(c), remove: (c) => s.delete(c), contains: (c) => s.has(c) };
    },
    focus() { focused.push(id); }, scrollIntoView() {},
    addEventListener(type, cb) { this.listeners[type] = cb; },
    showModal() { this.open = true; },
    close() { if (!this.open) return; this.open = false; if (this.listeners.close) this.listeners.close(); },
  });
  const steps = ['s1', 'sp2', 'sp3', 'sp4', 'sp5', 'sd2', 'sd3', 'sd4', 'sd5'];
  let domReady = null;
  const document = {
    getElementById: (id) => el(id),
    querySelector: () => null,
    querySelectorAll: (sel) => (sel === '.form-step' ? steps.map(el) : []),
    addEventListener(type, cb) { if (type === 'DOMContentLoaded') domReady = cb; },
    createElement: () => ({ setAttribute() {}, appendChild() {}, scrollIntoView() {} }), createTextNode: (t) => ({ t }),
  };
  const window = { location: { href: '' } };
  const ctx = vm.createContext({
    document, window, localStorage: { setItem() {} }, fetch: async () => { throw new Error('no network in this test'); },
    console: { log() {}, warn() {}, error() {} }, setTimeout: () => 0, Promise, JSON, Intl, Date,
  });
  // Loaded the way signup.html loads them: the shared rule first, then the page script.
  vm.runInContext(fs.readFileSync(AGE_JS_PATH, 'utf8'), ctx, { filename: 'child-age.js' });
  vm.runInContext(fs.readFileSync(SIGNUP_JS_PATH, 'utf8'), ctx, { filename: 'signup.js' });
  domReady();
  const env = {
    els, el, focused, window, run: (expr) => vm.runInContext(expr, ctx),
    active: () => steps.filter((s) => el(s).classes.has('active')),
  };
  return env;
}

function fillChild(env, dob) {
  const typed = { childFirst: 'Justine', childLast: 'Dayak', childMiddle: '', dob, childGender: 'female' };
  Object.entries(typed).forEach(([k, v]) => { env.el(k).value = v; });
  return typed;
}

function toChildInfo(env) {
  env.run("selectedRole = 'parent'");
  env.run('go(2)');
  assert.deepStrictEqual(env.active(), ['sp2']);
}

{
  const today = localToday();

  // Picker limits are set on load.
  {
    const env = makeEnv();
    const range = eligibleBirthDateRange(today);
    assert.strictEqual(env.els.dob.min, range.min);
    assert.strictEqual(env.els.dob.max, range.max);
  }

  // The whole table through the real Continue handler.
  for (const [label, dob, expected] of ageTable(today)) {
    const env = makeEnv();
    toChildInfo(env);
    const typed = fillChild(env, dob);
    env.run('go(3)');
    if (expected === 'ok') {
      assert.deepStrictEqual(env.active(), ['sp3'], `${label}: moves on to Your Information`);
      assert.strictEqual(env.els.ageDialog.open, false, `${label}: no notice`);
      assert.strictEqual(env.els.ep2.textContent, '');
    } else {
      assert.deepStrictEqual(env.active(), ['sp2'], `${label}: stays on Child Information`);
      assert.strictEqual(env.els.ageDialog.open, true, `${label}: age notice shown`);
      assert.strictEqual(env.els.ageDialogTitle.textContent, 'Age Requirement Not Met');
      assert.strictEqual(env.els.ageDialogMessage.textContent, childAge.MESSAGES[expected], `${label}: ${expected} message`);
      assert.strictEqual(env.window.location.href, '', `${label}: no redirect`);
      // Closing it keeps the user here, with everything they typed.
      env.els.ageDialogOkBtn.listeners.click();
      assert.strictEqual(env.els.ageDialog.open, false);
      assert.deepStrictEqual(env.active(), ['sp2'], `${label}: still on Child Information after closing`);
      assert.strictEqual(env.focused[env.focused.length - 1], 'dob', `${label}: focus back on Date of Birth`);
    }
    Object.entries(typed).forEach(([k, v]) => assert.strictEqual(env.els[k].value, v, `${label}: ${k} preserved`));
  }
  ok('Continue: under 3 / 9 and over show the matching "Age Requirement Not Met" notice and stay on the step with every field intact; 3 to 8 (inclusive) continue');

  // Missing / invalid / future: the step's error line, no notice, no navigation.
  for (const [label, dob] of [['empty', ''], ['invalid', '2023-02-30'], ['future', bornAgo(today, { days: -1 })]]) {
    const env = makeEnv();
    toChildInfo(env);
    fillChild(env, dob);
    env.run('go(3)');
    assert.deepStrictEqual(env.active(), ['sp2'], `${label}: stays on Child Information`);
    assert.match(env.els.ep2.textContent, /^Please enter a valid date of birth before continuing\./, `${label}: required-field message`);
    assert.strictEqual(env.els.ageDialog.open, false, `${label}: not an age notice`);
    assert.strictEqual(env.focused[env.focused.length - 1], 'dob');
    // Changing the date clears the message.
    env.els.dob.listeners.change();
    assert.strictEqual(env.els.ep2.textContent, '');
  }
  ok('Continue: empty, impossible and future dates use the step\'s required-field message and do not advance');

  // Correcting an ineligible date lets the existing flow continue.
  {
    const env = makeEnv();
    toChildInfo(env);
    fillChild(env, bornAgo(today, { years: 2 }));
    env.run('go(3)');
    assert.deepStrictEqual(env.active(), ['sp2']);
    env.els.ageDialogOkBtn.listeners.click();
    env.els.dob.value = bornAgo(today, { years: 4 });
    env.run('go(3)');
    assert.deepStrictEqual(env.active(), ['sp3'], 'corrected date continues');
    // Later steps navigate as before, including Back to Your Information (also go(3)).
    Object.entries({ pFirst: 'Ana', pLast: 'Dayak', relationship: 'mother' }).forEach(([k, v]) => { env.el(k).value = v; });
    env.run('go(4)'); assert.deepStrictEqual(env.active(), ['sp4']);
    env.run('go(3)'); assert.deepStrictEqual(env.active(), ['sp3']);
    env.run('go(2)'); assert.deepStrictEqual(env.active(), ['sp2']);
    env.run('go(1)'); assert.deepStrictEqual(env.active(), ['s1']);
  }
  ok('Continue: correcting the date to an eligible one continues; Back/Continue on the other parent steps unchanged');

  // Pediatrician flow never sees the child rule.
  {
    const env = makeEnv();
    env.run("selectedRole = 'pediatrician'");
    env.el('dob').value = bornAgo(today, { years: 1 });
    env.run('go(2)'); assert.deepStrictEqual(env.active(), ['sd2']);
    env.el('dFirst').value = 'Ben'; env.el('dLast').value = 'Cruz';
    env.run('go(3)'); assert.deepStrictEqual(env.active(), ['sd3'], 'pediatrician Continue unaffected');
    assert.strictEqual(env.els.ageDialog.open, false);
  }
  ok('pediatrician steps navigate exactly as before');
}

routeTests()
  .then(() => {
    results.forEach((r) => console.log(`  ✓ ${r}`));
    console.log(`\nchild-age.test.js: ${results.length} checks passed`);
  })
  .catch((err) => {
    results.forEach((r) => console.log(`  ✓ ${r}`));
    console.error('\n✗ FAILED:', err && err.stack ? err.stack : err);
    process.exit(1);
  });
