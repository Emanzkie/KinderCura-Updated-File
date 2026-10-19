// Locks the ?v= version on PEDIA/pedia-reports.html's and
// ADMIN/admin-analytics.html's own script and
// stylesheet URLs to the content of those files.
//
// The reported defect: after a deploy, Section B (Patient Development
// Progress) stayed on "Loading…" forever. The HTML is always revalidated
// (max-age=0), but scripts and stylesheets may be reused from the browser
// cache for 10 minutes and then served stale for up to a day while they
// refresh (server.js CACHE_RULES). The browser ran the NEW page with the OLD
// pedia-reports.js, which had never heard of #devProgressSection, so nothing
// ever replaced its placeholder.
//
// A version that changes with the file's content gives the new HTML a new
// URL, which no cache has seen, so the page and its scripts always match.
// This test fails when one of the files changes without its version being
// updated. Line endings are normalised so the hash is the same on Windows
// checkouts (CRLF) and on the Linux build (LF).
//
// To update after editing one of these files: run this test and copy the
// expected URL from the failure message into the HTML.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

// Page -> its own scripts and stylesheets: served URL -> file on disk
// (server.js mounts /css on "CSS files"). ADMIN/admin-analytics.html was added
// after the same defect hit it: a browser ran the old cached
// admin-analytics.js (initCharts, "Chart is not defined") against the new
// HTML, and every section stayed on "Loading…".
const PAGES = {
  'PEDIA/pedia-reports.html': {
    '/css/pedia-reports-styles.css': 'CSS files/pedia-reports-styles.css',
    '/js/pedia/pedia-reports-interpretations.js': 'js/pedia/pedia-reports-interpretations.js',
    '/js/pedia/pedia-reports.js': 'js/pedia/pedia-reports.js',
  },
  'ADMIN/admin-analytics.html': {
    '/css/admin-analytics.css': 'CSS files/admin-analytics.css',
    '/js/admin/analytics-interpretations.js': 'js/admin/analytics-interpretations.js',
    '/js/admin/admin-analytics.js': 'js/admin/admin-analytics.js',
  },
  // Same defect again: the new "How these averages are calculated" panel ran
  // with the old cached admin-reports.js and stayed on "Loading...".
  'ADMIN/admin-reports.html': {
    '/css/admin-reports.css': 'CSS files/admin-reports.css',
    '/js/admin/admin-reports-interpretations.js': 'js/admin/admin-reports-interpretations.js',
    '/js/admin/admin-reports.js': 'js/admin/admin-reports.js',
    '/js/admin/admin-clinics.js': 'js/admin/admin-clinics.js',
  },
};

function contentVersion(file) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\r\n').join('\n');
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 10);
}

for (const [page, assets] of Object.entries(PAGES)) {
  const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
  for (const [url, file] of Object.entries(assets)) {
    const expected = `"${url}?v=${contentVersion(file)}"`;
    const mentions = html.split(`"${url}`).length - 1;
    assert.strictEqual(mentions, 1, `${url} is referenced exactly once in ${page}`);
    assert.ok(html.includes(expected),
      `${url} must be referenced as ${expected} — update the version in ${page}`);
  }
}

console.log('Page asset versions OK — Pediatrician Reports, Admin Analytics and Admin Reports reference the current content of their own script and stylesheet files');
