// api.js keeps a parent on the assessment until the first one is done, and the
// server's answer from /auth/me corrects the stored flag. Runs api.js in a vm.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../../api.js'), 'utf8');

function load({ pathname, role = 'parent', flag, me, token = 't' }) {
  const store = new Map(Object.entries({ kc_user: JSON.stringify({ role }) }));
  if (token) store.set('kc_token', token);
  if (flag) store.set('kc_preAssessmentRequired', 'true');
  const went = [];
  const classes = new Set();
  const ctx = {
    console,
    URLSearchParams,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    document: {
      cookie: '',
      addEventListener() {},
      body: { classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) } },
    },
    location: { pathname, hostname: 'x.invalid', replace: (u) => went.push(u) },
    fetch: async () => ({ ok: true, json: async () => ({ user: { role }, ...me }) }),
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  return { ctx, store, went, classes };
}

(async () => {
  for (const page of ['dashboard', 'appointments', 'settings', 'profile', 'guardians', 'statement']) {
    assert.deepStrictEqual(load({ pathname: `/parent/${page}`, flag: true }).went, ['/parent/screening'], page);
  }
  for (const page of ['/parent/screening', '/parent/screening/', '/parent/accept-invitation', '/help.html']) {
    assert.deepStrictEqual(load({ pathname: page, flag: true }).went, [], page);
  }
  assert.deepStrictEqual(load({ pathname: '/parent/dashboard' }).went, [], 'not required');
  assert.deepStrictEqual(load({ pathname: '/parent/dashboard', flag: true, token: null }).went, [], 'signed out');
  assert.deepStrictEqual(load({ pathname: '/parent/results', role: 'pediatrician', flag: true }).went, [], 'staff');

  assert.ok(load({ pathname: '/parent/screening', flag: true }).classes.has('pre-assessment'));
  assert.ok(!load({ pathname: '/parent/screening' }).classes.has('pre-assessment'), 'a reassessment keeps the menu');

  // Flag missing (removed by hand, or an older session): the server sets it.
  let p = load({ pathname: '/parent/dashboard', me: { needsPreAssessment: true, preAssessmentChildId: 'c1' } });
  await p.ctx.refreshCurrentUser();
  assert.deepStrictEqual(p.went, ['/parent/screening']);
  assert.strictEqual(p.store.get('kc_preAssessmentRequired'), 'true');
  assert.strictEqual(p.store.get('kc_childId'), 'c1');
  assert.ok(!p.store.get('kc_user').includes('needsPreAssessment'));

  // Stale flag: the server clears it and the menu comes back.
  p = load({ pathname: '/parent/screening', flag: true, me: { needsPreAssessment: false, preAssessmentChildId: null } });
  await p.ctx.refreshCurrentUser();
  assert.ok(!p.store.has('kc_preAssessmentRequired') && !p.classes.has('pre-assessment'));

  // No answer from the server changes nothing.
  p = load({ pathname: '/parent/screening', flag: true, me: {} });
  await p.ctx.refreshCurrentUser();
  assert.strictEqual(p.store.get('kc_preAssessmentRequired'), 'true');

  console.log('Pre-assessment gate tests OK');
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
