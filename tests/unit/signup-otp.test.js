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
    sendOtpBtn: 'I Agree & Continue', resendOtpBtn: 'Resend Code', verifyBtn: 'Verify & Continue',
    dSendOtpBtn: 'I Agree & Continue', dResendOtpBtn: 'Resend Code', dVerifyBtn: 'Verify & Continue',
  }).forEach(([id, label]) => { el(id).textContent = label; });
  return { els, el, fetchCalls, run: (e) => vm.runInContext(e, ctx) };
}

function fillParent(env) {
  Object.entries({ pFirst: 'A', pLast: 'B', pUsername: 'p', pEmail: 'new.parent@example.invalid', pPassword: 'pw-long-enough', pConfirm: 'pw-long-enough' })
    .forEach(([k, v]) => { env.el(k).value = v; });
  env.el('pAcceptTerms').checked = true; env.el('pAckPrivacy').checked = true;
}
function fillDoctor(env) {
  Object.entries({ dFirst: 'B', dLast: 'C', dUsername: 'd', dEmail: 'new.doc@example.invalid', dPassword: 'pw-long-enough', dConfirm: 'pw-long-enough' })
    .forEach(([k, v]) => { env.el(k).value = v; });
  env.el('dAcceptTerms').checked = true; env.el('dAckPrivacy').checked = true;
}

const ok = (m) => console.log('  ok -', m);

// Mail-failure labelling. The distinction that matters in production: a host
// that blocks outbound SMTP produces a socket-level error, which must NOT be
// reported as a generic send failure — it is a connectivity fault and points at
// the network, not at the credentials or the message.
function mailErrorTests() {
  const classify = require(path.join(ROOT, 'routes/auth.js'))._classifyMailError;
  assert.strictEqual(typeof classify, 'function', 'routes/auth.js must export the classifier test seam');

  const cases = [
    // real nodemailer shapes, captured from live failures
    [{ code: 'ETIMEDOUT' },                          'EMAIL_CONNECTION_FAILED', 502, 'blocked / dropped SMTP port'],
    [{ code: 'ESOCKET', errno: -4078, syscall: 'connect' }, 'EMAIL_CONNECTION_FAILED', 502, 'connection refused'],
    [{ code: 'EDNS', errno: -3008, syscall: 'getaddrinfo' }, 'EMAIL_CONNECTION_FAILED', 502, 'DNS failure'],
    [{ code: 'ECONNECTION' },                        'EMAIL_CONNECTION_FAILED', 502, 'generic connection error'],
    [{ message: 'ECONNREFUSED 173.194.76.109:465' }, 'EMAIL_CONNECTION_FAILED', 502, 'errno only in the message'],
    [{ code: 'EAUTH', responseCode: 535 },           'EMAIL_AUTH_FAILED',       503, 'bad App Password'],
    [{ responseCode: 535 },                          'EMAIL_AUTH_FAILED',       503, '535 without a code'],
    [{ message: 'MAIL_TIMEOUT after 8500ms' },       'EMAIL_TIMEOUT',           502, 'our own deadline'],
    [{ code: 'EENVELOPE', responseCode: 553 },       'EMAIL_SEND_FAILED',       502, 'message refused after connecting'],
    [{},                                             'EMAIL_SEND_FAILED',       502, 'unknown'],
  ];

  for (const [err, label, status, why] of cases) {
    const got = classify(err);
    assert.strictEqual(got.label, label, `${why}: expected ${label}, got ${got.label}`);
    assert.strictEqual(got.status, status, `${why}: expected HTTP ${status}, got ${got.status}`);
    assert.ok(got.clientMessage && !/password|pass|secret|@/i.test(got.clientMessage), `${why}: client message leaks nothing`);
    // the echoed detail is protocol-level only
    assert.deepStrictEqual(Object.keys(got.smtp).sort(), ['code', 'command', 'responseCode']);
  }

  // An auth failure must never be described as a connectivity problem: Gmail
  // answering at all proves the network path works.
  assert.notStrictEqual(classify({ code: 'EAUTH', responseCode: 535 }).label, 'EMAIL_CONNECTION_FAILED');
  ok('mail errors: blocked port / refused / DNS -> EMAIL_CONNECTION_FAILED (502), 535 -> EMAIL_AUTH_FAILED (503), deadline -> EMAIL_TIMEOUT, envelope -> EMAIL_SEND_FAILED');
}

