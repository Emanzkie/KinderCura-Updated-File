// The clinic's local time. KinderCura runs in the Philippines (UTC+8, no
// daylight saving), so a date an admin picks ("to 8 August") and the month a
// record is counted in are Manila days and months. They used to be UTC ones,
// so anything done between midnight and 7:59 AM Manila time landed on the
// previous day (or month).
const CLINIC_TIMEZONE = 'Asia/Manila';
const CLINIC_UTC_OFFSET = '+08:00';
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Start of a YYYY-MM-DD day in clinic time, as a Date (Invalid Date if malformed). */
function clinicDayStart(ymd) {
  return new Date(`${ymd}T00:00:00.000${CLINIC_UTC_OFFSET}`);
}

/** Last millisecond of a YYYY-MM-DD day in clinic time. */
function clinicDayEnd(ymd) {
  return new Date(`${ymd}T23:59:59.999${CLINIC_UTC_OFFSET}`);
}

module.exports = { CLINIC_TIMEZONE, CLINIC_UTC_OFFSET, DATE_ONLY, clinicDayStart, clinicDayEnd };
