// Uploads are checked before they are stored, and identity documents stay
// private (PEDIATRICIAN_BUGS.md #21).
//
//   - /upload/pediatric-id, /upload/prc-id, /upload/child/:id, /prc/upload and
//     /videos/chat ran multer first and checked the caller's role or access
//     afterwards, so a refused request had already written its file (and two of
//     them never removed it); chat videos took up to 150 MB from any role.
//   - /upload/pediatric-id wrote the PRC ID card into the PUBLIC profile photos
//     folder.
//   - /uploads is served by express.static and an object-store fallback with no
//     access check, so a file in uploads/prc or uploads/prc-documents could be
//     fetched by anyone who knew its name.
//
// No DB: the file store is replaced by an in-memory one that records what would
// have been stored, models are stubbed, and the real routers run in a local
// express app. The /uploads checks boot server.js and use short-lived files.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const mongoose = require('mongoose');

mongoose.set('bufferCommands', false);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.EMAIL_USER = '';
process.env.EMAIL_PASS = '';

const ROOT = path.join(__dirname, '..', '..');
const results = [];
const ok = (m) => results.push(m);

// What the routes asked the file store to keep.
const stored = [];
const fileStorage = require('../../services/fileStorage');
fileStorage.makeStorage = () => multer.memoryStorage();
fileStorage.finalizeUploads = (dir, _name, access) => (req, res, next) => {
  stored.push({ dir, access: access && access.access, originalName: req.file && req.file.originalname });
  if (req.file) req.file.filename = `stored_${stored.length}${path.extname(req.file.originalname)}`;
  next();
};
fileStorage.deleteStored = () => {};

const guardianAccess = require('../../middleware/guardianAccess');
let mayUploadForChild = false;
guardianAccess.hasPermission = async () => mayUploadForChild;

const Child = require('../../models/Child');
const User = require('../../models/User');
const Notification = require('../../models/Notification');

const kidId = new mongoose.Types.ObjectId();
const pediaId = new mongoose.Types.ObjectId();
const parentId = new mongoose.Types.ObjectId();
let pediaDoc;
const chain = (value) => {
  const q = { select: () => q, lean: () => q, sort: () => q, then: (a, b) => Promise.resolve(value).then(a, b) };
  return q;
};
Child.findById = (id) => chain(String(id) === String(kidId) ? { _id: kidId, parentId, profileIcon: null, save: async () => {} } : null);
User.findById = () => chain(pediaDoc);
User.find = () => chain([]);
Notification.create = async (n) => n;

const app = express();
app.use('/api/upload', require('../../routes/upload'));
app.use('/api/prc', require('../../routes/prc-verification'));
app.use('/api/videos', require('../../routes/videos'));

const tokenFor = (userId, role) => jwt.sign({ userId: String(userId), role }, process.env.JWT_SECRET);
const sendFile = async (server, route, field, filename, type, role, extraFields = {}) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(extraFields)) form.append(k, v);
  form.append(field, new Blob([Buffer.from('not really a file')], { type }), filename);
  const userId = role === 'pediatrician' ? pediaId : parentId;
  const res = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
    method: 'POST', headers: { Authorization: `Bearer ${tokenFor(userId, role)}` }, body: form,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const quiet = async (fn) => {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try { return await fn(); } finally { Object.assign(console, saved); }
};

