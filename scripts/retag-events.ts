#!/usr/bin/env tsx
/**
 * Re-tag events already in the database with the LLM, REPLACING their categories.
 *
 * Why a separate script rather than letting the next scrape fix it: ingestion
 * deliberately UNIONS categories when it re-sees an event, so multi-source coverage
 * is additive. That also means a bad tag can never be removed by scraping — and the
 * corpus was seeded with keyword tags from runs where the LLM was misconfigured
 * (plus a regex bug that read the "PM" in "6 PM" as Product/Design). Fixing that
 * needs an explicit replace.
 *
 * Usage:
 *   npx tsx scripts/retag-events.ts               everything the feed can show
 *   npx tsx scripts/retag-events.ts --ongoing     only in-progress events
 *   npx tsx scripts/retag-events.ts --all         past events too
 *   npx tsx scripts/retag-events.ts --limit 100
 *   npx tsx scripts/retag-events.ts --dry
 */
import './load-env';
import mongoose from 'mongoose';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';
import { tagEvents } from '../lib/llm/tagger';

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const ALL = argv.includes('--all');
// Ongoing events (started, not finished) are the ones a start-date-only filter
// misses, and they're exactly where stale tags survived.
const ONGOING_ONLY = argv.includes('--ongoing');
const limitArg = argv.indexOf('--limit');
const LIMIT = limitArg >= 0 ? Number(argv[limitArg + 1]) : 0;

/** Process in chunks so a long run reports progress and can be interrupted safely. */
const CHUNK = 40;

async function main() {
  await connectDB();

  // "Upcoming" must mean the same thing here as it does in the feed, which shows
  // in-progress events too. Filtering on startDateTime alone skipped exactly the
  // ongoing occurrences of recurring events — they kept stale tags while their
  // later occurrences got correct ones, so the same event appeared twice in the
  // feed with contradictory categories.
  const now = new Date();
  const filter = ALL
    ? {}
    : ONGOING_ONLY
      ? { startDateTime: { $lt: now }, endDateTime: { $gte: now } }
      : { $or: [{ startDateTime: { $gte: now } }, { endDateTime: { $gte: now } }] };
  let query = Event.find(filter)
    .sort({ startDateTime: 1 })
    .select('title description venue onlineLink category tags isTechEvent hasFood format');
  if (LIMIT > 0) query = query.limit(LIMIT);

  const events = await query;
  console.log(`Re-tagging ${events.length} event(s)${DRY ? ' (dry run)' : ''}\n`);

  let updated = 0;
  let techFlipped = 0;
  let processed = 0;

  for (let offset = 0; offset < events.length; offset += CHUNK) {
    const chunk = events.slice(offset, offset + CHUNK);
    const results = await tagEvents(
      chunk.map(e => ({
        title: e.title,
        description: e.description,
        venue: e.venue,
        onlineLink: e.onlineLink,
        hints: e.tags,
      }))
    );

    for (let i = 0; i < chunk.length; i++) {
      const event = chunk[i];
      const tagged = results[i];
      processed++;

      const categoriesChanged =
        event.category.join('|') !== tagged.categories.join('|');
      const techChanged = event.isTechEvent !== tagged.isTechEvent;
      if (techChanged) techFlipped++;
      if (!categoriesChanged && !techChanged) continue;

      if (!DRY) {
        await Event.updateOne(
          { _id: event._id },
          {
            $set: {
              category: tagged.categories,
              isTechEvent: tagged.isTechEvent,
              // Record the confidence too, otherwise the next scrape sees these
              // as low-confidence and unions keyword tags back in.
              tagConfidence: tagged.confidence,
              // Only upgrade food away from "unknown"; the LLM saying "unknown"
              // shouldn't erase a source that positively reported catering.
              ...(event.hasFood === 'unknown' && tagged.hasFood !== 'unknown'
                ? { hasFood: tagged.hasFood }
                : {}),
            },
          }
        );
      }
      updated++;
    }

    console.log(
      `  ${processed}/${events.length} processed, ${updated} changed, ${techFlipped} tech-flag flips`
    );
  }

  console.log(`\nDone: ${updated}/${events.length} event(s) re-tagged`);
  await mongoose.disconnect();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
