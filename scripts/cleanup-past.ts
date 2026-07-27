#!/usr/bin/env tsx
/**
 * DESTRUCTIVE cleanup — deletes PAST-DATED events only.
 *
 * User-approved scope (2026-07-27): "Past-dated only". Removes events whose end
 * (or start, when no end) is before now. Leaves seed stubs and all upcoming
 * events untouched. Uses the SAME filter as scripts/cleanup-dryrun.ts so the
 * count deleted here matches the dry-run's "PAST-DATED" bucket exactly.
 *
 * Run: npx tsx scripts/cleanup-past.ts
 */
import './load-env';
import mongoose from 'mongoose';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';

function fmt(d: Date | undefined): string {
  return d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '(none)';
}

async function main() {
  await connectDB();
  const now = new Date();

  // Identical to cleanup-dryrun.ts's pastFilter — an event is "past" if its end
  // (or start, when no end) is before now.
  const pastFilter = {
    $or: [
      { endDateTime: { $exists: true, $ne: null, $lt: now } },
      {
        $and: [
          { $or: [{ endDateTime: { $exists: false } }, { endDateTime: null }] },
          { startDateTime: { $lt: now } },
        ],
      },
    ],
  };

  const doomed = await Event.find(pastFilter)
    .sort({ startDateTime: 1 })
    .select('title startDateTime endDateTime source')
    .lean();

  console.log(`\n🗑️  Deleting ${doomed.length} past-dated events:\n`);
  for (const e of doomed) {
    console.log(`   • ${fmt(e.startDateTime)}  [${e.source}]  ${e.title.slice(0, 50)}`);
  }

  const res = await Event.deleteMany(pastFilter);
  const remaining = await Event.countDocuments({});

  console.log('\n' + '═'.repeat(70));
  console.log(`✅ Deleted: ${res.deletedCount}`);
  console.log(`📊 Events remaining in DB: ${remaining}`);
  console.log('═'.repeat(70) + '\n');

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(e => { console.error('❌', e); process.exit(1); });
