#!/usr/bin/env tsx
/**
 * Live smoke test for every scraper adapter. Touches NO database — it only
 * proves each adapter returns plausible events with the fields the UI needs.
 *
 * Run:  npx tsx scripts/test-adapters.ts            (fast set)
 *       npx tsx scripts/test-adapters.ts --all      (includes slow/broad sources)
 */
import './load-env';
import { ScrapeResult, RawEvent } from '../lib/scrapers/core/types';
import { scrapeLumaCity, scrapeLumaCalendar, enrichLumaDescriptions } from '../lib/scrapers/adapters/luma';
import { scrapeMeetupCity, scrapeMeetupGroups, SEED_MEETUP_GROUPS } from '../lib/scrapers/adapters/meetup';
import { scrapeEventbrite } from '../lib/scrapers/adapters/eventbrite';
import { scrapeBevy } from '../lib/scrapers/adapters/bevy';
import { scrapeDevfolio } from '../lib/scrapers/adapters/devfolio';
import { scrapeUnstop } from '../lib/scrapers/adapters/unstop';
import { scrapeAllEvents } from '../lib/scrapers/adapters/allevents';
import { scrapeUrlUniversal, COMPANY_EVENT_PAGES } from '../lib/scrapers/adapters/universal';

const ALL = process.argv.includes('--all');
const IST = 'Asia/Kolkata';

function fmt(d: Date | undefined): string {
  if (!d) return '—'.padEnd(17);
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: IST, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d).padEnd(17);
}

/** Field-completeness report: which fields does this source actually populate? */
function coverage(events: RawEvent[]): string {
  if (events.length === 0) return '';
  const fields: Array<[string, (e: RawEvent) => boolean]> = [
    ['img', e => Boolean(e.imageUrl)],
    ['desc', e => e.description.length > e.title.length + 20],
    ['venue', e => Boolean(e.venue)],
    ['geo', e => typeof e.lat === 'number'],
    ['host', e => Boolean(e.organizer)],
    ['price', e => e.isFree !== undefined || e.price !== undefined],
    ['going', e => typeof e.attendeeCount === 'number'],
    ['end', e => Boolean(e.endDateTime)],
  ];
  return fields
    .map(([name, test]) => {
      const pct = Math.round((events.filter(test).length / events.length) * 100);
      return `${name}:${String(pct).padStart(3)}%`;
    })
    .join(' ');
}

function report(result: ScrapeResult) {
  const { events, errors } = result;
  const mark = events.length > 0 ? '✅' : errors.length > 0 ? '❌' : '⚠️ ';
  console.log(
    `\n${mark} ${result.label}  →  ${events.length} events in ${(result.durationMs / 1000).toFixed(1)}s`
  );
  if (events.length > 0) console.log(`   coverage: ${coverage(events)}`);
  if (result.discovered?.length) console.log(`   discovered: ${result.discovered.length} sources`);

  const sorted = [...events].sort((a, b) => a.startDateTime.getTime() - b.startDateTime.getTime());
  for (const e of sorted.slice(0, 4)) {
    console.log(
      `      ${fmt(e.startDateTime)} ${e.title.slice(0, 44).padEnd(44)} ${(e.venue || (e.rawFormat === 'online' ? 'Online' : '?')).slice(0, 24)}`
    );
  }
  // Sanity: any event in the past, or absurdly far out, is a parsing bug.
  const now = Date.now();
  const past = events.filter(e => (e.endDateTime ?? e.startDateTime).getTime() < now);
  const farFuture = events.filter(
    e => e.startDateTime.getTime() > now + 2 * 365 * 24 * 3600 * 1000
  );
  if (past.length) console.log(`   ⚠️  ${past.length} past event(s) leaked through`);
  if (farFuture.length) console.log(`   ⚠️  ${farFuture.length} event(s) >2y out (suspect dates)`);
  if (errors.length) {
    console.log(`   errors (${errors.length}): ${errors.slice(0, 3).join(' | ').slice(0, 260)}`);
  }
}

