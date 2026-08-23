#!/usr/bin/env tsx
/**
 * One more avenue for hardware: search Meetup by COMMUNITY NAME, not by keyword.
 *
 * The keyword fan-out already covers embedded, fpga, vlsi, semiconductor and arduino, and
 * returns nothing — consistent with diag-hardware-gap.ts finding that just 1 of 788 events
 * mentions hardware vocabulary at all.
 *
 * But keyword search and name search behave differently on Meetup, and the difference has
 * already paid once: searching the community NAMES from the user's attendance history
 * resolved 12 real groups (apache-iceberg-meetups-india, presto-bangalore,
 * apache-pinot-bengaluru-by-startree) that keywords never surfaced. Group slugs are
 * harvested from the results, so a group that exists gets found even if its events are not
 * indexed under the obvious keyword.
 *
 * Guessing slugs directly does NOT work — 0 of 35 — so this searches and harvests.
 *
 * Read-only.
 *
 * Run: npx tsx scripts/probe-hardware-meetup.ts
 */
import './load-env';
import { fetchText } from '../lib/scrapers/core/http';
import { rawEventsFromIcs } from '../lib/scrapers/core/ics';

/** Names real Bengaluru hardware communities would plausibly use. */
const QUERIES = [
  'embedded systems',
  'IoT hardware',
  'robotics',
  'VLSI',
  'semiconductor',
  'RISC-V',
  'electronics',
  'makers',
  'drone',
  'PCB design',
  'FPGA',
  'firmware',
  'hardware startup',
  'IEEE',
];

function harvestSlugs(html: string): string[] {
  const slugs = new Set<string>();
  const re = /meetup\.com\\?\/([a-zA-Z0-9][a-zA-Z0-9-]{2,60})\\?\/events\\?\/(\d{6,})/g;
  for (const m of html.matchAll(re)) {
    const slug = m[1].toLowerCase();
    if (['find', 'topics', 'cities', 'members', 'help', 'blog', 'home'].includes(slug)) continue;
    slugs.add(slug);
  }
  return [...slugs];
}

async function main() {
  console.log(`Searching Meetup for ${QUERIES.length} hardware community name(s)…\n`);

  const allSlugs = new Map<string, string[]>(); // slug -> which queries found it
  for (const q of QUERIES) {
    const url =
      `https://www.meetup.com/find/?keywords=${encodeURIComponent(q)}` +
      `&location=in--Bengaluru&source=EVENTS&sortField=DATETIME`;
    try {
      const html = await fetchText(url, { timeoutMs: 25000, retries: 1 });
      const slugs = harvestSlugs(html);
      console.log(`  "${q}" -> ${slugs.length} slug(s)`);
      for (const s of slugs) {
        if (!allSlugs.has(s)) allSlugs.set(s, []);
        allSlugs.get(s)!.push(q);
      }
    } catch (err) {
      console.log(`  "${q}" -> failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Groups already seeded do not need testing again.
  const { SEED_MEETUP_GROUPS } = await import('../lib/scrapers/adapters/meetup');
  const known = new Set(SEED_MEETUP_GROUPS.map(s => s.toLowerCase()));

  const candidates = [...allSlugs.keys()].filter(s => !known.has(s));
  console.log(`\n${allSlugs.size} distinct slug(s); ${candidates.length} not already seeded\n`);

  // A hardware-sounding NAME is the filter — most search hits are unrelated, because
  // Meetup's search is fuzzy relevance rather than a filter.
  const HW_NAME =
    /(embedded|iot|robot|vlsi|semiconduct|risc|electronic|maker|drone|pcb|fpga|firmware|hardware|circuit|arduino|raspberry|chip|silicon|ieee|mechatron)/i;

  const hardwareish = candidates.filter(s => HW_NAME.test(s));
  console.log(`hardware-sounding slugs: ${hardwareish.length}`);
  for (const s of hardwareish) console.log(`   ${s}   (found via: ${allSlugs.get(s)!.join(', ')})`);

  if (hardwareish.length === 0) {
    console.log('\n   none — consistent with the 1-in-788 measurement: these communities are');
    console.log('   not on Meetup Bengaluru at all, so no search phrasing will surface them.');
  }

  // Test every hardware-sounding candidate the way the adapter would.
  console.log('\nTesting each for UPCOMING events via its ICS feed:\n');
  const keep: Array<[string, number]> = [];
  for (const slug of hardwareish) {
    try {
      const ics = await fetchText(`https://www.meetup.com/${slug}/events/ical/`, {
        timeoutMs: 20000,
        retries: 1,
      });
      const events = rawEventsFromIcs(ics, {
        source: 'meetup',
        fallbackUrl: `https://www.meetup.com/${slug}/`,
        organizer: slug,
      });
      const future = events.filter(e => e.startDateTime.getTime() > Date.now());
      console.log(`  ${future.length > 0 ? 'KEEP ' : 'empty'} ${slug.padEnd(44)} upcoming=${future.length}`);
      for (const e of future.slice(0, 3)) {
        console.log(`          ${e.startDateTime.toISOString().slice(0, 10)}  ${e.title.slice(0, 52)}`);
      }
      if (future.length > 0) keep.push([slug, future.length]);
    } catch {
      console.log(`  HTTP-- ${slug}`);
    }
  }

  console.log(`\n=> ${keep.length} group(s) worth seeding:`);
  for (const [s, n] of keep) console.log(`     '${s}',   // ${n} upcoming`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
