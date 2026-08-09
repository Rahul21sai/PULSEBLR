#!/usr/bin/env tsx
/**
 * Verify LLM tagging against REAL events pulled from the database — the same
 * long descriptions and odd titles the pipeline actually sees. A synthetic
 * short-prompt test passed while the real run fell back to keywords for 832 of
 * 840 events, so this reads live rows instead.
 *
 * Read-only. Run: npx tsx scripts/test-tagging.ts [count]
 */
import './load-env';
import mongoose from 'mongoose';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';
import { tagEvents, keywordTagging } from '../lib/llm/tagger';

async function main() {
  const count = Number(process.argv[2] || 20);
  await connectDB();

  const events = await Event.find({ startDateTime: { $gte: new Date() } })
    .sort({ startDateTime: 1 })
    .limit(count)
    .select('title description venue onlineLink category isTechEvent')
    .lean();

  console.log(`\nTagging ${events.length} real events…\n`);
  const started = Date.now();
  const results = await tagEvents(
    events.map(e => ({
      title: e.title,
      description: e.description,
      venue: e.venue,
      onlineLink: e.onlineLink,
    }))
  );
  const ms = Date.now() - started;

  let changed = 0;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const llm = results[i];
    const kw = keywordTagging({ title: e.title, description: e.description, venue: e.venue });
    const differs = llm.categories.join('|') !== kw.categories.join('|');
    if (differs) changed++;
    console.log(`${e.title.slice(0, 44).padEnd(44)}`);
    console.log(`   llm      ${llm.categories.join(', ').padEnd(46)} tech=${llm.isTechEvent} conf=${llm.confidence}`);
    console.log(`   keyword  ${kw.categories.join(', ').padEnd(46)} tech=${kw.isTechEvent}`);
  }

  console.log(`\n${ms}ms total, ${Math.round(ms / Math.max(1, events.length))}ms/event`);
  console.log(`${changed}/${events.length} differ from keyword tagging (higher = LLM is contributing)`);
  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
