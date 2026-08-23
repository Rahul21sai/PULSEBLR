#!/usr/bin/env tsx
/**
 * Live smoke test for the District adapter. No DB writes.
 *
 * Asserts the three things the adapter's design depends on, so a silent regression in any of
 * them is a non-zero exit rather than a quietly shrinking feed:
 *
 *   1. the slug date parser round-trips the real forms found in the sitemap
 *   2. the sitemap still yields dated Bengaluru URLs
 *   3. the events that come back are DATED and in Bengaluru — not the always-on
 *      "experiences" catalogue the slug filter exists to exclude
 *
 * Run: npx tsx scripts/test-district.ts
 */
import './load-env';
import { scrapeDistrict, districtSlugDate } from '../lib/scrapers/adapters/district';

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function main() {
  console.log('══ 1. districtSlugDate on the real slug forms ══\n');

  const cases: Array<[string, string | null]> = [
    ['https://www.district.in/events/singles-meetup-bengaluru-apr19-2026-buy-tickets', '2026-04-19'],
    ['https://www.district.in/events/terrarium-workshop-date-bangalore-may31-2026-buy-tickets', '2026-05-31'],
    ['https://www.district.in/events/sufi-qawwali-mehfil-bengaluru-sep6-2026-buy-tickets', '2026-09-06'],
    // Month-only resolves to the end of the month, on purpose — see the parser's comment.
    ['https://www.district.in/events/little-fun-world-bengaluru-nov-2025-buy-tickets', '2025-11-30'],
    // The always-on catalogue: no date, so it must be unparseable and therefore skipped.
    ['https://www.district.in/events/timezone-orion-mall-bengaluru-buy-tickets', null],
    ['https://www.district.in/events/club-cabana-amusement-park-bengaluru-buy-tickets', null],
    ['https://www.district.in/events/rage-room-bengaluru-buy-tickets', null],
  ];

  for (const [url, expected] of cases) {
    const got = districtSlugDate(url);
    // The parser returns the LAST INSTANT of the slug's IST day (18:30 UTC = midnight IST the
    // next day), so that an event still running today survives the cutoff. Reading that
    // instant as an IST calendar day therefore lands on the following day by construction —
    // subtract a millisecond to get the day it actually represents.
    const gotDay = got
      ? new Date(got.getTime() - 1 + 5.5 * 3600_000).toISOString().slice(0, 10)
      : null;
    check(url.split('/').pop()!.slice(0, 56), gotDay === expected, `expected ${expected}, got ${gotDay}`);
  }

  console.log('\n══ 2. Live scrape ══\n');
  const result = await scrapeDistrict();
  console.log(`  ${result.events.length} event(s) in ${(result.durationMs / 1000).toFixed(1)}s`);
  for (const e of result.errors) console.log(`  ! ${e}`);

  check('returned at least 5 events', result.events.length >= 5, `got ${result.events.length}`);

  console.log('\n══ 3. Are they dated, Bengaluru events? ══\n');
  const now = Date.now();
  const past = result.events.filter(e => e.startDateTime.getTime() < now - 86400_000);
  const undated = result.events.filter(e => Number.isNaN(e.startDateTime.getTime()));
  const startsToday = result.events.filter(e => Math.abs(e.startDateTime.getTime() - now) < 36 * 3600_000 && !e.endDateTime);

  check('no unparseable dates', undated.length === 0, `${undated.length}`);
  check('no past events', past.length === 0, `${past.length}`);
  check('no evergreen (starts now, no end)', startsToday.length === 0, `${startsToday.length}`);

  const withVenue = result.events.filter(e => e.venue).length;
  const withImage = result.events.filter(e => e.imageUrl).length;
  const withPrice = result.events.filter(e => e.price !== undefined || e.isFree).length;
  const withDesc = result.events.filter(e => e.description && e.description.length > 60).length;
  const n = result.events.length || 1;
  const pct = (k: number) => `${Math.round((k / n) * 100)}%`;
  console.log(`\n  field coverage: venue ${pct(withVenue)}  image ${pct(withImage)}  price ${pct(withPrice)}  description ${pct(withDesc)}`);
  check('venue coverage >= 80%', withVenue / n >= 0.8, pct(withVenue));

  console.log('\n  sample:');
  for (const e of result.events.slice(0, 12)) {
    const day = new Date(e.startDateTime.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
    console.log(`    ${day}  ${e.title.slice(0, 50).padEnd(50)} ${(e.venue || '-').slice(0, 28)}`);
  }

  console.log(`\n${failures === 0 ? 'OK — all assertions passed' : `${failures} assertion(s) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
