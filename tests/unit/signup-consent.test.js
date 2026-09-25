// Unit tests for the sign-up Terms of Service / consent flow.
//
// Source of truth for every word of the Terms and the three selections:
//   SIGN-UP,LOGIN/legal/KINDERCURA-TERMS-OF-SERVICE.txt  (section 17)
// The checkbox labels in signup.html are compared against that file line by line,
// so a wording drift fails this test instead of shipping.
//
// No DB and no network: models are monkey-patched, the /register route is exercised
// over an in-process HTTP server, and js/auth/signup.js runs in a fake DOM (node vm).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');

const ROOT = path.join(__dirname, '..', '..');
const TERMS_PATH = path.join(ROOT, 'SIGN-UP,LOGIN', 'legal', 'KINDERCURA-TERMS-OF-SERVICE.txt');
const HTML_PATH = path.join(ROOT, 'SIGN-UP,LOGIN', 'signup.html');
const JS_PATH = path.join(ROOT, 'js', 'auth', 'signup.js');
const CSS_PATH = path.join(ROOT, 'CSS files', 'signup.css');

const termsText = fs.readFileSync(TERMS_PATH, 'utf8').replace(/^﻿/, '');
const termsLines = termsText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const html = fs.readFileSync(HTML_PATH, 'utf8');
const css = fs.readFileSync(CSS_PATH, 'utf8');
const signupJs = fs.readFileSync(JS_PATH, 'utf8');

// The three selections, exactly as written in the source file (minus the leading ☐).
const checkboxLines = termsLines.filter((l) => l.startsWith('☐')).map((l) => l.replace(/^☐\s*/, ''));
assert.strictEqual(checkboxLines.length, 3, 'the Terms file must define exactly three selections');
const [TERMS_LABEL, PRIVACY_LABEL, ML_LABEL] = checkboxLines;

const { TERMS_VERSION, parseSignupConsent } = require('../../constants/legalConsent');
const User = require('../../models/User');

const results = [];
const ok = (label) => results.push(label);

// ── 0. Source file <-> constants ──────────────────────────────────────────────
{
  const versionLine = termsLines.find((l) => /^Version:/.test(l));
  assert.strictEqual(versionLine, `Version: ${TERMS_VERSION}`, 'TERMS_VERSION must match the "Version:" line of the Terms file');
  assert.ok(termsLines.includes('[Insert Date]') || termsLines.some((l) => l.includes('[Insert Date]')), 'placeholders stay as written in the source');
  ok('constants: TERMS_VERSION matches the Terms file');
}

// ── 1. Server rule: cases A–E ────────────────────────────────────────────────
{
  const A = parseSignupConsent({ acceptTerms: false, acknowledgePrivacy: false, mlConsent: false });
  const B = parseSignupConsent({ acceptTerms: true, acknowledgePrivacy: false });
  const C = parseSignupConsent({ acceptTerms: false, acknowledgePrivacy: true });
  assert.strictEqual(A.ok, false, 'A: Terms unchecked + Privacy unchecked -> blocked');
  assert.strictEqual(B.ok, false, 'B: Terms checked + Privacy unchecked -> blocked');
  assert.strictEqual(C.ok, false, 'C: Terms unchecked + Privacy checked -> blocked');
  assert.match(A.error, /Terms of Service/); assert.match(A.error, /Privacy Notice/);
  assert.match(B.error, /Privacy Notice/); assert.doesNotMatch(B.error, /accept the Terms/);
  assert.match(C.error, /Terms of Service/); assert.doesNotMatch(C.error, /acknowledge the Privacy/);

  const now = new Date('2026-09-25T08:00:00Z');
  const D = parseSignupConsent({ acceptTerms: true, acknowledgePrivacy: true, mlConsent: false }, now);
  const E = parseSignupConsent({ acceptTerms: true, acknowledgePrivacy: true, mlConsent: true }, now);
  assert.strictEqual(D.ok, true, 'D: both required checked + ML unchecked -> allowed');
  assert.strictEqual(E.ok, true, 'E: both required checked + ML checked -> allowed');
  assert.strictEqual(D.consents.mlConsentGiven, false, 'declining ML is recorded as false, not "never asked"');
  assert.strictEqual(E.consents.mlConsentGiven, true);
  assert.strictEqual(D.consents.termsVersion, TERMS_VERSION);
  assert.strictEqual(D.consents.termsAcceptedAt.getTime(), now.getTime());
  assert.strictEqual(D.consents.privacyNoticeAcknowledgedAt.getTime(), now.getTime());

  // ML omitted entirely (older client / API caller) is still just "declined", never a block.
  assert.strictEqual(parseSignupConsent({ acceptTerms: true, acknowledgePrivacy: true }).ok, true);
  // Multipart form values arrive as strings.
  assert.strictEqual(parseSignupConsent({ acceptTerms: 'true', acknowledgePrivacy: 'true', mlConsent: 'false' }).consents.mlConsentGiven, false);
  assert.strictEqual(parseSignupConsent({ acceptTerms: 'true', acknowledgePrivacy: 'true', mlConsent: 'true' }).consents.mlConsentGiven, true);
  // Anything that is not an explicit yes is "not selected".
  for (const bad of [undefined, null, '', 'false', 'no', '0', 0, [], {}, 'TRUEISH']) {
    assert.strictEqual(parseSignupConsent({ acceptTerms: bad, acknowledgePrivacy: true }).ok, false, `acceptTerms=${JSON.stringify(bad)} must not count`);
  }
  assert.strictEqual(parseSignupConsent(undefined).ok, false);
  assert.strictEqual(parseSignupConsent({}).ok, false);
  // ML consent alone never satisfies the required boxes.
  assert.strictEqual(parseSignupConsent({ mlConsent: true }).ok, false);
  ok('server rule: A blocked, B blocked, C blocked, D allowed, E allowed (+ string/absent/garbage inputs)');
}

