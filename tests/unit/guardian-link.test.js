// Unit tests for the GuardianLink fixes.
//
// Covers the reported failure ("GuardianLink validation failed: role: `father`
// is not a valid enum value"), the account left behind without a link (which is
// why the new guardian saw "No child registered"), preset permissions, and the
// rule that an email is only reported as sent when the provider accepted it.
//
// No DB and no network: models are monkey-patched and handlers are called with
// fake req/res objects, the same way as clinic-payment-qr.test.js.
const assert = require('assert');
const mongoose = require('mongoose');

// No email transport in this process: delivery must report "not sent".
['EMAIL_API_KEY', 'EMAIL_PROVIDER', 'EMAIL_USER', 'EMAIL_PASS'].forEach((k) => { process.env[k] = ''; });

const auditController = require('../../controllers/auditController');
auditController.createLog = async () => {}; // patched before the controller destructures it

const Child = require('../../models/Child');
const User = require('../../models/User');
const GuardianLink = require('../../models/GuardianLink');
const GuardianInvitation = require('../../models/GuardianInvitation');
const emailService = require('../../services/emailService');
const rules = require('../../constants/guardianLink');
const controller = require('../../controllers/guardianController');

const results = [];
const ok = (label) => results.push(label);

const chain = (v) => { const o = { sort: () => o, select: () => o, populate: () => o, lean: async () => v, then: (a, b) => Promise.resolve(v).then(a, b) }; return o; };
const fakeRes = () => {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};
const oid = () => new mongoose.Types.ObjectId();

async function modelTests() {
  // The exact reported error is still produced for a relationship saved as role…
  const bad = new GuardianLink({ childId: oid(), guardianId: oid(), role: 'father', status: 'active' });
  const err = await bad.validate().then(() => null, (e) => e);
  assert.ok(err && /`father` is not a valid enum value for path `role`/.test(err.message), 'role enum is still enforced');

  // …and every dropdown relationship now maps to a valid role and is kept as relationship.
  for (const relationship of rules.RELATIONSHIPS) {
    const link = new GuardianLink({
      childId: oid(), guardianId: oid(), status: 'active',
      role: rules.roleForRelationship(relationship), relationship,
      permissions: rules.resolvePermissions('standard'),
    });
    await link.validate();
  }
  assert.strictEqual(rules.roleForRelationship('father'), 'parent');
  assert.strictEqual(rules.roleForRelationship('mother'), 'parent');
  assert.strictEqual(rules.roleForRelationship('legal_guardian'), 'legal_guardian');
  assert.strictEqual(rules.roleForRelationship('foster_parent'), 'foster_parent');
  assert.strictEqual(rules.roleForRelationship('court_appointed'), 'court_appointed');
  assert.strictEqual(rules.roleForRelationship('nanny'), 'parent');
  ok('relationship → role mapping: Father/Mother → parent, legal standings kept, every option validates; invalid role still rejected');

  // Existing links without a relationship stay valid.
  await new GuardianLink({ childId: oid(), guardianId: oid(), status: 'active' }).validate();
  const badRel = await new GuardianLink({ childId: oid(), guardianId: oid(), relationship: 'uncle' }).validate().then(() => null, (e) => e);
  assert.ok(badRel, 'unknown relationship is rejected');
  ok('relationship field: optional for existing links, validated when present');
}

function presetTests() {
  const full = rules.resolvePermissions('full');
  assert.strictEqual(full.submitAssessments, true);
  assert.strictEqual(full.viewMedicalRecords, 'full');
  assert.strictEqual(full.viewRecommendations, true);

  const standard = rules.resolvePermissions('standard');
  assert.deepStrictEqual(
    Object.keys(standard).filter((k) => standard[k] === true).sort(),
    ['viewAssessments', 'viewMessages', 'viewNotifications', 'viewRecommendations', 'viewResults'].sort()
  );
  assert.strictEqual(standard.viewMedicalRecords, 'none');
  assert.strictEqual(standard.manageAppointments, false);

  const medical = rules.resolvePermissions('medical');
  assert.strictEqual(medical.viewMedicalRecords, 'full');
  assert.strictEqual(medical.manageAppointments, true);
  assert.strictEqual(medical.viewAssessments, false);

  const limited = rules.resolvePermissions('limited');
  assert.strictEqual(limited.viewResults, true);
  assert.strictEqual(limited.viewAssessments, false);

  // Custom: booleans from checkboxes are coerced; unknown keys dropped.
  const custom = rules.resolvePermissions('custom', { viewMedicalRecords: true, sendMessages: 'true', hacker: true, viewRecommendations: false, viewResults: true });
  assert.strictEqual(custom.viewMedicalRecords, 'full');
  assert.strictEqual(custom.sendMessages, true);
  assert.strictEqual(custom.viewRecommendations, false);
  assert.ok(!('hacker' in custom));

  // The checkbox value true used to be cast to "true" and fail the String enum.
  const inv = new GuardianInvitation({ codeHash: 'x', createdBy: oid(), childIds: [oid()], permissionPreset: 'custom', customPermissions: custom });
  const invErr = inv.validateSync();
  assert.strictEqual(invErr, undefined, invErr && invErr.message);
  assert.strictEqual(rules.normalizeMedical(true, 'partial'), 'partial', 'checked box keeps an existing partial level');
  assert.strictEqual(rules.normalizeMedical(false, 'full'), 'none');
  ok('presets match the Guardian Management definitions; custom permissions coerced to stored types');

  assert.strictEqual(rules.normalizeEmail('  Eden@Example.COM '), 'eden@example.com');
  assert.strictEqual(rules.normalizeEmail('not-an-email'), null);
  ok('email normalisation');
}

