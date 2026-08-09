#!/usr/bin/env tsx
/**
 * READ-ONLY diagnostic — what does the feed actually contain, and how good is the
 * data? Writes nothing. Run: npx tsx scripts/diag-events.ts
 */
import './load-env';
import mongoose from 'mongoose';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';

const IST = 'Asia/Kolkata';

function fmt(d: Date | undefined | null): string {
  if (!d) return '(none)';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: IST,
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(d));
}

async function main() {
  await connectDB();
  const now = new Date();

  const total = await Event.countDocuments({});
  const upcoming = await Event.countDocuments({ startDateTime: { $gte: now } });
  const past = total - upcoming;

  console.log(`\nTotal ${total}   upcoming ${upcoming}   past ${past}\n`);

  const bySource = await Event.aggregate([
    { $match: { startDateTime: { $gte: now } } },
    { $group: { _id: '$source', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);
  console.log('Upcoming by source:');
  for (const row of bySource) console.log(`   ${String(row._id).padEnd(12)} ${row.count}`);

  const byCategory = await Event.aggregate([
    { $match: { startDateTime: { $gte: now } } },
    { $unwind: '$category' },
    { $group: { _id: '$category', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 15 },
  ]);
  console.log('\nTop categories (upcoming):');
  for (const row of byCategory) console.log(`   ${String(row._id).padEnd(24)} ${row.count}`);

  const byArea = await Event.aggregate([
    { $match: { startDateTime: { $gte: now }, area: { $ne: null } } },
    { $group: { _id: '$area', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 12 },
  ]);
  console.log('\nTop areas (upcoming):');
  for (const row of byArea) console.log(`   ${String(row._id).padEnd(24)} ${row.count}`);

  // Data-quality metrics — these are what the UI depends on.
  const q = async (filter: Record<string, unknown>) =>
    Event.countDocuments({ startDateTime: { $gte: now }, ...filter });

  console.log('\nField coverage (upcoming):');
  const metrics: Array<[string, Record<string, unknown>]> = [
    ['has image', { imageUrl: { $exists: true, $ne: null } }],
    ['has venue', { venue: { $exists: true, $ne: null } }],
    ['has area', { area: { $exists: true, $ne: null } }],
    ['has coords', { lat: { $exists: true, $ne: null } }],
    ['has organizer', { organizer: { $exists: true, $ne: null } }],
    ['has attendees', { attendeeCount: { $exists: true, $gt: 0 } }],
    ['is tech', { isTechEvent: true }],
    ['is free', { isFree: true }],
    ['multi-source', { 'seenInSources.1': { $exists: true } }],
  ];
  for (const [label, filter] of metrics) {
    const count = await q(filter);
    console.log(`   ${label.padEnd(16)} ${String(count).padStart(4)}  ${Math.round((count / Math.max(1, upcoming)) * 100)}%`);
  }

  // Real descriptions (not just the title repeated).
  const placeholder = await Event.countDocuments({
    startDateTime: { $gte: now },
    $expr: { $lte: [{ $strLenCP: '$description' }, { $add: [{ $strLenCP: '$title' }, 5] }] },
  });
  console.log(`   ${'real desc'.padEnd(16)} ${String(upcoming - placeholder).padStart(4)}  ${Math.round(((upcoming - placeholder) / Math.max(1, upcoming)) * 100)}%`);

  // Remaining duplicate clusters — dedup effectiveness.
  const dupes = await Event.aggregate([
    { $match: { startDateTime: { $gte: now } } },
    { $group: { _id: '$clusterKey', count: { $sum: 1 }, titles: { $push: '$title' }, sources: { $push: '$source' } } },
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 12 },
  ]);
  console.log(`\nRemaining duplicate clusters (upcoming): ${dupes.length}`);
  for (const d of dupes) {
    console.log(`   ${d.count}x [${[...new Set(d.sources)].join(',')}] ${String(d.titles[0]).slice(0, 56)}`);
  }

  const next = await Event.find({ startDateTime: { $gte: now } })
    .sort({ startDateTime: 1 })
    .limit(25)
    .select('title startDateTime source venue area category isTechEvent imageUrl')
    .lean();

  console.log('\nNext 25 upcoming:');
  for (const e of next) {
    const img = e.imageUrl ? 'img' : '   ';
    const tech = e.isTechEvent ? 'T' : ' ';
    console.log(
      `   ${fmt(e.startDateTime)} ${img} ${tech} [${String(e.source).padEnd(9)}] ${String(e.title).slice(0, 42).padEnd(42)} ${String(e.venue || e.area || '').slice(0, 22)}`
    );
  }

  await mongoose.disconnect();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