// ── 2. User model: reuse + additive, legacy accounts unaffected ───────────────
{
  const base = { firstName: 'A', lastName: 'B', username: 'ab', email: 'ab@example.com', passwordHash: 'x', role: 'parent' };
  const legacy = new User(base);
  assert.strictEqual(legacy.validateSync(), undefined, 'a legacy-shaped account (no consents) is still valid');
  assert.strictEqual(legacy.consents.termsVersion, null);
  assert.strictEqual(legacy.consents.termsAcceptedAt, null);
  assert.strictEqual(legacy.consents.mlConsentGiven, null, 'null = never asked (pre-existing accounts)');
  const withConsent = new User({ ...base, consents: parseSignupConsent({ acceptTerms: true, acknowledgePrivacy: true, mlConsent: true }).consents });
  assert.strictEqual(withConsent.validateSync(), undefined);
  assert.strictEqual(withConsent.consents.mlConsentGiven, true);
  assert.strictEqual(withConsent.consents.termsVersion, TERMS_VERSION);
  ok('User model: consents default to null for legacy accounts and store the recorded selections');
}

// ── 3. The real /register route (models mocked; no DB) ───────────────────────
const chain = (v) => { const o = { sort: () => o, select: () => o, lean: async () => v, then: (a, b) => Promise.resolve(v).then(a, b) }; return o; };

