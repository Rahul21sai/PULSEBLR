#!/usr/bin/env tsx
/**
 * The attendance-seed run produced visible same-title pairs in the feed
 * ("Bangalore Iceberg Community Meetup", "n8n Bangalore: Founders & Builders Mixer",
 * "Aarambha - Bengaluru Tech Week 2026 Kickoff"). clusterKey exists precisely to
 * collapse those across sources, so either the keys differ or the merge path is not
 * being reached.
 *
 * This prints the full dedup identity of each member of a suspected pair so the cause
 * is visible rather than guessed.
 *
 * Read-only.
 *
 * Run: npx tsx scripts/diag-seed-dupes.ts
 */
import './load-env';
import mongoose from 'mongoose';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';

const SUSPECTS = [
  /iceberg community meetup/i,
  /n8n bangalore/i,
  /aarambha/i,
  /uipath maestro/i,
];

async function main() {
  await connectDB();
  const now = new Date();

  for (const re of SUSPECTS) {
    const docs = await Event.find({ startDateTime: { $gte: now }, title: re })
      .select('title source sourceUrl startDateTime clusterKey dedupHash connectionScore isTechEvent category seenInSources lastSeenAt createdAt')
      .sort({ startDateTime: 1 })
      .lean();

    console.log('='.repeat(96));
    console.log(`${re}  →  ${docs.length} document(s)`);
    for (const d of docs) {
      console.log(`  title      : ${d.title}`);
      console.log(`  source     : ${d.source}   seenIn=${JSON.stringify(d.seenInSources || [])}`);
      console.log(`  start      : ${d.startDateTime.toISOString()}`);
      console.log(`  clusterKey : ${JSON.stringify(d.clusterKey)}`);
      console.log(`  dedupHash  : ${String(d.dedupHash).slice(0, 20)}…`);
      console.log(`  score/tech : ${d.connectionScore ?? 'MISSING'} / ${d.isTechEvent}`);
      console.log(`  categories : ${JSON.stringify(d.category)}`);
      console.log(`  created    : ${d.createdAt ? new Date(d.createdAt).toISOString() : '?'}`);
      console.log('  ---');
    }
    if (docs.length > 1) {
      const keys = new Set(docs.map(d => d.clusterKey));
      const days = new Set(docs.map(d => d.startDateTime.toISOString().slice(0, 10)));
      console.log(`  VERDICT: ${keys.size} distinct clusterKey(s), ${days.size} distinct UTC day(s)`);
      if (keys.size > 1) {
        console.log('  => the keys DIFFER, so clustering never had a chance. Compare them above.');
      } else {
        console.log('  => same clusterKey but two documents: the merge path failed.');
      }
    }
  }

  // Corpus-wide: how common is this?
  const clusters = await Event.aggregate([
    { $match: { startDateTime: { $gte: now } } },
    { $group: { _id: '$clusterKey', n: { $sum: 1 }, titles: { $push: '$title' } } },
    { $match: { n: { $gt: 1 } } },
    { $sort: { n: -1 } },
  ]);
  console.log('\n' + '='.repeat(96));
  console.log(`Upcoming documents sharing a clusterKey: ${clusters.length} cluster(s)`);
  for (const c of clusters.slice(0, 8)) {
    console.log(`  ${c.n}x  ${String(c.titles[0]).slice(0, 66)}`);
  }

  // And near-duplicates that clustering cannot see: same IST day, same normalized title
  // prefix but a different key (the case above).
  const sameDayTitle = await Event.aggregate([
    { $match: { startDateTime: { $gte: now } } },
    {
      $group: {
        _id: { t: { $toLower: '$title' }, d: { $dateToString: { format: '%Y-%m-%d', date: '$startDateTime', timezone: 'Asia/Kolkata' } } },
        n: { $sum: 1 },
        keys: { $addToSet: '$clusterKey' },
        sources: { $addToSet: '$source' },
      },
    },
    { $match: { n: { $gt: 1 } } },
    { $sort: { n: -1 } },
  ]);
  console.log(`\nIdentical title + same IST day: ${sameDayTitle.length} group(s)`);
  for (const g of sameDayTitle.slice(0, 12)) {
    console.log(`  ${g.n}x  ${String(g._id.t).slice(0, 58).padEnd(58)} keys=${g.keys.length} src=${g.sources.join(',')}`);
  }

  await mongoose.disconnect();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
