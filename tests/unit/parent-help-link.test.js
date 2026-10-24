// Regression test: every parent page with a profile menu links to Help &
// Support (/help.html).
//
// The bug: only PARENT/settings.html had the link, so from every other parent
// page (dashboard, results, appointments, ...) Help & Support could not be
// reached from the profile menu.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const ok = (m) => console.log('  ok -', m);

// The page every link points to must exist (served at /help.html from SIGN-UP,LOGIN/).
assert.ok(fs.existsSync(path.join(ROOT, 'SIGN-UP,LOGIN', 'help.html')), 'SIGN-UP,LOGIN/help.html exists');

const pages = fs.readdirSync(path.join(ROOT, 'PARENT')).filter((f) => f.endsWith('.html'));
let withMenu = 0;
for (const page of pages) {
  const html = fs.readFileSync(path.join(ROOT, 'PARENT', page), 'utf8');
  const start = html.indexOf('id="profileMenu"');
  if (start === -1) continue;
  withMenu += 1;
  // The menu ends at its Logout item; the Help link must sit inside it.
  const end = html.indexOf('logout', start);
  const menu = html.slice(start, end === -1 ? undefined : end);
  assert.ok(/<a href="\/help\.html" class="menu-item">/.test(menu), `${page}: profile menu links to /help.html`);
  assert.ok(!/href="help\.html"/.test(html), `${page}: no relative help.html link (it 404s under /parent/)`);
}
assert.ok(withMenu >= 11, `expected the parent pages with a profile menu, found ${withMenu}`);
ok(`all ${withMenu} parent pages with a profile menu link to Help & Support`);

console.log('\nParent help link tests OK');
