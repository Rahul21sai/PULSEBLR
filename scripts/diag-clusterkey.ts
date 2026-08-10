#!/usr/bin/env tsx
/**
 * Why do a handful of events fail to ingest with "clusterKey: Path `clusterKey` is
 * required"? Read-only diagnosis of the three failing titles from the last run,
 * plus a corpus-wide check for documents missing the key.
 *
 * Run: npx tsx scripts/diag-clusterkey.ts
 */
import './load-env';
import mongoose from 'mongoose';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';

const FAILING = [
  'Cartesia AI: Vinyl and Whiskey Night',
  'Breakfast Party by The Bangalore Breakfast Club',
  'Monad Blitz Bangalore V5',
];

async function main() {
  await connectDB();

  // 1. Corpus-wide: any stored document missing the key?
  const missing = await Event.countDocuments({
    $or: [{ clusterKey: { $exists: false } }, { clusterKey: '' }, { clusterKey: null }],
  });
  console.log(`Documents with a missing/empty clusterKey: ${missing}`);

  // 2. Do the failing titles exist at all, and what do their keys look like?
  for (const title of FAILING) {
    const docs = await Event.find({ title }).select('title clusterKey dedupHash source startDateTime sourceEventId').lean();
    console.log(`\n"${title}" → ${docs.length} doc(s)`);
    for (const d of docs) {
      console.log(`   source=${d.source} start=${d.startDateTime?.toISOString?.() ?? d.startDateTime}`);
      console.log(`   clusterKey=${JSON.stringify(d.clusterKey)}`);
      console.log(`   sourceEventId=${JSON.stringify(d.sourceEventId)}`);
    }
  }

  // 3. What does the generator produce for these titles? Includes the edge cases
  //    that would yield a falsy key.
  console.log('\ngenerateClusterKey() behaviour:');
  for (const title of [...FAILING, '🎉🎊', '', '   ']) {
    try {
      const key = Event.generateClusterKey(title, new Date('2026-08-20T15:30:00Z'));
      console.log(`   ${JSON.stringify(title).padEnd(50)} → ${JSON.stringify(key)} (truthy=${!!key})`);
    } catch (err) {
      console.log(`   ${JSON.stringify(title).padEnd(50)} → THREW ${(err as Error).message}`);
    }
  }

  // 4. An invalid date is the remaining suspect: Intl throws on it, and a throw
  //    inside pre('save') surfaces as a save failure.
  console.log('\nInvalid startDateTime:');
  try {
    const key = Event.generateClusterKey('Some Event', new Date('not-a-date'));
    console.log(`   → ${JSON.stringify(key)}`);
  } catch (err) {
    console.log(`   → THREW ${(err as Error).constructor.name}: ${(err as Error).message}`);
  }

  await mongoose.disconnect();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
