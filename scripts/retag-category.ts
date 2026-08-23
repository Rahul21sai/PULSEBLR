#!/usr/bin/env tsx
/**
 * Re-tag every event carrying ONE named category, REPLACING its categories.
 *
 * Sibling of retag-events.ts, which selects by time window or by the isTechEvent/category
 * contradiction. Neither can express "this specific category has gone bad", which is the case
 * that actually keeps arising: a keyword regex or a prompt line is sharpened, and the documents
 * the old version mis-tagged need re-deciding — but only those. Re-tagging the whole corpus to
 * fix one category costs richness everywhere (see the header of retag-events.ts).
 *
 * First use: `Gaming/XR`. Measured with diag-gamingxr-leak.ts, all 7 upcoming events tagged
 * Gaming/XR were mis-tags and ZERO were games engineering — the category had become the bin the
 * classifier reached for when unsure, and because it sits in TECH_CATEGORY_NAMES it put a DJ
 * night, a design-thinking workshop and a board-game meetup into the default tech feed.
 *
 * Usage:
 *   npx tsx scripts/retag-category.ts "Gaming/XR" --dry
 *   npx tsx scripts/retag-category.ts "Gaming/XR"
 *   npx tsx scripts/retag-category.ts "Gaming/XR" --all     include past events
 */
import './load-env';
import mongoose from 'mongoose';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';
import { tagEvents } from '../lib/llm/tagger';
import { EVENT_CATEGORIES } from '../lib/event-types';

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const ALL = argv.includes('--all');
const CATEGORY = argv.find(a => !a.startsWith('--'));

const CHUNK = 25;

async function main() {
  if (!CATEGORY) {
    console.error('usage: retag-category.ts "<Category>" [--dry] [--all]');
    console.error(`categories: ${EVENT_CATEGORIES.join(', ')}`);
    process.exit(1);
  }
  if (!(EVENT_CATEGORIES as readonly string[]).includes(CATEGORY)) {
    console.error(`"${CATEGORY}" is not a category. Valid: ${EVENT_CATEGORIES.join(', ')}`);
    process.exit(1);
  }

  await connectDB();
  const now = new Date();

  const filter = {
    category: CATEGORY,
    ...(ALL ? {} : { $or: [{ startDateTime: { $gte: now } }, { endDateTime: { $gte: now } }] }),
  };

  const events = await Event.find(filter).select(
    'title description venue onlineLink category tags isTechEvent hasFood format'
  );

  console.log(`Re-tagging ${events.length} event(s) carrying "${CATEGORY}"${DRY ? ' (dry run)' : ''}\n`);

  let changed = 0;
  let stillHas = 0;
  let techFlips = 0;

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

      const oldCats = event.category.join(', ');
      const newCats = tagged.categories.join(', ');
      const catsChanged = oldCats !== newCats;
      const techChanged = event.isTechEvent !== tagged.isTechEvent;
      if (techChanged) techFlips++;
      if (tagged.categories.includes(CATEGORY)) stillHas++;

      console.log(
        `  ${catsChanged || techChanged ? '~' : ' '} ${String(event.title).slice(0, 46).padEnd(46)}`
      );
      console.log(`      old tech=${event.isTechEvent}  [${oldCats}]`);
      console.log(`      new tech=${tagged.isTechEvent}  [${newCats}]`);

      if (!catsChanged && !techChanged) continue;
      if (!DRY) {
        await Event.updateOne(
          { _id: event._id },
          {
            $set: {
              category: tagged.categories,
              isTechEvent: tagged.isTechEvent,
              tagConfidence: tagged.confidence,
              ...(event.hasFood === 'unknown' && tagged.hasFood !== 'unknown'
                ? { hasFood: tagged.hasFood }
                : {}),
            },
          }
        );
      }
      changed++;
    }
  }

  console.log(`\nDone: ${changed}/${events.length} changed, ${techFlips} tech-flag flip(s)`);
  console.log(`  ${stillHas} still carry "${CATEGORY}" — those are the ones the sharpened rule accepts`);
  await mongoose.disconnect();
}

main().catch(async e => {
  console.error(e);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
