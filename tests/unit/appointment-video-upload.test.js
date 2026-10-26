// Appointment video upload (PEDIATRICIAN_BUGS.md #6).
//
// POST /api/videos/appointment/:id loaded the appointment with .lean() and then
// called appointment.save() on that plain object, which throws. The first video
// for any appointment therefore answered 500 after the file and the
// AppointmentVideo row were already stored: hasVideo was never set, the
// pediatrician was never notified, and a retry stored the video again.
//
// No DB and no disk: the file store is replaced with an in-memory multer
// storage, the models are stubbed, and the real router runs in a local express
// app behind the real authMiddleware (a parent token needs no lookup).
const assert = require('assert');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const mongoose = require('mongoose');

mongoose.set('bufferCommands', false);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// Keep the upload in memory instead of writing under public/uploads.
const fileStorage = require('../../services/fileStorage');
fileStorage.makeStorage = () => multer.memoryStorage();
fileStorage.finalizeUploads = () => (req, res, next) => {
  if (req.file) req.file.filename = `appointment_video_test_${Date.now()}.mp4`;
  next();
};
require('../../middleware/guardianAccess').hasPermission = async () => true;

const Appointment = require('../../models/Appointment');
const Child = require('../../models/Child');
const User = require('../../models/User');
const Notification = require('../../models/Notification');
const videosRouter = require('../../routes/videos');
const AppointmentVideo = mongoose.models.AppointmentVideo;

const chain = (value) => {
  const q = { lean: () => q, select: () => q, then: (a, b) => Promise.resolve(value).then(a, b) };
  return q;
};

const parentId = new mongoose.Types.ObjectId();
const pediaId = new mongoose.Types.ObjectId();
const childId = new mongoose.Types.ObjectId();
const apptMongoId = new mongoose.Types.ObjectId();

let appointment;
let updates;
let storedVideos;
let notifications;

function reset(fields = {}) {
  // Exactly what .lean() returns: a plain object with no save().
  appointment = { _id: apptMongoId, id: 7, parentId, childId, pediatricianId: pediaId, hasVideo: false, ...fields };
  updates = [];
  storedVideos = [];
  notifications = [];
}

Appointment.findOne = () => chain(appointment);
Appointment.updateOne = async (filter, update) => { updates.push({ filter, update }); return { modifiedCount: 1 }; };
Child.findById = () => chain({ _id: childId, firstName: 'Kemri', lastName: 'Soto' });
User.findById = (id) => chain({ _id: id, firstName: String(id) === String(pediaId) ? 'Ana' : 'Emman', lastName: 'Cruz' });
AppointmentVideo.create = async (doc) => { storedVideos.push(doc); return doc; };
Notification.create = async (n) => { notifications.push(n); return n; };

const app = express();
app.use('/api/videos', videosRouter);

async function upload(server) {
  const token = jwt.sign({ userId: String(parentId), role: 'parent' }, process.env.JWT_SECRET);
  const form = new FormData();
  form.append('video', new Blob([Buffer.from('not really a video')], { type: 'video/mp4' }), 'clip.mp4');
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/videos/appointment/7`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
  });
  return { status: res.status, body: await res.json() };
}

(async () => {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const savedErr = console.error;
  console.error = () => {};
  try {
    reset();
    let r = await upload(server);
    assert.strictEqual(r.status, 200, `first video should succeed: ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.success, true);
    assert.strictEqual(storedVideos.length, 1, 'the video is recorded once');
    assert.strictEqual(updates.length, 1, 'the appointment is flagged once');
    assert.deepStrictEqual(updates[0].filter, { _id: apptMongoId });
    assert.deepStrictEqual(updates[0].update, { $set: { hasVideo: true } });
    assert(notifications.some((n) => String(n.userId) === String(pediaId) && /Video Attached/.test(n.title)),
      'the pediatrician is notified');
    console.log('  ✓ first video for an appointment succeeds, flags hasVideo and notifies the pediatrician');

    reset({ hasVideo: true });
    r = await upload(server);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(updates.length, 0, 'an appointment already flagged is not written again');
    assert.strictEqual(storedVideos.length, 1);
    console.log('  ✓ a further video leaves an already-flagged appointment alone');
  } finally {
    console.error = savedErr;
    server.close();
  }
  console.log('\nappointment-video-upload.test.js: 2 checks passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
