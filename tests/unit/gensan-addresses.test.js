// Pediatrician addresses are moved into General Santos City
// (scripts/migrate-pediatrician-gensan-addresses.js), and the demo generator
// now places new demo pediatricians there too. Pure functions only: no DB.
const assert = require('assert');
const { plannedUpdate, plannedAppointmentLocation, barangayFor } = require('../../scripts/migrate-pediatrician-gensan-addresses');
const { GENSAN_BARANGAYS, GENSAN_INSTITUTION, isInGenSan } = require('../../constants/genSanLocations');

const results = [];
const ok = (m) => results.push(m);

// 1. A demo pediatrician elsewhere: street kept, GenSan barangay added, the
//    institution renamed, and the same answer on every run.
const demo = { _id: '6a1b2c3d4e5f60718293a4b5', isSynthetic: true, clinicAddress: '284 Navarro St., Iloilo City', institution: 'Iloilo City Medical Center' };
const plan = plannedUpdate(demo);
const brgy = barangayFor(demo._id);
assert.ok(GENSAN_BARANGAYS.includes(brgy));
assert.deepStrictEqual(plan, { set: { clinicAddress: `284 Navarro St., Brgy. ${brgy}, General Santos City`, institution: GENSAN_INSTITUTION } });
assert.deepStrictEqual(plannedUpdate(demo), plan, 'deterministic');
assert.ok(isInGenSan(plan.set.clinicAddress) && isInGenSan(plan.set.institution));
ok('demo pediatrician: street kept, GenSan barangay and institution, same result every run');

// 2. Already in GenSan: nothing to do.
assert.strictEqual(plannedUpdate({ _id: 'x', isSynthetic: true, clinicAddress: '12 Santos St., Brgy. Lagao, General Santos City', institution: GENSAN_INSTITUTION }), null);
assert.strictEqual(plannedUpdate({ _id: 'y', isSynthetic: false, clinicAddress: 'Santiago Blvd, General Santos City', institution: null }), null);
ok('addresses already in General Santos City are left alone');

// 3. A real account takes its registered GenSan clinic's address; its clinic
//    name is never touched. Without such a clinic nothing is invented.
const real = { _id: 'r1', isSynthetic: false, clinicName: 'KinderCura Development Center', clinicAddress: 'Octavio Village Cannery Site', institution: null };
const clinic = { address: 'Room 3 HQ Lab ni Dok, Santiago Blvd, General Santos City' };
assert.deepStrictEqual(plannedUpdate(real, clinic), { set: { clinicAddress: clinic.address } });
assert.ok(plannedUpdate(real, null).skip, 'no linked clinic: listed, not changed');
assert.ok(plannedUpdate(real, { address: 'Koronadal City' }).skip, 'a linked clinic outside GenSan is not copied');
ok('real account: linked GenSan clinic address copied, clinic name kept; nothing invented otherwise');

// 4. Appointment.location: a booking-time copy of an old address takes the
//    pediatrician's current address; a clinic-name location is not an address.
const ped = { clinicName: 'KinderCura Development Center', clinicAddress: clinic.address, institution: null };
assert.strictEqual(plannedAppointmentLocation({ location: 'Octavio Village Cannery Site' }, ped), clinic.address);
assert.strictEqual(plannedAppointmentLocation({ location: 'KinderCura Development Center' }, ped), null, 'clinic name kept');
assert.strictEqual(plannedAppointmentLocation({ location: clinic.address }, ped), null, 'already in GenSan');
assert.strictEqual(plannedAppointmentLocation({ location: null }, ped), null);
assert.strictEqual(plannedAppointmentLocation({ location: 'Koronadal City' }, { ...ped, clinicAddress: 'Koronadal City' }), null, 'never copies a non-GenSan address');
ok('appointment location: old address copies updated, clinic names and GenSan locations kept');

results.forEach((m) => console.log(`  ok - ${m}`));
console.log(`GenSan address tests OK — ${results.length} groups`);