async function routeTests() {
  process.env.JWT_SECRET = process.env.JWT_SECRET || ('unit-test-only-' + Math.random());
  const express = require('express');
  const OtpCode = require('../../models/OtpCode');
  const authRouter = require('../../routes/auth');

  const orig = { log: console.log, warn: console.warn, uFindOne: User.findOne, uCreate: User.create, oFindOne: OtpCode.findOne };
  // The route logs the request body (including the password) — keep it out of test output.
  console.log = () => {}; console.warn = () => {};

  const calls = { findOne: 0, create: [] };
  let existing = null;
  let otpVerified = true;
  User.findOne = () => { calls.findOne += 1; return chain(existing); };
  OtpCode.findOne = () => chain(otpVerified ? { email: 'x', used: true } : null);
  User.create = async (doc) => { calls.create.push(doc); return { ...doc, _id: doc._id, save: async () => {} }; };

  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  const srv = http.createServer(app).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;

  const account = { role: 'parent', firstName: 'Test', lastName: 'Parent', username: 'test_parent', email: 'test.parent@example.invalid', password: 'a-long-enough-pw' };
  const post = async (body) => {
    const r = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const reset = () => { calls.findOne = 0; calls.create.length = 0; existing = null; otpVerified = true; };

  try {
    // A / B / C — blocked before ANY database work
    for (const [label, consent] of [
      ['A', { acceptTerms: false, acknowledgePrivacy: false, mlConsent: true }],
      ['B', { acceptTerms: true, acknowledgePrivacy: false, mlConsent: true }],
      ['C', { acceptTerms: false, acknowledgePrivacy: true, mlConsent: true }],
      ['none', {}],
    ]) {
      reset();
      const r = await post({ ...account, ...consent });
      assert.strictEqual(r.status, 400, `${label}: register must be refused`);
      assert.ok(/Terms of Service|Privacy Notice/.test(r.body.error), `${label}: clear reason returned`);
      assert.strictEqual(calls.create.length, 0, `${label}: no account created`);
      assert.strictEqual(calls.findOne, 0, `${label}: refused before any database lookup`);
    }
    // D — ML unchecked
    reset();
    let r = await post({ ...account, acceptTerms: true, acknowledgePrivacy: true, mlConsent: false });
    assert.strictEqual(r.status, 201, 'D: allowed'); assert.strictEqual(calls.create.length, 1);
    assert.strictEqual(calls.create[0].consents.mlConsentGiven, false);
    assert.strictEqual(calls.create[0].consents.termsVersion, TERMS_VERSION);
    assert.ok(calls.create[0].consents.termsAcceptedAt instanceof Date);
    assert.ok(calls.create[0].consents.privacyNoticeAcknowledgedAt instanceof Date);
    // E — ML checked
    reset();
    r = await post({ ...account, acceptTerms: true, acknowledgePrivacy: true, mlConsent: true });
    assert.strictEqual(r.status, 201, 'E: allowed'); assert.strictEqual(calls.create[0].consents.mlConsentGiven, true);
    // multipart-style string values
    reset();
    r = await post({ ...account, acceptTerms: 'true', acknowledgePrivacy: 'true', mlConsent: 'false' });
    assert.strictEqual(r.status, 201); assert.strictEqual(calls.create[0].consents.mlConsentGiven, false);

    // Existing signup validation is unchanged when consent IS given
    const consented = { acceptTerms: true, acknowledgePrivacy: true };
    reset(); r = await post({ ...account, ...consented, role: 'secretary' });
    assert.strictEqual(r.status, 400); assert.match(r.body.error, /Invalid user role/);
    reset(); r = await post({ ...account, ...consented, email: 'not-an-email' });
    assert.strictEqual(r.status, 400); assert.match(r.body.error, /valid email/);
    reset(); r = await post({ ...account, ...consented, password: 'short' });
    assert.strictEqual(r.status, 400); assert.match(r.body.error, /at least 8/);
    reset(); r = await post({ ...consented, role: 'parent', email: account.email });
    assert.strictEqual(r.status, 400); assert.match(r.body.error, /required fields/);
    reset(); existing = { _id: 'x' }; r = await post({ ...account, ...consented });
    assert.strictEqual(r.status, 409); assert.strictEqual(calls.create.length, 0);
    reset(); otpVerified = false; r = await post({ ...account, ...consented });
    assert.strictEqual(r.status, 400); assert.match(r.body.error, /verify your email/i); assert.strictEqual(calls.create.length, 0);
    // password handling untouched: stored as a bcrypt hash, never the plain text
    reset(); await post({ ...account, ...consented });
    assert.ok(/^\$2[aby]\$/.test(calls.create[0].passwordHash) && calls.create[0].passwordHash !== account.password);
  } finally {
    srv.close();
    console.log = orig.log; console.warn = orig.warn;
    User.findOne = orig.uFindOne; User.create = orig.uCreate; OtpCode.findOne = orig.oFindOne;
  }
  ok('/register route: A/B/C refused before any DB work, D/E create the account with the recorded consents; OTP/role/email/password/duplicate checks unchanged');
}

// ── 4. signup.html: real checkboxes, labels, required vs optional ────────────
{
  const groups = [
    { prefix: 'p', terms: 'pAcceptTerms', privacy: 'pAckPrivacy', ml: 'pMlConsent', error: 'pConsentError' },
    { prefix: 'd', terms: 'dAcceptTerms', privacy: 'dAckPrivacy', ml: 'dMlConsent', error: 'dConsentError' },
  ];
  const inputTag = (id) => (new RegExp(`<input\\b[^>]*\\bid="${id}"[^>]*>`).exec(html) || [])[0];
  const labelText = (id) => {
    const all = [...html.matchAll(new RegExp(`<label\\b[^>]*\\bfor="${id}"[^>]*>([\\s\\S]*?)</label>`, 'g'))];
    assert.strictEqual(all.length, 1, `exactly one <label for="${id}">`);
    return all[0][1].replace(/\s+/g, ' ').trim();
  };
  for (const g of groups) {
    for (const [id, expected, required] of [[g.terms, TERMS_LABEL, true], [g.privacy, PRIVACY_LABEL, true], [g.ml, ML_LABEL, false]]) {
      const tag = inputTag(id);
      assert.ok(tag, `${id} exists`);
      assert.match(tag, /\btype="checkbox"/, `${id} is a real <input type="checkbox">`);
      assert.strictEqual(/\brequired\b/.test(tag), required, `${id} required=${required}`);
      assert.ok(!/\bdisabled\b|tabindex="-1"|\bhidden\b|style=|onclick=|onkeydown=|onkeypress=|onkeyup=/.test(tag), `${id}: natively focusable, no key/click interception, not hidden`);
      assert.strictEqual(labelText(id), expected, `${id}: label wording equals the Terms file exactly`);
      assert.strictEqual([...html.matchAll(new RegExp(`\\bid="${id}"`, 'g'))].length, 1, `${id} is unique`);
    }
    assert.match(inputTag(g.terms), new RegExp(`aria-describedby="${g.error}"`));
    assert.ok(new RegExp(`id="${g.error}"[^>]*role="alert"`).test(html), `${g.error} is an alert region`);
  }
  assert.ok(!/role="checkbox"/.test(html), 'no fake role="checkbox" controls');
  const allIds = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  assert.strictEqual(allIds.length, new Set(allIds).size, 'no duplicate ids on the page');
  // Section-17 headings and statements are present as written in the source.
  for (const line of ['Required Terms Acceptance', 'Privacy Notice Acknowledgment', 'Optional Machine Learning Consent',
    'The Optional Machine Learning Consent is separate from acceptance of the KinderCura Terms of Service and acknowledgment of the KinderCura Privacy Notice.',
    'Before creating an account or using KinderCura, users should review these Terms of Service and the KinderCura Privacy Notice.',
    'The following selections are presented separately to distinguish acceptance of the Terms from optional consent:']) {
    assert.ok(termsLines.includes(line), `source line exists: ${line.slice(0, 40)}`);
    assert.ok(html.includes(line), `signup.html shows it verbatim: ${line.slice(0, 40)}`);
  }
  // Privacy Notice Acknowledgment -> a way to review the privacy content that exists in the Terms file.
  {
    const heading = termsLines.find((l) => /^7\.\s+PRIVACY AND COOKIES$/.test(l));
    assert.ok(heading, 'the Terms file has a section 7 headed PRIVACY AND COOKIES');
    const links = [...html.matchAll(/<a\b[^>]*data-terms-section="7"[^>]*>([^<]*)<\/a>/g)];
    assert.strictEqual(links.length, 2, 'one privacy-review link per role');
    for (const m of links) {
      assert.ok(m[0].includes('href="/legal/KINDERCURA-TERMS-OF-SERVICE.txt"') && m[0].includes('class="terms-open-link"'), 'opens the dialog when available, falls back to the plain-text Terms');
      assert.ok(m[1].includes(`"${heading}"`), 'link text quotes the source heading exactly');
    }
    for (const p of ['p', 'd']) {
      const iPrivacy = html.indexOf(`id="${p}AckPrivacy"`);
      const iLink = html.indexOf('data-terms-section="7"', iPrivacy);
      const iMl = html.indexOf(`id="${p}MlConsent"`);
      assert.ok(iPrivacy < iLink && iLink < iMl, `${p}: review link sits right after the Privacy checkbox (Tab order: checkbox, link, ML checkbox)`);
    }
    ok('signup.html: each Privacy Notice Acknowledgment is followed by a link to section "7. PRIVACY AND COOKIES" of the Terms');
  }
  // Login page is untouched by the consent UI.
  const login = fs.readFileSync(path.join(ROOT, 'SIGN-UP,LOGIN', 'login.html'), 'utf8');
  assert.ok(!/AcceptTerms|AckPrivacy|MlConsent|termsDialog/.test(login), 'login flow has no consent UI');
  ok('signup.html: 6 real checkboxes, one matching <label for> each, wording == Terms file, Terms+Privacy required, ML optional, no fake controls, login untouched');

  // Dialog accessibility + visible focus
  assert.ok(html.indexOf('id="pConsentError"') < html.indexOf('id="pAcceptTerms"') && html.indexOf('id="dConsentError"') < html.indexOf('id="dAcceptTerms"'), 'consent message sits above the checkboxes so it is seen without scrolling');
  assert.match(html, /<dialog id="termsDialog"[^>]*aria-labelledby="termsDialogTitle"/);
  assert.match(html, /<h2 id="termsDialogTitle">[^<]+<\/h2>/);
  assert.match(html, /<button type="button"[^>]*id="termsDialogClose"/);
  assert.match(html, /id="termsDialogBody"[^>]*tabindex="0"[^>]*role="region"[^>]*aria-label=/);
  assert.match(signupJs, /showModal\(\)/, 'native modal dialog (browser-managed focus trap, Escape, focus return)');
  assert.ok(!/keydown[\s\S]{0,80}Tab/.test(signupJs.slice(signupJs.indexOf('Terms of Service & consent'))), 'no hand-rolled Tab trap');
  assert.match(css, /\.consent-input:focus-visible\s*\{[^}]*outline:\s*3px/);
  assert.match(css, /\.terms-dialog-body:focus-visible\s*\{[^}]*outline/);
  assert.match(css, /\.consent-input\[aria-invalid="true"\]/);
  assert.match(css, /\.consent-error:not\(:empty\)\s*\{\s*display:\s*block/);
  assert.match(css, /@media \(max-width: 480px\)[\s\S]*\.terms-dialog\s*\{[^}]*calc\(100vw/);
  ok('dialog: labelled <dialog>, focusable scroll region, native focus handling; visible focus + invalid + mobile CSS present');
}

// ── 5. js/auth/signup.js in a fake DOM ───────────────────────────────────────
function makeSignupEnv() {
  const els = {}; const focused = []; const fetchCalls = [];
  const el = (id) => (els[id] ||= {
    id, value: '', checked: false, textContent: '', disabled: false, style: {}, files: [], attrs: {}, listeners: {}, children: [], className: '', open: false, scrollTop: 0,
    classList: { added: [], add(c) { this.added.push(c); }, remove() {} },
    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k]; },
    focus() { focused.push(id); }, scrollIntoView() {}, appendChild(c) { this.children.push(c); },
    addEventListener(type, cb) { this.listeners[type] = cb; },
  });
  const registry = {};   // elements created by the page's own code, found again by id
  let domReady = null;
  const document = {
    getElementById: (id) => registry[id] || (id.startsWith('terms-section-') ? null : el(id)), querySelector: () => null, querySelectorAll: () => [],
    addEventListener(type, cb) { if (type === 'DOMContentLoaded') domReady = cb; },
    createElement(tag) {
      const node = {
        tag, className: '', textContent: '', children: [], attrs: {}, scrolled: false,
        appendChild(c) { this.children.push(c); }, setAttribute(k, v) { this.attrs[k] = String(v); },
        scrollIntoView() { this.scrolled = true; }, focus() { focused.push(this.id); },
      };
      Object.defineProperty(node, 'id', { get() { return this._id; }, set(v) { this._id = v; registry[v] = node; } });
      return node;
    },
    createTextNode(text) { return { text }; },
  };
  const resp = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  let fetchImpl = async (url) => {
    if (url.endsWith('/send-otp') || url.endsWith('/verify-otp')) return resp(200, { success: true });
    if (url.endsWith('/register')) return resp(201, { success: true, token: 't', user: {}, needsPreAssessment: false });
    return resp(404, {});
  };
  const ctx = vm.createContext({
    document, window: { location: { href: '' } }, localStorage: { setItem() {} },
    fetch: async (url, opts) => { fetchCalls.push({ url, opts }); return fetchImpl(url, opts); },
    FormData, console: { log() {}, warn() {}, error() {} }, setTimeout: () => 0, Promise, JSON, Boolean, String, RegExp,
  });
  vm.runInContext(signupJs, ctx, { filename: 'signup.js' });
  return { els, el, focused, fetchCalls, registry, ctx, run: (expr) => vm.runInContext(expr, ctx), domReady: () => domReady && domReady(), setFetch: (f) => { fetchImpl = f; }, resp };
}

const setConsent = (env, kind, { terms, privacy, ml }) => {
  const ids = { parent: ['pAcceptTerms', 'pAckPrivacy', 'pMlConsent'], pediatrician: ['dAcceptTerms', 'dAckPrivacy', 'dMlConsent'] }[kind];
  env.el(ids[0]).checked = terms; env.el(ids[1]).checked = privacy; env.el(ids[2]).checked = ml;
};
const CASES = {
  A: { terms: false, privacy: false, ml: false, blocked: true },
  B: { terms: true, privacy: false, ml: false, blocked: true },
  C: { terms: false, privacy: true, ml: false, blocked: true },
  D: { terms: true, privacy: true, ml: false, blocked: false },
  E: { terms: true, privacy: true, ml: true, blocked: false },
};

async function clientTests() {
  // 5a. validateConsent, focus + aria-invalid + message text
  {
    const env = makeSignupEnv();
    setConsent(env, 'parent', CASES.A);
    assert.strictEqual(env.run("validateConsent('parent')"), false);
    assert.match(env.els.pConsentError.textContent, /Terms of Service and acknowledge the Privacy Notice/);
    assert.strictEqual(env.els.pAcceptTerms.attrs['aria-invalid'], 'true'); assert.strictEqual(env.els.pAckPrivacy.attrs['aria-invalid'], 'true');
    assert.strictEqual(env.focused[env.focused.length - 1], 'pAcceptTerms', 'focus moves to the first missing required box');
    setConsent(env, 'parent', CASES.B);
    env.run("validateConsent('parent')");
    assert.match(env.els.pConsentError.textContent, /Privacy Notice/); assert.doesNotMatch(env.els.pConsentError.textContent, /Terms of Service/);
    assert.strictEqual(env.focused[env.focused.length - 1], 'pAckPrivacy');
    setConsent(env, 'parent', CASES.C);
    env.run("validateConsent('parent')");
    assert.match(env.els.pConsentError.textContent, /Terms of Service/); assert.doesNotMatch(env.els.pConsentError.textContent, /Privacy Notice/);
    for (const c of ['D', 'E']) {
      setConsent(env, 'parent', CASES[c]);
      assert.strictEqual(env.run("validateConsent('parent')"), true, `${c} passes client validation`);
      assert.strictEqual(env.els.pConsentError.textContent, ''); assert.strictEqual(env.els.pAcceptTerms.attrs['aria-invalid'], 'false');
    }
    // ticking the missing box clears the message once the user has been told
    setConsent(env, 'parent', CASES.B); env.run("validateConsent('parent')");
    assert.ok(env.els.pConsentError.textContent);
    env.domReady();
    env.els.pAckPrivacy.checked = true; env.els.pAckPrivacy.listeners.change();
    assert.strictEqual(env.els.pConsentError.textContent, '', 'message clears as soon as both required boxes are ticked');
    ok('client validateConsent: messages, aria-invalid, focus, live clearing (A/B/C blocked, D/E pass)');
  }

  // 5b. Parent flow — Send Verification Code gate, no fields erased
  for (const [name, c] of Object.entries(CASES)) {
    const env = makeSignupEnv();
    const typed = { pUsername: 'kind_parent', pEmail: 'kind.parent@example.invalid', pPassword: 'pw-long-enough', pConfirm: 'pw-long-enough', pFirst: 'Ana', pLast: 'Reyes', childFirst: 'Luz', dob: '2022-03-04' };
    Object.entries(typed).forEach(([k, v]) => { env.el(k).value = v; });
    setConsent(env, 'parent', c);
    await env.run('sendOTP')();
    const sent = env.fetchCalls.filter((f) => f.url.endsWith('/send-otp')).length;
    assert.strictEqual(sent, c.blocked ? 0 : 1, `${name}: send-otp ${c.blocked ? 'NOT ' : ''}called`);
    Object.entries(typed).forEach(([k, v]) => assert.strictEqual(env.els[k].value, v, `${name}: ${k} preserved`));
    if (c.blocked) assert.ok(env.els.pConsentError.textContent, `${name}: validation message shown`);
  }
  ok('parent sign-up: Send Verification Code blocked for A/B/C (nothing sent, every typed field intact), allowed for D/E');

  // 5c. Parent flow — final registration guard + payload
  for (const [name, c] of Object.entries(CASES)) {
    const env = makeSignupEnv();
    ['o1', 'o2', 'o3', 'o4'].forEach((id, i) => { env.el(id).value = String(i + 1); });
    const typed = { pUsername: 'kind_parent', pEmail: 'kind.parent@example.invalid', pPassword: 'pw-long-enough', pConfirm: 'pw-long-enough', pFirst: 'Ana', pLast: 'Reyes' };
    Object.entries(typed).forEach(([k, v]) => { env.el(k).value = v; });
    setConsent(env, 'parent', c);
    await env.run('verifyAndRegister')();
    if (c.blocked) {
      assert.strictEqual(env.fetchCalls.length, 0, `${name}: final step sends NOTHING (OTP not consumed, no account)`);
      assert.match(env.els.pConsentError.textContent, /Terms of Service|Privacy Notice/, name + ': message shown inside the consent block');
      assert.ok(env.els.sp4.classList.added.includes('active'), name + ': user is taken back to the step that holds the checkboxes');
    } else {
      const reg = env.fetchCalls.find((f) => f.url.endsWith('/register'));
      assert.ok(reg, `${name}: register request made`);
      assert.strictEqual(reg.opts.body.get('acceptTerms'), 'true');
      assert.strictEqual(reg.opts.body.get('acknowledgePrivacy'), 'true');
      assert.strictEqual(reg.opts.body.get('mlConsent'), c.ml ? 'true' : 'false', `${name}: ML choice sent as chosen`);
    }
    Object.entries(typed).forEach(([k, v]) => assert.strictEqual(env.els[k].value, v));
  }
  ok('parent sign-up: final step blocked for A/B/C before any request; D/E register with acceptTerms/acknowledgePrivacy=true and the ML choice as selected');

  // 5d. Pediatrician flow — OTP gate + final guard + payload
  for (const [name, c] of Object.entries(CASES)) {
    const env = makeSignupEnv();
    const typed = { dFirst: 'Ben', dLast: 'Cruz', dUsername: 'dr_cruz', dEmail: 'dr.cruz@example.invalid', dPassword: 'pw-long-enough', dConfirm: 'pw-long-enough' };
    Object.entries(typed).forEach(([k, v]) => { env.el(k).value = v; });
    setConsent(env, 'pediatrician', c);
    await env.run('sendDoctorOTP')();
    assert.strictEqual(env.fetchCalls.filter((f) => f.url.endsWith('/send-otp')).length, c.blocked ? 0 : 1, `${name}: pediatrician send-otp gate`);
    Object.entries(typed).forEach(([k, v]) => assert.strictEqual(env.els[k].value, v));

    const env2 = makeSignupEnv();
    Object.entries(typed).forEach(([k, v]) => { env2.el(k).value = v; });
    Object.assign(env2.el('docIdInput'), { files: [{ name: 'prc.png', size: 10, type: 'image/png' }] });
    env2.el('license').value = '0123456'; env2.el('pediaPhone').value = '09123456789'; env2.el('licenseExpiry').value = '2099-01-01';
    setConsent(env2, 'pediatrician', c);
    await env2.run('registerPedia')();
    const reg = env2.fetchCalls.find((f) => f.url.endsWith('/register'));
    if (c.blocked) {
      assert.ok(!reg, `${name}: pediatrician register NOT sent`);
      assert.match(env2.els.dConsentError.textContent, /Terms of Service|Privacy Notice/, name + ': message shown inside the consent block');
      assert.ok(env2.els.sd3.classList.added.includes('active'), name + ': pediatrician is taken back to the credentials step');
    } else {
      assert.ok(reg, `${name}: pediatrician register sent`);
      assert.strictEqual(reg.opts.body.get('acceptTerms'), 'true'); assert.strictEqual(reg.opts.body.get('acknowledgePrivacy'), 'true');
      assert.strictEqual(reg.opts.body.get('mlConsent'), c.ml ? 'true' : 'false');
      assert.strictEqual(reg.opts.body.get('role'), 'pediatrician'); assert.strictEqual(reg.opts.body.get('licenseNumber'), '0123456');
    }
    Object.entries(typed).forEach(([k, v]) => assert.strictEqual(env2.els[k].value, v));
  }
  ok('pediatrician sign-up: OTP step and final submit blocked for A/B/C, allowed for D/E; existing PRC/credential payload unchanged');

  // 5e. Existing client validation still runs first and is unchanged
  {
    const env = makeSignupEnv();
    setConsent(env, 'parent', CASES.E);
    await env.run('sendOTP')();   // no credentials typed
    assert.strictEqual(env.els.ep4.textContent, 'Please complete all parent login credentials.');
    assert.strictEqual(env.fetchCalls.length, 0);
    env.el('pUsername').value = 'u'; env.el('pEmail').value = 'bad'; env.el('pPassword').value = 'password1'; env.el('pConfirm').value = 'password1';
    await env.run('sendOTP')();
    assert.strictEqual(env.els.ep4.textContent, 'Please enter a valid email address.');
    ok('existing credential validation messages unchanged');
  }

  // 5f. Terms reader: verbatim rendering
  {
    const env = makeSignupEnv();
    const container = { children: [], appendChild(c) { this.children.push(c); }, textContent: '' };
    env.run('renderTermsDocument')(termsText, container);
    const rendered = container.children.filter((c) => c.tag !== 'hr').map((c) => c.textContent);
    const source = termsLines.filter((l) => !/^_{5,}$/.test(l));
    assert.deepStrictEqual(rendered, source, 'every source line is rendered, verbatim and in order');
    assert.strictEqual(container.children.filter((c) => c.tag === 'hr').length, termsLines.filter((l) => /^_{5,}$/.test(l)).length, 'separators become dividers');
    assert.strictEqual(container.children[0].textContent, 'KINDERCURA');
    assert.strictEqual(container.children[1].textContent, 'TERMS OF SERVICE');
    assert.strictEqual(container.children.filter((c) => c.tag === 'h4').length, 17, '17 numbered section headings preserved');
    const text = rendered.join('\n');
    for (const keep of ['Effective Date: [Insert Date]', 'Last Updated: [Insert Date]', 'Version: 1.0', 'Organization/Institution: [Insert Organization/Institution Name]', 'Email Address: [Insert Official Email Address]', 'Telephone: [Insert Contact Number, if applicable]', 'Address: [Insert Official Address]', '17. ACCEPTANCE AND CONSENT']) {
      assert.ok(text.includes(keep), `kept as written: ${keep}`);
    }
    assert.strictEqual(rendered.filter((l) => l.startsWith('☐')).length, 3, 'the acceptance section is shown as written');
    // Text goes in via textContent — markup in the source could never become elements.
    const evil = { children: [], appendChild(c) { this.children.push(c); }, textContent: '' };
    env.run('renderTermsDocument')('KINDERCURA\nTERMS OF SERVICE\n<img src=x onerror=alert(1)>', evil);
    assert.strictEqual(evil.children[2].textContent, '<img src=x onerror=alert(1)>'); assert.strictEqual(evil.children[2].tag, 'p');
    ok('Terms reader: all source lines rendered verbatim + in order, placeholders/version/section numbers untouched, text inserted as text');

    // open / fallback behaviour
    const dlg = env.el('termsDialog'); let shown = 0; dlg.showModal = () => { shown += 1; dlg.open = true; };
    env.setFetch(async () => env.resp(200, termsText));
    assert.strictEqual(env.run("openTermsDialog(null)"), true); assert.strictEqual(shown, 1);
    await new Promise((r) => setImmediate(r));
    assert.ok(env.el('termsDialogBody').children.length > 20, 'Terms text loaded into the dialog');
    const env2 = makeSignupEnv();
    assert.strictEqual(env2.run("openTermsDialog(null)"), false, 'no <dialog> support -> falls back to the plain-text link');
    const env3 = makeSignupEnv(); env3.el('termsDialog').showModal = () => {}; env3.setFetch(async () => env3.resp(500, {}));
    env3.run("openTermsDialog(null)"); await new Promise((r) => setImmediate(r));
    assert.ok(env3.el('termsDialogBody').children.some((c) => c.children && c.children.some((k) => k.tag === 'a')), 'load failure shows a link to the plain-text file');
    ok('Terms dialog: opens via showModal, loads text, degrades to a plain-text link when unavailable or failing');

    // 5g. Privacy review link: opens the Terms at section 7 and lands on its heading
    const env4 = makeSignupEnv();
    const container4 = { children: [], appendChild(c) { this.children.push(c); }, textContent: '' };
    env4.run('renderTermsDocument')(termsText, container4);
    const sectionHeadings = container4.children.filter((c) => c.tag === 'h4');
    assert.strictEqual(sectionHeadings.length, 17);
    for (const h of sectionHeadings) {
      const n = /^(\d+)\./.exec(h.textContent)[1];
      assert.strictEqual(h.id, `terms-section-${n}`, `${h.textContent}: anchored by the source's own section number`);
      assert.strictEqual(h.attrs.tabindex, '-1', 'programmatically focusable, not added to the Tab order');
    }
    assert.strictEqual(env4.registry['terms-section-7'].textContent, '7. PRIVACY AND COOKIES');
    const s7 = termsLines.slice(termsLines.indexOf('7. PRIVACY AND COOKIES') + 1, termsLines.indexOf('8. MACHINE LEARNING AND AUTOMATED PROCESSING'));
    assert.ok(s7.some((l) => l.includes('Data Privacy Act of 2012')) && s7.some((l) => l.includes('cookies')), 'section 7 carries the privacy and cookies provisions');

    const env5 = makeSignupEnv();
    const dlg5 = env5.el('termsDialog'); dlg5.showModal = () => { dlg5.open = true; };
    env5.setFetch(async () => env5.resp(200, termsText));
    assert.strictEqual(env5.run('openTermsDialog(null, "7")'), true);
    await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
    const h7 = env5.registry['terms-section-7'];
    assert.ok(h7 && h7.scrolled, 'section 7 scrolled into view');
    assert.ok(env5.focused.includes('terms-section-7'), 'focus moved to the section 7 heading');

    const env6 = makeSignupEnv();
    env6.el('termsDialog').showModal = () => {}; env6.setFetch(async () => env6.resp(200, termsText));
    env6.run('openTermsDialog(null)'); await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
    assert.ok(!env6.focused.some((f) => String(f).startsWith('terms-section-')), 'no section focus when none was requested (opens at the top, as before)');
    assert.strictEqual(env6.run('jumpToTermsSection("99")'), false, 'an unknown section is a harmless no-op');
    ok('privacy access: headings anchored by source section number; opening at section 7 scrolls to and focuses "7. PRIVACY AND COOKIES"; no jump when none requested');
  }
}

(async () => {
  await routeTests();
  await clientTests();
  console.log(results.map((r) => `  ok - ${r}`).join('\n'));
  console.log(`Sign-up consent tests OK — ${results.length} groups: cases A–E (server, route, client), labels, wording vs Terms file, required vs optional, field preservation, verbatim Terms rendering.`);
})().catch((err) => { console.error(err); process.exit(1); });
