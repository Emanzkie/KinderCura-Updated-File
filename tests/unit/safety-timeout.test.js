// Serverless safety timeout (ADMIN bug scan P1, middleware/safetyTimeout.js).
//
// After the 504 went out the route kept running, and its own res.json() then
// threw ERR_HTTP_HEADERS_SENT. In an async handler that is an unhandled
// rejection, which exits the process (server.js) and fails every other request
// on the Vercel instance — e.g. a slow ML prediction during an assessment
// submission. A late reply must now be ignored, on both the success and the
// error path of the route.
const assert = require('assert');
const http = require('http');
const express = require('express');
const { safetyTimeout } = require('../../middleware/safetyTimeout');

(async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);

  let lateReplies = 0;
  const app = express();
  app.use(safetyTimeout(50));
  app.get('/slow', async (req, res) => {
    await new Promise((r) => setTimeout(r, 120));
    lateReplies += 1;
    res.status(200).json({ late: true });
  });
  app.get('/slow-error', async (req, res) => {
    try {
      await new Promise((r) => setTimeout(r, 120));
      throw new Error('work failed late');
    } catch (err) {
      lateReplies += 1;
      res.status(500).json({ error: err.message });
    }
  });
  app.get('/fast', (req, res) => res.json({ ok: true }));

  const server = http.createServer(app).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const saved = console.error;
  console.error = () => {};
  try {
    for (const path of ['/slow', '/slow-error']) {
      const res = await fetch(base + path);
      assert.strictEqual(res.status, 504, `${path}: the timeout answers first`);
      assert.deepStrictEqual(await res.json(), { error: 'Request timed out' });
    }
    await new Promise((r) => setTimeout(r, 250));
    assert.strictEqual(lateReplies, 2, 'both routes finished and tried to reply');
    assert.deepStrictEqual(unhandled.map(String), [], 'a late reply never throws');

    const fast = await fetch(`${base}/fast`);
    assert.strictEqual(fast.status, 200);
    assert.deepStrictEqual(await fast.json(), { ok: true });
  } finally {
    console.error = saved;
    process.off('unhandledRejection', onUnhandled);
    server.closeAllConnections();
    server.close();
  }
  console.log('Safety timeout OK — the 504 goes out on time, a late reply is ignored, fast requests are untouched');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
