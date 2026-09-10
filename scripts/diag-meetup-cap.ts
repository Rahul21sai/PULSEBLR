#!/usr/bin/env tsx
/**
 * How much does Meetup's 10-event ICS cap actually cost — MEASURED, not extrapolated?
 *
 * THE FINDING THIS REPLACES. `audit/AUDIT-2026-09-07-PART4-COVERAGE.md` §1 established that
 * `/<group>/events/ical/` returns at most 10 events, that 74 of 261 stored groups were sitting on
 * exactly that number and none above it, and then sized the loss by counting event cards on FIVE
 * group pages with Playwright: a 2.28× ratio extrapolated to "~900-950 events invisible". Its own
 * closing sentence says the honest thing — "five groups is an indicative sample, not a
 * measurement… the first engineering step is to measure it across all 74". This script is that
 * step, and it corrects the audit in two ways that both matter:
 *
 *   1. THE AUDIT'S PAGE COUNTS WERE TOO HIGH. It counted `/events/<id>` links in the rendered DOM,
 *      and a Meetup group page renders its PAST tab as well — ten more events. Measured through
 *      the upstream's own upcoming connection: `ai-blr` has 17 upcoming, not 32; `agile-kitchen`
 *      16, not 26; `agile-chapter-bengaluru` 12, not 25. The truncation is real and the ratio is
 *      not 2.28×.
 *   2. NO BROWSER IS NEEDED. The audit inferred one because the page yields zero JSON-LD `Event`
 *      nodes to a plain fetch. True — and there are none in a rendered DOM either. The events are
 *      server-rendered into `__NEXT_DATA__.props.pageProps.__APOLLO_STATE__`, which a plain fetch
 *      reads in ~1 s against a browser's ~7 s. `--render` is available for comparison and is
 *      expected to add nothing.
 *
 * WHY IT ASKS THE UPSTREAM FOR ITS OWN TOTAL. `hasNextPage`/`totalCount` on the upcoming
 * connection mean this can report the difference between "the page shows everything" and "the page
 * ALSO caps, at 30" — which counting rendered cards cannot, and which is the difference between a
 * solved problem and a smaller one. `active-adventure-travel-junkies` reports 148 upcoming.
 *
 * READ-ONLY. It reads the Source collection and fetches public pages. No writes, no ingest, no
 * tagging — an event counted here is not stored.
 *
 * Run:
 *   npx tsx scripts/diag-meetup-cap.ts                 every enabled Meetup group (~2 requests each)
 *   npx tsx scripts/diag-meetup-cap.ts --capped-only   only groups already reported at the cap
 *   npx tsx scripts/diag-meetup-cap.ts --limit=40       first 40 groups, for a quick look
 *   npx tsx scripts/diag-meetup-cap.ts --render         also try the headless-browser fallback
 */
import './load-env';
import mongoose from 'mongoose';
import connectDB from '../lib/mongodb';
import Source from '../lib/models/Source';
import { fetchText, mapPool } from '../lib/scrapers/core/http';
import {
  MEETUP_ICS_CAP,
  MEETUP_PAGE_CAP,
  meetupEventsFromGroupPage,
  SEED_MEETUP_GROUPS,
} from '../lib/scrapers/adapters/meetup';

const argv = process.argv.slice(2);
const cappedOnly = argv.includes('--capped-only');
const useRender = argv.includes('--render');
const limitArg = argv.find(a => a.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.slice('--limit='.length)) : Infinity;

interface Row {
  slug: string;
  /** What the last real scrape recorded — the field the wall was found in. */
  storedCount: number | null;
  icsCount: number | null;
  pageCount: number | null;
  upstreamTotal?: number;
  hasMore: boolean;
  offCountry: number;
  note?: string;
}

async function icsCount(slug: string): Promise<number | null> {
  try {
    const ics = await fetchText(`https://www.meetup.com/${slug}/events/ical/`, {
      timeoutMs: 20000,
      retries: 2,
    });
    return (ics.match(/BEGIN:VEVENT/g) || []).length;
  } catch {
    return null;
  }
}