async function main() {
  const started = Date.now();
  const all: RawEvent[] = [];

  // ── Luma city + one discovered host calendar ──────────────────────────────
  const lumaCity = await scrapeLumaCity('bengaluru');
  report(lumaCity);
  all.push(...lumaCity.events);

  const hostCalendars = (lumaCity.discovered || []).slice(0, ALL ? 12 : 3);
  for (const cal of hostCalendars) {
    const one = await scrapeLumaCalendar(cal.handle, cal.label);
    report(one);
    all.push(...one.events);
  }

  // Enrichment: prove descriptions actually get filled in.
  const before = all.filter(e => e.source === 'luma' && e.description === e.title).length;
  const enriched = await enrichLumaDescriptions(all, ALL ? 40 : 8);
  console.log(`\n📝 Luma enrichment: ${enriched} of ${before} placeholder descriptions replaced`);

  // ── Meetup ────────────────────────────────────────────────────────────────
  const meetupCity = await scrapeMeetupCity();
  report(meetupCity);
  all.push(...meetupCity.events);

  const groups = [
    ...new Set([...(meetupCity.discovered || []).map(d => d.handle), ...SEED_MEETUP_GROUPS]),
  ].slice(0, ALL ? 80 : 10);
  const meetupGroups = await scrapeMeetupGroups(groups);
  report(meetupGroups);
  all.push(...meetupGroups.events);

  // ── Everything else ───────────────────────────────────────────────────────
  for (const run of [scrapeBevy, scrapeDevfolio, scrapeUnstop, scrapeAllEvents]) {
    const result = await run();
    report(result);
    all.push(...result.events);
  }

  if (ALL) {
    const eventbrite = await scrapeEventbrite();
    report(eventbrite);
    all.push(...eventbrite.events);
  }

  // ── Universal adapter over company pages ──────────────────────────────────
  console.log('\n══ UNIVERSAL ADAPTER — company/community pages ══════════════════');
  const pages = ALL ? COMPANY_EVENT_PAGES : COMPANY_EVENT_PAGES.slice(0, 6);
  let companyEvents = 0;
  let companyWorking = 0;
  for (const page of pages) {
    const one = await scrapeUrlUniversal(page.url, {
      organizer: page.organizer,
      source: 'company',
      followRssItems: 0,
    });
    const mark = one.events.length > 0 ? '✅' : '·';
    console.log(
      `  ${mark} ${page.organizer.padEnd(20)} ${String(one.events.length).padStart(3)} events   ${one.errors[0]?.slice(0, 70) || ''}`
    );
    if (one.events.length > 0) {
      companyWorking++;
      companyEvents += one.events.length;
      all.push(...one.events);
      for (const e of one.events.slice(0, 2)) {
        console.log(`        ${fmt(e.startDateTime)} ${e.title.slice(0, 56)}`);
      }
    }
  }
  console.log(`  → ${companyWorking}/${pages.length} company pages yielded ${companyEvents} events`);

  // ── Aggregate ─────────────────────────────────────────────────────────────
  const bySource = new Map<string, number>();
  for (const e of all) bySource.set(e.source, (bySource.get(e.source) || 0) + 1);
  const uniqueUrls = new Set(all.map(e => e.sourceUrl)).size;

  console.log('\n══ TOTALS ═══════════════════════════════════════════════════════');
  for (const [source, count] of [...bySource.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${source.padEnd(12)} ${String(count).padStart(4)}`);
  }
  console.log(`   ${'TOTAL'.padEnd(12)} ${String(all.length).padStart(4)} raw / ${uniqueUrls} distinct URLs`);
  console.log(`   wall clock: ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`   with images: ${all.filter(e => e.imageUrl).length} (${Math.round((all.filter(e => e.imageUrl).length / Math.max(1, all.length)) * 100)}%)`);
}

main().catch(e => {
  console.error('❌', e);
  process.exit(1);
});
