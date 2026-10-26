// services/secretaryPermissions.js
//
// What a secretary may do is set per secretary by their pediatrician in
// Settings > Staff Access (User.secretaryPermissions). Only scheduling actions
// are listed; medical decisions are never delegated.
//
// A secretary saved before a flag existed has no stored value for it, and
// Mongoose's lean() does not apply schema defaults, so a stored value always
// wins and anything missing falls back to the default below. routes/secretary.js
// has always merged them this way; the appointment routes share it now.
const User = require('../models/User');

const SECRETARY_DEFAULT_PERMISSIONS = Object.freeze({
  viewAppointments: true,    // can see the appointment list
  manageBookings: true,      // can approve / reject booking requests
  rescheduleRequests: true,  // can propose new dates/times
  approveSchedules: true,    // can mark approved appointments as confirmed
  managePayments: false,     // can confirm cash/POS payments: must be explicitly enabled
});

async function getSecretaryPermissions(userId) {
  const secretary = await User.findById(userId).select('secretaryPermissions').lean();
  return { ...SECRETARY_DEFAULT_PERMISSIONS, ...((secretary && secretary.secretaryPermissions) || {}) };
}

module.exports = { SECRETARY_DEFAULT_PERMISSIONS, getSecretaryPermissions };
