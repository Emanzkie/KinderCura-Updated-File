// Admin Users page (js/admin/admin-users.js): every server value is escaped
// before it is put into innerHTML.
//
// Names and emails are typed by whoever signs up, and a pediatrician types
// their own clinic name. These used to be written into the Users table, the
// Pending Approvals cards and the Secretary list raw, so a signup named
// `<img src=x onerror=...>` ran script in the admin's session.
//
// No browser, no network: the real page script runs in a node vm with a tiny
// fake DOM.
//
// Also covers the Active / Suspended Users tabs: the main table lists only
// active accounts by default, suspended ones (with their suspension date and
// Re-activate) are on their own tab, and pending sign-ups stay in the Pending
// Approvals card.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'js/admin/admin-users.js');
const results = [];
const ok = (label) => results.push(label);

function loadPage(source, responses) {
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) els.set(id, { id, innerHTML: '', textContent: '', value: '', className: '', style: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } });
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
      { id: 'u3', firstName: EVIL, lastName: "O'Brien & <b>", email: `${EVIL}@x.com`, role: 'parent', status: 'active', createdAt: 'Oct 1, 2026' },
      { id: 'u4', firstName: EVIL, lastName: 'S', email: 's@x.com', role: 'parent', status: 'suspended', createdAt: 'Oct 1, 2026', suspendedAt: '<script>y</script>' },
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
      { id: '6650a1b2c3d4e5f601234569', firstName: 'Ben', lastName: 'Reyes', email: 'ben@example.com', role: 'secretary', status: 'suspended', createdAt: 'Oct 3, 2026', suspendedAt: 'Oct 20, 2026' },
      { id: '6650a1b2c3d4e5f60123456c', firstName: 'Enrique', lastName: 'Domingo', email: 'enrique@example.com', role: 'pediatrician', status: 'suspended', prcVerificationStatus: 'verified', createdAt: 'Sep 2, 2026', suspendedAt: null },
      { id: '6650a1b2c3d4e5f60123456d', firstName: 'Old', lastName: 'Account', email: 'old@example.com', role: 'parent', createdAt: 'Jan 1, 2026' },
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
  const out = {
    users: page.el('usersList').innerHTML,
    pending: page.el('pendingList').innerHTML,
    secretaries: page.el('secList').innerHTML,
    pendingCount: page.el('pendingCount').textContent,
    userCount: page.el('userCount').textContent,
    activeCount: page.el('activeCount').textContent,
    suspendedCount: page.el('suspendedCount').textContent,
    secCount: page.el('secCount').textContent,
  };
  page.sandbox.showSection('suspended');
  out.suspended = page.el('usersList').innerHTML;
  out.suspendedUserCount = page.el('userCount').textContent;
  out.suspendedTitle = page.el('userSectionTitle').textContent;
  out.suspendedDateHeader = page.el('userDateHeader').textContent;
  out.suspendedTabClass = page.el('tabSuspendedUsers').className;
  out.page = page;
  return out;
}

const noRawTag = (html) => !/<img|<script|<b>/i.test(html);