async function emailTests() {
  const r = await emailService.sendInvitationEmail({
    to: 'guardian@example.com', code: 'abc', inviterName: 'Ana Soto', children: [{ firstName: 'Kemri', lastName: 'Soto' }],
    relationship: 'father', permissionPreset: 'standard', permissions: {}, expiresAt: new Date(Date.now() + 3600e3),
  });
  assert.deepStrictEqual(r, { sent: false, reason: 'NOT_CONFIGURED' });
  const w = await emailService.sendWelcomeEmail({ to: 'guardian@example.com', childNames: ['Kemri Soto'], accountCreatedBy: 'Ana Soto' });
  assert.strictEqual(w.sent, false);
  assert.ok(emailService.acceptUrlFor('a b').endsWith('/accept-invitation?code=a%20b'));
  ok('emails report sent:false when no provider is configured (never a silent "sent")');

  // With EMAIL_API_KEY set, guardian mail uses the HTTPS API like the OTP mail
  // (the host blocks SMTP). Provider accepted → sent; provider error → not sent.
  const httpEmail = require('../../services/httpEmail');
  const origSend = httpEmail.sendViaHttp;
  const origErr = console.error;
  process.env.EMAIL_API_KEY = 're_test_key';
  process.env.EMAIL_FROM = 'noreply@kindercura.test';
  try {
    let captured = null;
    httpEmail.sendViaHttp = async (msg) => { captured = msg; return { messageId: 'm1', provider: 'resend' }; };
    const sent = await emailService.sendInvitationEmail({
      to: 'guardian@example.com', code: 'c0de', inviterName: 'Ana Soto',
      children: [{ firstName: 'Kemri', lastName: 'Soto', dateOfBirth: new Date('2021-01-01') }],
      relationship: 'father', permissionPreset: 'standard', permissions: rules.resolvePermissions('standard'),
      personalMessage: '<b>hi</b>', expiresAt: new Date(Date.now() + 48 * 3600e3),
    });
    assert.deepStrictEqual(sent, { sent: true, transport: 'https-api' });
    assert.strictEqual(captured.to, 'guardian@example.com');
    assert.match(captured.html, /Kemri Soto/);
    assert.match(captured.html, /accept-invitation\?code=c0de/);
    assert.match(captured.html, /Father/);
    assert.match(captured.html, /expires on/);
    assert.match(captured.html, /&lt;b&gt;hi&lt;\/b&gt;/, 'personal message is escaped');
    assert.ok(!/Age:/.test(captured.html), 'no age / date of birth in the email');

    httpEmail.sendViaHttp = async () => { const e = new Error('Email API returned 403: domain not verified'); e.code = 'EAUTH'; throw e; };
    console.error = () => {};
    const failed = await emailService.sendWelcomeEmail({ to: 'guardian@example.com', childNames: ['Kemri Soto'] });
    assert.deepStrictEqual(failed, { sent: false, reason: 'SEND_FAILED' });
    ok('HTTPS email API: accepted → sent:true; provider rejection → sent:false; content names the child and inviter only');
  } finally {
    httpEmail.sendViaHttp = origSend;
    console.error = origErr;
    process.env.EMAIL_API_KEY = '';
    process.env.EMAIL_FROM = '';
  }
}

