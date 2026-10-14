// Unit tests for KC.poll (api.js), the shared "refresh every N ms" helper.
//
// The reported problem: pages kept polling the API with plain setInterval —
// the parent dashboard fired ~5 requests every 5 s — even in background tabs
// nobody was looking at. KC.poll only runs while the tab is visible, never
// overlaps a run that is still waiting on the server, and catches up once
// when the tab comes back.
//
// No DB, no network, no browser: api.js runs in a node vm with fake timers,
// a fake clock and a fake document.visibilityState.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const results = [];
const ok = (label) => results.push(label);
const flush = () => new Promise((resolve) => setImmediate(resolve));

function loadApi() {
  const env = { now: 1_000_000, timers: new Map(), nextId: 1, listeners: new Map(), errors: [] };
  const document = {
    visibilityState: 'visible',
    addEventListener(type, fn) {
      if (!env.listeners.has(type)) env.listeners.set(type, new Set());
      env.listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      if (env.listeners.has(type)) env.listeners.get(type).delete(fn);
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
  };
  const sandbox = {
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document,
    Date: class extends Date { static now() { return env.now; } },
    setInterval: (fn, ms) => { const id = env.nextId++; env.timers.set(id, { fn, ms }); return id; },
    clearInterval: (id) => { env.timers.delete(id); },
    URL,
    URLSearchParams,
    console: { ...console, error: (...args) => env.errors.push(args) },
  };
  sandbox.window = sandbox;
  sandbox.window.location = { hostname: 'kindercura.com', pathname: '/', origin: 'https://kindercura.com', search: '' };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'api.js'), 'utf8'), sandbox);

  // Advance the fake clock by one interval and fire every live timer.
  env.tick = async (ms) => {
    env.now += ms;
    for (const { fn } of [...env.timers.values()]) fn();
    await flush();
  };
  env.setVisibility = async (state) => {
    document.visibilityState = state;
    for (const fn of [...(env.listeners.get('visibilitychange') || [])]) fn();
    await flush();
  };
  env.KC = sandbox.KC;
  return env;
}

async function run() {
  // 1. Runs every interval while visible, and not on start.
  {
    const env = loadApi();
    let calls = 0;
    env.KC.poll(() => { calls += 1; }, 30000);
    assert.strictEqual(calls, 0, 'does not run on start — callers do their own first load');
    await env.tick(30000);
    await env.tick(30000);
    assert.strictEqual(calls, 2);
  }
  ok('1: runs once per interval while the tab is visible, not on start');

  // 2. Hidden tab: no calls at all.
  {
    const env = loadApi();
    let calls = 0;
    env.KC.poll(() => { calls += 1; }, 5000);
    await env.setVisibility('hidden');
    for (let i = 0; i < 10; i += 1) await env.tick(5000);
    assert.strictEqual(calls, 0, 'a hidden tab must not call the API');
  }
  ok('2: makes no calls while the tab is hidden');

  // 3. Coming back after missing an interval catches up once; a quick
  //    switch away and back does not add an extra call.
  {
    const env = loadApi();
    let calls = 0;
    env.KC.poll(() => { calls += 1; }, 30000);
    await env.setVisibility('hidden');
    await env.tick(30000);
    await env.tick(30000);
    assert.strictEqual(calls, 0);
    await env.setVisibility('visible');
    assert.strictEqual(calls, 1, 'catches up once on return');

    await env.setVisibility('hidden');
    env.now += 1000;
    await env.setVisibility('visible');
    assert.strictEqual(calls, 1, 'a brief switch away does not refetch');
  }
  ok('3: refreshes once when the tab comes back after a missed interval, not on a brief switch');

  // 4. Never overlaps a run still waiting on the server.
  {
    const env = loadApi();
    let calls = 0;
    let finish;
    env.KC.poll(() => { calls += 1; return new Promise((resolve) => { finish = resolve; }); }, 4000);
    await env.tick(4000);
    await env.tick(4000);
    await env.tick(4000);
    assert.strictEqual(calls, 1, 'slow request: later ticks skip instead of stacking up');
    finish();
    await flush();
    await env.tick(4000);
    assert.strictEqual(calls, 2, 'next tick runs once the slow one finished');
  }
  ok('4: never starts a run while the previous one is still in progress');

  // 5. stop() clears the timer and the visibility listener.
  {
    const env = loadApi();
    let calls = 0;
    const poller = env.KC.poll(() => { calls += 1; }, 5000);
    poller.stop();
    assert.strictEqual(env.timers.size, 0, 'timer cleared');
    assert.strictEqual(env.listeners.get('visibilitychange').size, 0, 'listener removed');
    await env.tick(5000);
    await env.setVisibility('hidden');
    env.now += 60000;
    await env.setVisibility('visible');
    assert.strictEqual(calls, 0);
    poller.stop(); // a second stop() is harmless
  }
  ok('5: stop() ends polling and removes its listener');

  // 6. A failing run is logged and does not end the polling.
  {
    const env = loadApi();
    let calls = 0;
    env.KC.poll(() => { calls += 1; if (calls === 1) throw new Error('network down'); }, 5000);
    await env.tick(5000);
    await env.tick(5000);
    assert.strictEqual(calls, 2);
    assert.strictEqual(env.errors.length, 1, 'the failure is logged');
  }
  ok('6: an error in one run is logged and polling continues');

  // 7. The pages that used to poll with setInterval now go through KC.poll.
  {
    const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
    const dashboard = read('js/parent/dashboard.js');
    assert.ok(/window\.KC\.poll\(\s*\(\)\s*=>\s*Promise\.all\(\[loadDashboard\(\),\s*loadParentAnalytics\(\)\]\),\s*30000\)/.test(dashboard),
      'parent dashboard refreshes through KC.poll every 30 s');
    for (const f of ['js/parent/dashboard.js', 'js/parent/chat.js', 'js/pedia/pedia-chat.js', 'js/admin/admin-data-sources.js']) {
      const src = read(f);
      assert.ok(!/setInterval\(\s*(pollMessages|loadPipelineStatus|\(\)\s*=>\s*\{\s*loadDashboard)/.test(src), `${f}: no raw setInterval data polling left`);
      assert.ok(src.includes('window.KC.poll('), `${f}: polls through KC.poll`);
      assert.ok(!/clearInterval\((pollTimer|pipelinePollTimer)\)/.test(src), `${f}: stops the poller with .stop()`);
    }
  }
  ok('7: dashboard, both chats and admin pipeline status poll through KC.poll');
}

run()
  .then(() => {
    results.forEach((label) => console.log(`  ok - ${label}`));
    console.log(`KC.poll tests OK — ${results.length} groups`);
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