(async () => {
  const current = fs.readFileSync(SCRIPT, 'utf8');

  // 1. Hostile values are shown as text, never as markup.
  const evil = await renderAll(current, evilResponses);
  assert(noRawTag(evil.users), 'users table has no raw tag');
  assert(noRawTag(evil.suspended), 'suspended table has no raw tag');
  assert(noRawTag(evil.pending), 'pending cards have no raw tag');
  assert(noRawTag(evil.secretaries), 'secretary list has no raw tag');
  assert(evil.users.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'));
  assert(evil.users.includes('O&#39;Brien &amp; &lt;b&gt;'));
  assert(evil.users.includes('&lt;script&gt;x&lt;/script&gt;'), 'createdAt is escaped too');
  assert(evil.suspended.includes('&lt;script&gt;y&lt;/script&gt;'), 'suspendedAt is escaped too');
  assert(evil.pending.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'));
  assert(evil.secretaries.includes('Dr. &lt;img'), 'pediatrician name in the dropdown is escaped');
  ok('signup names, emails, dates and pediatrician names render as plain text, not HTML');

  // 2. Buttons still call the right handler with the right id.
  assert(evil.pending.includes(`approveUser('u1')`) && evil.pending.includes(`rejectUser('u1')`));
  assert(evil.users.includes(`suspendUser('u2')`));
  assert(evil.suspended.includes(`approveUser('u4')`), 'Re-activate targets the suspended account');
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

  // 4. Active Users is the default and lists only active accounts (and legacy
  //    accounts with no stored status, which can still sign in).
  const normal = await renderAll(current, NORMAL);
  assert(normal.users.includes('Ana Cruz') && normal.users.includes('Old Account'));
  assert(!normal.users.includes('Ben Reyes') && !normal.users.includes('Enrique Domingo'), 'no suspended account in Active Users');
  assert(!normal.users.includes('Lucas Dumaniel'), 'pending sign-ups are not in Active Users');
  assert(!normal.users.includes('Re-activate'));
  assert.strictEqual(normal.userCount, '(2)');
  assert.strictEqual(normal.activeCount, '(2)');
  assert.strictEqual(normal.suspendedCount, '(2)');
  ok('Active Users is the default, lists only active accounts, and both tab counts are shown');

  // 5. Suspended Users lists every suspended account with its date and Re-activate.
  assert.strictEqual(normal.suspendedTitle, 'Suspended Users');
  assert.strictEqual(normal.suspendedDateHeader, 'Suspended On');
  assert.strictEqual(normal.suspendedTabClass, 'btn btn-primary');
  assert.strictEqual(normal.suspendedUserCount, '(2)');
  assert(normal.suspended.includes('Ben Reyes') && normal.suspended.includes('Enrique Domingo'));
  assert(!normal.suspended.includes('Ana Cruz') && !normal.suspended.includes('Lucas Dumaniel'));
  assert(normal.suspended.includes('Oct 20, 2026'), 'suspension date shown');
  assert(!normal.suspended.includes('Oct 3, 2026'), 'the join date is not shown as the suspension date');
  assert(normal.suspended.includes('—'), 'a missing suspension date shows a dash');
  assert.strictEqual((normal.suspended.match(/Re-activate/g) || []).length, 2);
  assert(!normal.suspended.includes('suspendUser('));
  ok('Suspended Users lists only suspended accounts with name, email, role, suspension date and Re-activate');

  // 6. Pending sign-ups still reach the Pending Approvals card.
  assert(normal.pending.includes('Lucas Dumaniel') && normal.pending.includes('Approve'));
  assert.strictEqual(normal.pendingCount, 1);
  ok('pending sign-ups stay in the Pending Approvals card');

  // 7. A reload (after Suspend / Re-activate, or the 30-second refresh) keeps
  //    the selected tab, and the account moves between the lists.
  const page = normal.page;
  NORMAL['/admin/users'].users[1].status = 'suspended';
  NORMAL['/admin/users'].users[1].suspendedAt = 'Oct 30, 2026';
  await page.sandbox.loadUsers();
  assert(page.el('usersList').innerHTML.includes('Ana Cruz'), 'still on the Suspended tab, now with Ana');
  assert.strictEqual(page.el('suspendedCount').textContent, '(3)');
  assert.strictEqual(page.el('activeCount').textContent, '(1)');
  NORMAL['/admin/users'].users[1].status = 'active';
  delete NORMAL['/admin/users'].users[1].suspendedAt;
  await page.sandbox.loadUsers();
  page.sandbox.showSection('active');
  assert(page.el('usersList').innerHTML.includes('Ana Cruz'), 're-activated account is back in Active Users');
  assert.strictEqual(page.el('userDateHeader').textContent, 'Joined');
  assert.strictEqual(page.el('tabActiveUsers').attrs['aria-selected'], 'true');
  ok('after Suspend / Re-activate the account moves between tabs and the selected tab is kept');

  // 8. Search and role go to the server; the old status parameter is gone.
  const calls = [];
  const filtered = loadPage(current, NORMAL);
  filtered.sandbox.apiFetch = async (endpoint) => { calls.push(endpoint); return NORMAL['/admin/users']; };
  filtered.el('searchInput').value = ' ana ';
  filtered.el('roleFilter').value = 'pediatrician';
  await filtered.sandbox.applyFilters();
  assert.deepStrictEqual(calls, ['/admin/users?search=ana&role=pediatrician']);
  ok('search and role filter apply to both tabs; no status parameter is sent');

  console.log(results.map((r) => `  ok - ${r}`).join('\n'));
  console.log(`Admin Users escaping tests OK — ${results.length} groups`);
})().catch((err) => { console.error(err); process.exit(1); });
