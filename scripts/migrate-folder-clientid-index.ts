#!/usr/bin/env tsx
/**
 * Replace `folders.userId_1_clientId_1` with a PARTIAL unique index.
 *
 * WHY THIS EXISTS. The index was declared `{ unique: true, sparse: true }`, and on a COMPOUND
 * index `sparse` omits a document only when EVERY indexed field is missing. `userId` is always
 * present, so every folder was indexed — with `clientId: null` for the ones created in the app,
 * which do not carry a clientId at all. `unique` then allowed exactly ONE such folder per user.
 *
 * Measured symptom, reproduced directly against the model before this was written:
 *
 *     Folder.create({ userId, name: 'amd' })
 *     E11000 duplicate key error collection: pulseblr.folders index: userId_1_clientId_1
 *       dup key: { userId: "1001028…", clientId: null }
 *
 * A user with one folder could never create a second, and `POST /api/folders` reported it as
 * "You already have a folder with that name" — naming the one thing that was not wrong. One
 * folder per event is the core of the scan feature; it was capped at one folder per user.
 *
 * `partialFilterExpression: { clientId: { $type: 'string' } }` indexes only the folders that
 * really have a clientId, which is what `sparse` was reaching for. Offline-created folders keep
 * their idempotency guarantee; folders made in the app stop colliding with each other.
 *
 * A SCHEMA EDIT ALONE DOES NOT FIX A DEPLOYED DATABASE. Mongoose creates an index if it is
 * absent and otherwise leaves it exactly as it found it — it will not alter options on an
 * existing index, and `createIndex` with different options on the same key raises
 * IndexOptionsConflict rather than migrating. So the old index has to be dropped explicitly.
 * That is this script.
 *
 * Safe to re-run: it reports and exits if the partial index is already in place.
 *
 * There is a brief window between the drop and the create where uniqueness is unenforced. That
 * is acceptable here — the constraint being dropped is the one that was rejecting legitimate
 * writes, and the replacement is created immediately after.
 *
 * Run: npx tsx scripts/migrate-folder-clientid-index.ts          (dry)
 *      npx tsx scripts/migrate-folder-clientid-index.ts --apply
 */
import './load-env';
import connectDB from '../lib/mongodb';
import mongoose from 'mongoose';

const APPLY = process.argv.includes('--apply');
const INDEX_NAME = 'userId_1_clientId_1';
const PARTIAL = { clientId: { $type: 'string' } };

async function main() {
  await connectDB();
  const folders = mongoose.connection.collection('folders');

  const before = await folders.indexes();
  const existing = before.find(i => i.name === INDEX_NAME);

  console.log(`folders: ${await folders.countDocuments({})} document(s)`);
  if (!existing) {
    console.log(`\n${INDEX_NAME} is absent. Mongoose will create the partial index on next use.`);
    await mongoose.disconnect();
    return;
  }

  const isPartial = Boolean(existing.partialFilterExpression);
  console.log(`\ncurrent ${INDEX_NAME}:`);
  console.log(`  unique  ${Boolean(existing.unique)}`);
  console.log(`  sparse  ${Boolean(existing.sparse)}`);
  console.log(`  partial ${existing.partialFilterExpression ? JSON.stringify(existing.partialFilterExpression) : 'none'}`);

  if (isPartial) {
    console.log('\nAlready partial. Nothing to do.');
    await mongoose.disconnect();
    return;
  }

  // How many rows the broken index was collapsing, so the impact is stated rather than implied.
  const withClientId = await folders.countDocuments({ clientId: { $type: 'string' } });
  const without = await folders.countDocuments({ clientId: { $not: { $type: 'string' } } });
  console.log(`\n  folders WITH a string clientId (offline-created): ${withClientId}`);
  console.log(`  folders WITHOUT one (created in the app):          ${without}`);
  if (without > 1) {
    console.log('  → more than one already exists, so this database predates the constraint.');
  } else {
    console.log(`  → the ${without === 1 ? 'single' : 'nonexistent'} row above is why no further folder could be created.`);
  }

  if (!APPLY) {
    console.log('\nDRY RUN. Would drop and recreate:');
    console.log(`  db.folders.dropIndex("${INDEX_NAME}")`);
    console.log(
      `  db.folders.createIndex({ userId: 1, clientId: 1 }, { unique: true, partialFilterExpression: ${JSON.stringify(PARTIAL)} })`
    );
    console.log('\nRe-run with --apply to write.');
    await mongoose.disconnect();
    return;
  }

  console.log(`\ndropping ${INDEX_NAME} …`);
  await folders.dropIndex(INDEX_NAME);
  console.log('creating the partial replacement …');
  await folders.createIndex(
    { userId: 1, clientId: 1 },
    { unique: true, partialFilterExpression: PARTIAL, name: INDEX_NAME }
  );

  const after = (await folders.indexes()).find(i => i.name === INDEX_NAME);
  console.log('\nresult:');
  console.log(`  unique  ${Boolean(after?.unique)}`);
  console.log(`  sparse  ${Boolean(after?.sparse)}`);
  console.log(`  partial ${after?.partialFilterExpression ? JSON.stringify(after.partialFilterExpression) : 'none'}`);
  console.log(
    after?.partialFilterExpression ? '\nDone. A second folder can now be created.' : '\nFAILED — index is not partial.'
  );

  await mongoose.disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
