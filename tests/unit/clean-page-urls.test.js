// Clean addresses for sign-in, sign-up and every role's pages.
//
// /login, /signup, /parent/<page>, /pedia/<page>, /admin/<page> and
// /secretary/<page> serve the page directly. The old ".html" address answers a
// 302 to the clean one and keeps its query string, so bookmarks, emails,
// stored notification links, printed Pay at Clinic QR codes and the pages that
// still link to ".html" keep working.
//
// No DB: server.js exports the Express app when it is required rather than
// run, and none of these requests touch Mongo.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const app = require(path.join(ROOT, 'server.js'));
const { versionAssetUrls } = require(path.join(ROOT, 'services', 'assetVersions.js'));

const results = [];
const ok = (label) => results.push(label);

async function run() {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (url) => {
    const res = await fetch(base + url, { headers: { accept: 'text/html' }, redirect: 'manual' });
    return { status: res.status, location: res.headers.get('location'), body: await res.text() };
  };
  // A page is served with its own script/stylesheet URLs content-versioned
  // (tests/unit/asset-versions.test.js), so compare against that.
  const read = (...parts) => versionAssetUrls(fs.readFileSync(path.join(ROOT, ...parts), 'utf8'));

  try {
    // 1. Clean addresses serve the page itself.
    for (const [url, file] of [['/login', 'login.html'], ['/signup', 'signup.html']]) {
      const r = await get(url);
      assert.strictEqual(r.status, 200, `${url} should load (got ${r.status})`);
      assert.strictEqual(r.body, read('SIGN-UP,LOGIN', file), `${url} serves ${file}`);
    }
    const parentPages = fs.readdirSync(path.join(ROOT, 'PARENT')).filter((f) => f.endsWith('.html'));
    for (const file of parentPages) {
      const url = `/parent/${file.slice(0, -'.html'.length)}`;
      const r = await get(url);
      assert.strictEqual(r.status, 200, `${url} should load (got ${r.status})`);
      if (!['/parent/payment', '/parent/accept-invitation'].includes(url)) {
        assert.strictEqual(r.body, read('PARENT', file), `${url} serves ${file}`);
      }
    }
    ok(`1: /login, /signup and all ${parentPages.length} parent pages load without .html`);

    // 2. Old .html addresses redirect to the clean one and keep the query.
    for (const [from, to] of [
      ['/login.html', '/login'],
      ['/login.html?next=%2Fparent%2Fresults&showLogin=1', '/login?next=%2Fparent%2Fresults&showLogin=1'],
      ['/signup.html?role=parent', '/signup?role=parent'],
      ['/parent/dashboard.html', '/parent/dashboard'],
      ['/PARENT/dashboard.html', '/parent/dashboard'],
      ['/parent/results.html?childId=c1&assessmentId=a1', '/parent/results?childId=c1&assessmentId=a1'],
      ['/parent/reports.html', '/parent/reports'],
      ['/parent/recommendations.html', '/parent/recommendations'],
      ['/parent/payment.html?appointmentId=a1', '/parent/payment?appointmentId=a1'],
      ['/parent/guardians.html', '/parent/guardians'],
    ]) {
      const r = await get(from);
      assert.strictEqual(r.status, 302, `${from} should redirect (got ${r.status})`);
      assert.strictEqual(r.location, to, `${from} redirects to ${to}`);
    }
    ok('2: .html addresses redirect to the clean address with the query string kept');

    // 3. The redirect never leaves the site, and odd names are still refused.
    for (const url of [
      '/parent/dashboard.js', '/parent/..%2Fserver', '/parent/.env', '/parent/does-not-exist',
      '/pedia/pedia-chat.js', '/pedia/..%2Fserver', '/pedia/.env', '/pedia/does-not-exist',
      '/admin/admin-users.js', '/admin/..%2Fserver', '/admin/.env', '/admin/does-not-exist',
    ]) {
      const r = await get(url);
      assert.strictEqual(r.status, 404, `${url} should be 404 (got ${r.status})`);
    }
    const missing = await get('/parent/does-not-exist.html');
    assert.strictEqual(missing.location, '/parent/does-not-exist', 'a missing page redirects within /parent, then 404s');
    ok('3: traversal and unknown names are 404; redirects stay on /parent');

    // 4. Pediatrician pages: clean addresses serve, .html redirects.
    const pediaPages = fs.readdirSync(path.join(ROOT, 'PEDIA')).filter((f) => f.endsWith('.html'));
    for (const file of pediaPages) {
      const name = file.slice(0, -'.html'.length);
      const r = await get(`/pedia/${name}`);
      assert.strictEqual(r.status, 200, `/pedia/${name} should load (got ${r.status})`);
      assert.strictEqual(r.body, read('PEDIA', file), `/pedia/${name} serves ${file}`);
      const old = await get(`/pedia/${file}`);
      assert.strictEqual(old.status, 302, `/pedia/${file} should redirect (got ${old.status})`);
      assert.strictEqual(old.location, `/pedia/${name}`);
    }
    for (const [from, to] of [
      ['/pedia/pedia-chat.html?appointmentId=7', '/pedia/pedia-chat?appointmentId=7'],
      ['/pedia/pediatrician-appointments.html?appointmentId=108', '/pedia/pediatrician-appointments?appointmentId=108'],
      ['/PEDIA/pediatrician-dashboard.html', '/pedia/pediatrician-dashboard'],
    ]) {
      const r = await get(from);
      assert.strictEqual(r.status, 302, `${from} should redirect (got ${r.status})`);
      assert.strictEqual(r.location, to, `${from} redirects to ${to}`);
    }
    ok(`4: all ${pediaPages.length} pediatrician pages load without .html; .html redirects keep the query`);

    // 5. Admin pages: clean addresses serve, .html redirects, the older short
    //    routes (/admin/payments, /admin/prc-verification) still work.
    const adminPages = fs.readdirSync(path.join(ROOT, 'ADMIN')).filter((f) => f.endsWith('.html'));
    for (const file of adminPages) {
      const name = file.slice(0, -'.html'.length);
      const r = await get(`/admin/${name}`);
      assert.strictEqual(r.status, 200, `/admin/${name} should load (got ${r.status})`);
      assert.strictEqual(r.body, read('ADMIN', file), `/admin/${name} serves ${file}`);
      const old = await get(`/admin/${file}`);
      assert.strictEqual(old.status, 302, `/admin/${file} should redirect (got ${old.status})`);
      assert.strictEqual(old.location, `/admin/${name}`);
    }
    for (const [from, to] of [
      ['/admin/admin-users.html?status=pending', '/admin/admin-users?status=pending'],
      ['/ADMIN/admin-dashboard.html', '/admin/admin-dashboard'],
    ]) {
      const r = await get(from);
      assert.strictEqual(r.status, 302, `${from} should redirect (got ${r.status})`);
      assert.strictEqual(r.location, to, `${from} redirects to ${to}`);
    }
    for (const url of ['/admin/payments', '/admin/prc-verification']) {
      assert.strictEqual((await get(url)).status, 200, `${url} still loads`);
    }
    ok(`5: all ${adminPages.length} admin pages load without .html; .html redirects keep the query`);

    // 6. Secretary pages: clean addresses serve, .html redirects. Pay at Clinic
    //    QR codes already handed out encode the .html Cashier URL with ?ref=.
    const secretaryPages = fs.readdirSync(path.join(ROOT, 'SECRETARY')).filter((f) => f.endsWith('.html'));
    for (const file of secretaryPages) {
      const name = file.slice(0, -'.html'.length);
      const r = await get(`/secretary/${name}`);
      assert.strictEqual(r.status, 200, `/secretary/${name} should load (got ${r.status})`);
      assert.strictEqual(r.body, read('SECRETARY', file), `/secretary/${name} serves ${file}`);
      const old = await get(`/secretary/${file}`);
      assert.strictEqual(old.status, 302, `/secretary/${file} should redirect (got ${old.status})`);
      assert.strictEqual(old.location, `/secretary/${name}`);
    }
    for (const [from, to] of [
      ['/secretary/secretary-cashier.html?ref=KC-PAY-ABC123', '/secretary/secretary-cashier?ref=KC-PAY-ABC123'],
      ['/SECRETARY/secretary-dashboard.html', '/secretary/secretary-dashboard'],
    ]) {
      const r = await get(from);
      assert.strictEqual(r.status, 302, `${from} should redirect (got ${r.status})`);
      assert.strictEqual(r.location, to, `${from} redirects to ${to}`);
    }
    for (const url of ['/secretary/secretary-cashier.js', '/secretary/..%2Fserver', '/secretary/.env', '/secretary/does-not-exist']) {
      assert.strictEqual((await get(url)).status, 404, `${url} should be 404`);
    }
    ok(`6: all ${secretaryPages.length} secretary pages load without .html; old QR links keep ?ref=`);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

run()
  .then(() => {
    results.forEach((label) => console.log(`  ok - ${label}`));
    console.log(`Clean page URL tests OK — ${results.length} groups`);
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
