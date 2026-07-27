#!/usr/bin/env tsx
/**
 * READ-ONLY diagnostic — what does /api/events actually return, and which docs
 * are seed stubs vs scraped? Deletes/writes nothing. Run: npx tsx scripts/diag-events.ts
 */
import './load-env';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';

const SEED_DEDUP_HASHES = [
  'llm-workshop-blr-001', 'upi-mixer-blr-001', 'founders-funders-blr-001',
  'aws-watch-party-blr-001', 'react-nextjs-blr-001', 'ctf-blr-001',
  'data-summit-blr-001', 'nvidia-nim-hack-blr-001',
];

function fmt(d: Date | undefined | null): string {
  return d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '(none)';
}

async function main() {
  await connectDB();
  const now = new Date();
  console.log(`\n⏰ now = ${now.toISOString()}\n`);

  const total = await Event.countDocuments({});
  console.log(`📊 Total events in DB: ${total}`);

  // Count by source
  const bySource = await Event.aggregate([
    { $group: { _id: '$source', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);
  console.log('\nBy source:');
  for (const s of bySource) console.log(`   ${s._id.padEnd(10)} ${s.count}`);

  // What the homepage sees: upcoming only, sorted ascending, limit 50
  const upcoming = await Event.find({ startDateTime: { $gte: now } })
    .sort({ startDateTime: 1 })
    .limit(50)
    .select('title startDateTime source dedupHash category')
    .lean();

  console.log(`\n🔮 UPCOMING (what /api/events returns by default): ${upcoming.length}`);
  console.log('─'.repeat(90));
  for (const e of upcoming) {
    const seed = SEED_DEDUP_HASHES.includes(e.dedupHash) ? '🌱SEED' : '      ';
    console.log(`   ${seed} ${fmt(e.startDateTime)} [${String(e.source).padEnd(8)}] ${String(e.title).slice(0, 45)}`);
  }

  // Past events (invisible on homepage)
  const past = await Event.find({ startDateTime: { $lt: now } })
    .sort({ startDateTime: 1 })
    .select('title startDateTime source dedupHash')
    .lean();
  console.log(`\n🕰️  PAST (hidden from homepage): ${past.length}`);
  for (const e of past) {
    const seed = SEED_DEDUP_HASHES.includes(e.dedupHash) ? '🌱SEED' : '      ';
    console.log(`   ${seed} ${fmt(e.startDateTime)} [${String(e.source).padEnd(8)}] ${String(e.title).slice(0, 45)}`);
  }

  await (await import('mongoose')).default.disconnect();
  process.exit(0);
}

main().catch(e => { console.error('❌', e); process.exit(1); });
