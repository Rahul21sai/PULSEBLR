#!/usr/bin/env tsx
/**
 * How much of the corpus has a resolved AREA, and — the useful half — what are the venue
 * strings of the rows that do not?
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS. `lib/events/relevance.ts` weights `areaMatch: +22` and
 * `areaMiss: -14`, its single biggest term, because commute is the measured reason a good event
 * goes unattended in this city. `areaUnknown` is deliberately **0** — neither credit nor
 * penalty — so every unresolved row is one personalisation cannot help with at all. The "Near
 * you" shelf is gated on the same field. So area coverage is a ceiling on two shipped features,
 * and it is a DATA problem, not a model problem.
 *
 * ── THE DISTINCTION THIS SCRIPT EXISTS TO MAKE ───────────────────────────────────────────────
 *
 * `Event.area` is written ONCE, at ingest, by `lib/scrapers/normalizer.ts`. Widening the
 * gazetteer in `geo.ts` therefore changes NOTHING about a stored row — the improvement only
 * reaches events scraped after the edit. So there are two different numbers, and reporting
 * either alone is misleading:
 *
 *   STORED      what the product shows today, and what the "Near you" shelf actually has.
 *   RECOMPUTED  what `resolveArea` would return NOW, from the same stored fields. This is what
 *               `scripts/backfill-area.ts --apply` would write.
 *
 * A gap between them is not a bug, it is the backfill's whole reason for existing. Quoting a
 * rising RECOMPUTED figure as "coverage improved" while the database still holds the old values
 * would be the mirror mistake `pipeline.ts`'s DEFAULTS warns about.
 *
 * ── WHY THE DENOMINATOR IS NOT `countDocuments()` ────────────────────────────────────────────
 *
 * `normalizer.ts` skips `resolveArea` entirely when `format === 'online'`, so an online event
 * has `area: undefined` BY DESIGN and is not a miss. Dividing by every event reports a product
 * decision as a coverage failure and understates the real number. The headline denominator here
 * is therefore UPCOMING NON-ONLINE events; the other slices are printed beside it so the choice
 * is arguable rather than hidden.
 *
 * ── SECTION 3 IS THE POINT ───────────────────────────────────────────────────────────────────
 *
 * It prints the venue / address / city strings of the rows that resolve to `'Other'`, grouped and
 * counted, VERBATIM. The gazetteer must be widened against strings sources actually publish, not
 * against a map — half the misses so far have been MISSPELLINGS of tokens already in the list
 * (`Kormangala`, `Kanakpura`, `Penya`), which no amount of looking at a map would ever suggest.
 *
 * Read-only. No writes, no network. `scripts/backfill-area.ts` is what writes.
 *
 * Run: npx tsx scripts/diag-area-coverage.ts [--limit N]
 */
import './load-env';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';
import { resolveArea, BENGALURU_AREAS } from '../lib/scrapers/core/geo';
import mongoose from 'mongoose';

const LIMIT = (() => {
  const arg = process.argv.find(a => a.startsWith('--limit='));
  return arg ? Number(arg.split('=')[1]) : 60;
})();

interface Row {
  _id: unknown;
  title?: string;
  venue?: string;
  address?: string;
  city?: string;
  lat?: number;
  lng?: number;
  area?: string;
  format?: string;
  isTechEvent?: boolean;
  startDateTime?: Date;
  source?: string;
}

/** Exactly the input `normalizer.ts` builds, so this cannot drift from the write path. */
function recompute(r: Row): string | undefined {
  if (r.format === 'online') return undefined;
  return resolveArea({ venue: r.venue, address: r.address, city: r.city, lat: r.lat, lng: r.lng });
}

const isResolved = (a: string | undefined): boolean => !!a && a !== 'Other';

function pct(n: number, d: number): string {
  return d === 0 ? '  n/a' : `${((n / d) * 100).toFixed(1)}%`;
}