// The OTP value must never reach a log line or a response body.
function noSecretLeakTests() {
  const src = fs.readFileSync(path.join(ROOT, 'routes/auth.js'), 'utf8');
  const sendOtp = src.slice(src.indexOf("router.post('/send-otp'"), src.indexOf("router.post('/verify-otp'"));
  const logLines = sendOtp.split('\n').filter((l) => /console\.(log|error|warn)/.test(l));
  for (const line of logLines) {
    assert.ok(!/\botp\b/.test(line.replace(/\[OTP\]/g, '').replace(/OTP /g, '')),
      `a /send-otp log line may reference the otp variable: ${line.trim()}`);
  }
  assert.ok(!/res\.json\([^)]*\botp\b/.test(sendOtp), 'the OTP must never be returned in a response');
  assert.ok(/EMAIL_PASS = String\(process\.env\.EMAIL_PASS \|\| ''\)\.replace/.test(src), 'EMAIL_PASS whitespace is stripped');
  // Naming EMAIL_PASS inside a message string is fine ("EMAIL_USER / EMAIL_PASS
  // missing"); interpolating or passing the variable is not.
  assert.ok(!/\$\{\s*EMAIL_PASS\s*\}/.test(src), 'EMAIL_PASS is never interpolated into a string');
  assert.ok(!/console\.\w+\([^)]*,\s*EMAIL_PASS\s*[,)]/.test(src), 'EMAIL_PASS is never passed to a logger');
  assert.ok(!/\$\{\s*EMAIL_USER\s*\}/.test(src.replace(/from: `"KinderCura" <\$\{EMAIL_USER\}>`/g, '')),
    'EMAIL_USER is interpolated only into the From header');
  ok('secrets: no /send-otp log references the OTP value, no OTP in any response, EMAIL_PASS never logged');
}

