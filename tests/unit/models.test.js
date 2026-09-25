// Basic unit tests for new models (no DB required)
const assert = require('assert');
const mongoose = require('mongoose');
const PermissionSet = require('../../models/PermissionSet');
const GuardianLink = require('../../models/GuardianLink');
const Assessment = require('../../models/Assessment');
const PediatricianCheckup = require('../../models/PediatricianCheckup');

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

  const checkup = new PediatricianCheckup({
    childId: new mongoose.Types.ObjectId(),
    pediatricianId: new mongoose.Types.ObjectId(),
    visitType: 'initial_checkup',
    diagnosis: 'Communication concern noted.',
  });
  assert(checkup.appointmentId === null);
  assert(checkup.assessmentId === null);
  assert(checkup.previousRecordId === null);
  assert(checkup.status === 'initial_review');
  assert(checkup.checkupDate instanceof Date);
  // No score fields on this model — scores remain in AssessmentResult only.
  assert(checkup.overallScore === undefined);
  assert(checkup.communicationScore === undefined);

  console.log('Basic model defaults OK');
}

run();
