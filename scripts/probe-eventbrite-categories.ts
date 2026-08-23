#!/usr/bin/env tsx
/**
 * Is the Eventbrite adapter leaving coverage on the table?
 *
 * It browses FIVE paths — all-events, technology, business, science-and-tech, startup — at 6
 * pages each. Eventbrite's /d/india--bengaluru/<path>/ URL also accepts arbitrary keywords,
 * not just its own category slugs, and both dimensions still short of target could be helped
 * by this one already-working source:
 *
 *   HARDWARE, where three probes have now shown the events are not on Meetup, Luma, Bevy,
 *   HasGeek, developers.events or FOSS United. Eventbrite carries paid industry events, which
 *   is where electronics and semiconductor gatherings would sit if they are online anywhere.
 *
 *   EVERY BENGALURU EVENT, where the whole non-tech half of the city — music, food, arts,
 *   health, sports, community — has no dedicated path at all and reaches the corpus only
 *   through whatever all-events happens to rank in 6 pages.
 *
 * Reports each candidate's yield AND its overlap with what the current five already return,
 * because a path that duplicates existing results is not coverage, it is cost.
 *
 * Read-only.
 *
 * Run: npx tsx scripts/probe-eventbrite-categories.ts
 */
import './load-env';
import { fetchText } from '../lib/scrapers/core/http';
import { rawEventsFromHtml } from '../lib/scrapers/core/jsonld';

const BASE = 'https://www.eventbrite.com/d/india--bengaluru';

/** What the adapter browses today. */
const CURRENT = ['all-events', 'technology--events', 'business--events', 'science-and-tech--events', 'startup--events'];

/** Candidates: hardware-leaning first, then the missing non-tech half of the city. */
const CANDIDATES = [
  // Hardware / engineering
  'robotics--events',
  'engineering--events',
  'electronics--events',
  'hardware--events',
  'iot--events',
  'drone--events',
  'semiconductor--events',
  'maker--events',
  // The non-tech city, which currently has no dedicated path
  'music--events',
  'food-and-drink--events',
  'arts--events',
  'health--events',
  'sports-and-fitness--events',
  'community--events',
  'film-and-media--events',
  'hobbies--events',
  'education--events',
  'travel-and-outdoor--events',
  'charity-and-causes--events',
  'fashion--events',
];

async function urlsFor(path: string, pages = 2): Promise<Set<string>> {
  const found = new Set<string>();
  for (let page = 1; page <= pages; page++) {
    const url = `${BASE}/${path}/${page > 1 ? `?page=${page}` : ''}`;
    try {
      const html = await fetchText(url, { timeoutMs: 25000, retries: 1 });
      const events = rawEventsFromHtml(html, { baseUrl: url, source: 'eventbrite' });
      if (events.length === 0) break;
      for (const e of events) found.add(e.sourceUrl);
    } catch {
      break;
    }
  }
  return found;
}

async function main() {
  console.log('Baseline: what the current five paths already return (2 pages each)…\n');
  const baseline = new Set<string>();
  for (const path of CURRENT) {
    const urls = await urlsFor(path);
    for (const u of urls) baseline.add(u);
    console.log(`  ${path.padEnd(28)} ${urls.size} event(s)`);
  }
  console.log(`\n  baseline union: ${baseline.size} distinct event(s)\n`);

  console.log('Candidates — yield, and how much of it is NEW:\n');
  const worthwhile: Array<{ path: string; total: number; fresh: number }> = [];

  for (const path of CANDIDATES) {
    const urls = await urlsFor(path);
    const fresh = [...urls].filter(u => !baseline.has(u));
    const verdict = urls.size === 0 ? 'no results' : fresh.length === 0 ? 'all duplicates' : 'ADDS';
    console.log(
      `  ${verdict.padEnd(15)} ${path.padEnd(28)} ${String(urls.size).padStart(3)} found, ` +
        `${String(fresh.length).padStart(3)} new`
    );
    if (fresh.length > 0) {
      worthwhile.push({ path, total: urls.size, fresh: fresh.length });
      // Count them into the baseline so the next candidate is judged against reality.
      for (const u of fresh) baseline.add(u);
    }
  }

  console.log(`\n=> ${worthwhile.length} path(s) add events not already reachable:`);
  for (const w of worthwhile.sort((a, b) => b.fresh - a.fresh)) {
    console.log(`     '${w.path}',`.padEnd(38) + `// +${w.fresh} new of ${w.total}`);
  }
  console.log(`\n  corpus reachable after adding them: ${baseline.size} distinct event(s)`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
