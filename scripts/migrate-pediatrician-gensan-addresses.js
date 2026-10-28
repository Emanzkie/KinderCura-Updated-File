// scripts/migrate-pediatrician-gensan-addresses.js
// Moves pediatrician clinic addresses into General Santos City, South Cotabato.
//
// Pages read User.clinicAddress live (appointments, suggested pediatricians,
// admin and PRC views); nothing stores a copy, so this one update is enough.
// On pediatricians only clinicAddress and institution are written; on
// appointments only location. Names, specialties, fees, availability, clinic
// links, schedules, statuses and payments are untouched.
//
//   • Demo pediatricians (isSynthetic) outside GenSan: the street part is kept
//     ("284 Navarro St.") and a GenSan barangay is added, picked from the
//     account id so every run gives the same answer. institution becomes
//     "General Santos City Medical Center".
//   • Real pediatricians outside GenSan who are linked to a registered clinic
//     in GenSan: clinicAddress becomes that clinic's address; clinicName is
//     kept. Real accounts with no such clinic are listed, never invented.
//   • Appointment.location holding a copy of an old address (booking copies
//     clinicAddress into it) takes the pediatrician's current address. A
//     location that is the clinic name is left alone.
//
// Usage (local and live share one Atlas database — dry-run first):
//   node scripts/migrate-pediatrician-gensan-addresses.js --dry-run
//   node scripts/migrate-pediatrician-gensan-addresses.js
require('dotenv').config();
const crypto = require('crypto');
const { GENSAN_CITY, GENSAN_BARANGAYS, GENSAN_INSTITUTION, isInGenSan } = require('../constants/genSanLocations');

/** A barangay for this account, the same on every run. */
function barangayFor(id) {
  const n = crypto.createHash('sha256').update(String(id)).digest().readUInt32BE(0);
  return GENSAN_BARANGAYS[n % GENSAN_BARANGAYS.length];
}

/**
 * The $set for one pediatrician, or null when nothing needs to change.
 * linkedClinic is the registered Clinic the account is linked to (if any).
 * Returns { set } or { skip: reason }.
 */
function plannedUpdate(ped, linkedClinic = null) {
  const addressOk = isInGenSan(ped.clinicAddress);
  const institutionOk = !ped.institution || isInGenSan(ped.institution);
  if (addressOk && institutionOk) return null;

  if (ped.isSynthetic === true) {
    const set = {};
    if (!addressOk) {
      const street = String(ped.clinicAddress || '').split(',')[0].trim() || 'Pioneer Ave.';
      set.clinicAddress = `${street}, Brgy. ${barangayFor(ped._id)}, ${GENSAN_CITY}`;
    }
    if (!institutionOk) set.institution = GENSAN_INSTITUTION;
    return { set };
  }

  // A real account: only an address the clinic registry already holds.
  if (!addressOk && linkedClinic && isInGenSan(linkedClinic.address)) {
    return { set: { clinicAddress: String(linkedClinic.address).trim() } };
  }
  return { skip: 'real account with no registered General Santos City clinic to copy' };
}

/**
 * Booking copies the pediatrician's clinicAddress into Appointment.location
 * (routes/appointments.js POST /create). A copy of an address outside GenSan
 * takes the pediatrician's current (GenSan) address. A location holding the
 * clinic name or institution (the demo generator's choice) is not an address
 * and is left as it is. Returns the new location or null.
 */
function plannedAppointmentLocation(appt, ped) {
  const location = String(appt.location || '').trim();
  if (!location || isInGenSan(location) || !ped || !isInGenSan(ped.clinicAddress)) return null;
  if ([ped.clinicName, ped.institution].some((v) => v && String(v).trim() === location)) return null;
  return String(ped.clinicAddress).trim();
}

