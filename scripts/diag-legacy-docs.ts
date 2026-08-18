#!/usr/bin/env tsx
/**
 * How much of the corpus was written by OLD code, and when?
 *
 * The attendance-seed run surfaced visible duplicate cards. The cause is not the new
 * seeds: one member of each pair has no clusterKey, no connectionScore, and categories
 * from the RETIRED 32-value taxonomy ("Networking/Meetup"). Those fields were all in
 * place before this run, so something else is still writing pre-migration documents.
 *
 * The prime suspect is .github/workflows/daily-scrape.yml, which runs `npm run scrape`
 * from the DEFAULT branch every morning. All of this project's work lives on a feature
 * branch that has never been pushed, so the cron has been running months-old scraper
 * code against the same Atlas database.
 *
 * This groups the damage by creation date to confirm or refute that.
 *
 * Read-only.
 *
 * Run: npx tsx scripts/diag-legacy-docs.ts
 */
import './load-env';
import mongoose from 'mongoose';
import connectDB from '../lib/mongodb';
import Event, { EVENT_CATEGORIES } from '../lib/models/Event';

async function main() {
  await connectDB();
  const valid = new Set<string>(EVENT_CATEGORIES as unknown as string[]);

  const missingKey = {
    $or: [{ clusterKey: { $exists: false } }, { clusterKey: null }, { clusterKey: '' }],
  };

  const noKey = await Event.countDocuments(missingKey);
  const noScore = await Event.countDocuments({ connectionScore: { $exists: false } });
  const noTech = await Event.countDocuments({ isTechEvent: { $exists: false } });
  console.log(`missing clusterKey     : ${noKey}`);
  console.log(`missing connectionScore: ${noScore}`);
  console.log(`missing isTechEvent    : ${noTech}`);

  const cats = await Event.aggregate([
    { $unwind: '$category' },
    { $group: { _id: '$category', n: { $sum: 1 } } },
    { $sort: { n: -1 } },
  ]);
  const retired = cats.filter(c => !valid.has(c._id));
  console.log(
    `\nretired/invalid categories still stored: ${retired.length ? retired.map(r => `${r._id}=${r.n}`).join(', ') : 'none'}`
  );

  // When were the damaged documents created? This is the decisive evidence.
  const byDay = await Event.aggregate([
    { $match: missingKey },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'Asia/Kolkata' } },
        n: { $sum: 1 },
        sources: { $addToSet: '$source' },
      },
    },
    { $sort: { _id: 1 } },
  ]);
  console.log('\nclusterKey-less documents by creation date (IST):');
  for (const d of byDay) {
    console.log(`   ${d._id}  ${String(d.n).padStart(4)}  sources=${d.sources.join(',')}`);
  }

  // For contrast: when was the healthy majority created?
  const healthyByDay = await Event.aggregate([
    { $match: { clusterKey: { $exists: true, $nin: [null, ''] } } },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'Asia/Kolkata' } },
        n: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);
  console.log('\nhealthy documents by creation date (IST):');
  for (const d of healthyByDay) console.log(`   ${d._id}  ${String(d.n).padStart(4)}`);

  await mongoose.disconnect();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
