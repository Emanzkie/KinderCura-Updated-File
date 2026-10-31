// Admin Reports > Patient reports overview: system-wide totals only.
//
// The overview used to return the 25 most active pediatricians and parents by
// name, and every pediatrician's name for a filter. For patient
// confidentiality it now returns counts only: no names, ids or rosters.
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

const chain = (v) => { const q = { select: () => q, sort: () => q, lean: () => q, then: (a, b) => Promise.resolve(v).then(a, b) }; return q; };
const calls = [];
User.findById = () => chain({ _id: adminId, role: 'admin', status: 'active' });
User.find = (q) => { calls.push(['User.find', q]); return chain([{ firstName: 'Doc', lastName: 'Cruz' }]); };
const totals = { User: 7, Child: 11, Assessment: 5, Appointment: 9 };
for (const [name, M] of Object.entries({ User, Child, Assessment, Appointment })) M.countDocuments = async () => totals[name];
Appointment.aggregate = async () => { calls.push(['Appointment.aggregate']); return []; };
Child.aggregate = async () => { calls.push(['Child.aggregate']); return []; };

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
    assert.deepStrictEqual(Object.keys(body).sort(), ['range', 'success', 'systemTotals'], 'totals only');
    assert.deepStrictEqual(body.systemTotals, {
      totalPatients: 11, totalParents: 7, totalPediatricians: 7,
      totalCompletedAssessments: 5, totalAppointments: 9, totalReviewed: 5,
    });
    assert.ok(!/name|Cruz|Id"/i.test(JSON.stringify(body)), 'no names or ids');
    assert.deepStrictEqual(calls, [], 'no roster or name queries');
  } finally {
    server.closeAllConnections();
    server.close();
  }
  console.log('Admin patient reports overview OK — system-wide totals only, no names, ids or rosters');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
