#!/usr/bin/env tsx
/**
 * DESTRUCTIVE cleanup — deletes PAST-DATED events only.
 *
 * User-approved scope (2026-07-27): "Past-dated only". Removes events whose end
 * (or start, when no end) is before now. Leaves seed stubs and all upcoming
 * events untouched. Uses the SAME filter as scripts/cleanup-dryrun.ts, so the
 * dry-run's "PAST-DATED" bucket is exactly what is deleted here PLUS what is kept
 * below — both counts are printed so the two reconcile.
 *
 * NEVER A ROW A USER STILL POINTS AT. A past event somebody tracked, filed a folder
 * for, or met someone at is their history: `TrackerEntry.eventId` is required, so
 * deleting the event strands the entry's status, notes and people rather than
 * removing them. Those rows are KEPT and named in the output, exactly as the nightly
 * `pruneStale()` keeps them. The check is `splitByReference` from
 * lib/scrapers/prune-selection.ts, imported rather than mirrored, so this script and
 * the pruner cannot drift on what "referenced" means. Untrack the event, or delete
 * its folder, and the next run removes it.
 *
 * Run: npx tsx scripts/cleanup-past.ts
 */
import './load-env';
import mongoose from 'mongoose';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';
import { PRUNE_BATCH_SIZE, chunk, splitByReference } from '../lib/scrapers/prune-selection';

// A hand-entered event is never a candidate for automated deletion.
//
// `$exists: false` rather than `null`, because the ~1500 documents that predate ownership have no
// such key and they ARE the intended targets. The reasoning is the same in every script that
// deletes events: a maintenance job the user never ran and cannot see must not destroy something
// they typed in themselves. Typing an event in by hand is a stronger signal of intent than the
// heuristics these scripts apply — a date typo, a venue on "Mysore Road", or a genuinely far-out
// conference is theirs to fix or keep, and nothing re-creates it because there is no upstream.
const SCRAPED_ONLY = { createdByUserId: { $exists: false } } as const;


function fmt(d: Date | undefined): string {
  return d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '(none)';
}

async function main() {
  await connectDB();
  const now = new Date();

  // Identical to cleanup-dryrun.ts's pastFilter — an event is "past" if its end
  // (or start, when no end) is before now.
  const pastFilter = {
    ...SCRAPED_ONLY,
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

  // A user's own record outranks a date heuristic. SPARED, never repointed: a lone delete has no
  // surviving twin to repoint to. Fails closed — a lookup error aborts before anything is deleted.
  const { deletable, spared } = await splitByReference(doomed, { idOf: e => String(e._id) });

  if (spared.length > 0) {
    console.log(
      `\nKeeping ${spared.length} past event(s) a user tracked, filed a folder for, or met someone at:\n`
    );
    for (const e of spared) {
      console.log(`   • ${fmt(e.startDateTime)}  [${e.source}]  ${e.title.slice(0, 50)}`);
    }
  }

  console.log(`\n🗑️  Deleting ${deletable.length} past-dated events:\n`);
  for (const e of deletable) {
    console.log(`   • ${fmt(e.startDateTime)}  [${e.source}]  ${e.title.slice(0, 50)}`);
  }

  let deletedCount = 0;
  for (const batch of chunk(deletable.map(e => String(e._id)), PRUNE_BATCH_SIZE)) {
    // `pastFilter` is repeated alongside the ids, so a row that stopped matching after it was read
    // (re-dated, or claimed by an owner) is not deleted on a verdict about its old state.
    const res = await Event.deleteMany({ ...pastFilter, _id: { $in: batch } });
    deletedCount += res.deletedCount || 0;
  }
  const remaining = await Event.countDocuments({});

  console.log('\n' + '═'.repeat(70));
  console.log(`✅ Deleted: ${deletedCount}`);
  console.log(`   Kept because a user points at them: ${spared.length}`);
  console.log(`📊 Events remaining in DB: ${remaining}`);
  console.log('═'.repeat(70) + '\n');

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(e => { console.error('❌', e); process.exit(1); });
