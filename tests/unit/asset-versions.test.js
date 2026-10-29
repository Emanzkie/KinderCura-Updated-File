// Every page's own scripts and stylesheets are referenced by content version.
//
// The reported defect: after a deploy, PEDIA/pedia-reports.html's Section B
// stayed on "Loading…" forever. The HTML is always revalidated (max-age=0),
// but scripts and stylesheets may be reused from the browser cache for 10
// minutes and then served stale for up to a day (server.js CACHE_RULES), so
// the browser ran the NEW page with the OLD pedia-reports.js. Every other page
// had the same risk; the parent Appointments page's new Refund Policy button
// hit it too ("openRefundPolicy is not defined").
//
// server.js now sends every page through services/assetVersions.js, which
// appends ?v=<hash of the file's content> to each local .css/.js URL. This
// test fetches every page the way a browser would and checks that each local
// <script src> and <link rel="stylesheet"> carries the version of exactly what
// the server returns at that URL — so a changed file always gets a new URL.
//
// Stylesheets that @import another local stylesheet carry its version by hand
// (only kc-tokens.css today). When this test reports one, copy the expected
// URL from the failure message into the CSS file.
//
// No DB: server.js exports the Express app when it is required rather than
// run, and none of these requests touch Mongo.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const app = require(path.join(ROOT, 'server.js'));
const { assetVersion, contentVersion } = require(path.join(ROOT, 'services', 'assetVersions.js'));

const results = [];
const ok = (label) => results.push(label);

const htmlFiles = (dir) => fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith('.html'));
const isLocal = (url) => !/^([a-z]+:|\/\/)/i.test(url);

