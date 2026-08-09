#!/usr/bin/env tsx
/**
 * Find (and optionally fix) documents carrying more categories than the tagger
 * ever emits. The tagger returns at most 3; anything with 4+ is a leftover from
 * before `mergeInto` capped its union, so it can only come from history.
 *
 * Read-only by default. Run:
 *   npx tsx scripts/diag-overtagged.ts          report only
 *   npx tsx scripts/diag-overtagged.ts --fix    re-tag them with the LLM
 *   npx tsx scripts/diag-overtagged.ts --trim   just truncate to the first 3 (no LLM)
 */
import './load-env';
import mongoose from 'mongoose';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';
import { tagEvents } from '../lib/llm/tagger';

const FIX = process.argv.includes('--fix');
const TRIM = process.argv.includes('--trim');

async function main() {
  await connectDB();

  const docs = await Event.find({ 'category.3': { $exists: true } }).select(
    'title description venue onlineLink category tags isTechEvent tagConfidence'
  );

  console.log(`${docs.length} document(s) with 4+ categories`);
  for (const d of docs.slice(0, 12)) {
    console.log(
      `   conf=${String(d.tagConfidence ?? '(unset)').padEnd(7)} ${JSON.stringify(d.category)} ${d.title.slice(0, 34)}`
    );
  }

  if (docs.length === 0 || (!FIX && !TRIM)) {
    await mongoose.disconnect();
    return;
  }

  if (TRIM) {
    // No LLM call: keep the first three, which are the tagger's own ordering.
    for (const d of docs) {
      await Event.updateOne({ _id: d._id }, { $set: { category: d.category.slice(0, 3) } });
    }
    console.log(`Trimmed ${docs.length} document(s) to 3 categories`);
    await mongoose.disconnect();
    return;
  }

  const results = await tagEvents(
    docs.map(d => ({
      title: d.title,
      description: d.description,
      venue: d.venue,
      onlineLink: d.onlineLink,
      hints: d.tags,
    }))
  );

  for (let i = 0; i < docs.length; i++) {
    await Event.updateOne(
      { _id: docs[i]._id },
      {
        $set: {
          category: results[i].categories,
          isTechEvent: results[i].isTechEvent,
          tagConfidence: results[i].confidence,
        },
      }
    );
    console.log(`   fixed → ${results[i].categories.join(', ').padEnd(44)} ${docs[i].title.slice(0, 32)}`);
  }
  console.log(`Re-tagged ${docs.length}`);
  await mongoose.disconnect();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
