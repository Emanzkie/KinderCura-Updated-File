// scripts/migrate-add-viewRecommendations.js
// Non-destructive migration to ensure existing PermissionSet and GuardianLink
// documents include the `permissions.viewRecommendations` flag (default: true).
// Usage:
//   node scripts/migrate-add-viewRecommendations.js --dry-run
//   node scripts/migrate-add-viewRecommendations.js
//   MONGODB_URI=... node scripts/migrate-add-viewRecommendations.js --dry-run
require('dotenv').config();

const { connectDB, mongoose } = require('../db');
const PermissionSet = require('../models/PermissionSet');
const GuardianLink = require('../models/GuardianLink');

function isDryRun() {
  return process.argv.includes('--dry-run');
}

async function run() {
  const dryRun = isDryRun();
  await connectDB();

  try {
    const missingFilter = { $or: [ { 'permissions.viewRecommendations': { $exists: false } }, { 'permissions.viewRecommendations': null } ] };

    const psCount = await PermissionSet.countDocuments(missingFilter);
    const glCount = await GuardianLink.countDocuments(missingFilter);

    console.log('Migration: ensure permissions.viewRecommendations exists (true by default)');
    console.log(`PermissionSet docs missing flag: ${psCount}`);
    console.log(`GuardianLink docs missing flag: ${glCount}`);

    if (dryRun) {
      console.log('Dry-run: no changes will be made. Sample documents:');
      const psSample = await PermissionSet.find(missingFilter).limit(10).select('_id name').lean();
      const glSample = await GuardianLink.find(missingFilter).limit(10).select('_id childId guardianId').lean();
      console.log('  PermissionSet sample IDs:', psSample.map(p => String(p._id)));
      console.log('  GuardianLink sample IDs:', glSample.map(g => String(g._id)));
    } else {
      const psResult = await PermissionSet.updateMany(missingFilter, { $set: { 'permissions.viewRecommendations': true } });
      const glResult = await GuardianLink.updateMany(missingFilter, { $set: { 'permissions.viewRecommendations': true } });

      // Mongoose UpdateResult exposes matchedCount/modifiedCount in modern versions.
      console.log(`PermissionSet updated: matched=${psResult.matchedCount || psResult.n || 0} modified=${psResult.modifiedCount || psResult.nModified || 0}`);
      console.log(`GuardianLink updated: matched=${glResult.matchedCount || glResult.n || 0} modified=${glResult.modifiedCount || glResult.nModified || 0}`);
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