// Local stylesheet and script URLs in a page, wherever the tag is split.
function localAssets(html) {
  const urls = [];
  for (const [tag] of html.matchAll(/<(?:script|link)\b[^>]*>/gi)) {
    const isLink = /^<link/i.test(tag);
    if (isLink && !/\brel\s*=\s*["']?stylesheet/i.test(tag)) continue;
    const m = tag.match(isLink ? /\bhref\s*=\s*(["'])(.*?)\1/i : /\bsrc\s*=\s*(["'])(.*?)\1/i);
    if (m && isLocal(m[2])) urls.push(m[2]);
  }
  return urls;
}

async function run() {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const get = async (url) => {
    const res = await fetch(base + url, { headers: { accept: 'text/html' } });
    return { res, body: await res.text() };
  };
  // Hashed from the raw bytes: res.text() would drop a byte-order mark.
  const servedVersions = new Map();
  const servedVersion = async (url) => {
    if (!servedVersions.has(url)) {
      const res = await fetch(base + url);
      const body = Buffer.from(await res.arrayBuffer()).toString('utf8');
      assert.strictEqual(res.status, 200, `${url} should load (got ${res.status})`);
      assert.ok(!/text\/html/.test(res.headers.get('content-type')), `${url} fell through to a page`);
      servedVersions.set(url, contentVersion(body));
    }
    return servedVersions.get(url);
  };

  try {
    // 1. Every page, at the clean URL the app links to, plus the explicit
    //    routes, the folder-path URLs the root static handler serves, and EJS
    //    views. Old ".html" addresses redirect, so fetch follows them.
    const clean = (f) => f.slice(0, -'.html'.length);
    const pages = [
      ...htmlFiles('PARENT').map((f) => `/parent/${clean(f)}`),
      ...htmlFiles('PEDIA').map((f) => `/pedia/${clean(f)}`),
      ...htmlFiles('ADMIN').map((f) => `/admin/${clean(f)}`),
      ...htmlFiles('SECRETARY').map((f) => `/secretary/${clean(f)}`),
      ...htmlFiles('SIGN-UP,LOGIN').map((f) => `/${f}`),
      '/', '/some/unknown/page', '/login', '/signup',
      '/parent/guardians', '/parent/payment', '/admin/payments', '/admin/prc-verification', '/accept-invitation',
      '/parent/dashboard.html', '/PARENT/dashboard.html', '/SIGN-UP,LOGIN/login.html',
      '/parent/invite-guardian', '/admin/guardian-management',
    ];
    let refs = 0;
    for (const page of pages) {
      const { res, body } = await get(page);
      assert.strictEqual(res.status, 200, `${page} should load (got ${res.status} at ${res.url})`);
      assert.match(res.headers.get('content-type'), /^text\/html/, `${page} is HTML`);
      for (const url of localAssets(body)) {
        const m = url.match(/^(\/[^?#]+)\?v=([0-9a-f]{10})$/);
        assert.ok(m, `${page} references ${url} without a content version`);
        assert.strictEqual(m[2], await servedVersion(m[1]), `${page}: ${url} is not the version of what ${m[1]} serves`);
        refs += 1;
      }
    }
    assert.ok(refs > 300, `expected every page's assets, checked only ${refs}`);
    ok(`1: ${pages.length} pages, ${refs} script/stylesheet URLs, each the content version of what it serves`);

    // 1b. The pages that broke this way (Section B stuck on "Loading…"; Admin
    //     Analytics "Chart is not defined"; parent Refund Policy
    //     "openRefundPolicy is not defined") keep their own files versioned.
    const KNOWN = {
      '/pedia/pedia-reports': ['/css/pedia-reports-styles.css', '/js/pedia/pedia-reports-interpretations.js', '/js/pedia/pedia-reports.js'],
      '/admin/admin-analytics': ['/css/admin-analytics.css', '/js/admin/analytics-interpretations.js', '/js/admin/admin-analytics.js'],
      '/admin/admin-reports': ['/css/admin-reports.css', '/js/admin/admin-reports.js', '/js/admin/admin-clinics.js'],
      '/parent/appointments': ['/css/appointments-styles.css', '/js/parent/appointments.js'],
      '/pedia/pediatrician-appointments': ['/js/shared/refund-requests.js', '/js/pedia/pediatrician-appointments.js'],
      '/secretary/secretary-cashier': ['/js/shared/refund-requests.js', '/js/secretary/secretary-cashier.js'],
    };
    for (const [page, urls] of Object.entries(KNOWN)) {
      const { body } = await get(page);
      for (const url of urls) {
        assert.ok(body.includes(`"${url}?v=${await servedVersion(url)}"`), `${page} must reference ${url} by its current version`);
      }
    }
    ok('1b: Pediatrician Reports, Admin Analytics/Reports, parent Appointments and the refund panels reference their own files by current version');

    // 2. Hand-written @import versions in stylesheets.
    const cssDir = path.join(ROOT, 'CSS files');
    let imports = 0;
    for (const file of fs.readdirSync(cssDir).filter((f) => f.endsWith('.css'))) {
      const css = fs.readFileSync(path.join(cssDir, file), 'utf8');
      for (const [, url] of css.matchAll(/@import\s+(?:url\()?\s*["']?([^"')\s;]+)/g)) {
        if (!isLocal(url)) continue;
        const target = url.split('?')[0];
        const expected = `${target}?v=${assetVersion(path.join(cssDir, target))}`;
        assert.strictEqual(url, expected, `CSS files/${file}: @import must be '${expected}'`);
        imports += 1;
      }
    }
    assert.ok(imports >= 3, `expected the kc-tokens.css imports, found ${imports}`);
    ok(`2: ${imports} stylesheet @imports carry the imported file's current version`);

    // 3. A changed file gets a new version without a restart (dev edits).
    {
      const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kc-assets-')), 'a.js');
      try {
        fs.writeFileSync(tmp, 'one();\r\n');
        const first = assetVersion(tmp);
        assert.strictEqual(first, contentVersion('one();\n'), 'CRLF and LF checkouts give the same version');
        fs.writeFileSync(tmp, 'two();\n');
        fs.utimesSync(tmp, new Date(), new Date(Date.now() + 5000));
        assert.notStrictEqual(assetVersion(tmp), first, 'an edited file gets a new version');
      } finally {
        fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
      }
    }
    ok('3: versions follow content, with line endings normalised');

    // 4. Pages still answer conditional requests with 304.
    {
      const raw = (headers) => new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: '/parent/dashboard', headers }, (res) => {
          res.resume();
          res.on('end', () => resolve(res));
        }).on('error', reject);
      });
      const first = await raw({});
      assert.ok(first.headers.etag, 'pages carry an ETag');
      const again = await raw({ 'if-none-match': first.headers.etag });
      assert.strictEqual(again.statusCode, 304);
    }
    ok('4: pages still revalidate with 304 Not Modified');
  } finally {
    server.close();
  }
}

run()
  .then(() => {
    results.forEach((label) => console.log(`  ok - ${label}`));
    console.log(`Asset version tests OK — ${results.length} groups`);
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