async function run() {
  await connectDB();

  const stored = (await Source.find({ kind: 'meetup-group' })
    .select('handle enabled lastEventCount')
    .lean()) as Array<{ handle?: string; enabled?: boolean; lastEventCount?: number }>;

  const byHandle = new Map<string, number | null>();
  for (const row of stored) {
    if (!row.handle || row.enabled === false) continue;
    byHandle.set(row.handle, typeof row.lastEventCount === 'number' ? row.lastEventCount : null);
  }
  for (const slug of SEED_MEETUP_GROUPS) if (!byHandle.has(slug)) byHandle.set(slug, null);

  let slugs = [...byHandle.keys()].sort();
  const population = slugs.length;
  const reportedAtCap = slugs.filter(s => (byHandle.get(s) ?? -1) >= MEETUP_ICS_CAP).length;
  const reportedAbove = slugs.filter(s => (byHandle.get(s) ?? -1) > MEETUP_ICS_CAP).length;

  console.log('─'.repeat(100));
  console.log('MEETUP ICS CAP — measured, not extrapolated');
  console.log('─'.repeat(100));
  console.log(`  groups known (enabled Source rows + hand-verified seeds)   ${population}`);
  console.log(`  last scrape reported >= ${MEETUP_ICS_CAP} events                        ${reportedAtCap}`);
  console.log(
    `  last scrape reported  > ${MEETUP_ICS_CAP} events                        ${reportedAbove}` +
      (reportedAbove === 0
        ? '  ← still a wall: the second pass has not written to this DB yet'
        : '  ← the wall is gone')
  );

  if (cappedOnly) slugs = slugs.filter(s => (byHandle.get(s) ?? -1) >= MEETUP_ICS_CAP);
  if (Number.isFinite(limit)) slugs = slugs.slice(0, limit);
  console.log(`  measuring                                                  ${slugs.length} group(s), 2 requests each`);
  if (useRender) console.log('  headless-browser fallback                                  ENABLED');
  console.log('');

  const renderer = useRender ? await import('../lib/scrapers/core/render') : null;
  const startedAt = Date.now();

  const results = await mapPool(slugs, 4, async (slug): Promise<Row> => {
    const row: Row = {
      slug,
      storedCount: byHandle.get(slug) ?? null,
      icsCount: await icsCount(slug),
      pageCount: null,
      hasMore: false,
      offCountry: 0,
    };
    try {
      const url = `https://www.meetup.com/${slug}/events/`;
      const html = await fetchText(url, { timeoutMs: 25000, retries: 2 });
      const parsed = meetupEventsFromGroupPage(html, { slug });
      row.pageCount = parsed.events.length;
      row.upstreamTotal = parsed.upstreamTotal;
      row.hasMore = parsed.hasMore;
      row.offCountry = parsed.offCountry;

      if (renderer && parsed.events.length === 0 && parsed.upstreamTotal !== 0) {
        const rendered = await renderer.renderHtml(url);
        if (rendered) {
          const viaBrowser = meetupEventsFromGroupPage(rendered, { slug });
          row.note = `plain fetch 0, render ${viaBrowser.events.length}`;
          if (viaBrowser.events.length > 0) row.pageCount = viaBrowser.events.length;
        } else {
          row.note = 'plain fetch 0, render unavailable';
        }
      }
    } catch (error) {
      row.note = `page failed: ${error instanceof Error ? error.message.slice(0, 56) : String(error)}`;
    }
    return row;
  });

  if (renderer) await renderer.closeRenderer();
  const elapsedMs = Date.now() - startedAt;

  const rows = results.filter((r): r is Row => r !== null);

  // ── Per-group table, truncated groups first and by size of the gain ─────────────────────────
  const gain = (r: Row) => Math.max(0, (r.pageCount ?? 0) - (r.icsCount ?? 0));
  const atCap = rows.filter(r => r.icsCount !== null && r.icsCount >= MEETUP_ICS_CAP);
  const gained = atCap.filter(r => gain(r) > 0).sort((a, b) => gain(b) - gain(a));

  console.log('  TRUNCATED GROUPS — ICS is hiding events (page > ICS)');
  console.log(`  ${'group'.padEnd(40)} ${'ICS'.padStart(4)} ${'page'.padStart(5)} ${'gain'.padStart(5)}  upstream`);
  for (const row of gained) {
    console.log(
      `  ${row.slug.padEnd(40)} ${String(row.icsCount).padStart(4)} ${String(row.pageCount).padStart(5)} ` +
        `${('+' + gain(row)).padStart(5)}  ${row.upstreamTotal ?? '?'}${row.hasMore ? ' (more!)' : ''}` +
        (row.offCountry ? `  [${row.offCountry} non-India dropped]` : '') +
        (row.note ? `  ${row.note}` : '')
    );
  }
  if (gained.length === 0) console.log('  (none)');

  const flatAtCap = atCap.filter(r => gain(r) === 0);
  if (flatAtCap.length > 0) {
    console.log('');
    console.log(`  AT THE CAP BUT NO GAIN — ${flatAtCap.length} group(s). Either genuinely ${MEETUP_ICS_CAP} events,`);
    console.log('  or the page shape changed. A LARGE number here is the regression signal.');
    for (const row of flatAtCap.slice(0, 15)) {
      console.log(
        `  ${row.slug.padEnd(40)} ${String(row.icsCount).padStart(4)} ${String(row.pageCount ?? '—').padStart(5)}` +
          `        ${row.upstreamTotal ?? '?'}` +
          (row.note ? `  ${row.note}` : '')
      );
    }
    if (flatAtCap.length > 15) console.log(`  … and ${flatAtCap.length - 15} more`);
  }

  const pageFailures = rows.filter(r => r.pageCount === null);
  if (pageFailures.length > 0) {
    console.log('');
    console.log(`  PAGE UNREADABLE — ${pageFailures.length} group(s):`);
    for (const row of pageFailures.slice(0, 10)) {
      console.log(`  ${row.slug.padEnd(40)} ${row.note ?? 'no data island'}`);
    }
    if (pageFailures.length > 10) console.log(`  … and ${pageFailures.length - 10} more`);
  }

  // ── The totals, which are the point of the script ───────────────────────────────────────────
  const icsTotal = rows.reduce((sum, r) => sum + (r.icsCount ?? 0), 0);
  const pageTotal = rows.reduce((sum, r) => sum + Math.max(r.pageCount ?? 0, r.icsCount ?? 0), 0);
  const upstreamKnown = rows.filter(r => typeof r.upstreamTotal === 'number');
  const upstreamTotal = upstreamKnown.reduce((sum, r) => sum + (r.upstreamTotal ?? 0), 0);
  const stillCapped = rows.filter(r => r.hasMore);
  const offCountryTotal = rows.reduce((sum, r) => sum + r.offCountry, 0);

  console.log('');
  console.log('─'.repeat(100));
  console.log(`  groups measured                    ${rows.length}`);
  console.log(`  at the ICS cap                     ${atCap.length}`);
  console.log(`  of those, genuinely truncated      ${gained.length}`);
  console.log(`  ICS total (what we scrape today)   ${icsTotal}`);
  console.log(`  page total (what we can scrape)    ${pageTotal}`);
  console.log(`  NET NEW EVENTS RECOVERABLE         ${pageTotal - icsTotal}`);
  if (icsTotal > 0) console.log(`  ratio                              ${(pageTotal / icsTotal).toFixed(2)}x`);
  if (upstreamKnown.length > 0) {
    console.log(
      `  upstream's own total (${upstreamKnown.length} groups)   ${upstreamTotal}` +
        `   ← the true ceiling; the page itself caps at ${MEETUP_PAGE_CAP}`
    );
  }
  if (stillCapped.length > 0) {
    console.log(`  still capped by the PAGE           ${stillCapped.length} group(s) report hasNextPage`);
    for (const row of stillCapped.slice(0, 6)) {
      console.log(`      ${row.slug.padEnd(40)} page ${row.pageCount}, upstream ${row.upstreamTotal}`);
    }
  }
  if (offCountryTotal > 0) {
    console.log(
      `  non-India rows the guard dropped   ${offCountryTotal}   ← would otherwise reach the city gate,`
    );
    console.log('                                          which has no country input and would keep them');
  }
  console.log(`  wall-clock                         ${(elapsedMs / 1000).toFixed(1)}s for ${rows.length * 2} requests`);
  console.log('─'.repeat(100));
  console.log('');
  console.log('  This is a MEASUREMENT of what is reachable, not of what would be stored: every row');
  console.log('  counted here still has to pass the date window, the off-city gate and dedup.');

  await mongoose.disconnect();
}

run().catch(async error => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
