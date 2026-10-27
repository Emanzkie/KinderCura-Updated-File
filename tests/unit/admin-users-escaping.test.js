// Admin Users page (js/admin/admin-users.js): every server value is escaped
// before it is put into innerHTML.
//
// Names and emails are typed by whoever signs up, and a pediatrician types
// their own clinic name. These used to be written into the Users table, the
// Pending Approvals cards and the Secretary list raw, so a signup named
// `<img src=x onerror=...>` ran script in the admin's session.
//
// No browser, no network: the real page script runs in a node vm with a tiny
// fake DOM. Ordinary values must render exactly as before the fix (compared
// against the committed version of the file), so nothing visible changes.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'js/admin/admin-users.js');
const results = [];
const ok = (label) => results.push(label);

function loadPage(source, responses) {
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) els.set(id, { id, innerHTML: '', textContent: '', value: '', style: {} });
    return els.get(id);
  };
  const sandbox = {
    console,
    URLSearchParams,
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    alert() {},
    confirm: () => true,
    requireAuth: () => true,
    KC: { user: () => ({ role: 'admin' }) },
    window: { location: { href: '' } },
    document: { getElementById: el, addEventListener() {} },
    apiFetch: async (endpoint) => {
      const key = Object.keys(responses).find((k) => endpoint.startsWith(k));
      const out = key ? responses[key] : {};
      if (out instanceof Error) throw out;
      return out;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return { sandbox, el };
}

const EVIL = '<img src=x onerror="alert(1)">';
const evilResponses = {
  '/admin/users': {
    users: [
      { id: 'u1', firstName: EVIL, lastName: "O'Brien & <b>", email: `${EVIL}@x.com`, role: 'parent', status: 'pending', createdAt: 'Oct 1, 2026' },
      { id: 'u2', firstName: 'Ana', lastName: 'Cruz', email: 'ana@x.com', role: 'pediatrician', status: 'active', createdAt: '<script>x</script>' },
    ],
  },
  '/secretary/pediatricians': { pediatricians: [{ id: 'p1', name: `Dr. ${EVIL}`, clinic: `${EVIL} Clinic` }] },
  '/secretary/list': {
    secretaries: [{ id: 's1', firstName: EVIL, lastName: 'Lee', email: 'sec@x.com', status: 'active', linkedPediatricianId: 'p1', linkedPediatricianName: `Dr. ${EVIL}` }],
  },
};

const NORMAL = {
  '/admin/users': {
    users: [
      { id: '6650a1b2c3d4e5f601234567', firstName: 'Lucas', lastName: 'Dumaniel', email: 'chan@example.com', role: 'parent', status: 'pending', createdAt: 'Oct 1, 2026' },
      { id: '6650a1b2c3d4e5f601234568', firstName: 'Ana', lastName: 'Cruz', email: 'ana@example.com', role: 'pediatrician', status: 'active', createdAt: 'Oct 2, 2026' },
      { id: '6650a1b2c3d4e5f601234569', firstName: 'Ben', lastName: 'Reyes', email: 'ben@example.com', role: 'secretary', status: 'suspended', createdAt: 'Oct 3, 2026' },
    ],
  },
  '/secretary/pediatricians': { pediatricians: [{ id: '6650a1b2c3d4e5f60123456a', name: 'Dr. Ana Cruz', clinic: 'Sunrise Clinic' }] },
  '/secretary/list': {
    secretaries: [{ id: '6650a1b2c3d4e5f60123456b', firstName: 'Ben', lastName: 'Reyes', email: 'ben@example.com', status: 'active', linkedPediatricianId: '6650a1b2c3d4e5f60123456a', linkedPediatricianName: 'Dr. Ana Cruz' }],
  },
};

async function renderAll(source, responses) {
  const page = loadPage(source, responses);
  await page.sandbox.loadUsers();
  await page.sandbox.loadSecretaryFormDependencies();
  await page.sandbox.loadSecretaries();
  return {
    users: page.el('usersList').innerHTML,
    pending: page.el('pendingList').innerHTML,
    secretaries: page.el('secList').innerHTML,
    pendingCount: page.el('pendingCount').textContent,
    userCount: page.el('userCount').textContent,
    secCount: page.el('secCount').textContent,
  };
}

const noRawTag = (html) => !/<img|<script|<b>/i.test(html);

(async () => {
  const current = fs.readFileSync(SCRIPT, 'utf8');

  // 1. Hostile values are shown as text, never as markup.
  const evil = await renderAll(current, evilResponses);
  assert(noRawTag(evil.users), 'users table has no raw tag');
  assert(noRawTag(evil.pending), 'pending cards have no raw tag');
  assert(noRawTag(evil.secretaries), 'secretary list has no raw tag');
  assert(evil.users.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'));
  assert(evil.users.includes('O&#39;Brien &amp; &lt;b&gt;'));
  assert(evil.users.includes('&lt;script&gt;x&lt;/script&gt;'), 'createdAt is escaped too');
  assert(evil.secretaries.includes('Dr. &lt;img'), 'pediatrician name in the dropdown is escaped');
  ok('signup names, emails, dates and pediatrician names render as plain text, not HTML');

  // 2. Buttons still call the right handler with the right id.
  assert(evil.users.includes(`approveUser('u1')`) && evil.users.includes(`rejectUser('u1')`));
  assert(evil.users.includes(`suspendUser('u2')`));
  assert(evil.secretaries.includes(`linkSecretary('s1')`) && evil.secretaries.includes('id="linkSelect_s1"'));
  assert(/<option value="p1" selected>/.test(evil.secretaries), 'linked pediatrician stays selected');
  ok('Approve / Reject / Suspend / Update Link still target the right account');

  // 3. Error messages are escaped.
  const failing = loadPage(current, { '/admin/users': new Error(EVIL), '/secretary/list': new Error(EVIL) });
  await failing.sandbox.loadUsers();
  await failing.sandbox.loadSecretaries();
  assert(noRawTag(failing.el('usersList').innerHTML) && failing.el('usersList').innerHTML.includes('Error: &lt;img'));
  assert(noRawTag(failing.el('secList').innerHTML));
  ok('error messages are escaped');

  // 4. Ordinary data renders exactly as before the fix.
  let committed = null;
  try {
    committed = execFileSync('git', ['show', 'HEAD:js/admin/admin-users.js'], { cwd: ROOT, encoding: 'utf8' });
  } catch {
    committed = null; // no git available (e.g. packaged copy): skip the comparison
  }
  if (committed && committed !== current) {
    const before = await renderAll(committed, NORMAL);
    const after = await renderAll(current, NORMAL);
    assert.deepStrictEqual(after, before, 'normal names and emails render byte-for-byte the same');
    ok('ordinary users, pending cards and secretaries render exactly as before (compared with HEAD)');
  } else {
    const after = await renderAll(current, NORMAL);
    assert(after.users.includes('Lucas Dumaniel') && after.users.includes('Re-activate') && after.pending.includes('Approve'));
    assert.strictEqual(after.pendingCount, 1);
    assert.strictEqual(after.userCount, '(3)');
    ok('ordinary users, pending cards and secretaries render normally');
  }

  console.log(results.map((r) => `  ok - ${r}`).join('\n'));
  console.log(`Admin Users escaping tests OK — ${results.length} groups`);
})().catch((err) => { console.error(err); process.exit(1); });
