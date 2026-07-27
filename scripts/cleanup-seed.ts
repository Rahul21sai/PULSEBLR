#!/usr/bin/env tsx
/**
 * DESTRUCTIVE cleanup — deletes the hand-written SEED stubs only.
 *
 * User-approved (2026-07-27): remove the demo/prepopulated events so the app
 * shows only real scraped events. Matches ONLY the exact dedupHashes minted by
 * scripts/seed.ts (`*-blr-001`), so scraped events (luma/meetup/devfolio) can
 * never be caught by this filter. Re-run scripts/seed.ts to restore them.
 *
 * Run: npx tsx scripts/cleanup-seed.ts
 */
import './load-env';
import mongoose from 'mongoose';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';

const SEED_DEDUP_HASHES = [
  'llm-workshop-blr-001', 'upi-mixer-blr-001', 'founders-funders-blr-001',
  'aws-watch-party-blr-001', 'react-nextjs-blr-001', 'ctf-blr-001',
  'data-summit-blr-001', 'nvidia-nim-hack-blr-001',
];

async function main() {
  await connectDB();
  const seedFilter = { dedupHash: { $in: SEED_DEDUP_HASHES } };

  const doomed = await Event.find(seedFilter).select('title dedupHash source').lean();
  console.log(`\n🗑️  Deleting ${doomed.length} seed stubs:\n`);
  for (const e of doomed) {
    console.log(`   • [${e.source}] ${e.title.slice(0, 55)}  (${e.dedupHash})`);
  }

  // Safety assertion: refuse to run if any matched doc is NOT source 'manual'.
  const nonManual = doomed.filter(e => e.source !== 'manual');
  if (nonManual.length > 0) {
    console.error(`\n❌ ABORT: ${nonManual.length} matched doc(s) are not source:'manual'. Not deleting.`);
    await mongoose.disconnect();
    process.exit(1);
  }

  const res = await Event.deleteMany(seedFilter);
  const remaining = await Event.countDocuments({});

  console.log('\n' + '═'.repeat(70));
  console.log(`✅ Deleted: ${res.deletedCount}`);
  console.log(`📊 Events remaining in DB: ${remaining}`);
  console.log('═'.repeat(70) + '\n');

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(e => { console.error('❌', e); process.exit(1); });
