#!/usr/bin/env tsx
/**
 * Remove Source rows left behind by the pre-rewrite naming scheme.
 *
 * The old orchestrator named sources by splitting the URL:
 *   `url.split('/')[4]`   → "events"     for https://www.meetup.com/<g>/events/rss/
 *   `url.split('/').pop()` → "bengaluru"  for https://luma.com/bengaluru
 *
 * Those rows still sit in the collection with stale counts, so Settings shows
 * meaningless entries called "events" and inflates the source total. The current
 * pipeline names every source properly, so these can never be recreated.
 *
 * Usage:
 *   npx tsx scripts/cleanup-sources.ts          apply
 *   npx tsx scripts/cleanup-sources.ts --dry    report only
 */
import './load-env';
import mongoose from 'mongoose';
import connectDB from '../lib/mongodb';
import Source from '../lib/models/Source';

const DRY = process.argv.includes('--dry');

/** Names only the legacy scheme could have produced. */
const LEGACY_NAMES = ['events', 'bengaluru', 'blr', 'ical', 'rss', 'undefined', 'null'];

async function main() {
  await connectDB();

  const before = await Source.countDocuments({});

  // Legacy rows are identifiable by name AND by having no `kind` (discovered rows
  // always carry one). That pairing avoids deleting a legitimate source that
  // happens to be called something short.
  const filter = {
    name: { $in: LEGACY_NAMES },
    kind: { $exists: false },
  };

  const doomed = await Source.find(filter).select('name url type lastEventCount lastScrapedAt').lean();
  console.log(`${before} sources total; ${doomed.length} legacy row(s) to remove${DRY ? ' (dry run)' : ''}\n`);
  for (const s of doomed) {
    console.log(`   - name="${s.name}" type=${s.type} lastCount=${s.lastEventCount ?? '-'} url=${String(s.url).slice(0, 56)}`);
  }

  if (!DRY && doomed.length > 0) {
    const outcome = await Source.deleteMany(filter);
    console.log(`\nDeleted ${outcome.deletedCount}`);
  }

  // Also report rows that duplicate a discovered source under a different name,
  // which is the other way the list gets noisy.
  const dupes = await Source.aggregate([
    { $match: { handle: { $exists: true } } },
    { $group: { _id: '$handle', n: { $sum: 1 }, names: { $push: '$name' } } },
    { $match: { n: { $gt: 1 } } },
    { $limit: 10 },
  ]);
  if (dupes.length > 0) {
    console.log(`\n${dupes.length} handle(s) with more than one row:`);
    for (const d of dupes) console.log(`   ${d._id}: ${d.names.join(' | ')}`);
  }

  const after = await Source.countDocuments({});
  console.log(`\n${after} sources remain`);
  await mongoose.disconnect();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
