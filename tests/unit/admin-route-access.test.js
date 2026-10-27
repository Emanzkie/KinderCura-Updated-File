// Routes that were open to the wrong callers (ADMIN bug scan P8, P9).
//
//   GET  /api/auth/email-status        needed no login, and every call opens a
//                                      mail connection; admins only now.
//   POST /api/ml/predict               any signed-in account could run the
//                                      model on arbitrary scores; admins only.
//   /api/ml/models/:modelId/...        a malformed id was a 500 cast error;
//                                      now a 404.
//
// GET /api/payments/clinic-config stays open to signed-in users on purpose:
// the Help page of every role shows the clinic contact from it, and it holds
// no secrets.
const assert = require('assert');
const http = require('http');
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

mongoose.set('bufferCommands', false);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.EMAIL_USER = '';
process.env.EMAIL_PASS = '';
process.env.EMAIL_API_KEY = '';

const User = require('../../models/User');
const TrainedModel = require('../../models/TrainedModel');

const adminId = String(new mongoose.Types.ObjectId());
const parentId = String(new mongoose.Types.ObjectId());
const chain = (v) => { const q = { select: () => q, lean: () => q, then: (a, b) => Promise.resolve(v).then(a, b) }; return q; };
User.findById = (id) => chain(String(id) === adminId ? { _id: adminId, role: 'admin', status: 'active' } : { _id: parentId, role: 'parent', status: 'active' });
TrainedModel.findOne = () => chain(null);

(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../../routes/auth'));
  app.use('/api/ml', require('../../routes/ml'));
  const server = http.createServer(app).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const as = (id, role) => ({ Authorization: `Bearer ${jwt.sign({ userId: id, role }, process.env.JWT_SECRET)}` });
  const call = async (method, url, headers = {}) => {
    const saved = console.error;
    console.error = () => {};
    try {
      const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: method === 'POST' ? '{}' : undefined });
      return res.status;
    } finally { console.error = saved; }
  };

  try {
    assert.strictEqual(await call('GET', '/api/auth/email-status'), 401, 'email-status needs a login');
    assert.strictEqual(await call('GET', '/api/auth/email-status', as(parentId, 'parent')), 403, 'and an admin');
    assert.strictEqual(await call('GET', '/api/auth/email-status', as(adminId, 'admin')), 503, 'admins still get the check (email not configured here)');

    assert.strictEqual(await call('POST', '/api/ml/predict', as(parentId, 'parent')), 403, 'predict is admin-only');
    assert.strictEqual(await call('POST', '/api/ml/predict', as(adminId, 'admin')), 404, 'admins reach it (no active model here)');

    assert.strictEqual(await call('POST', '/api/ml/models/not-an-id/activate', as(adminId, 'admin')), 404);
    assert.strictEqual(await call('POST', '/api/ml/models/not-an-id/smoke-test', as(adminId, 'admin')), 404);
  } finally {
    server.closeAllConnections();
    server.close();
  }
  console.log('Admin route access OK — email-status and ML predict are admin-only, malformed model ids are 404s');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
