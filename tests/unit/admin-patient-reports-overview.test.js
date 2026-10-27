// Admin Reports > Patient reports: the Pediatrician filter lists every
// pediatrician (ADMIN bug scan P4).
//
// The filter was filled from the roster, which is capped at the 25 most active
// pediatricians, while the page told the admin to use that filter to find any
// pediatrician outside the roster. The overview now returns
// pediatricianOptions: every pediatrician account, names only.
const assert = require('assert');
const http = require('http');
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

mongoose.set('bufferCommands', false);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const User = require('../../models/User');
const Child = require('../../models/Child');
const Assessment = require('../../models/Assessment');
const Appointment = require('../../models/Appointment');

const adminId = String(new mongoose.Types.ObjectId());
const pediatricians = Array.from({ length: 40 }, (_, i) => ({ _id: new mongoose.Types.ObjectId(), firstName: `Doc${i}`, lastName: 'Cruz' }));
const roster = pediatricians.slice(0, 25).map((p) => ({ pediatricianId: String(p._id), firstName: p.firstName, lastName: p.lastName, patients: 1, assessments: 1, reviewed: 0 }));

const chain = (v) => { const q = { select: () => q, sort: () => q, lean: () => q, then: (a, b) => Promise.resolve(v).then(a, b) }; return q; };
let pediatricianQuery = null;
User.findById = () => chain({ _id: adminId, role: 'admin', status: 'active' });
User.find = (q) => { pediatricianQuery = q; return chain(pediatricians); };
for (const M of [User, Child, Assessment, Appointment]) M.countDocuments = async () => 0;
Appointment.aggregate = async () => roster;
Child.aggregate = async () => [];

(async () => {
  const app = express();
  app.use('/api/admin/patient-reports', require('../../routes/admin-patient-reports'));
  const server = http.createServer(app).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/patient-reports/overview`, {
      headers: { Authorization: `Bearer ${jwt.sign({ userId: adminId, role: 'admin' }, process.env.JWT_SECRET)}` },
    });
    const body = await res.json();
    assert.strictEqual(res.status, 200, JSON.stringify(body));
    assert.strictEqual(body.pediatricianSummary.length, 25, 'the roster stays capped');
    assert.strictEqual(body.pediatricianSummaryCapped, true);
    assert.strictEqual(body.pediatricianOptions.length, 40, 'the filter lists every pediatrician');
    assert.deepStrictEqual(Object.keys(body.pediatricianOptions[39]).sort(), ['name', 'pediatricianId'], 'names only');
    assert.strictEqual(body.pediatricianOptions[39].name, 'Doc39 Cruz');
    assert.deepStrictEqual(pediatricianQuery, { role: 'pediatrician' });
  } finally {
    server.closeAllConnections();
    server.close();
  }
  console.log('Admin patient reports overview OK — the Pediatrician filter lists every pediatrician, the roster stays capped');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