async function createAccountTests() {
  const parentId = oid();
  const childId = oid();
  const child = { _id: childId, parentId, firstName: 'Kemri', lastName: 'Soto' };
  const orig = {
    childFind: Child.find, userFindOne: User.findOne, userCreate: User.create, userDeleteOne: User.deleteOne, userFindById: User.findById,
    linkFindOne: GuardianLink.findOne, linkCreate: GuardianLink.create, linkExists: GuardianLink.exists, linkDelete: GuardianLink.findOneAndDelete,
    welcome: emailService.sendWelcomeEmail, consoleError: console.error,
  };
  const restore = () => {
    Child.find = orig.childFind; User.findOne = orig.userFindOne; User.create = orig.userCreate; User.deleteOne = orig.userDeleteOne;
    User.findById = orig.userFindById; GuardianLink.findOne = orig.linkFindOne; GuardianLink.create = orig.linkCreate;
    GuardianLink.exists = orig.linkExists; GuardianLink.findOneAndDelete = orig.linkDelete; emailService.sendWelcomeEmail = orig.welcome;
    console.error = orig.consoleError;
  };

  try {
    const created = { users: [], links: [], deletedUsers: [] };
    Child.find = () => chain([child]);
    User.findOne = () => chain(null);
    User.findById = () => chain({ firstName: 'Ana', lastName: 'Soto' });
    User.create = async (doc) => { const u = { _id: oid(), ...doc }; created.users.push(u); return u; };
    User.deleteOne = async (q) => { created.deletedUsers.push(String(q._id)); return { deletedCount: 1 }; };
    GuardianLink.exists = async () => null;
    GuardianLink.findOne = async () => null;
    GuardianLink.create = async (doc) => {
      const link = new GuardianLink(doc);
      await link.validate(); // the real schema check that used to throw
      created.links.push(link);
      return link;
    };
    let mailed = null;
    emailService.sendWelcomeEmail = async (args) => { mailed = args; return { sent: true }; };

    // 1. Father — the reported case — now succeeds and stores the relationship.
    const req = {
      user: { userId: String(parentId), role: 'parent' },
      body: { firstName: 'Emmanuel', lastName: 'Dumaniel', email: 'EDEN@example.com ', password: 'secret123', relationship: 'father', childIds: [String(childId)], permissionPreset: 'full' },
      ip: '127.0.0.1',
    };
    const res = fakeRes();
    await controller.createSecondaryAccount(req, res);
    assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
    assert.strictEqual(created.users[0].email, 'eden@example.com');
    assert.strictEqual(created.links.length, 1);
    assert.strictEqual(created.links[0].role, 'parent');
    assert.strictEqual(created.links[0].relationship, 'father');
    assert.strictEqual(String(created.links[0].childId), String(childId));
    assert.strictEqual(created.links[0].permissions.submitAssessments, true, 'Full Access preset applied');
    assert.strictEqual(res.body.emailSent, true);
    assert.ok(mailed && !JSON.stringify(mailed).includes('secret123'), 'password never goes into the email');
    ok('create-account: Father links the new account to the selected child with the chosen preset; email has no password');

    // 2. Link creation fails → the new user is deleted (no orphan "No child registered" account).
    created.users.length = 0; created.links.length = 0;
    GuardianLink.create = async () => { throw new Error('simulated write failure'); };
    console.error = () => {};
    const res2 = fakeRes();
    await controller.createSecondaryAccount({ ...req, body: { ...req.body, email: 'second@example.com' } }, res2);
    assert.strictEqual(res2.statusCode, 500);
    assert.strictEqual(created.users.length, 1);
    assert.deepStrictEqual(created.deletedUsers, [String(created.users[0]._id)], 'created account rolled back');
    ok('create-account: a failed link removes the just-created account (no orphaned guardian)');

    // 3. Invalid relationship / preset → 400 before any account exists.
    created.users.length = 0;
    const res3 = fakeRes();
    await controller.createSecondaryAccount({ ...req, body: { ...req.body, relationship: 'uncle' } }, res3);
    assert.strictEqual(res3.statusCode, 400);
    const res4 = fakeRes();
    await controller.createSecondaryAccount({ ...req, body: { ...req.body, permissionPreset: 'everything' } }, res4);
    assert.strictEqual(res4.statusCode, 400);
    assert.strictEqual(created.users.length, 0);
    ok('create-account: unknown relationship or preset is a clear 400 and creates nothing');

    // 4. Existing email → 409, pointing to the invitation flow.
    User.findOne = () => chain({ _id: oid() });
    const res5 = fakeRes();
    await controller.createSecondaryAccount(req, res5);
    assert.strictEqual(res5.statusCode, 409);
    assert.match(res5.body.error, /invitation/i);
    ok('create-account: existing email → 409 with guidance, no duplicate account');

    // 5. Not the child's primary → 403.
    User.findOne = () => chain(null);
    const res6 = fakeRes();
    await controller.createSecondaryAccount({ ...req, user: { userId: String(oid()), role: 'parent' } }, res6);
    assert.strictEqual(res6.statusCode, 403);
    ok('create-account: only the child\'s primary parent/guardian may add family');
  } finally {
    restore();
  }
}

