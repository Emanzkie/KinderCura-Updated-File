// scripts/fix-payment-indexes.js
// Replaces the sparse-unique indexes on payments.paymentRef / payments.receiptNumber
// with partial-unique ones.
//
// Why this exists: both fields default to null. A `sparse` unique index only
// skips documents where the field is ABSENT, so once two payments were stored
// with an explicit null the second insert failed with E11000. A partial index
// keyed on `$type: 'string'` ignores nulls entirely, which is what was meant.
//
// Safe to run repeatedly. Run once per environment after deploying:
//   node scripts/fix-payment-indexes.js
require('dotenv').config();
const { connectDB, mongoose } = require('../db');

const TARGETS = [
  { field: 'paymentRef', name: 'paymentRef_1' },
  { field: 'receiptNumber', name: 'receiptNumber_1' },
];

(async () => {
  await connectDB();
  const collection = mongoose.connection.db.collection('payments');
  const existing = await collection.indexes();

  for (const { field, name } of TARGETS) {
    const current = existing.find((i) => i.name === name);

    if (current && !current.partialFilterExpression) {
      await collection.dropIndex(name);
      console.log(`dropped legacy index ${name} (sparse=${Boolean(current.sparse)})`);
    } else if (current) {
      console.log(`${name} already partial — leaving it alone`);
      continue;
    } else {
      console.log(`${name} not present`);
    }

    await collection.createIndex(
      { [field]: 1 },
      { unique: true, name, partialFilterExpression: { [field]: { $type: 'string' } } }
    );
    console.log(`created partial unique index ${name}`);
  }

  const after = await collection.indexes();
  console.log('\npayments indexes now:');
  for (const i of after) {
    console.log(`  ${i.name}${i.unique ? ' [unique]' : ''}${i.partialFilterExpression ? ' [partial]' : ''}${i.sparse ? ' [sparse]' : ''}`);
  }

  await mongoose.disconnect();
})().catch((err) => { console.error(err); process.exit(1); });
