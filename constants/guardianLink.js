// constants/guardianLink.js
// Shared rules for the Linked Guardian (GuardianLink) system.
//
// Two different concepts live on a guardian link and must not be mixed up:
//
//   relationship  How the guardian is related to the child (mother, father,
//                 nanny, ...). This is what the Relationship dropdowns on
//                 Settings > Family and Guardian Management send. Same values as
//                 GuardianInvitation.relationship.
//
//   role          The guardian's legal standing. Mirrors the guardian account
//                 types in User.role, so the GuardianLink.role enum is only
//                 parent / legal_guardian / foster_parent / court_appointed.
//
// Saving a relationship value such as 'father' into role is what produced
// "GuardianLink validation failed: role: `father` is not a valid enum value".

const RELATIONSHIPS = [
  'mother', 'father', 'grandparent', 'legal_guardian', 'foster_parent',
  'court_appointed', 'nanny', 'babysitter', 'therapist', 'teacher', 'other',
];

const RELATIONSHIP_LABELS = {
  mother: 'Mother', father: 'Father', grandparent: 'Grandparent',
  legal_guardian: 'Legal Guardian', foster_parent: 'Foster Parent',
  court_appointed: 'Court-Appointed', nanny: 'Nanny / Babysitter',
  babysitter: 'Babysitter', therapist: 'Therapist', teacher: 'Teacher', other: 'Other',
};

const LINK_ROLES = ['parent', 'legal_guardian', 'foster_parent', 'court_appointed'];

// Relationships that ARE a legal standing keep it. Every other relationship
// gets the schema default 'parent' — the value every invitation-accepted link
// has always had — and the precise relationship is kept in link.relationship.
function roleForRelationship(relationship) {
  return LINK_ROLES.includes(relationship) ? relationship : 'parent';
}

function isValidRelationship(value) {
  return RELATIONSHIPS.includes(value);
}

// Every permission key stored on GuardianLink.permissions.
const BOOLEAN_PERMISSION_KEYS = [
  'viewAssessments', 'submitAssessments', 'viewResults', 'viewRecommendations',
  'uploadDocuments', 'manageAppointments', 'modifyChild', 'inviteGuardians',
  'revokeAccess', 'viewMessages', 'sendMessages', 'manageMessages',
  'viewNotifications', 'sendNotifications', 'manageNotifications',
];
const MEDICAL_LEVELS = ['none', 'partial', 'full'];

const PRESETS = ['full', 'standard', 'medical', 'limited', 'custom'];

// The presets as defined on the Guardian Management page
// (js/parent/guardian-management.js). A key a preset does not list is OFF.
// viewRecommendations is not on that page's list; it follows viewResults,
// because recommendations are derived from the assessment results.
const PRESET_GRANTS = {
  full: {
    viewAssessments: true, submitAssessments: true, viewResults: true,
    uploadDocuments: true, manageAppointments: true, viewMedicalRecords: 'full',
    modifyChild: true, inviteGuardians: true, revokeAccess: true,
    viewMessages: true, sendMessages: true, viewNotifications: true,
  },
  standard: { viewAssessments: true, viewResults: true, viewMessages: true, viewNotifications: true },
  medical: { viewMedicalRecords: 'full', manageAppointments: true },
  limited: { viewResults: true },
};

function isValidPreset(value) {
  return PRESETS.includes(value);
}

// The schema stores viewMedicalRecords as 'none' | 'partial' | 'full', but the
// checkboxes in the UI send booleans. Casting `true` straight into that field
// fails the enum, so booleans are translated here.
function normalizeMedical(value, previous) {
  if (MEDICAL_LEVELS.includes(value)) return value;
  if (value === true || value === 'true') {
    return previous === 'partial' || previous === 'full' ? previous : 'full';
  }
  return 'none';
}

function emptyPermissions() {
  const out = {};
  for (const k of BOOLEAN_PERMISSION_KEYS) out[k] = false;
  out.viewMedicalRecords = 'none';
  return out;
}

// Full permission object for a preset. For 'custom', only known keys of
// `custom` are used and every value is coerced to the stored type.
function resolvePermissions(preset, custom) {
  const out = emptyPermissions();
  const grants = preset === 'custom' ? (custom || {}) : (PRESET_GRANTS[preset] || PRESET_GRANTS.standard);
  for (const k of BOOLEAN_PERMISSION_KEYS) {
    if (k in grants) out[k] = grants[k] === true || grants[k] === 'true';
  }
  if (preset !== 'custom' || !('viewRecommendations' in grants)) {
    out.viewRecommendations = out.viewResults;
  }
  out.viewMedicalRecords = normalizeMedical(grants.viewMedicalRecords);
  return out;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return EMAIL_RE.test(email) ? email : null;
}

module.exports = {
  RELATIONSHIPS, RELATIONSHIP_LABELS, LINK_ROLES, PRESETS, PRESET_GRANTS,
  BOOLEAN_PERMISSION_KEYS, MEDICAL_LEVELS,
  roleForRelationship, isValidRelationship, isValidPreset,
  normalizeMedical, resolvePermissions, normalizeEmail,
};
