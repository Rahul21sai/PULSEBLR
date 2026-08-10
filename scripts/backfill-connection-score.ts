#!/usr/bin/env tsx
/**
 * Compute `connectionScore` for every stored event.
 *
 * The score is derived data — it depends only on fields already stored — so it can
 * always be recomputed without re-scraping. Run this after editing
 * lib/events/connection-score.ts.
 *
 * Usage:
 *   npx tsx scripts/backfill-connection-score.ts          apply
 *   npx tsx scripts/backfill-connection-score.ts --dry    report only
 */
import './load-env';
import mongoose from 'mongoose';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';
import { connectionScore, connectionTier } from '../lib/events/connection-score';

const DRY = process.argv.includes('--dry');

async function main() {
  await connectDB();

  // `.lean()` matters here. A hydrated Mongoose document fills missing paths with
  // the schema default (20), so a document that has NO stored connectionScore reads
  // back as 20 — and if the computed score is also 20, the "unchanged" check skips
  // it and the field is never actually written. Those documents then sort first
  // under an ascending sort as `undefined`. Reading lean shows the true stored value.
  const events = await Event.find({})
    .select(
      'title format hasFood attendeeCount capacity category companies organizer isFree price isTechEvent startDateTime connectionScore'
    )
    .lean();
  console.log(`Scoring ${events.length} event(s)${DRY ? ' (dry run)' : ''}\n`);

  const tiers = { high: 0, medium: 0, low: 0 };
  let changed = 0;

  for (const event of events) {
    const score = connectionScore({
      format: event.format,
      hasFood: event.hasFood,
      attendeeCount: event.attendeeCount,
      capacity: event.capacity,
      category: event.category,
      companies: event.companies,
      organizer: event.organizer,
      title: event.title,
      isFree: event.isFree,
      price: event.price,
    });
    tiers[connectionTier(score)]++;

    // Write when the value differs OR when the field is absent entirely.
    if (event.connectionScore !== score || event.connectionScore === undefined) {
      changed++;
      if (!DRY) await Event.updateOne({ _id: event._id }, { $set: { connectionScore: score } });
    }
  }

  console.log(`${changed} document(s) ${DRY ? 'would change' : 'updated'}`);
  console.log(`tiers: high ${tiers.high} · medium ${tiers.medium} · low ${tiers.low}\n`);

  // The list that matters: the best TECH events for meeting people.
  const now = new Date();
  const best = await Event.find({ isTechEvent: true, startDateTime: { $gte: now } })
    .sort({ connectionScore: -1, startDateTime: 1 })
    .limit(15)
    .select('title connectionScore format hasFood attendeeCount organizer companies startDateTime')
    .lean();

  console.log('Top 15 tech events for connections:');
  for (const e of best) {
    const bits = [
      e.format === 'offline' ? 'in-person' : e.format,
      e.attendeeCount ? `${e.attendeeCount} going` : null,
      e.hasFood === 'yes' ? 'food' : null,
      (e.companies || []).length ? (e.companies || []).join('/') : null,
    ].filter(Boolean);
    console.log(
      `  ${String(e.connectionScore).padStart(3)}  ${String(e.title).slice(0, 48).padEnd(48)} ${bits.join(' · ')}`
    );
  }

  const worst = await Event.find({ isTechEvent: true, startDateTime: { $gte: now } })
    .sort({ connectionScore: 1 })
    .limit(6)
    .select('title connectionScore format')
    .lean();
  console.log('\nLowest-scoring tech events (should be webinars / paid courses):');
  for (const e of worst) {
    console.log(`  ${String(e.connectionScore).padStart(3)}  [${e.format}] ${String(e.title).slice(0, 52)}`);
  }

  await mongoose.disconnect();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
