// Regression tests for the sign-up OTP step (parent sp5 / pediatrician sd4).
//
// The bug these lock down: the "Send Verification Code" buttons carried no id,
// so sendOTP() / sendDoctorOTP() put their loading state on 'verifyBtn' and
// 'dVerifyBtn' — the Verify & Continue buttons on the step that had not been
// shown yet. The Send button therefore never disabled and never changed label
// (so repeated clicks each replaced the OTP that was already in the user's
// inbox), while the Verify button on the OTP step arrived disabled and, after
// two overlapping sends, kept the label "Sending..." permanently.
//
// Runs in a fake DOM, mirroring the harness
// used by tests/unit/signup-consent.test.js.
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const signupJs = fs.readFileSync(path.join(ROOT, 'js/auth/signup.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'SIGN-UP,LOGIN/signup.html'), 'utf8');

function makeEnv(sendDelayMs = 20) {
  const els = {}; const fetchCalls = [];
  const el = (id) => (els[id] ||= {
    id, value: '', checked: false, textContent: '', disabled: false, style: {}, files: [], attrs: {}, listeners: {}, children: [], className: '',
    classList: { added: [], add(c) { this.added.push(c); }, remove() {} },
    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k]; },
    focus() {}, scrollIntoView() {}, appendChild(c) { this.children.push(c); }, addEventListener() {},
  });
  const document = {
    getElementById: (id) => el(id), querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, createElement: () => ({ setAttribute() {}, appendChild() {}, scrollIntoView() {} }), createTextNode: (t) => ({ t }),
  };
  const ctx = vm.createContext({
    document, window: { location: { href: '' } }, localStorage: { setItem() {} },
    fetch: async (url, opts) => {
      fetchCalls.push({ url, opts });
      await new Promise((r) => setTimeout(r, sendDelayMs));
      return { ok: true, status: 200, json: async () => ({ success: true }), text: async () => '{}' };
    },
    FormData, console: { log() {}, warn() {}, error() {} }, setTimeout, Promise, JSON, Boolean, String, RegExp, Date, Math, Object,
  });
  vm.runInContext(signupJs, ctx, { filename: 'signup.js' });
  // Seed the four buttons with the labels the real markup gives them, so an
  // assertion about a button the code should NOT have touched is meaningful.
  Object.entries({
    sendOtpBtn: 'Send Verification Code', resendOtpBtn: 'Resend Code', verifyBtn: 'Verify & Continue',
    dSendOtpBtn: 'Send Verification Code', dResendOtpBtn: 'Resend Code', dVerifyBtn: 'Verify & Continue',
  }).forEach(([id, label]) => { el(id).textContent = label; });
  return { els, el, fetchCalls, run: (e) => vm.runInContext(e, ctx) };
}

function fillParent(env) {
  Object.entries({ pUsername: 'p', pEmail: 'new.parent@example.invalid', pPassword: 'pw-long-enough', pConfirm: 'pw-long-enough' })
    .forEach(([k, v]) => { env.el(k).value = v; });
  env.el('pAcceptTerms').checked = true; env.el('pAckPrivacy').checked = true;
}
function fillDoctor(env) {
  Object.entries({ dFirst: 'B', dLast: 'C', dUsername: 'd', dEmail: 'new.doc@example.invalid', dPassword: 'pw-long-enough', dConfirm: 'pw-long-enough' })
    .forEach(([k, v]) => { env.el(k).value = v; });
  env.el('dAcceptTerms').checked = true; env.el('dAckPrivacy').checked = true;
}

const ok = (m) => console.log('  ok -', m);