async function linkRollbackTests() {
  const { linkGuardianToChildren } = controller._internal;
  const orig = { findOne: GuardianLink.findOne, create: GuardianLink.create, del: GuardianLink.findOneAndDelete };
  try {
    const deleted = [];
    let n = 0;
    GuardianLink.findOne = async () => null;
    GuardianLink.create = async (doc) => { n += 1; if (n === 2) throw new Error('second child failed'); return { _id: oid(), ...doc }; };
    GuardianLink.findOneAndDelete = (q) => { deleted.push(String(q._id)); return { catch: () => {} }; };
    const err = await linkGuardianToChildren({
      guardianId: oid(), childIds: [String(oid()), String(oid())], relationship: 'mother',
      permissions: rules.resolvePermissions('standard'), createdBy: oid(),
    }).then(() => null, (e) => e);
    assert.ok(err);
    assert.strictEqual(deleted.length, 1, 'the first child\'s link is undone');

    // A suspended link is never silently re-activated by an invitation.
    GuardianLink.findOne = async () => ({ status: 'suspended' });
    const err2 = await linkGuardianToChildren({
      guardianId: oid(), childIds: [String(oid())], relationship: 'mother',
      permissions: rules.resolvePermissions('standard'), createdBy: oid(),
    }).then(() => null, (e) => e);
    assert.strictEqual(err2.status, 403);
    ok('linking is all-or-nothing across children; suspended access is not re-activated');
  } finally {
    GuardianLink.findOne = orig.findOne; GuardianLink.create = orig.create; GuardianLink.findOneAndDelete = orig.del;
  }
}

async function invitationAcceptTests() {
  const orig = { userFindById: User.findById, invFindOne: GuardianInvitation.findOne };
  try {
    const guardianId = oid();
    User.findById = () => chain({ _id: guardianId, email: 'someone.else@example.com', role: 'parent', firstName: 'X', lastName: 'Y' });
    GuardianInvitation.findOne = () => chain({
      _id: oid(), childIds: [oid()], used: false, revokedAt: null, sentTo: 'eden@example.com',
      expiresAt: new Date(Date.now() + 3600e3), permissionPreset: 'standard', relationship: 'father',
    });
    const res = fakeRes();
    await controller.acceptInvitation({ user: { userId: String(guardianId), role: 'parent' }, body: { code: 'abc' } }, res);
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.emailMismatch, true);
    assert.ok(!res.body.error.includes('eden@'), 'invited address is masked');
    ok('accept: an invitation can only be used by the account with the invited email');

    GuardianInvitation.findOne = () => chain({ _id: oid(), childIds: [oid()], used: false, revokedAt: new Date(), expiresAt: new Date() });
    User.findById = () => chain({ _id: guardianId, email: 'eden@example.com', role: 'parent' });
    const res2 = fakeRes();
    await controller.acceptInvitation({ user: { userId: String(guardianId), role: 'parent' }, body: { code: 'abc' } }, res2);
    assert.strictEqual(res2.statusCode, 410);
    assert.strictEqual(res2.body.revoked, true);

    User.findById = () => chain({ _id: guardianId, email: 'eden@example.com', role: 'pediatrician' });
    const res3 = fakeRes();
    await controller.acceptInvitation({ user: { userId: String(guardianId), role: 'pediatrician' }, body: { code: 'abc' } }, res3);
    assert.strictEqual(res3.statusCode, 403);
    ok('accept: revoked invitations are refused (410); non-guardian accounts cannot accept');
  } finally {
    User.findById = orig.userFindById; GuardianInvitation.findOne = orig.invFindOne;
  }
}

(async () => {
  await modelTests();
  presetTests();
  await emailTests();
  await createAccountTests();
  await linkRollbackTests();
  await invitationAcceptTests();
  console.log(results.map((r) => `  ok - ${r}`).join('\n'));
  console.log(`GuardianLink tests OK — ${results.length} groups`);
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
