// Basic unit tests for new models (no DB required)
const assert = require('assert');
const mongoose = require('mongoose');
const PermissionSet = require('../../models/PermissionSet');
const GuardianLink = require('../../models/GuardianLink');
const Assessment = require('../../models/Assessment');

function run() {
  const ps = new PermissionSet({ name: 'temp' });
  assert(ps.name === 'temp');
  assert(ps.permissions.viewAssessments === true);

  const gl = new GuardianLink({ childId: null, guardianId: null });
  // default permission values
  assert(gl.permissions.viewAssessments === true);
  assert(gl.permissions.manageAppointments === true);

  const assessment = new Assessment({
    childId: new mongoose.Types.ObjectId(),
    createdBy: new mongoose.Types.ObjectId(),
  });
  assert(assessment.nextAssessmentDate === null);
  assert(assessment.nextAssessmentReason === null);

  console.log('Basic model defaults OK');
}

run();
