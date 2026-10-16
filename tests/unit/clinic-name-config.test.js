// Admin clinic-name configuration (PUT/GET /api/payments/clinic-config):
//   - only admins can save; blank, whitespace-only, non-string and over-long
//     names are rejected without touching the settings document
//   - a valid save $sets only clinic.clinicName (trimmed) on the singleton
//   - clinicNameConfigured reports the stored field, not getClinic()'s
//     merged schema default, so "not configured" stays truthful
//   - the admin settings page and its script agree on element ids
// No database: SystemSetting's statics are stubbed.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SystemSetting = require('../../models/SystemSetting');
const paymentController = require('../../controllers/paymentController');

let stored = { singleton: 'default', clinic: { onlinePaymentEnabled: true } };
const writes = [];
SystemSetting.getClinic = async () => ({ ...new SystemSetting().clinic.toObject(), ...(stored.clinic || {}) });
SystemSetting.findOne = () => ({ select: () => ({ lean: async () => stored }) });
SystemSetting.findOneAndUpdate = async (filter, update, options) => {
  writes.push({ filter, update, options });
  for (const [k, v] of Object.entries(update.$set || {})) stored.clinic[k.replace(/^clinic\./, '')] = v;
  return stored;
};

function res() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
async function put(body, role = 'admin') {
  const r = res();
  await paymentController.updateClinicConfig({ body, user: { userId: 'u1', role } }, r);
  return r;
}

async function testNotConfigured() {
  const r = res();
  await paymentController.getClinicConfig({ user: { role: 'admin' } }, r);
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(r.body.clinicNameConfigured, false);
  // Receipts and payment pages keep their built-in default.
  assert.strictEqual(r.body.clinic.clinicName, 'KinderCura Clinic');
  assert.strictEqual(writes.length, 0);
}

async function testRejected() {
  for (const role of ['parent', 'pediatrician', 'secretary']) {
    assert.strictEqual((await put({ clinicName: 'X' }, role)).statusCode, 403, role);
  }
  for (const clinicName of ['', '   ', '\t\n', null, 42, { $gt: '' }, ['A'], 'a'.repeat(121)]) {
    const r = await put({ clinicName });
    assert.strictEqual(r.statusCode, 400, JSON.stringify(clinicName));
    assert.ok(r.body.error);
  }
  assert.strictEqual(writes.length, 0, 'nothing written for a rejected request');
}

async function testValidSave() {
  const r = await put({ clinicName: '  Sta. Rosa Pediatrics  ' });
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(writes.length, 1);
  const { filter, update, options } = writes[0];
  assert.deepStrictEqual(filter, { singleton: 'default' });
  assert.deepStrictEqual(update.$set, { 'clinic.clinicName': 'Sta. Rosa Pediatrics' }, 'only the name is set');
  assert.ok(options.upsert, 'one singleton, never a second document');
  assert.strictEqual(r.body.clinicNameConfigured, true);
  assert.strictEqual(r.body.clinic.clinicName, 'Sta. Rosa Pediatrics');
  assert.strictEqual(r.body.clinic.onlinePaymentEnabled, true);
  assert.strictEqual((await put({ clinicName: 'b'.repeat(120) })).statusCode, 200, '120 characters is allowed');
}

function testPageScriptContract() {
  const root = path.join(__dirname, '..', '..');
  const html = fs.readFileSync(path.join(root, 'ADMIN', 'admin-settings.html'), 'utf8');
  const js = fs.readFileSync(path.join(root, 'js', 'admin', 'admin-settings.js'), 'utf8');
  for (const id of ['clinicNameForm', 'clinicNameInput', 'clinicNameState', 'clinicNameSaveBtn']) {
    assert.ok(html.includes(`id="${id}"`), `page has #${id}`);
    assert.ok(js.includes(`'${id}'`), `script uses #${id}`);
  }
  assert.ok(/id="clinicNameInput"[^>]*maxlength="120"/.test(html), 'input limit matches the server');
  assert.ok(js.includes('CLINIC_NAME_MAX_LENGTH = 120'));
  // Only the name is sent, and status text is set with textContent, never innerHTML.
  assert.ok(js.includes("JSON.stringify({ clinicName })"));
  assert.ok(!/clinicName[^\n]*innerHTML|innerHTML[^\n]*clinicName/.test(js));
}

(async () => {
  await testNotConfigured();
  await testRejected();
  await testValidSave();
  testPageScriptContract();
  console.log('Clinic name config OK — admin-only, blank/invalid/over-long rejected without a write, only clinic.clinicName set on the singleton, configured flag reads the stored field, page and script agree');
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
