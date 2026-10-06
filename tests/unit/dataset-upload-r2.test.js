// tests/unit/dataset-upload-r2.test.js
// Admin -> Training -> Upload Dataset with object storage on (Render + R2).
// multer buffers the file in memory in that mode and never runs the route's
// filename function, so the upload used to fail with
// `The "path" argument must be of type string. Received undefined` and no
// dataset could reach R2. Runs the real route against an in-memory R2 mock.

const assert = require('assert');
const http = require('http');

const BUCKET = 'kindercura-ml-models';
Object.assign(process.env, {
  USE_BLOB: 'true',
  R2_BUCKET: BUCKET,
  R2_ACCESS_KEY_ID: 'test-key',
  R2_SECRET_ACCESS_KEY: 'test-secret',
  R2_REGION: 'auto',
  JWT_SECRET: 'test-jwt-secret',
});

function startMockR2() {
  const objects = new Map();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const parts = new URL(req.url, 'http://mock').pathname.replace(/^\/+/, '').split('/');
      const bucket = parts.shift();
      const key = decodeURIComponent(parts.join('/'));
      if (bucket !== BUCKET) { res.statusCode = 400; return res.end(); }
      if (req.method === 'PUT') { objects.set(key, Buffer.concat(chunks)); return res.end(); }
      const obj = objects.get(key);
      if (!obj) { res.statusCode = 404; return res.end(); }
      res.setHeader('Content-Length', obj.length);
      return res.end(req.method === 'GET' ? obj : undefined);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, objects, close: () => server.close() })));
}

async function run() {
  const r2 = await startMockR2();
  process.env.R2_ENDPOINT = `http://127.0.0.1:${r2.port}`;

  const jwt = require('jsonwebtoken');
  const mongoose = require('mongoose');
  const TrainingDataset = require('../../models/TrainingDataset');
  const fileStorage = require('../../services/fileStorage');
  assert.strictEqual(fileStorage.USE_BLOB, true);

  const created = [];
  TrainingDataset.create = async (doc) => { const d = { _id: new mongoose.Types.ObjectId(), ...doc }; created.push(d); return d; };

  const app = require('../../server.js');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const token = jwt.sign({ userId: String(new mongoose.Types.ObjectId()), role: 'admin' }, process.env.JWT_SECRET);

  const csv = 'assessment_ref,age_months,communication_score,social_score,cognitive_score,motor_score,overall_score,risk_category\r\n'
    + 'TEST-00001,60,80,70,60,75,71,Low\r\nTEST-00002,48,30,25,35,28,30,High\r\n';
  try {
    const fd = new FormData();
    fd.append('dataset', new Blob([csv], { type: 'text/csv' }), 'kindercura synthetic (50000).csv');
    fd.append('name', 'KinderCura Synthetic Training Dataset');
    fd.append('targetModule', 'assessment');
    fd.append('sourceType', 'synthetic');
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/training/upload`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd,
    });
    const body = await res.json();
    assert.strictEqual(res.status, 201, JSON.stringify(body));

    const doc = created[0];
    assert.match(doc.storedName, /^\d+_kindercura_synthetic__50000_\.csv$/, 'same naming as disk storage');
    assert.strictEqual(doc.filePath, `/uploads/datasets/${doc.storedName}`);
    assert.strictEqual(doc.rowCount, 2);
    assert.strictEqual(doc.provenance.sourceType, 'synthetic');
    assert.strictEqual(doc.status, 'uploaded');
    const stored = r2.objects.get(`public/uploads/datasets/${doc.storedName}`);
    assert.ok(stored && stored.toString('utf8') === csv, 'CSV stored in R2 under the key Process reads back');
    console.log('Dataset upload with R2 tests OK — buffered upload named, stored in R2, record created');
  } finally {
    server.close();
    r2.close();
  }
}

run().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