(async () => {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    pediaDoc = { _id: pediaId, role: 'pediatrician', status: 'active', save: async function save() { this.saved = true; } };

    // ── Refused before anything is stored ─────────────────────────────────
    let r;
    stored.length = 0;
    r = await quiet(() => sendFile(server, '/api/upload/pediatric-id', 'photo', 'id.jpg', 'image/jpeg', 'parent'));
    assert.strictEqual(r.status, 403, 'pediatric-id: a parent is refused');
    r = await quiet(() => sendFile(server, '/api/upload/prc-id', 'prcId', 'id.jpg', 'image/jpeg', 'parent'));
    assert.strictEqual(r.status, 403, 'prc-id: a parent is refused');
    assert.strictEqual(r.body.success, false, 'prc-id keeps its { success, message } error shape');
    r = await quiet(() => sendFile(server, '/api/prc/upload', 'prcDocument', 'id.jpg', 'image/jpeg', 'parent', { prcLicenseNumber: 'PRC-12345' }));
    assert.strictEqual(r.status, 403, 'prc/upload: a parent is refused');
    for (const role of ['secretary', 'admin']) {
      r = await quiet(() => sendFile(server, '/api/videos/chat', 'video', 'clip.mp4', 'video/mp4', role));
      assert.strictEqual(r.status, 403, `chat video: ${role} is refused`);
    }
    mayUploadForChild = false;
    r = await quiet(() => sendFile(server, `/api/upload/child/${kidId}`, 'photo', 'kid.jpg', 'image/jpeg', 'parent'));
    assert.strictEqual(r.status, 403, 'child photo: no upload permission');
    r = await quiet(() => sendFile(server, `/api/upload/child/${new mongoose.Types.ObjectId()}`, 'photo', 'kid.jpg', 'image/jpeg', 'parent'));
    assert.strictEqual(r.status, 404, 'child photo: unknown child');
    r = await quiet(() => sendFile(server, '/api/upload/child/not-an-id', 'photo', 'kid.jpg', 'image/jpeg', 'parent'));
    assert.strictEqual(r.status, 404, 'child photo: malformed id');
    assert.strictEqual(stored.length, 0, 'nothing was handed to the file store for any refused request');
    ok('role and access are checked before multer, so a refused upload never writes a file');

    // ── Allowed requests still work ───────────────────────────────────────
    mayUploadForChild = true;
    r = await quiet(() => sendFile(server, `/api/upload/child/${kidId}`, 'photo', 'kid.jpg', 'image/jpeg', 'parent'));
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(stored.at(-1).dir, 'uploads/profiles');
    r = await quiet(() => sendFile(server, '/api/videos/chat', 'video', 'clip.mp4', 'video/mp4', 'parent'));
    assert.strictEqual(r.status, 200, 'a parent can still send a chat video');
    r = await quiet(() => sendFile(server, '/api/videos/chat', 'video', 'clip.mp4', 'video/mp4', 'pediatrician'));
    assert.strictEqual(r.status, 200, 'and so can a pediatrician');
    r = await quiet(() => sendFile(server, '/api/prc/upload', 'prcDocument', 'id.jpg', 'image/jpeg', 'pediatrician', { prcLicenseNumber: 'PRC-12345' }));
    assert.strictEqual(r.status, 200, `a pediatrician can still submit a PRC document: ${JSON.stringify(r.body)}`);
    r = await quiet(() => sendFile(server, '/api/upload/prc-id', 'prcId', 'id.jpg', 'image/jpeg', 'pediatrician'));
    assert.strictEqual(r.status, 200, `a pediatrician can still upload a PRC ID: ${JSON.stringify(r.body)}`);
    ok('the owners of each upload can still make it');

    // ── The ID document goes to private storage ───────────────────────────
    stored.length = 0;
    r = await quiet(() => sendFile(server, '/api/upload/pediatric-id', 'photo', 'id.jpg', 'image/jpeg', 'pediatrician'));
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(stored.length, 1);
    assert.strictEqual(stored[0].dir, 'uploads/prc', 'the ID card is written to the PRC folder');
    assert.strictEqual(stored[0].access, 'private', 'with private access');
    assert(pediaDoc.idDocumentPath.startsWith('/uploads/prc/'), pediaDoc.idDocumentPath);
    assert(!pediaDoc.idDocumentPath.includes('profiles'), 'not the public profile photos folder');
    assert.strictEqual(pediaDoc.prcIdDocumentPath, pediaDoc.idDocumentPath);
    ok('/upload/pediatric-id stores the ID card in the private PRC folder, not the public profile photos folder');
  } finally {
    server.close();
  }

  // ── /uploads does not serve the PRC folders ─────────────────────────────
  const serverApp = require('../../server.js');
  const live = serverApp.listen(0, '127.0.0.1');
  await new Promise((resolve) => live.once('listening', resolve));
  const base = `http://127.0.0.1:${live.address().port}`;
  const made = [];
  const plant = (dir, name, content) => {
    const full = path.join(ROOT, 'uploads', dir);
    if (!fs.existsSync(full)) { fs.mkdirSync(full, { recursive: true }); made.push(full); }
    fs.writeFileSync(path.join(full, name), content);
    made.push(path.join(full, name));
  };
  try {
    plant('prc', '__guard_test.txt', 'SECRET-PRC-CARD');
    plant('prc-documents', '__guard_test.txt', 'SECRET-REGISTRATION-CARD');
    plant('profiles', '__guard_test.txt', 'PUBLIC-PHOTO');
    const get = async (url) => {
      const res = await fetch(base + url, { headers: { accept: 'application/octet-stream' } });
      return { status: res.status, body: await res.text() };
    };

    for (const url of [
      '/uploads/prc/__guard_test.txt',
      '/uploads/prc-documents/__guard_test.txt',
      '/uploads/PRC/__guard_test.txt',
      '/uploads/Prc-Documents/__guard_test.txt',
      '/uploads/%70rc/__guard_test.txt',
      '/uploads/profiles/..%2Fprc/__guard_test.txt',
      '/uploads//prc/__guard_test.txt',
    ]) {
      const res = await get(url);
      assert.notStrictEqual(res.status, 200, `${url} must not be served`);
      assert(!res.body.includes('SECRET-'), `${url} leaked a private document`);
    }
    const pub = await get('/uploads/profiles/__guard_test.txt');
    assert.strictEqual(pub.status, 200, 'public uploads are still served');
    assert.strictEqual(pub.body, 'PUBLIC-PHOTO');
    ok('/uploads refuses the PRC folders, including encoded and differently-cased forms, and still serves public files');
  } finally {
    live.close();
    for (const p of made.reverse()) {
      try { fs.statSync(p).isDirectory() ? fs.rmdirSync(p) : fs.unlinkSync(p); } catch { /* already gone */ }
    }
  }

  console.log(results.map((m) => `  ✓ ${m}`).join('\n'));
  console.log(`\nupload-guards.test.js: ${results.length} checks passed`);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