async function run() {
  const dryRun = process.argv.includes('--dry-run');
  const { connectDB, mongoose } = require('../db');
  const User = require('../models/User');
  const Clinic = require('../models/Clinic');
  await connectDB();
  try {
    const peds = await User.find({ role: 'pediatrician' })
      .select('_id firstName lastName clinicName clinicAddress institution isSynthetic clinicId')
      .lean();
    const clinicIds = peds.map((p) => p.clinicId).filter(Boolean);
    const clinics = clinicIds.length ? await Clinic.find({ _id: { $in: clinicIds } }).select('_id address').lean() : [];
    const clinicById = new Map(clinics.map((c) => [String(c._id), c]));

    console.log(`Migration: pediatrician addresses -> ${GENSAN_CITY}${dryRun ? ' (dry-run, no changes)' : ''}`);
    console.log(`Pediatricians: ${peds.length}`);
    let updated = 0;
    const skipped = [];
    for (const ped of peds) {
      const plan = plannedUpdate(ped, ped.clinicId ? clinicById.get(String(ped.clinicId)) : null);
      if (!plan) continue;
      const who = `${ped.firstName} ${ped.lastName}${ped.isSynthetic ? ' (demo)' : ''}`;
      if (plan.skip) { skipped.push(`${who}: ${plan.skip}`); continue; }
      console.log(`  ${who}: "${ped.clinicAddress || ''}" -> "${plan.set.clinicAddress || ped.clinicAddress}"`
        + (plan.set.institution ? `; institution -> "${plan.set.institution}"` : ''));
      if (!dryRun) await User.updateOne({ _id: ped._id }, { $set: plan.set });
      updated += 1;
    }
    console.log(`${dryRun ? 'Would update' : 'Updated'}: ${updated}`);
    if (skipped.length) {
      console.log(`Left unchanged (${skipped.length}):`);
      skipped.forEach((s) => console.log(`  ${s}`));
    }

    // Appointment.location copies of an old address. Reads the pediatricians
    // again so a dry-run shows what the address step above would produce.
    const Appointment = require('../models/Appointment');
    const current = new Map((await User.find({ role: 'pediatrician' })
      .select('_id clinicName clinicAddress institution isSynthetic clinicId').lean())
      .map((p) => {
        const plan = dryRun ? plannedUpdate(p, p.clinicId ? clinicById.get(String(p.clinicId)) : null) : null;
        return [String(p._id), plan && plan.set ? { ...p, ...plan.set } : p];
      }));
    const appts = await Appointment.find({ location: { $nin: [null, ''], $not: /general\s+santos/i } })
      .select('_id id pediatricianId location').lean();
    let apptUpdated = 0;
    for (const appt of appts) {
      const next = plannedAppointmentLocation(appt, current.get(String(appt.pediatricianId)));
      if (!next) continue;
      if (!dryRun) await Appointment.updateOne({ _id: appt._id }, { $set: { location: next } });
      apptUpdated += 1;
    }
    console.log(`Appointment locations (copies of an old address): ${dryRun ? 'would update' : 'updated'} ${apptUpdated}`);

    if (!dryRun) {
      const after = await User.find({ role: 'pediatrician' }).select('clinicAddress institution').lean();
      const outside = after.filter((p) => !isInGenSan(p.clinicAddress) || (p.institution && !isInGenSan(p.institution)));
      const clinicsOutside = await Clinic.countDocuments({ address: { $not: /general\s+santos/i } });
      console.log(`Check: pediatricians outside ${GENSAN_CITY}: ${outside.length}; registered clinics outside: ${clinicsOutside}`);
      if (outside.length || clinicsOutside) process.exitCode = 1;
    }
  } catch (err) {
    console.error('Migration failed:', err && err.stack ? err.stack : err);
    process.exitCode = 1;
  } finally {
    await mongoose.connection.close();
  }
}

if (require.main === module) {
  run().catch((err) => {
    console.error('Migration error:', err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

module.exports = { run, plannedUpdate, plannedAppointmentLocation, barangayFor };