// HTTPS email transport. Render blocks outbound SMTP, so this is the path that
// actually carries production OTP mail; its request shape is checked against
// each provider's documented API, and its failures must land on the same labels
// the SMTP path uses.
async function httpEmailTests() {
  const httpEmail = require(path.join(ROOT, 'services/httpEmail.js'));
  const classify = require(path.join(ROOT, 'routes/auth.js'))._classifyMailError;
  const saved = { key: process.env.EMAIL_API_KEY, provider: process.env.EMAIL_PROVIDER, from: process.env.EMAIL_FROM, user: process.env.EMAIL_USER };
  const realFetch = global.fetch;

  const withEnv = (env, fn) => {
    Object.assign(process.env, env);
    return fn();
  };
  const capture = (responder) => {
    const seen = [];
    global.fetch = async (url, init) => { seen.push({ url, init }); return responder(url, init); };
    return seen;
  };
  const jsonResponse = (status, body) => ({
    ok: status >= 200 && status < 300, status,
    json: async () => body, text: async () => JSON.stringify(body),
  });

  process.env.EMAIL_FROM = ''; process.env.EMAIL_USER = 'sender@kindercura.com';

  // Provider detected from the key prefix; no extra configuration needed.
  withEnv({ EMAIL_API_KEY: 're_abc123', EMAIL_PROVIDER: '' }, () => {
    assert.strictEqual(httpEmail.providerName(), 'resend');
    assert.strictEqual(httpEmail.httpEmailConfigured(), true);
  });
  withEnv({ EMAIL_API_KEY: 'xkeysib-abc123', EMAIL_PROVIDER: '' }, () => {
    assert.strictEqual(httpEmail.providerName(), 'brevo');
  });
  // An unrecognised key must NOT be treated as usable — guessing an API shape
  // would reproduce exactly the opaque failure this replaces.
  withEnv({ EMAIL_API_KEY: 'mystery-key', EMAIL_PROVIDER: '' }, () => {
    assert.strictEqual(httpEmail.httpEmailConfigured(), false);
  });
  // No key at all means the SMTP path stays in charge.
  withEnv({ EMAIL_API_KEY: '', EMAIL_PROVIDER: '' }, () => {
    assert.strictEqual(httpEmail.httpEmailConfigured(), false);
  });

  // Resend: POST https://api.resend.com/emails, Bearer auth, {from,to[],subject,html}
  {
    const seen = capture(() => jsonResponse(200, { id: 'msg-1' }));
    const out = await withEnv({ EMAIL_API_KEY: 're_abc123', EMAIL_PROVIDER: '' },
      () => httpEmail.sendViaHttp({ to: 'p@example.invalid', subject: 'S', html: '<b>H</b>' }, 5000));
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].url, 'https://api.resend.com/emails');
    assert.strictEqual(seen[0].init.method, 'POST');
    assert.strictEqual(seen[0].init.headers.Authorization, 'Bearer re_abc123');
    const body = JSON.parse(seen[0].init.body);
    assert.strictEqual(body.from, 'KinderCura <sender@kindercura.com>');
    assert.deepStrictEqual(body.to, ['p@example.invalid']);
    assert.strictEqual(body.subject, 'S');
    assert.strictEqual(body.html, '<b>H</b>');
    assert.strictEqual(out.messageId, 'msg-1');
    assert.strictEqual(out.provider, 'resend');
  }

  // Brevo: POST https://api.brevo.com/v3/smtp/email, api-key header,
  // {sender:{email,name}, to:[{email}], subject, htmlContent}
  {
    const seen = capture(() => jsonResponse(201, { messageId: '<abc@relay>' }));
    const out = await withEnv({ EMAIL_API_KEY: 'xkeysib-abc123', EMAIL_PROVIDER: '' },
      () => httpEmail.sendViaHttp({ to: 'p@example.invalid', subject: 'S', html: '<b>H</b>' }, 5000));
    assert.strictEqual(seen[0].url, 'https://api.brevo.com/v3/smtp/email');
    assert.strictEqual(seen[0].init.headers['api-key'], 'xkeysib-abc123');
    assert.ok(!seen[0].init.headers.Authorization, 'Brevo uses api-key, not Authorization');
    const body = JSON.parse(seen[0].init.body);
    assert.deepStrictEqual(body.sender, { email: 'sender@kindercura.com', name: 'KinderCura' });
    assert.deepStrictEqual(body.to, [{ email: 'p@example.invalid' }]);
    assert.strictEqual(body.htmlContent, '<b>H</b>');
    assert.ok(!('html' in body), 'Brevo expects htmlContent');
    assert.strictEqual(out.messageId, '<abc@relay>');
  }

  // Failure mapping, and the key must never surface in an error message.
  const failures = [
    [() => jsonResponse(401, { message: 'bad key re_abc123' }), 'EMAIL_AUTH_FAILED', 503, 'rejected key'],
    [() => jsonResponse(403, { message: 'forbidden' }),         'EMAIL_AUTH_FAILED', 503, 'forbidden key'],
    [() => jsonResponse(422, { message: 'sender not verified' }), 'EMAIL_SEND_FAILED', 502, 'unverified sender'],
    [() => jsonResponse(500, { message: 'boom' }),              'EMAIL_SEND_FAILED', 502, 'provider outage'],
    [() => { const e = new Error('fetch failed'); e.cause = { code: 'ENOTFOUND' }; throw e; }, 'EMAIL_CONNECTION_FAILED', 502, 'DNS failure'],
    [() => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }, 'EMAIL_TIMEOUT', 502, 'our deadline'],
  ];
  for (const [responder, label, status, why] of failures) {
    capture(responder);
    let thrown = null;
    try {
      await withEnv({ EMAIL_API_KEY: 're_abc123', EMAIL_PROVIDER: '' },
        () => httpEmail.sendViaHttp({ to: 'p@example.invalid', subject: 'S', html: 'H' }, 5000));
    } catch (e) { thrown = e; }
    assert.ok(thrown, `${why}: must throw rather than report success`);
    const got = classify(thrown);
    assert.strictEqual(got.label, label, `${why}: expected ${label}, got ${got.label}`);
    assert.strictEqual(got.status, status, `${why}: expected HTTP ${status}`);
    assert.ok(!/re_abc123|xkeysib-/.test(thrown.message), `${why}: the API key must never appear in an error`);
  }

  // The key check sends no mail.
  {
    const seen = capture(() => jsonResponse(200, { data: [] }));
    await withEnv({ EMAIL_API_KEY: 're_abc123', EMAIL_PROVIDER: '' }, () => httpEmail.verifyHttpEmail(5000));
    assert.strictEqual(seen[0].init.method, 'GET', 'the probe must not POST a message');
    assert.strictEqual(seen[0].url, 'https://api.resend.com/domains');
  }

  global.fetch = realFetch;
  process.env.EMAIL_API_KEY = saved.key ?? ''; process.env.EMAIL_PROVIDER = saved.provider ?? '';
  process.env.EMAIL_FROM = saved.from ?? ''; process.env.EMAIL_USER = saved.user ?? '';

  // The API key must never be reachable from anything the browser loads.
  for (const f of ['js/auth/signup.js', 'SIGN-UP,LOGIN/signup.html']) {
    assert.ok(!/EMAIL_API_KEY/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')), `${f} must not reference EMAIL_API_KEY`);
  }
  ok('https transport: Resend + Brevo request shapes match their docs, key auto-detected, failures map to the same labels, key never leaked or shipped to the browser');
}

(async () => {
  // 1. Every id the JS touches exists in the markup.
  for (const id of ['pEmail','pPassword','pConfirm','pUsername','pConsentDialog','ep4c','pCredentialsNextBtn','otpEmail','o1','o2','o3','o4','sp5','verifyBtn','sendOtpBtn','resendOtpBtn',
                    'dEmail','dPassword','dConfirm','dUsername','dConsentDialog','ed3c','dCredentialsNextBtn','dOtpEmail','d1','d2','d3','d4','sd4','dVerifyBtn','dSendOtpBtn','dResendOtpBtn']) {
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
    assert.strictEqual(env.els.sendOtpBtn.textContent, 'I Agree & Continue', 'Send button label restored');
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
    assert.strictEqual(env.els.sendOtpBtn.textContent, 'I Agree & Continue');
    assert.match(env.els.ep4c.textContent, /Email service is not configured/, 'shown in the consent modal, where I Agree & Continue was clicked');
    assert.ok(!env.els.sp5 || !env.els.sp5.classList.added.includes('active'), 'does not advance on failure');
    ok('failure path: server message shown, button restored, no advance to the OTP step');
  }

  mailErrorTests();
  noSecretLeakTests();
  await httpEmailTests();

  console.log('\nOTP UI tests OK');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
