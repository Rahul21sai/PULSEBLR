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
 *   npx tsx scripts/retag-events.ts --inconsistent  ONLY documents whose two "tech"
 *                                                   signals contradict each other
 *   npx tsx scripts/retag-events.ts --limit 100
 *   npx tsx scripts/retag-events.ts --dry
 *
 * ── WHY `--inconsistent` EXISTS, AND WHY IT IS USUALLY THE RIGHT FLAG ──────────────
 * A blanket re-tag is not free. Measured with scripts/diag-retag-preview.ts on 16 targeted
 * events: the current provider (NVIDIA llama-3.1-8b, because the IBM ICA key has expired)
 * corrected 7 wrong `isTechEvent` flags and broke none — but it consistently returns FEWER
 * categories than are stored. `Databricks Campus Hackathon` came back `[Data/Analytics]`
 * where it had held `[Hackathon, AI/ML, Data/Analytics]`, so re-tagging it would delete a
 * correct Event-type tag the filter rail depends on.
 *
 * So a `--all` run trades category richness across the whole corpus for flag accuracy on a
 * small slice of it. `--inconsistent` takes only the documents where the two independent
 * definitions of "tech" contradict each other — `isTechEvent`, which `techOnly` filters on,
 * versus membership of TECH_CATEGORY_NAMES, which the "Tech topic" rail counts. Those
 * documents are provably wrong in one direction or the other, so a narrower-but-correct tag
 * is a strict improvement; every consistent document keeps the tags it has.
 *
 * Note that re-tagging does NOT guarantee the two agree afterwards, and should not: a
 * hackathon with no topic category is legitimately `isTechEvent: true`.
 */
import './load-env';
import mongoose from 'mongoose';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';
import { tagEvents } from '../lib/llm/tagger';
import { TECH_CATEGORY_NAMES } from '../lib/event-types';

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const ALL = argv.includes('--all');
// Ongoing events (started, not finished) are the ones a start-date-only filter
// misses, and they're exactly where stale tags survived.
const ONGOING_ONLY = argv.includes('--ongoing');
const INCONSISTENT_ONLY = argv.includes('--inconsistent');
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

  /**
   * The two contradictions, as a Mongo predicate:
   *   A. carries a tech TOPIC but isTechEvent is not true → hidden from the default feed
   *      despite being on a tech subject.
   *   B. isTechEvent is true but carries NO tech topic → shown in the tech feed with nothing
   *      tech about its categories.
   */
  const TECH = [...TECH_CATEGORY_NAMES];
  const inconsistent = {
    $or: [
      { isTechEvent: { $ne: true }, category: { $in: TECH } },
      { isTechEvent: true, category: { $nin: TECH } },
    ],
  };

  const window_ = ALL
    ? {}
    : ONGOING_ONLY
      ? { startDateTime: { $lt: now }, endDateTime: { $gte: now } }
      : { $or: [{ startDateTime: { $gte: now } }, { endDateTime: { $gte: now } }] };

  // $and rather than a merged object: both halves use $or, and spreading them would silently
  // drop the first one.
  const filter = INCONSISTENT_ONLY
    ? (Object.keys(window_).length > 0 ? { $and: [window_, inconsistent] } : inconsistent)
    : window_;

  if (INCONSISTENT_ONLY) {
    console.log('Selecting only documents whose isTechEvent contradicts their tech categories.');
  }
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
