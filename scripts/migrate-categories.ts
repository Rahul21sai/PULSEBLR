#!/usr/bin/env tsx
/**
 * Map stored events from the retired 32-category taxonomy onto the current 22.
 *
 * Uses `CATEGORY_MIGRATION` from the model, so the mapping lives in exactly one
 * place and this script cannot drift from it. No LLM calls and no re-scraping —
 * every retired value has a defined destination.
 *
 * Also re-derives `isTechEvent` from the migrated categories where the event was
 * only tech by virtue of a bucket that no longer counts as tech (Fintech became
 * Business/Finance, so a fintech sales mixer should stop being "tech").
 *
 * Usage:
 *   npx tsx scripts/migrate-categories.ts          apply
 *   npx tsx scripts/migrate-categories.ts --dry    report only
 */
import './load-env';
import mongoose from 'mongoose';
import connectDB from '../lib/mongodb';
import Event, {
  CATEGORY_MIGRATION,
  EVENT_CATEGORIES,
  TECH_CATEGORY_NAMES,
} from '../lib/models/Event';

const DRY = process.argv.includes('--dry');
const VALID = new Set<string>(EVENT_CATEGORIES);
const TECH = new Set<string>([...TECH_CATEGORY_NAMES, 'Hackathon']);

async function main() {
  await connectDB();

  const events = await Event.find({}).select('category isTechEvent tagConfidence').lean();
  console.log(`Migrating ${events.length} event(s)${DRY ? ' (dry run)' : ''}\n`);

  const moved = new Map<string, number>();
  let changed = 0;
  let techFlips = 0;
  let dropped = 0;

  for (const event of events) {
    const before: string[] = event.category || [];
    const after: string[] = [];

    for (const category of before) {
      const mapped = CATEGORY_MIGRATION[category] ?? category;
      if (mapped !== category) moved.set(`${category} → ${mapped}`, (moved.get(`${category} → ${mapped}`) || 0) + 1);
      // Anything still unknown after mapping is dropped rather than kept invalid —
      // the schema enum would reject the whole document on the next save.
      if (!VALID.has(mapped)) {
        dropped++;
        continue;
      }
      if (!after.includes(mapped)) after.push(mapped);
    }

    // De-duplication can empty or shrink the list; never leave an event uncategorised.
    const finalCategories = after.length > 0 ? after.slice(0, 3) : ['Other'];

    // An event that was tech only because of a retired bucket stops being tech.
    // Only recompute for LOW-confidence rows; a high-confidence LLM judgement that
    // an event is technical should survive a taxonomy rename.
    const derivedTech = finalCategories.some(c => TECH.has(c));
    const trustLlm = (event.tagConfidence ?? 0.6) >= 0.8;
    const nextTech = trustLlm ? event.isTechEvent : derivedTech;
    if (nextTech !== event.isTechEvent) techFlips++;

    if (before.join('|') !== finalCategories.join('|') || nextTech !== event.isTechEvent) {
      changed++;
      if (!DRY) {
        await Event.updateOne(
          { _id: event._id },
          { $set: { category: finalCategories, isTechEvent: nextTech } }
        );
      }
    }
  }

  console.log(`${changed} document(s) ${DRY ? 'would change' : 'updated'}`);
  console.log(`${techFlips} isTechEvent flip(s), ${dropped} unmappable value(s) dropped\n`);

  console.log('Category moves:');
  for (const [move, n] of [...moved.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(n).padStart(4)}  ${move}`);
  }

  if (!DRY) {
    const remaining = await Event.aggregate([
      { $unwind: '$category' },
      { $group: { _id: '$category', n: { $sum: 1 } } },
      { $sort: { n: -1 } },
    ]);
    const invalid = remaining.filter(r => !VALID.has(r._id));
    console.log(`\n${remaining.length} distinct categories in use; ${invalid.length} invalid`);
    if (invalid.length) console.log('   invalid:', invalid.map(r => `${r._id}(${r.n})`).join(', '));
  }

  await mongoose.disconnect();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
