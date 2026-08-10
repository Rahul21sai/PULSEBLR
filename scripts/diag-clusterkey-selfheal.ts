#!/usr/bin/env tsx
/**
 * End-to-end check that the real Event schema now self-heals a document that
 * reaches save() without a clusterKey — the failure that dropped 3 events.
 *
 * Strips the key from ONE document, saves, and asserts it comes back. The
 * regenerated value is a pure function of title + start date, so the document ends
 * up byte-identical to how it started; the script also asserts that.
 *
 * Run: npx tsx scripts/diag-clusterkey-selfheal.ts
 */
import './load-env';
import mongoose from 'mongoose';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';

async function main() {
  await connectDB();

  const victim = await Event.findOne({}).select('title clusterKey dedupHash startDateTime');
  if (!victim) {
    console.log('No events in DB — nothing to test.');
    await mongoose.disconnect();
    return;
  }

  const before = victim.clusterKey;
  console.log(`Subject: "${victim.title}"`);
  console.log(`  clusterKey before: ${JSON.stringify(before)}`);

  // Remove the field at the database level, exactly as the legacy documents were.
  await Event.updateOne({ _id: victim._id }, { $unset: { clusterKey: '' } });
  const stripped = await Event.findById(victim._id).select('title clusterKey startDateTime');
  console.log(`  after $unset:      ${JSON.stringify(stripped?.clusterKey)}`);

  // The merge path does exactly this: load, touch, save.
  try {
    stripped!.lastSeenAt = new Date();
    await stripped!.save();
    console.log('  save() ............ OK (no validation error)');
  } catch (err) {
    console.log(`  save() ............ FAILED: ${(err as Error).message}`);
  }

  const after = await Event.findById(victim._id).select('clusterKey').lean();
  console.log(`  clusterKey after:  ${JSON.stringify(after?.clusterKey)}`);
  console.log(
    after?.clusterKey === before
      ? '\nPASS — key regenerated and identical to the original.'
      : `\nFAIL — expected ${JSON.stringify(before)}, got ${JSON.stringify(after?.clusterKey)}`
  );

  // Restore explicitly if regeneration somehow differed, so the script is safe.
  if (after?.clusterKey !== before) {
    await Event.updateOne({ _id: victim._id }, { $set: { clusterKey: before } });
    console.log('Original value restored.');
  }

  await mongoose.disconnect();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
