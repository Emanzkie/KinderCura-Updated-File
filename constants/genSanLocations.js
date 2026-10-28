// Locations for pediatrician clinic addresses. KinderCura serves General Santos
// City, South Cotabato, so demo pediatricians and their institutions are placed
// in real barangays of the city. Used by scripts/generate-system-demo-data.js
// and scripts/migrate-pediatrician-gensan-addresses.js so the two agree.
const GENSAN_CITY = 'General Santos City';

const GENSAN_BARANGAYS = Object.freeze([
  'Lagao',
  'Dadiangas North',
  'Dadiangas East',
  'Dadiangas South',
  'Dadiangas West',
  'City Heights',
  'Calumpang',
  'Bula',
  'Fatima',
  'San Isidro',
  'Apopong',
  'Labangal',
  'Mabuhay',
  'Tambler',
]);

const GENSAN_INSTITUTION = `${GENSAN_CITY} Medical Center`;

/** True when a free-text address or institution names General Santos City. */
function isInGenSan(text) {
  return /general\s+santos/i.test(String(text || ''));
}

module.exports = { GENSAN_CITY, GENSAN_BARANGAYS, GENSAN_INSTITUTION, isInGenSan };
