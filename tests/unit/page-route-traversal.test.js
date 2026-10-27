// Unit tests for the two ways server.js serves files from the project tree:
// the root static handler and the role page routes (/parent/:page,
// /pedia/:page, /admin/:page, /secretary/:page).
//
// The reported defect: an encoded "../" reached backend source and the parent
// payment-proof images in private/ through both.
// - Root static: the SERVER_ONLY_* guard tested the raw URL, but express.static
//   decodes %2F and collapses "..", so "/x/..%2Froutes%2Fauth.js" passed the
//   guard and was served as /routes/auth.js.
// - Page routes: Express decodes %2F before routing, so "/parent/..%2Fserver.js"
//   arrived as page = "../server.js" and path.join resolved it to the root.
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

function firstFile(dir, ext) {
  return fs.readdirSync(path.join(ROOT, dir)).find((f) => f.endsWith(ext));
}

async function run() {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (url) => {
    const res = await fetch(base + url, { headers: { accept: 'text/html' } });
    return { status: res.status, body: await res.text() };
  };

  try {
    // 1. Every role folder still serves its real pages.
    for (const [prefix, dir] of [['parent', 'PARENT'], ['pedia', 'PEDIA'], ['admin', 'ADMIN'], ['secretary', 'SECRETARY']]) {
      const page = firstFile(dir, '.html');
      const res = await get(`/${prefix}/${page}`);
      assert.strictEqual(res.status, 200, `/${prefix}/${page} should load`);
      assert.strictEqual(res.body, fs.readFileSync(path.join(ROOT, dir, page), 'utf8'));
    }
    ok('1: /parent, /pedia, /admin and /secretary still serve their own .html pages');

    // 2. Encoded traversal into backend source is refused on every prefix.
    const sourceLeaks = [
      '/parent/..%2Fserver.js',
      '/pedia/..%2Fdb.js',
      '/admin/..%2Froutes%2Fauth.js',
      '/secretary/..%2Fmiddleware%2Fauth.js',
      '/parent/%2E%2E%2Fserver.js',
      '/admin/..%5Cserver.js',
    ];
    for (const url of sourceLeaks) {
      const res = await get(url);
      assert.strictEqual(res.status, 404, `${url} must not be served (got ${res.status})`);
      assert.ok(!/require\(|module\.exports/.test(res.body), `${url} leaked source`);
    }
    ok('2: encoded ../ on every role prefix cannot reach backend source');

    // 3. Private payment proofs cannot be reached through a page route.
    const proofDir = path.join(ROOT, 'private', 'payment-proofs');
    const proof = fs.existsSync(proofDir) ? fs.readdirSync(proofDir)[0] : 'proof.jpg';
    const res = await get(`/parent/..%2Fprivate%2Fpayment-proofs%2F${encodeURIComponent(proof)}`);
    assert.strictEqual(res.status, 404, 'payment proof must not be served');
    ok('3: private/payment-proofs is not reachable through /parent/:page');

    // 4. Only flat .html names are accepted (parent pages take them without .html).
    for (const url of ['/parent/dashboard.js', '/pedia/pediatrician-dashboard', '/parent/dashboard.html.js', '/admin/.env', '/pedia/..%2F']) {
      const r = await get(url);
      assert.strictEqual(r.status, 404, `${url} should be 404 (got ${r.status})`);
    }
    ok('4: names that are not a flat .html file are 404');

    // 5. The root static guard judges the decoded path, whatever the prefix.
    for (const url of [
      '/x/..%2Fserver.js',
      '/CSS%20files/..%2Fdb.js',
      '/x/..%2Froutes%2Fauth.js',
      '/x/..%5Cserver.js',
      '/x/..%2Fpackage.json',
      `/x/..%2Fprivate%2Fpayment-proofs%2F${encodeURIComponent(proof)}`,
      '/%2E%2E/server.js',
      '/routes%2Fauth.js',
    ]) {
      const r = await get(url);
      assert.ok(r.status !== 200 || !/require\(|"dependencies"|JFIF/.test(r.body), `${url} leaked a server-only file`);
      assert.notStrictEqual(r.body.slice(0, 2), '//', `${url} served a JS source file`);
    }
    ok('5: encoded ../ through the root static handler cannot reach server-only files');

    // 6. Browser assets the root static handler exists for still load.
    for (const file of ['notifications-card-ui.css', 'constants/scoring.js', 'api.js']) {
      const r = await get('/' + file);
      assert.strictEqual(r.status, 200, `/${file} should still load`);
      assert.strictEqual(r.body, fs.readFileSync(path.join(ROOT, file), 'utf8'));
    }
    ok('6: root-level browser assets are still served');

    // 7. A well-formed name that does not exist is still a 404, not a crash.
    const missing = await get('/parent/does-not-exist.html');
    assert.strictEqual(missing.status, 404);
    ok('7: a missing .html page is a 404');
  } finally {
    server.close();
  }
}

run()
  .then(() => {
    results.forEach((label) => console.log(`  ok - ${label}`));
    console.log(`Page route traversal tests OK — ${results.length} groups`);
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
