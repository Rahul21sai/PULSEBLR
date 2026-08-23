#!/usr/bin/env tsx
/**
 * Are the per-run caps silently dropping discovered sources?
 *
 * `DEFAULTS` in pipeline.ts sets `maxMeetupGroups: 120` and `maxLumaCalendars: 60`, and both are
 * applied with a bare `.slice()`. Discovery is designed to COMPOUND — every run starts from
 * everything ever found — so the number of known sources only grows, and the moment it passes a
 * cap the pipeline starts ignoring the tail on every single run, forever, with no log line and no
 * health signal. The dropped groups look exactly like groups that have no upcoming events.
 *
 * This became worth checking when the scorecard reported Docker, CNCF, Postgres, Grafana and
 * ClickHouse as having no upcoming events, despite CLAUDE.md naming company-run Meetup groups
 * (docker-bangalore, bangalore-mongodb-user-group …) as the route that actually reaches company
 * events. "No upcoming events" and "never scraped" are indistinguishable in the feed and have
 * opposite fixes.
 *
 * `.slice()` also takes the FIRST n in whatever order the query returned, which is not the same
 * as the n most valuable — so this prints which specific handles fall past the cap.
 *
 * Read-only.
 *
 * Run: npx tsx scripts/diag-source-caps.ts
 */
import './load-env';
import connectDB from '../lib/mongodb';
import Source from '../lib/models/Source';
import Event from '../lib/models/Event';
import mongoose from 'mongoose';

/** Mirrors DEFAULTS in lib/scrapers/pipeline.ts. */
const MAX_MEETUP_GROUPS = 120;
const MAX_LUMA_CALENDARS = 60;

/** Communities the scorecard reported absent, to test the "never scraped" explanation. */
const WATCH = ['docker', 'cncf', 'postgres', 'pgsql', 'grafana', 'clickhouse', 'linux', 'mongodb', 'kafka', 'hacktoberfest'];

async function main() {
  await connectDB();
  const now = new Date();

  for (const [kind, cap] of [
    ['meetup-group', MAX_MEETUP_GROUPS],
    ['luma-calendar', MAX_LUMA_CALENDARS],
  ] as Array<[string, number]>) {
    // Same query shape the pipeline uses: loadDiscovered(kind), then .slice(0, cap).
    const rows = await Source.find({ kind }).lean();
    const overflow = rows.length - cap;

    console.log(`\n══ ${kind} ══`);
    console.log(`  known:   ${rows.length}`);
    console.log(`  cap:     ${cap}`);
    if (overflow > 0) {
      console.log(`  DROPPED: ${overflow} every run — silently, with no health signal`);
      const dropped = rows.slice(cap);
      console.log(`\n  handles past the cap (first 25 of ${dropped.length}):`);
      for (const d of dropped.slice(0, 25)) {
        console.log(`     ${String(d.handle ?? d.name).slice(0, 56)}`);
      }
      const watched = dropped.filter(d =>
        WATCH.some(w => `${d.handle ?? ''} ${d.name ?? ''}`.toLowerCase().includes(w))
      );
      if (watched.length) {
        console.log(`\n  ** communities the scorecard called "absent" that are in fact NEVER SCRAPED:`);
        for (const w of watched) console.log(`     ${w.handle ?? w.name}`);
      }
    } else {
      console.log(`  headroom: ${-overflow} — nothing dropped`);
    }
  }

  // Cross-check: do the watched communities appear anywhere as a known source, and do they have
  // events? Four outcomes, and only two of them are supply problems.
  console.log('\n\n══ the communities the scorecard reported absent ══\n');
  console.log('  handle known?  ·  scraped this cycle?  ·  upcoming events?\n');

  for (const w of WATCH) {
    const re = new RegExp(w, 'i');
    const sources = await Source.find({ $or: [{ handle: re }, { name: re }] }).lean();
    const events = await Event.countDocuments({
      $or: [{ title: re }, { organizer: re }],
      $and: [{ $or: [{ startDateTime: { $gte: now } }, { endDateTime: { $gte: now } }] }],
    });

    const known = sources.length;
    const everProduced = sources.filter(s => (s.eventCount ?? 0) > 0).length;
    const lastScraped = sources
      .map(s => (s.lastScrapedAt ? new Date(s.lastScrapedAt as unknown as string).getTime() : 0))
      .reduce((a, b) => Math.max(a, b), 0);
    const scrapedLabel = lastScraped
      ? `${Math.round((Date.now() - lastScraped) / 86400_000)}d ago`
      : 'NEVER';

    let verdict: string;
    if (known === 0) verdict = 'no source exists → build or seed one';
    else if (scrapedLabel === 'NEVER') verdict = 'KNOWN BUT NEVER SCRAPED → cap or disabled, our bug';
    else if (events === 0 && everProduced === 0) verdict = 'scraped, never produced → dead handle';
    else if (events === 0) verdict = 'scraped, has produced before → genuine supply gap';
    else verdict = 'has events';

    console.log(
      `  ${w.padEnd(14)} sources ${String(known).padStart(3)}  last scraped ${scrapedLabel.padEnd(9)}  upcoming ${String(events).padStart(3)}   ${verdict}`
    );
  }

  console.log('\n  Only "genuine supply gap" and "dead handle" are outside our control.');

  await mongoose.disconnect();
}

main().catch(async e => {
  console.error(e);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
