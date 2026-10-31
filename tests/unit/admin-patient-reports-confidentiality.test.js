// Admin Reports > Patient reports: aggregated statistics only.
//
// GET /api/admin/patient-reports/patients used to return one row per child
// with the child's, parent's and pediatrician's names, and /search looked up
// parents and children by name. Now:
//   - /patients returns the filtered summary and a per-band count of patients,
//     with no rows, names, ids or title;
//   - the pediatrician, parent and child filters are ignored, so no request
//     can narrow the figures to one family;
//   - a band of 1-4 patients is sent as null (with a second group hidden when
//     only one is small), and below 5 patients in total no breakdown is sent;
//   - /search no longer exists.
// Models are stubbed: no DB, no network beyond the local test server.
const assert = require('assert');
const http = require('http');
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

mongoose.set('bufferCommands', false);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const User = require('../../models/User');
const Child = require('../../models/Child');
const Appointment = require('../../models/Appointment');

const adminId = String(new mongoose.Types.ObjectId());
const someId = String(new mongoose.Types.ObjectId());

const chain = (v) => { const q = { select: () => q, sort: () => q, lean: () => q, then: (a, b) => Promise.resolve(v).then(a, b) }; return q; };
User.findById = () => chain({ _id: adminId, role: 'admin', status: 'active' });
const forbidden = [];
User.find = () => { forbidden.push('User.find'); return chain([]); };
Child.find = () => { forbidden.push('Child.find'); return chain([]); };
Appointment.distinct = async () => { forbidden.push('Appointment.distinct'); return []; };

let facet = null;
let lastPipeline = null;
Child.aggregate = async (pipeline) => { lastPipeline = pipeline; return [facet]; };

const facetOf = (latestScores) => ({
  totalMatched: [{ n: latestScores.reduce((s, r) => s + r.n, 0) }],
  aggregates: [{ totalAssessments: 30, totalReviewed: 12, latestActivity: new Date('2026-10-01T00:00:00Z') }],
  latestScores,
});

(async () => {
  const app = express();
  app.use('/api/admin/patient-reports', require('../../routes/admin-patient-reports'));
  const server = http.createServer(app).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api/admin/patient-reports`;
  const headers = { Authorization: `Bearer ${jwt.sign({ userId: adminId, role: 'admin' }, process.env.JWT_SECRET)}` };
  const get = async (path) => {
    const res = await fetch(base + path, { headers });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const patientsOf = (body) => Object.fromEntries(body.bandDistribution.rows.map((r) => [r.key, r.patients]));
  const results = [];

  try {
    // 1. Aggregates only, and identity filters are ignored.
    facet = facetOf([{ _id: 90, n: 7 }, { _id: 85, n: 2 }, { _id: 65, n: 6 }, { _id: 45, n: 5 }, { _id: 30, n: 3 }, { _id: null, n: 0 }]);
    const { status, body } = await get(`/patients?pediatricianId=${someId}&parentId=${someId}&childId=${someId}&scope=all`);
    assert.strictEqual(status, 200, JSON.stringify(body));
    assert.deepStrictEqual(Object.keys(body).sort(), ['bandDistribution', 'filters', 'success', 'summary']);
    assert.deepStrictEqual(body.summary, { patients: 23, assessments: 30, reviewed: 12, latestActivity: '2026-10-01T00:00:00.000Z' });
    assert.strictEqual(body.filters.pediatricianId, null);
    assert.strictEqual(body.filters.parentId, null);
    assert.strictEqual(body.filters.childId, null);
    const json = JSON.stringify(body);
    assert.ok(!json.includes(someId), 'the requested ids are not echoed');
    assert.ok(!/childName|parentName|pediatricianName|"rows":\[\{"childId|title|pagination/.test(json), 'no patient rows or names');
    const pipelineJson = JSON.stringify(lastPipeline);
    assert.ok(!pipelineJson.includes(someId), 'identity filters never reach the query');
    assert.ok(!pipelineJson.includes(User.collection.name) && !pipelineJson.includes(Appointment.collection.name), 'no user or appointment lookups');
    assert.deepStrictEqual(forbidden, [], 'no name or relationship queries');
    results.push('summary and band counts only; pediatrician, parent and child filters are ignored and never reach the query');

    // 2. Bands from constants/scoring.js; on-track 9, developing 6, at-risk 5,
    //    delayed 3 (hidden), none 0 (shown). Only one small group, so the next
    //    smallest (at-risk 5) is hidden too.
    assert.deepStrictEqual(patientsOf(body), { 'on-track': 9, developing: 6, 'at-risk': null, delayed: null, none: 0 });
    assert.strictEqual(body.bandDistribution.minimumShown, 5);
    assert.strictEqual(body.bandDistribution.breakdownHidden, false);
    const sent = body.bandDistribution.rows.map((r) => r.patients);
    assert.ok(!sent.includes(3) && !sent.includes(5), 'hidden counts are not sent');
    results.push('a band of 1-4 patients is sent as null, a second band is hidden with it, zeros are shown');

    // 3. Fewer than 5 patients in total: no breakdown at all.
    facet = facetOf([{ _id: 90, n: 3 }, { _id: null, n: 1 }]);
    const small = await get('/patients?dateFrom=2026-10-01&dateTo=2026-10-01');
    assert.strictEqual(small.body.bandDistribution.breakdownHidden, true);
    assert.ok(small.body.bandDistribution.rows.every((r) => r.patients === null));
    assert.strictEqual(patientsOf(small.body).none, null);
    results.push('fewer than 5 patients in total: every band hidden');

    // 4. Assessments without a stored score count as "No scored assessment in range".
    facet = facetOf([{ _id: 90, n: 6 }, { _id: null, n: 6 }]);
    const none = await get('/patients');
    assert.deepStrictEqual(patientsOf(none.body), { 'on-track': 6, developing: 0, 'at-risk': 0, delayed: 0, none: 6 });
    assert.strictEqual(none.body.bandDistribution.rows.find((r) => r.key === 'none').label, 'No scored assessment in range');
    results.push('patients with no scored assessment in range are their own group');

    // 5. Name search is gone; admin only is unchanged.
    const search = await fetch(`${base}/search?type=child&q=an`, { headers });
    assert.strictEqual(search.status, 404, 'name search removed');
    const pedia = await fetch(`${base}/patients`, { headers: { Authorization: `Bearer ${jwt.sign({ userId: adminId, role: 'pediatrician' }, process.env.JWT_SECRET)}` } });
    assert.ok([401, 403].includes(pedia.status), 'admin only');
    results.push('/search returns 404; the endpoints stay admin only');
  } finally {
    server.closeAllConnections();
    server.close();
  }
  results.forEach((r) => console.log('ok -', r));
  console.log(`\nadmin-patient-reports-confidentiality: ${results.length} passed`);
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
