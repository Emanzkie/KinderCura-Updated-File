// The loading animation helper in api.js: which elements get .kc-loading, and
// when it comes off. The real code runs in a vm with a tiny fake DOM.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const src = fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8');
const code = src.slice(src.indexOf('(function showLoadingAnimation()'));
assert.ok(code.startsWith('(function'), 'helper found');

let notify;
class FakeObserver { constructor(fn) { notify = fn; } observe() {} }

const text = (data) => ({ nodeType: 3, data });
function el(tag, children = [], cls = '') {
  const e = {
    nodeType: 1, tag, cls, childNodes: [], parentElement: null, set: new Set(),
    classList: { contains: (c) => e.set.has(c), toggle: (c, on) => { if (on) e.set.add(c); else e.set.delete(c); } },
    get textContent() { return e.childNodes.map((n) => (n.nodeType === 3 ? n.data : n.textContent)).join(''); },
    querySelectorAll() { return e.childNodes.filter((n) => n.nodeType === 1).flatMap((n) => [n, ...n.querySelectorAll()]); },
    closest(sel) {
      const names = sel.split(',').map((s) => s.trim());
      for (let x = e; x; x = x.parentElement) if (names.includes(x.tag) || names.includes(`.${x.cls}`)) return x;
      return null;
    },
    fill(kids) {
      e.childNodes = kids.map((k) => (typeof k === 'string' ? text(k) : k));
      e.childNodes.forEach((k) => { k.parentElement = e; });
      return e;
    },
  };
  return e.fill(children);
}
const shown = (e) => e.set.has('kc-loading');
const change = (target, added = []) => notify([{ type: 'childList', target, addedNodes: added }]);

const yes = ['Loading…', 'Loading...', ' Loading users… ', "Loading your child's progress report…", 'Loading check-up history...'].map((t) => el('p', [t]));
const icon = el('div', [el('span', [el('img')]), 'Loading…']);
const no = [
  el('button', ['Loading…']), el('option', ['Loading...']), el('p', ['Uploading...']), el('p', ['Loading']),
  el('p', ['Loading failed. Please try again...']), el('p', ['My notes: Loading…']), el('p', [el('b', ['3']), ' Loading…']), el('p', []),
];
const bubble = el('div', [el('span', ['Loading...'])], 'msg-bubble');
const wrapper = el('div', ['\n  ', yes[0], '\n']);
const root = el('html', [wrapper, ...yes.slice(1), icon, ...no, bubble]);

vm.runInNewContext(code, { MutationObserver: FakeObserver, document: { documentElement: root } });

yes.forEach((e) => assert.ok(shown(e), e.textContent));
assert.ok(shown(icon), 'an icon beside the text is allowed');
no.forEach((e) => assert.ok(!shown(e), `${e.tag}: ${e.textContent}`));
assert.ok(!shown(bubble.childNodes[0]), 'a chat message stays text');
assert.ok(!shown(wrapper) && !shown(root), 'only the element holding the text, never its container');

// Text replaced with data, then loading again.
yes[1].fill(['12 users']); change(yes[1]);
assert.ok(!shown(yes[1]), 'data removes the animation');
yes[1].fill(['Loading…']); change(yes[1]);
assert.ok(shown(yes[1]), 'and loading again shows it');
yes[2].fill([el('b', ['Error'])]); change(yes[2], yes[2].childNodes);
assert.ok(!shown(yes[2]), 'markup removes it');
yes[3].childNodes[0].data = 'Done';
notify([{ type: 'characterData', target: yes[3].childNodes[0], addedNodes: [] }]);
assert.ok(!shown(yes[3]), 'edited text removes it');

// Content added later.
const late = el('td', ['Loading receipt…']);
const row = el('tr', [late]);
root.childNodes.push(row); row.parentElement = root;
change(root, [row]);
assert.ok(shown(late));

// Browsers (and other tests) without MutationObserver are left alone.
vm.runInNewContext(code, { document: { documentElement: root } });

const css = fs.readFileSync(path.join(ROOT, 'CSS files', 'dashboard-new-styles.css'), 'utf8');
assert.ok(css.includes("url('/icons/kindercura-loading.gif')"));
const gif = fs.readFileSync(path.join(ROOT, 'ICONS', 'kindercura-loading.gif'));
assert.strictEqual(gif.toString('latin1', 0, 6), 'GIF89a');
assert.ok(gif.length < 150 * 1024, 'a light file');

console.log('Loading indicator tests OK');
