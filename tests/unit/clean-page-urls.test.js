// Clean addresses for sign-in, sign-up, the parent and the pediatrician pages.
//
// /login, /signup, /parent/<page> and /pedia/<page> serve the page directly.
// The old ".html" address answers a 302 to the clean one and keeps its query
// string, so bookmarks, emails, stored notification links and the pages that
// still link to ".html" keep working. Admin and secretary pages are not part
// of this change and still use ".html".
//
// No DB: server.js exports the Express app when it is required rather than
// run, and none of these requests touch Mongo.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const app = require(path.join(ROOT, 'server.js'));

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
  const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

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

    // 5. Admin and secretary pages are unchanged: .html still serves directly, no clean form.
    for (const [prefix, dir] of [['admin', 'ADMIN'], ['secretary', 'SECRETARY']]) {
      const file = fs.readdirSync(path.join(ROOT, dir)).find((f) => f.endsWith('.html'));
      const r = await get(`/${prefix}/${file}`);
      assert.strictEqual(r.status, 200, `/${prefix}/${file} still loads`);
    }
    assert.strictEqual((await get('/admin/admin-dashboard')).status, 404);
    ok('5: admin and secretary pages still use .html');
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
