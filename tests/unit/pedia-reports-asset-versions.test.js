// Locks the ?v= version on PEDIA/pedia-reports.html's own script and
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
const html = fs.readFileSync(path.join(ROOT, 'PEDIA', 'pedia-reports.html'), 'utf8');

// Served URL -> file on disk (server.js mounts /css on "CSS files").
const ASSETS = {
  '/css/pedia-reports-styles.css': 'CSS files/pedia-reports-styles.css',
  '/js/pedia/pedia-reports-interpretations.js': 'js/pedia/pedia-reports-interpretations.js',
  '/js/pedia/pedia-reports.js': 'js/pedia/pedia-reports.js',
};

function contentVersion(file) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\r\n').join('\n');
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 10);
}

for (const [url, file] of Object.entries(ASSETS)) {
  const expected = `"${url}?v=${contentVersion(file)}"`;
  const mentions = html.split(`"${url}`).length - 1;
  assert.strictEqual(mentions, 1, `${url} is referenced exactly once in pedia-reports.html`);
  assert.ok(html.includes(expected),
    `${url} must be referenced as ${expected} — update the version in PEDIA/pedia-reports.html`);
}

console.log('Pediatrician Reports asset versions OK — the page references the current content of its own script and stylesheet files');
