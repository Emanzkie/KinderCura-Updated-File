// One-time consultation setup modal on the pediatrician dashboard
// (js/pedia/consultation-setup.js). No DB, no network, fake DOM.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const setup = require('../../js/pedia/consultation-setup');

const GOOD = {
  phoneNumber: '0912 345 6789', clinicName: 'Sunny Clinic', institution: 'City Hospital', consultationFee: '500',
  maxPatientsPerDay: '12', days: ['Monday', 'Friday'], startTime: '08:00', endTime: '15:00',
};
const ok = (m) => console.log('  ok -', m);

// ── Fake DOM ────────────────────────────────────────────────────────────────
function makeDom() {
  const make = () => {
    const els = {};
    const el = {
      value: '', textContent: '', hidden: false, disabled: false, attrs: {}, on: {}, opened: 0, removed: false, checked: [],
      setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(t, f) { this.on[t] = f; }, focus() { el.focused = true; },
      querySelector: (s) => (els[s] ||= make()), querySelectorAll: () => el.checked.map((value) => ({ value })),
      showModal() { el.opened += 1; }, close() { el.on.close && el.on.close(); }, remove() { el.removed = true; },
    };
    return el;
  };
  const dialogs = [];
  const body = { classList: { set: new Set(), add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); } }, appendChild() {} };
  global.document = { createElement: () => { const d = make(); dialogs.push(d); return d; }, body };
  global.localStorage = { store: {}, setItem(k, v) { this.store[k] = v; } };
  return { dialogs, body };
}
const NEW_USER = { role: 'pediatrician', firstName: '<b>Ana</b>', phoneNumber: '09123456789', clinicName: 'Sunny Clinic', institution: null, consultationFee: null, availability: { days: [], startTime: '09:00', endTime: '17:00', maxPatientsPerDay: 10 } };

(async () => {
  // 1. When it shows
  assert.strictEqual(setup.needsSetup(NEW_USER), true);
  assert.strictEqual(setup.needsSetup({ ...NEW_USER, availability: { days: ['Monday'] } }), false);
  for (const role of ['admin', 'secretary', 'parent']) assert.strictEqual(setup.needsSetup({ ...NEW_USER, role }), false, role);
  for (const u of [null, undefined, {}, { role: 'pediatrician' }]) assert.strictEqual(setup.needsSetup(u), false);
  let dom = makeDom();
  global.apiFetch = async () => { throw new Error('offline'); };
  const warn = console.warn; console.warn = () => {};
  await setup.init();
  console.warn = warn;
  assert.strictEqual(dom.dialogs.length, 0, 'a failed check shows nothing');
  global.apiFetch = async () => ({ user: { ...NEW_USER, availability: { days: ['Monday'] } } });
  await setup.init();
  assert.strictEqual(dom.dialogs.length, 0, 'a configured account never sees it');
  global.apiFetch = async () => ({ user: NEW_USER });
  await setup.init();
  assert.strictEqual(dom.dialogs.length, 1);
  ok('shown only to a pediatrician with no available days; never on a failed check');

  // 2. Validation
  assert.deepStrictEqual(setup.validate(GOOD), {});
  for (const k of Object.keys(GOOD)) {
    const e = setup.validate({ ...GOOD, [k]: k === 'days' ? [] : '' });
    assert.ok(e[k], `${k} is required`);
  }
  for (const [k, bad] of [['phoneNumber', ['123', '0812345678', 'abc', '+63812345678']], ['consultationFee', ['0', '-1', 'x', 'Infinity']],
    ['maxPatientsPerDay', ['0', '51', '2.5', 'x']], ['startTime', ['25:00', '9am']], ['endTime', ['08:00', '07:59', '24:00']]]) {
    for (const v of bad) assert.ok(setup.validate({ ...GOOD, [k]: v })[k], `${k}=${v}`);
  }
  assert.deepStrictEqual(setup.validate({ ...GOOD, phoneNumber: '+639123456789' }), {});
  ok('every field is required and checked');

  // 3. Payload
  assert.deepStrictEqual(setup.buildPayload(GOOD), {
    phoneNumber: '0912 345 6789', clinicName: 'Sunny Clinic', institution: 'City Hospital', consultationFee: '500',
    availability: { days: ['Monday', 'Friday'], startTime: '08:00', endTime: '15:00', maxPatientsPerDay: '12' },
  });
  ok('only the setup fields are sent');

  // 4. Form: prefill, required, one save, server error, success
  dom = makeDom();
  const dialog = setup.open(NEW_USER);
  const $ = (id) => dialog.querySelector(`#cs-${id}`);
  assert.strictEqual($('title').textContent, 'Welcome, Dr. <b>Ana</b>!', 'the name is set as text');
  assert.ok(!dialog.innerHTML.includes('<b>Ana'));
  assert.deepStrictEqual(['phoneNumber', 'clinicName', 'institution', 'consultationFee', 'startTime', 'maxPatientsPerDay'].map((n) => $(n).value),
    ['09123456789', 'Sunny Clinic', '', '', '09:00', 10]);
  const calls = [];
  let release;
  global.apiFetch = (url, o) => { calls.push([url, o.method, JSON.parse(o.body)]); return new Promise((res, rej) => { release = { res, rej }; }); };
  const submit = () => $('form').on.submit({ preventDefault() {} });
  await submit();
  assert.strictEqual(calls.length, 0, 'an incomplete form is not sent');
  assert.ok($('institution-err').textContent && $('days-err').textContent);
  for (const [k, v] of Object.entries(GOOD)) if (k !== 'days') $(k).value = v;
  dialog.checked = GOOD.days;
  let p = submit();
  submit();
  assert.strictEqual(calls.length, 1, 'a double click saves once');
  assert.deepStrictEqual(calls[0], ['/auth/pediatrician/settings', 'PUT', setup.buildPayload(GOOD)]);
  release.rej(new Error('<i>Server says no</i>'));
  await p;
  assert.strictEqual($('form-err').textContent, '<i>Server says no</i>');
  assert.ok(!$('form').hidden && !$('save').disabled, 'the form is kept after an error');

  // Not dismissible until saved
  let prevented = false;
  dialog.on.cancel({ preventDefault() { prevented = true; } });
  assert.ok(prevented, 'Escape does not close it');
  dialog.close();
  assert.ok(dialog.opened === 2 && !dialog.removed, 'a forced close reopens it');
  let out = 0;
  global.doLogout = () => { out += 1; };
  $('logout').on.click();
  assert.strictEqual(out, 1);

  p = submit();
  release.res({ user: { role: 'pediatrician', availability: { days: GOOD.days } } });
  await p;
  assert.ok($('form').hidden && $('done').hidden === false);
  assert.ok(/anytime through <strong>Profile Icon &gt; Settings<\/strong>/.test(dialog.innerHTML));
  assert.ok(global.localStorage.store.kc_user);
  $('close').on.click();
  assert.ok(dialog.removed && !dom.body.classList.set.has('cs-open'));
  ok('prefilled, saved once, errors kept, not dismissible until saved, then the Settings message');

  // 5. Wiring
  const html = fs.readFileSync(path.join(root, 'PEDIA/pediatrician-dashboard.html'), 'utf8');
  assert.ok(html.includes('/css/consultation-setup.css'));
  assert.ok(html.indexOf('/js/pedia/consultation-setup.js') > html.indexOf('/js/pedia/pediatrician-dashboard.js'), 'loads after the page script it uses');
  const { availability } = require('../../models/User').schema.paths;
  assert.ok(availability, 'uses the existing availability field');
  ok('wired on the dashboard after its script');

  console.log('Consultation setup tests OK');
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
