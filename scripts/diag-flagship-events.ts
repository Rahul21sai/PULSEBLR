#!/usr/bin/env tsx
/**
 * Are the events a Bengaluru engineer would be annoyed to miss actually IN the default feed?
 *
 * Totals do not answer this. A corpus can grow while the marquee events sit behind a filter,
 * and that is precisely what was happening: `IndiaFOSS 2026` — India's flagship open-source
 * conference, and one of the specific events the devevents adapter exists to capture — was
 * stored with `isTechEvent: false`, so the feed's default `techOnly` view hid it.
 *
 * This checks named events by name, the same discipline as diag-attended-coverage.ts: a rising
 * total does not prove the right things are present.
 *
 * "In the default feed" means exactly what the query layer means: upcoming (or in progress) AND
 * isTechEvent true, because /api/events maps techOnly to `filter.isTechEvent = true`.
 *
 * Read-only.
 *
 * Run: npx tsx scripts/diag-flagship-events.ts
 */
import './load-env';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';
import mongoose from 'mongoose';

/** Marquee Bengaluru tech events and communities, by name fragment. */
const FLAGSHIP = [
  'IndiaFOSS',
  'FOSS United',
  'Rootconf',
  'Fifth Elephant',
  'DevOpsDays',
  'KubeDay',
  'KCD',
  'Kubernetes',
  'PGConf',
  'Kafka Summit',
  'Great International Developer Summit',
  'GIDS',
  'droidcon',
  'Open Source India',
  'GDG',
  'CNCF',
  'Rust',
  'Hacktoberfest',
  'Devfolio',
  'Hackathon',
];

async function main() {
  await connectDB();
  const now = new Date();

  let present = 0;
  let hidden = 0;
  let absent = 0;

  console.log('flagship event coverage — "in feed" = upcoming AND isTechEvent (the default view)\n');

  for (const name of FLAGSHIP) {
    const rows = await Event.find(
      {
        title: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
        $or: [{ startDateTime: { $gte: now } }, { endDateTime: { $gte: now } }],
      },
      { title: 1, isTechEvent: 1, category: 1, source: 1, startDateTime: 1 }
    )
      .sort({ startDateTime: 1 })
      .limit(3)
      .lean();

    if (rows.length === 0) {
      absent++;
      console.log(`  —      ${name.padEnd(38)} no upcoming event`);
      continue;
    }

    const shown = rows.filter(r => r.isTechEvent);
    if (shown.length > 0) present++;
    else hidden++;

    for (const r of rows) {
      const mark = r.isTechEvent ? 'IN   ' : 'HIDDEN';
      const day = new Date(r.startDateTime as unknown as string).toISOString().slice(0, 10);
      console.log(
        `  ${mark} ${name.padEnd(20)} ${day}  ${String(r.title).slice(0, 40).padEnd(40)} [${(r.category || []).join(', ')}]`
      );
    }
  }

  console.log(`\n  in the default feed: ${present}`);
  console.log(`  present but HIDDEN:  ${hidden}   ← each of these is a recall bug, not a supply gap`);
  console.log(`  nothing scheduled:   ${absent}   ← supply, not a bug`);

  await mongoose.disconnect();
}

main().catch(async e => {
  console.error(e);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