function bucketise(rows: Row[], pick: (r: Row) => string | undefined) {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const key = pick(r) ?? '(none)';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

async function main() {
  await connectDB();

  const all = (await Event.find(
    {},
    {
      title: 1,
      venue: 1,
      address: 1,
      city: 1,
      lat: 1,
      lng: 1,
      area: 1,
      format: 1,
      isTechEvent: 1,
      startDateTime: 1,
      source: 1,
    }
  ).lean()) as unknown as Row[];

  const now = Date.now();
  const upcoming = all.filter(r => new Date(r.startDateTime as unknown as string).getTime() >= now);
  const offline = upcoming.filter(r => r.format !== 'online');
  const tech = offline.filter(r => r.isTechEvent);

  console.log('═══ 1. COVERAGE — stored vs recomputed ═══\n');
  console.log(`corpus ${all.length} events, ${upcoming.length} upcoming, ${offline.length} upcoming non-online\n`);

  const slices: Array<[string, Row[]]> = [
    ['upcoming non-online  ← THE HEADLINE', offline],
    ['   of those, tech', tech],
    ['all upcoming (incl. online)', upcoming],
    ['whole corpus', all],
  ];

  console.log('  slice                                 rows   STORED resolved   RECOMPUTED resolved');
  console.log('  ' + '─'.repeat(84));
  for (const [label, rows] of slices) {
    const s = rows.filter(r => isResolved(r.area)).length;
    const c = rows.filter(r => isResolved(recompute(r))).length;
    console.log(
      `  ${label.padEnd(36)}${String(rows.length).padStart(6)}` +
        `   ${String(s).padStart(5)} ${pct(s, rows.length).padStart(7)}` +
        `   ${String(c).padStart(5)} ${pct(c, rows.length).padStart(7)}`
    );
  }

  const storedOther = offline.filter(r => !isResolved(r.area));
  const recomputedOther = offline.filter(r => !isResolved(recompute(r)));
  console.log('');
  console.log(`  unresolved today (STORED):      ${storedOther.length} upcoming non-online rows`);
  console.log(`  unresolved after a backfill:    ${recomputedOther.length}`);
  console.log(
    `  a backfill would resolve:       ${storedOther.length - recomputedOther.length} row(s) ` +
      `— see scripts/backfill-area.ts (dry by default)`
  );
  console.log('');
  console.log('  STORED is what the product shows and what "Near you" has. RECOMPUTED is what');
  console.log('  resolveArea returns NOW from the same fields. The gap is the backfill, not a bug.');

  console.log('\n═══ 2. WHICH AREAS — recomputed distribution (upcoming non-online) ═══\n');
  for (const [area, n] of bucketise(offline, recompute)) {
    const stored = offline.filter(r => (r.area ?? '(none)') === area).length;
    const flag = area !== '(none)' && area !== 'Other' && !BENGALURU_AREAS.includes(area) ? '  ← NOT IN BENGALURU_AREAS' : '';
    console.log(`  ${String(n).padStart(5)}  (stored ${String(stored).padStart(4)})  ${area}${flag}`);
  }

  console.log('\n═══ 3. THE MISSES — verbatim strings of rows that STILL resolve to Other ═══\n');
  console.log(`${recomputedOther.length} upcoming non-online rows resolve to 'Other' with the CURRENT gazetteer.`);
  console.log('Grouped by the exact venue | address | city triple, most frequent first. Widen against');
  console.log('THESE strings — most misses so far were misspellings of tokens already in the list.\n');

  const strings = new Map<string, { n: number; titles: string[]; sources: Set<string> }>();
  for (const r of recomputedOther) {
    const key = [r.venue ?? '', r.address ?? '', r.city ?? ''].join(' | ');
    const hit = strings.get(key) ?? { n: 0, titles: [], sources: new Set<string>() };
    hit.n++;
    if (hit.titles.length < 2) hit.titles.push(String(r.title ?? '').slice(0, 58));
    hit.sources.add(String(r.source ?? '?'));
    strings.set(key, hit);
  }
  const ranked = [...strings.entries()].sort((a, b) => b[1].n - a[1].n);
  console.log(`${ranked.length} distinct venue|address|city strings.\n`);
  for (const [key, v] of ranked.slice(0, LIMIT)) {
    const empty = key.replace(/[\s|]/g, '') === '';
    console.log(`  ${String(v.n).padStart(4)}×  ${empty ? '(ALL THREE FIELDS EMPTY)' : key}`);
    console.log(`         [${[...v.sources].join(',')}]  e.g. ${v.titles.join(' / ')}`);
  }
  if (ranked.length > LIMIT) console.log(`\n  … ${ranked.length - LIMIT} more (raise --limit=N)`);

  console.log('\n═══ 4. IS THERE ANYTHING TO GO ON? ═══\n');
  const noFields = recomputedOther.filter(
    r => !r.venue?.trim() && !r.address?.trim() && !r.city?.trim() && typeof r.lat !== 'number'
  );
  const coordsOnly = recomputedOther.filter(
    r => !r.venue?.trim() && !r.address?.trim() && !r.city?.trim() && typeof r.lat === 'number'
  );
  const cityOnly = recomputedOther.filter(r => !r.venue?.trim() && !r.address?.trim() && !!r.city?.trim());
  console.log(`  no location fields AND no coords   ${String(noFields.length).padStart(4)}  ← UNREACHABLE by any gazetteer`);
  console.log(`  coordinates but no text            ${String(coordsOnly.length).padStart(4)}  ← nearestAreaByCoords already tried, >4km from every centroid`);
  console.log(`  a city value but no venue/address  ${String(cityOnly.length).padStart(4)}`);
  console.log('');
  console.log('  The first row is the CEILING. A gazetteer cannot place a row with no strings in it,');
  console.log('  so 100% is not the target and a shortfall of that size is a supply cap, not a defect.');
  const reachable = recomputedOther.length - noFields.length;
  console.log(
    `\n  reachable misses: ${reachable} of ${offline.length} upcoming non-online ` +
      `→ ceiling ${pct(offline.length - noFields.length, offline.length)}`
  );

  await mongoose.disconnect();
}

main().catch(async e => {
  console.error(e);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
