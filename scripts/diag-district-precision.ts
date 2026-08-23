#!/usr/bin/env tsx
/**
 * Did adding District cost tech precision?
 *
 * District is the CITY-BREADTH source: comedy, concerts, theatre, cultural festivals, runs.
 * It exists to serve "every Bengaluru event", and the whole safety argument for adding it is
 * that the feed defaults to `techOnly`, so a Sonu Nigam concert is ingested, classified
 * non-tech, and never seen by a user who has not opted out.
 *
 * That argument is only true if the classifier actually says non-tech. This checks it, and
 * prints every District row it DID flag tech so each one can be judged by eye rather than
 * trusted because an aggregate looked fine. A concert flagged tech is a precision regression
 * that would show up nowhere else.
 *
 * Read-only.
 *
 * Run: npx tsx scripts/diag-district-precision.ts
 */
import './load-env';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';
import mongoose from 'mongoose';

async function main() {
  await connectDB();
  const now = new Date();

  const total = await Event.countDocuments({});
  const upcoming = await Event.countDocuments({ startDateTime: { $gte: now } });
  const tech = await Event.countDocuments({ startDateTime: { $gte: now }, isTechEvent: true });
  console.log(`corpus ${total}  |  upcoming ${upcoming}  |  upcoming tech ${tech} (${Math.round((tech / (upcoming || 1)) * 100)}%)\n`);

  const bySource = await Event.aggregate([
    { $match: { startDateTime: { $gte: now } } },
    { $group: { _id: '$source', n: { $sum: 1 }, tech: { $sum: { $cond: ['$isTechEvent', 1, 0] } } } },
    { $sort: { n: -1 } },
  ]);
  console.log('upcoming by source:');
  for (const s of bySource) {
    console.log(`  ${String(s._id).padEnd(12)} ${String(s.n).padStart(5)}   tech ${String(s.tech).padStart(4)}`);
  }

  const rows = await Event.find(
    { source: 'district' },
    { title: 1, category: 1, isTechEvent: 1, connectionScore: 1, venue: 1, startDateTime: 1 }
  ).lean();

  const flagged = rows.filter(r => r.isTechEvent);
  console.log(`\ndistrict rows ${rows.length}  |  flagged tech ${flagged.length}`);

  console.log('\nflagged TECH — every one must be defensible:');
  if (flagged.length === 0) console.log('  (none)');
  for (const r of flagged) {
    console.log(
      `  score ${String(r.connectionScore ?? '-').padStart(3)}  ${String(r.title).slice(0, 56).padEnd(56)} [${(r.category || []).join(', ')}]`
    );
  }

  console.log('\nnot flagged tech — a sample, to confirm the classifier is not just saying no to everything:');
  for (const r of rows.filter(x => !x.isTechEvent).slice(0, 10)) {
    console.log(
      `  score ${String(r.connectionScore ?? '-').padStart(3)}  ${String(r.title).slice(0, 56).padEnd(56)} [${(r.category || []).join(', ')}]`
    );
  }

  // Distribution of categories District contributed, which is the "breadth" claim made concrete.
  const catCounts = new Map<string, number>();
  for (const r of rows) for (const c of r.category || []) catCounts.set(c, (catCounts.get(c) ?? 0) + 1);
  console.log('\ncategories District contributed:');
  for (const [c, n] of [...catCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${c}`);
  }

  await mongoose.disconnect();
}

main().catch(async e => {
  console.error(e);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