(async () => {
  // 1. Every id the JS touches exists in the markup.
  for (const id of ['pEmail','pPassword','pConfirm','pUsername','otpEmail','o1','o2','o3','o4','sp5','verifyBtn','sendOtpBtn','resendOtpBtn',
                    'dEmail','dPassword','dConfirm','dUsername','dOtpEmail','d1','d2','d3','d4','sd4','dVerifyBtn','dSendOtpBtn','dResendOtpBtn']) {
    assert.ok(new RegExp(`id="${id}"`).test(html), `signup.html is missing id="${id}"`);
  }
  assert.ok(/<script src="\/js\/auth\/signup\.js"><\/script>/.test(html), 'signup.html must load /js/auth/signup.js');
  assert.ok(!/verify-email\.js/.test(html), 'signup.html must not load the retired verify-email.js');
  ok('signup.html: all parent + pediatrician ids present, signup.js loaded, no legacy verify-email.js');

  // 2. Parent: the SEND button shows progress and the next-step Verify button is untouched.
  {
    const env = makeEnv(30);
    fillParent(env);
    const p = env.run('sendOTP')();
    assert.strictEqual(env.els.sendOtpBtn.disabled, true, 'Send button disables immediately');
    assert.strictEqual(env.els.sendOtpBtn.textContent, 'Sending...', 'Send button shows Sending...');
    assert.notStrictEqual(env.els.verifyBtn.textContent, 'Sending...', 'the next step Verify button is NOT relabelled');
    assert.strictEqual(env.els.verifyBtn.disabled, false, 'the next step Verify button is NOT disabled');
    await p;
    assert.strictEqual(env.els.sendOtpBtn.disabled, false, 'Send button re-enables');
    assert.strictEqual(env.els.sendOtpBtn.textContent, 'Send Verification Code', 'Send button label restored');
    assert.ok(env.els.sp5.classList.added.includes('active'), 'sp5 OTP step shown');
    assert.strictEqual(env.els.otpEmail.textContent, 'new.parent@example.invalid', 'OTP email display updated');
    ok('parent: Send button disables + reads "Sending...", verifyBtn untouched, sp5 shown, label restored');
  }

  // 3. Parent: rapid double-click sends exactly one request.
  {
    const env = makeEnv(40);
    fillParent(env);
    const a = env.run('sendOTP')(); const b = env.run('sendOTP')(); const c = env.run('sendOTP')();
    await Promise.all([a, b, c]);
    assert.strictEqual(env.fetchCalls.filter((f) => f.url.endsWith('/send-otp')).length, 1, 'only ONE send-otp request');
    assert.strictEqual(env.els.sendOtpBtn.disabled, false, 'button usable again afterwards');
    ok('parent: three rapid clicks produce exactly one /send-otp request; button not left disabled');
  }

  // 4. Parent: send then verify — verifyBtn must never be stuck reading "Sending...".
  {
    const env = makeEnv(10);
    fillParent(env);
    await env.run('sendOTP')();
    ['o1','o2','o3','o4'].forEach((id, i) => { env.el(id).value = String(i + 1); });
    await env.run('verifyAndRegister')();
    assert.strictEqual(env.els.verifyBtn.textContent, 'Verify & Continue', 'verifyBtn keeps its own label');
    assert.strictEqual(env.els.verifyBtn.disabled, false, 'verifyBtn not left disabled');
    ok('parent: verifyBtn keeps its label through send + verify (never stuck on "Sending...")');
  }

  // 5. Resend loads the resend button, not the verify button, and stays on sp5.
  {
    const env = makeEnv(20);
    fillParent(env);
    const p = env.run('sendOTP')(true);
    assert.strictEqual(env.els.resendOtpBtn.disabled, true, 'resend button disables');
    assert.strictEqual(env.els.resendOtpBtn.textContent, 'Resending...');
    assert.strictEqual(env.els.verifyBtn.disabled, false, 'verify button untouched during resend');
    await p;
    assert.strictEqual(env.fetchCalls[0].url, '/api/auth/send-otp', 'resend reuses /api/auth/send-otp');
    assert.strictEqual(env.els.resendOtpBtn.textContent, 'Resend Code', 'resend label restored');
    assert.match(env.els.ep5s.textContent, /new verification code was sent/);
    assert.ok(env.els.sp5.classList.added.includes('active'), 'still on the OTP step');
    ok('parent resend: same endpoint, own button, confirmation message, stays on sp5');
  }

  // 6. Pediatrician: same guarantees, and sd4 is shown.
  {
    const env = makeEnv(30);
    fillDoctor(env);
    const p = env.run('sendDoctorOTP')();
    assert.strictEqual(env.els.dSendOtpBtn.disabled, true);
    assert.strictEqual(env.els.dSendOtpBtn.textContent, 'Sending...');
    assert.strictEqual(env.els.dVerifyBtn.disabled, false, 'dVerifyBtn untouched');
    env.run('sendDoctorOTP')();
    await p;
    assert.strictEqual(env.fetchCalls.filter((f) => f.url.endsWith('/send-otp')).length, 1, 'one request despite double click');
    assert.ok(env.els.sd4.classList.added.includes('active'), 'sd4 OTP step shown');
    assert.strictEqual(env.els.dOtpEmail.textContent, 'new.doc@example.invalid');
    assert.strictEqual(env.els.dSendOtpBtn.disabled, false);
    ok('pediatrician: Send button loads, one request on double click, sd4 shown, dVerifyBtn untouched');
  }

  // 7. Pediatrician: verify moves to sd5 and leaves dVerifyBtn usable.
  {
    const env = makeEnv(10);
    fillDoctor(env);
    await env.run('sendDoctorOTP')();
    ['d1','d2','d3','d4'].forEach((id, i) => { env.el(id).value = String(i + 1); });
    await env.run('verifyDoctorOTP')();
    assert.ok(env.els.sd5.classList.added.includes('active'), 'sd5 professional step shown');
    assert.strictEqual(env.els.dVerifyBtn.textContent, 'Verify & Continue');
    assert.strictEqual(env.els.dVerifyBtn.disabled, false);
    ok('pediatrician: verify advances to sd5, dVerifyBtn label and state intact');
  }

  // 8. A failing send restores the button and surfaces the server message.
  {
    const env = makeEnv(10);
    fillParent(env);
    env.run("fetch = async (url, opts) => ({ ok: false, status: 503, json: async () => ({ error: 'Email service is not configured. Please contact support.', code: 'EMAIL_NOT_CONFIGURED' }) })");
    await env.run('sendOTP')();
    assert.strictEqual(env.els.sendOtpBtn.disabled, false, 'button restored after failure');
    assert.strictEqual(env.els.sendOtpBtn.textContent, 'Send Verification Code');
    assert.match(env.els.ep4.textContent, /Email service is not configured/);
    assert.ok(!env.els.sp5 || !env.els.sp5.classList.added.includes('active'), 'does not advance on failure');
    ok('failure path: server message shown, button restored, no advance to the OTP step');
  }

  console.log('\nOTP UI tests OK');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
