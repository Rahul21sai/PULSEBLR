#!/usr/bin/env tsx
/**
 * DRY-RUN cleanup analysis — READ ONLY, deletes nothing.
 *
 * Counts and samples the categories of "stale/junk" data the user asked to
 * clean up (Task 2), so we can present the numbers BEFORE any destructive
 * delete. Run: npx tsx scripts/cleanup-dryrun.ts
 *
 * Buckets analysed:
 *   1. Past-dated events   — startDateTime (or endDateTime when present) < now
 *   2. Seed data           — the 8 hand-written source:'manual' *-blr-001 stubs
 *   3. Duplicate stubs      — same title with >1 doc (e.g. "Python Meetup")
 */
import './load-env';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';

// The exact dedupHashes minted by scripts/seed.ts — unambiguous seed markers.
const SEED_DEDUP_HASHES = [
  'llm-workshop-blr-001',
  'upi-mixer-blr-001',
  'founders-funders-blr-001',
  'aws-watch-party-blr-001',
  'react-nextjs-blr-001',
  'ctf-blr-001',
  'data-summit-blr-001',
  'nvidia-nim-hack-blr-001',
];

function fmt(d: Date | undefined): string {
  return d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '(none)';
}

async function main() {
  await connectDB();
  const now = new Date();

  const total = await Event.countDocuments({});
  console.log(`\n📊 Total events in DB: ${total}\n`);

  // ── Bucket 1: past-dated events ──────────────────────────────────────────
  // An event is "past" if its end (or start, when no end) is before now.
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
  const pastCount = await Event.countDocuments(pastFilter);
  const pastSample = await Event.find(pastFilter)
    .sort({ startDateTime: 1 })
    .limit(10)
    .select('title startDateTime endDateTime source')
    .lean();

  console.log('━'.repeat(70));
  console.log(`1) PAST-DATED events (already finished): ${pastCount}`);
  console.log('━'.repeat(70));
  for (const e of pastSample) {
    console.log(`   • ${fmt(e.startDateTime)}  [${e.source}]  ${e.title.slice(0, 50)}`);
  }
  if (pastCount > pastSample.length) console.log(`   … and ${pastCount - pastSample.length} more`);

  // ── Bucket 2: seed data ──────────────────────────────────────────────────
  const seedFilter = { dedupHash: { $in: SEED_DEDUP_HASHES } };
  const seedCount = await Event.countDocuments(seedFilter);
  const seedDocs = await Event.find(seedFilter)
    .select('title startDateTime dedupHash')
    .lean();

  console.log('\n' + '━'.repeat(70));
  console.log(`2) SEED data (hand-written source:'manual' stubs): ${seedCount}`);
  console.log('━'.repeat(70));
  for (const e of seedDocs) {
    const past = new Date(e.startDateTime) < now ? ' (past)' : '';
    console.log(`   • ${fmt(e.startDateTime)}${past}  ${e.title.slice(0, 50)}`);
  }

  // ── Bucket 3: duplicate titles (same title, >1 doc) ──────────────────────
  const dupGroups = await Event.aggregate([
    { $group: { _id: '$title', count: { $sum: 1 }, ids: { $push: '$_id' } } },
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1 } },
  ]);
  const dupExtra = dupGroups.reduce((s, g) => s + (g.count - 1), 0);

  console.log('\n' + '━'.repeat(70));
  console.log(`3) DUPLICATE titles (>1 doc same title): ${dupGroups.length} groups, ${dupExtra} redundant docs`);
  console.log('━'.repeat(70));
  for (const g of dupGroups.slice(0, 10)) {
    console.log(`   • ${g.count}×  ${String(g._id).slice(0, 55)}`);
  }
  if (dupGroups.length > 10) console.log(`   … and ${dupGroups.length - 10} more groups`);

  // ── Overlap-aware net figure ─────────────────────────────────────────────
  // A doc could be BOTH seed AND past — count the union so we don't double-count.
  const pastOrSeedUnion = await Event.countDocuments({ $or: [pastFilter, seedFilter] });
  const upcomingReal = total - pastOrSeedUnion;

  console.log('\n' + '═'.repeat(70));
  console.log('SUMMARY');
  console.log('═'.repeat(70));
  console.log(`  Total events:                 ${total}`);
  console.log(`  Past-dated:                   ${pastCount}`);
  console.log(`  Seed stubs:                   ${seedCount}`);
  console.log(`  Past ∪ seed (union):          ${pastOrSeedUnion}`);
  console.log(`  Duplicate redundant docs:     ${dupExtra}`);
  console.log(`  → Upcoming, non-seed events:  ${upcomingReal}`);
  console.log('═'.repeat(70));
  console.log('\n⚠️  DRY RUN — nothing was deleted. Review the numbers above.\n');

  await (await import('mongoose')).default.disconnect();
  process.exit(0);
}

main().catch(e => { console.error('❌', e); process.exit(1); });
