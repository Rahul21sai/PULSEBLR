#!/usr/bin/env tsx
/**
 * Backfill events written before the schema gained clusterKey / lastSeenAt /
 * isTechEvent / tags / seenInSources.
 *
 * Why backfill instead of dropping the collection: TrackerEntry documents hold
 * ObjectId references to these events, so wiping them would silently empty every
 * user's tracker. And without a clusterKey, an old event can never match an
 * incoming scrape — the next run would insert a second copy of every event that
 * is still live upstream.
 *
 * Idempotent. Run: npx tsx scripts/migrate-events.ts [--dry]
 */
import './load-env';
import mongoose from 'mongoose';
import connectDB from '../lib/mongodb';
import Event, { EVENT_CATEGORIES } from '../lib/models/Event';
import { keywordTagging } from '../lib/llm/tagger';

const DRY = process.argv.includes('--dry');

/** Categories that no longer exist in the widened taxonomy, mapped forward. */
const CATEGORY_REMAP: Record<string, string> = {
  'Web/Mobile': 'Web/Mobile',
  'Data/Analytics': 'Data/Analytics',
  Corporate: 'Corporate',
  Government: 'Government',
  // The old taxonomy had no equivalents for these; keep them valid.
  'Summit/Conference': 'Summit/Conference',
  'Networking/Meetup': 'Networking/Meetup',
  'Career/Job Fair': 'Career/Job Fair',
};

const VALID = new Set<string>(EVENT_CATEGORIES);

async function main() {
  await connectDB();

  const total = await Event.countDocuments({});
  const needing = await Event.find({
    $or: [
      { clusterKey: { $exists: false } },
      { lastSeenAt: { $exists: false } },
      { isTechEvent: { $exists: false } },
      { seenInSources: { $exists: false } },
      { tags: { $exists: false } },
    ],
  });

  console.log(`${total} events in DB; ${needing.length} need backfill${DRY ? ' (dry run)' : ''}`);

  let updated = 0;
  let categoriesFixed = 0;

  for (const event of needing) {
    const clusterKey = Event.generateClusterKey(event.title, event.startDateTime);

    // Old docs may carry categories dropped from the enum; remap or re-derive so
    // the document stays saveable under the new schema.
    let category = (event.category || []).map(c => CATEGORY_REMAP[c] || c).filter(c => VALID.has(c));
    if (category.length === 0) {
      category = keywordTagging({ title: event.title, description: event.description }).categories;
      categoriesFixed++;
    }

    const tech = keywordTagging({
      title: event.title,
      description: event.description,
    }).isTechEvent;

    if (DRY) {
      updated++;
      continue;
    }

    await Event.updateOne(
      { _id: event._id },
      {
        $set: {
          clusterKey,
          category,
          tags: event.tags || [],
          // Existing events were last confirmed at their creation time; using
          // "now" would make every stale event look freshly seen and defeat pruning.
          lastSeenAt: event.updatedAt || event.createdAt || new Date(),
          seenInSources: event.seenInSources?.length ? event.seenInSources : [event.source],
          isTechEvent: event.isTechEvent ?? tech,
        },
      }
    );
    updated++;
  }

  console.log(`Backfilled ${updated} events (${categoriesFixed} had categories re-derived)`);

  // Remove seed stubs and vendor demo records that were only ever placeholders.
  const junkFilter = {
    $or: [
      { dedupHash: { $regex: '^(llm-workshop|upi-mixer|founders-funders|aws-watch-party|react-nextjs|ctf-blr|data-summit|nvidia-nim-hack)' } },
      { title: { $regex: '\\b(demo|fake)\\b', $options: 'i' }, source: 'devfolio' },
    ],
  };
  const junkCount = await Event.countDocuments(junkFilter);
  if (junkCount > 0) {
    console.log(`${junkCount} seed/demo stub(s) found`);
    if (!DRY) {
      const outcome = await Event.deleteMany(junkFilter);
      console.log(`Deleted ${outcome.deletedCount} stub(s)`);
    }
  }

  // Report duplicate clusters so we can see whether dedup will collapse them.
  const clusters = await Event.aggregate([
    { $group: { _id: '$clusterKey', count: { $sum: 1 }, titles: { $push: '$title' } } },
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 10 },
  ]);
  if (clusters.length > 0) {
    console.log(`\n${clusters.length} duplicate cluster(s) present from before dedup:`);
    for (const cluster of clusters) {
      console.log(`   ${cluster.count}x  ${String(cluster.titles[0]).slice(0, 60)}`);
    }
    console.log('   (these collapse as the scraper re-sees them; safe to leave)');
  }

  await mongoose.disconnect();
}

main().catch(error => {
  console.error('Migration failed:', error);
  process.exit(1);
});
