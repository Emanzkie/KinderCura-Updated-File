// Unit tests for the Cache-Control headers server.js puts on the app's own
// static files.
//
// The reported problem: every stylesheet, script, icon and page was served
// with express.static's default "max-age=0", so the browser re-requested all
// of them on every page view — and on Vercel each of those requests started
// the serverless function. Now CSS/JS/images/HTML carry s-maxage so Vercel's
// CDN serves them (its cache is purged on every deploy), with short browser
// lifetimes so a deploy still shows up quickly.
//
// What must NOT be cached is checked just as hard: /api responses (per-user
// data), 404s and errors, user uploads, and unknown URLs that fall through to
// the landing page.
//
// No DB: server.js exports the Express app when it is required rather than
// run, and none of these requests touch Mongo.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const app = require(path.join(ROOT, 'server.js'));

const ASSET = 'public, max-age=600, s-maxage=31536000, stale-while-revalidate=86400';
const IMAGE = 'public, max-age=86400, s-maxage=31536000';
const PAGE = 'public, max-age=0, must-revalidate, s-maxage=31536000';

const results = [];
const ok = (label) => results.push(label);

function firstFile(dir, test) {
  const full = path.join(ROOT, dir);
  return fs.existsSync(full) ? fs.readdirSync(full).find(test) : undefined;
}

async function run() {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (url, headers = {}) => {
    const res = await fetch(base + url, { headers: { accept: 'text/html', ...headers } });
    await res.arrayBuffer();
    return res;
  };
  const expectCache = async (url, expected) => {
    const res = await get(url);
    assert.strictEqual(res.status, 200, `${url} should load (got ${res.status})`);
    assert.strictEqual(res.headers.get('cache-control'), expected, `${url} Cache-Control`);
    return res;
  };
  const expectNoCdn = (res, url) => {
    const cc = res.headers.get('cache-control') || '';
    assert.ok(!/s-maxage/.test(cc), `${url} must not be CDN-cached (got "${cc}")`);
  };

  try {
    // 1. Stylesheets and scripts, from every mount that serves them.
    for (const url of [
      '/css/dashboard-new-styles.css',
      '/assets/css/dashboard-new-styles.css',
      '/js/parent/dashboard.js',
      `/assets/js/${firstFile('assets/js', (f) => f.endsWith('.js'))}`,
      '/api.js',
      '/notifications-card-ui.css',
      '/notifications-card-ui.js',
      '/constants/scoring.js',
    ]) {
      await expectCache(url, ASSET);
    }
    ok('1: CSS and JS: 10 min in the browser, kept by the CDN until the next deploy');

    // 2. Images.
    for (const url of ['/icons/logo.png', '/assets/images/logo.png', '/favicon.ico']) {
      await expectCache(url, IMAGE);
    }
    ok('2: icons and images: 1 day in the browser, kept by the CDN');

    // 3. HTML pages: always revalidated by the browser, answered by the CDN.
    for (const url of [
      '/',
      '/login.html',
      '/parent/dashboard.html',
      '/pedia/pediatrician-dashboard.html',
      '/admin/admin-dashboard.html',
      `/secretary/${firstFile('SECRETARY', (f) => f.endsWith('.html'))}`,
      '/parent/guardians',
      '/parent/payment',
      '/admin/payments',
      '/accept-invitation',
    ]) {
      await expectCache(url, PAGE);
    }
    ok('3: HTML pages are revalidated by the browser and served by the CDN');

    // 4. A browser revalidation (304) carries the same header. Raw http here:
    //    fetch() adds "Cache-Control: no-cache" to conditional requests, which
    //    makes the server skip the 304 the way it should for a forced reload.
    {
      const { port } = server.address();
      const raw = (headers) => new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: '/css/dashboard-new-styles.css', headers }, (res) => {
          res.resume();
          res.on('end', () => resolve(res));
        }).on('error', reject);
      });
      const first = await raw({});
      const again = await raw({ 'if-none-match': first.headers.etag });
      assert.strictEqual(again.statusCode, 304);
      assert.strictEqual(again.headers['cache-control'], ASSET);
    }
    ok('4: 304 Not Modified responses keep the cache header');

    // 5. Never cached: API responses, 404s, unknown URLs, uploads.
    {
      const health = await get('/api/health');
      assert.strictEqual(health.status, 200);
      expectNoCdn(health, '/api/health');

      for (const url of ['/api/does-not-exist', '/parent/does-not-exist.html', '/parent/..%2Fserver.js']) {
        const res = await get(url);
        assert.notStrictEqual(res.status, 200, `${url} should not succeed`);
        expectNoCdn(res, url);
      }

      // Unknown URLs, including a missing stylesheet, still fall through to the
      // landing page as before — but that answer is never CDN-cached.
      for (const url of ['/some/unknown/page', '/css/does-not-exist.css']) {
        const res = await get(url);
        assert.strictEqual(res.status, 200, `${url} still falls through to the landing page`);
        expectNoCdn(res, url);
      }

      const profile = firstFile('uploads/profiles', (f) => /\.(jpe?g|png)$/i.test(f));
      if (profile) {
        const res = await get(`/uploads/profiles/${profile}`);
        assert.strictEqual(res.status, 200);
        expectNoCdn(res, `/uploads/profiles/${profile}`);
      }
      const publicUpload = firstFile('public/uploads/datasets', () => true);
      if (publicUpload) {
        const res = await get(`/public/uploads/datasets/${encodeURIComponent(publicUpload)}`);
        assert.strictEqual(res.status, 200);
        expectNoCdn(res, '/public/uploads/...');
      }
    }
    ok('5: /api, 404s, unknown URLs and user uploads are never CDN-cached');

    // 6. Chart.js is pinned to one exact version on every page that uses it.
    {
      const pinned = 'https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js';
      let pages = 0;
      for (const dir of ['PARENT', 'PEDIA', 'ADMIN', 'SECRETARY', 'SIGN-UP,LOGIN']) {
        for (const file of fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith('.html'))) {
          const html = fs.readFileSync(path.join(ROOT, dir, file), 'utf8');
          const refs = html.match(/https:\/\/cdn\.jsdelivr\.net\/npm\/chart\.js[^"']*/g) || [];
          for (const ref of refs) assert.strictEqual(ref, pinned, `${dir}/${file} loads an unpinned Chart.js: ${ref}`);
          if (refs.length) pages += 1;
        }
      }
      assert.ok(pages >= 7, `expected the 7 chart pages, found ${pages}`);
    }
    ok('6: every chart page loads Chart.js 4.5.1 by exact URL');
  } finally {
    server.close();
  }
}

run()
  .then(() => {
    results.forEach((label) => console.log(`  ok - ${label}`));
    console.log(`Static cache header tests OK — ${results.length} groups`);
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
