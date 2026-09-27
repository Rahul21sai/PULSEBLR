#!/usr/bin/env tsx
/**
 * Why does "Great International Developer Summit (GIDS)" render twice in the default feed?
 *
 * Prints every identity-relevant field of every GIDS row, then measures the class:
 *   1. upcoming `devevents` rows starting at exactly 00:00:00.000Z (a date stored as UTC midnight,
 *      which renders as a 05:30 IST "start" nobody announced);
 *   2. every upcoming scraped row that has a NEAR-TWIN — same normalized title, a different
 *      source, start within ±1 IST day — which the exact `clusterKey` cannot collapse.
 *
 * Read-only. Run: npx tsx --tsconfig tsconfig.json scripts/diag-gids-dupe.ts
 */
import './load-env';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';
import mongoose from 'mongoose';
import { normalizeTitleForMatch } from '../lib/scrapers/core/text';
import { dayKeyIST } from '../lib/format';

const ist = (d?: Date | null) =>
  d ? new Date(d).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false }) : '-';

type Row = {
  _id: unknown; title: string; source: string; startDateTime: Date; endDateTime?: Date;
  clusterKey: string; dedupHash: string; seenInSources?: string[]; organizer?: string;
  venue?: string; city?: string; sourceUrl?: string; createdByUserId?: string;
};

async function main() {
  await connectDB();
  const fields =
    'title source startDateTime endDateTime clusterKey dedupHash seenInSources organizer venue city sourceUrl createdByUserId';

  console.log('── 1. Every GIDS row ─────────────────────────────────────────────');
  const gids = await Event.find({ title: /great international developer summit|\bgids\b/i })
    .select(fields)
    .lean<Row[]>();
  for (const r of gids) {
    console.log({
      _id: String(r._id),
      source: r.source,
      title: r.title,
      normalized: normalizeTitleForMatch(r.title),
      startUTC: new Date(r.startDateTime).toISOString(),
      startIST: ist(r.startDateTime),
      endUTC: r.endDateTime ? new Date(r.endDateTime).toISOString() : '-',
      endIST: ist(r.endDateTime),
      clusterKey: r.clusterKey,
      dedupHash: r.dedupHash?.slice(0, 16),
      seenInSources: r.seenInSources,
      organizer: r.organizer,
      venue: r.venue,
      city: r.city,
      sourceUrl: r.sourceUrl,
      owned: Boolean(r.createdByUserId),
    });
  }

  const now = new Date();
  const upcoming = await Event.find({
    createdByUserId: { $exists: false },
    $or: [{ startDateTime: { $gte: now } }, { endDateTime: { $gte: now } }],
  })
    .select(fields)
    .lean<Row[]>();

  console.log('\n── 2. Upcoming devevents rows at exactly 00:00:00.000Z ────────────');
  const dev = upcoming.filter(r => r.source === 'devevents');
  const midnight = dev.filter(r => new Date(r.startDateTime).toISOString().endsWith('T00:00:00.000Z'));
  console.log(`devevents upcoming: ${dev.length}, at UTC midnight: ${midnight.length}`);
  for (const r of dev) {
    console.log(`  ${new Date(r.startDateTime).toISOString()}  ${ist(r.startDateTime)}  ${r.title}`);
  }

  console.log('\n── 3. Near-twins: same normalized title, other source, within ±1 IST day ──');
  const byTitle = new Map<string, Row[]>();
  for (const r of upcoming) {
    const k = normalizeTitleForMatch(r.title);
    byTitle.set(k, [...(byTitle.get(k) || []), r]);
  }
  const dayMs = (d: Date) => Date.parse(`${dayKeyIST(d)}T00:00:00Z`);
  let pairs = 0;
  for (const [k, rows] of byTitle) {
    if (rows.length < 2) continue;
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const a = rows[i], b = rows[j];
        if (a.source === b.source) continue;
        const gap = Math.abs(dayMs(a.startDateTime) - dayMs(b.startDateTime)) / 86_400_000;
        if (gap > 1) continue;
        pairs++;
        console.log(`  [${k}] gap=${gap}d sameKey=${a.clusterKey === b.clusterKey}`);
        console.log(`     ${a.source.padEnd(12)} ${ist(a.startDateTime)}  ${a.title}  | city=${a.city} venue=${a.venue}`);
        console.log(`     ${b.source.padEnd(12)} ${ist(b.startDateTime)}  ${b.title}  | city=${b.city} venue=${b.venue}`);
      }
    }
  }
  console.log(`near-twin cross-source pairs: ${pairs}`);

  await mongoose.disconnect();
}

main().catch(async err => {
  console.error(err);
  await mongoose.disconnect();
  process.exit(1);
});
