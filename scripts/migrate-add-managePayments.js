// scripts/migrate-add-managePayments.js
// Non-destructive migration: backfills secretaryPermissions.managePayments for
// existing secretary User documents created before this field existed.
//
// Backfill value is COMPUTED per document, not a blanket true/false:
//   managePayments = Boolean(manageBookings || approveSchedules)
// This preserves whichever secretaries could already pass the old proxy
// check in controllers/paymentController.js (no regression), while NOT
// silently granting payment access to secretaries who never had it under
// the old logic (no over-grant). Going forward, pediatricians adjust this
// explicitly via Settings > Staff Access.
//
// Usage:
//   node scripts/migrate-add-managePayments.js --dry-run
//   node scripts/migrate-add-managePayments.js
require('dotenv').config();

const { connectDB, mongoose } = require('../db');
const User = require('../models/User');

function isDryRun() {
  return process.argv.includes('--dry-run');
}

async function run() {
  const dryRun = isDryRun();
  await connectDB();

  try {
    const missingFilter = {
      role: 'secretary',
      $or: [
        { 'secretaryPermissions.managePayments': { $exists: false } },
        { 'secretaryPermissions.managePayments': null },
      ],
    };

    const secretaries = await User.find(missingFilter)
      .select('_id secretaryPermissions')
      .lean();

    console.log('Migration: backfill secretaryPermissions.managePayments');
    console.log(`Secretary docs missing field: ${secretaries.length}`);

    if (dryRun) {
      console.log('Dry-run: no changes will be made. Computed values:');
      secretaries.forEach((s) => {
        const perms = s.secretaryPermissions || {};
        const computed = Boolean(perms.manageBookings || perms.approveSchedules);
        console.log(`  ${s._id}: manageBookings=${!!perms.manageBookings} approveSchedules=${!!perms.approveSchedules} -> managePayments=${computed}`);
      });
    } else {
      let grantedTrue = 0;
      let setFalse = 0;
      for (const s of secretaries) {
        const perms = s.secretaryPermissions || {};
        const computed = Boolean(perms.manageBookings || perms.approveSchedules);
        await User.updateOne(
          { _id: s._id },
          { $set: { 'secretaryPermissions.managePayments': computed } }
        );
        if (computed) grantedTrue += 1; else setFalse += 1;
      }
      console.log(`Backfilled managePayments=true for ${grantedTrue} secretaries (had manageBookings or approveSchedules).`);
      console.log(`Backfilled managePayments=false for ${setFalse} secretaries.`);
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

module.exports = { run };
