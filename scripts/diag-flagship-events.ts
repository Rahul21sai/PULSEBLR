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
import { buildEventFilter } from '../lib/events/query';
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
  // Added once it existed: the microsite JSON-LD pass put it in the corpus, and whether a
  // government trade summit belongs in an engineering feed is a real product question rather
  // than something to leave unmeasured. It currently reads HID/not tech — see the note below.
  'Bengaluru Tech Summit',
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

  /*
   * ── "IN FEED" IS THE FEED'S OWN PREDICATE, NOT A HAND-ROLLED COPY OF TWO OF ITS CLAUSES ──────
   *
   * This used to query `{ title, upcoming }` and call a row visible whenever `isTechEvent` was true.
   * That is two of the four things the real feed requires, and the two it omitted are the ones that
   * HIDE a row: the visibility clause and the soft-delete exclusion.
   *
   * Caught in the act. A `visibility: 'pending'` microsite candidate — `Open Source India | India's
   * #1 Open Source Event`, awaiting review and visible to nobody — was reported **IN** the feed by
   * this script, while `buildEventFilter(..., null)` correctly excluded it. A diagnostic that
   * over-reports coverage is worse than none: it answers "is our flagship visible?" with yes when
   * the row is quarantined, soft-deleted, or somebody's private event.
   *
   * So visibility is now decided by `buildEventFilter(params, null)` — the anonymous viewer, the
   * same function `/api/events` and the sitemap use. Same discipline as
   * `cleanup-non-bengaluru.ts` importing `offCityReason` rather than mirroring it, and
   * `diag-offcity.ts` ranking through `buildSort`: a check that reimplements the thing it checks
   * only ever tests the copy.
   */
  console.log(
    'flagship event coverage — "in feed" = buildEventFilter({ techOnly, includeOngoing }, null),\n' +
      '  i.e. exactly what a signed-out reader sees: upcoming, tech-flagged, public, not deleted\n'
  );

  const feedFilter = buildEventFilter({ techOnly: true, includeOngoing: true }, null);

  for (const name of FLAGSHIP) {
    const titleMatch = {
      title: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
      $or: [{ startDateTime: { $gte: now } }, { endDateTime: { $gte: now } }],
    };

    // Every upcoming row with this name, regardless of whether a reader can reach it — so the
    // "present but hidden" case can be distinguished from "no supply at all".
    const rows = await Event.find(titleMatch, {
      title: 1,
      isTechEvent: 1,
      category: 1,
      source: 1,
      startDateTime: 1,
      visibility: 1,
      createdByUserId: 1,
      deletedAt: 1,
    })
      .sort({ startDateTime: 1 })
      .limit(3)
      .lean();

    // And which of those the feed itself admits. Asked as a set so one round trip covers all three.
    const visibleIds = new Set(
      (
        await Event.find({ ...feedFilter, ...titleMatch }, { _id: 1 })
          .limit(3)
          .lean()
      ).map(r => String(r._id))
    );

    if (rows.length === 0) {
      absent++;
      console.log(`  —      ${name.padEnd(38)} no upcoming event`);
      continue;
    }

    const shown = rows.filter(r => visibleIds.has(String(r._id)));
    if (shown.length > 0) present++;
    else hidden++;

    for (const r of rows) {
      // WHY it is hidden, not merely that it is — the three causes need different fixes: a
      // classification decision, a pending review, or a delete.
      const reason = !r.isTechEvent
        ? 'not tech'
        : r.deletedAt
          ? 'deleted'
          : r.visibility && r.visibility !== 'public'
            ? String(r.visibility)
            : 'filtered';
      const mark = visibleIds.has(String(r._id)) ? 'IN   ' : `HID/${reason.slice(0, 8).padEnd(8)}`;
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
