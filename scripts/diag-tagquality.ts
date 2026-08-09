#!/usr/bin/env tsx
/** READ-ONLY: tagging-confidence distribution, to prove low-confidence passes
 *  can no longer overwrite LLM tags (see mergeInto in lib/scrapers/ingestion.ts). */
import './load-env';
import mongoose from 'mongoose';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';

async function main() {
  await connectDB();
  const rows = await Event.aggregate([
    { $group: { _id: '$tagConfidence', n: { $sum: 1 } } },
    { $sort: { _id: -1 } },
  ]);
  const total = rows.reduce((s, r) => s + r.n, 0);
  console.log('tagConfidence distribution:');
  for (const r of rows) {
    const label = r._id === null || r._id === undefined ? '(unset)' : String(r._id);
    const kind = r._id >= 0.8 ? 'LLM' : r._id === 0.6 ? 'keyword' : '';
    console.log(`   ${label.padEnd(9)} ${String(r.n).padStart(4)}  ${Math.round((r.n / total) * 100)}%  ${kind}`);
  }
  const keywordTagged = await Event.countDocuments({ tagConfidence: { $lte: 0.65 } });
  console.log(`\n${keywordTagged}/${total} still on keyword-quality tags`);
  await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
