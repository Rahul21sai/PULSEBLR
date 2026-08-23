#!/usr/bin/env tsx
/**
 * Verify the FEED over HTTP, the way the app actually serves it.
 *
 * Every other diagnostic here reads MongoDB directly. That proves the data is right; it does not
 * prove `/api/events` and `/api/events/facets` agree with it, and those two share `lib/events/
 * query.ts` precisely so the list and the counts beside the filters can never disagree — a claim
 * worth checking rather than trusting.
 *
 * It also asserts the invariant that keeps the default view honest: with `techOnly=true`, every
 * returned event must carry `isTechEvent`, and the facet total must equal the pagination total.
 *
 * Needs a dev server on :3000. Read-only — GETs only.
 *
 * Run: npx tsx scripts/diag-feed-http.ts
 */
import './load-env';

const BASE = process.env.DIAG_BASE_URL ?? 'http://localhost:3000';

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${res.status} for ${path}`);
  return (await res.json()) as T;
}

interface FeedResponse {
  events: Array<{
    title: string;
    isTechEvent?: boolean;
    category?: string[];
    connectionScore?: number;
    imageUrl?: string;
    venue?: string;
  }>;
  pagination: { total: number };
}
/**
 * `/api/events/facets` returns these keys at the TOP LEVEL — there is no `facets` wrapper. Worth
 * stating, because the client shape in lib/event-types.ts is named `Facets` and it is easy to
 * assume a `{ facets: … }` envelope; assuming one here produced a bare "cannot read properties of
 * undefined" that looked like the server being down.
 */
interface FacetResponse {
  categories: Record<string, number>;
  areas: Record<string, number>;
  sources: Record<string, number>;
  formats: Record<string, number>;
  companies: Record<string, number>;
  totals: { total: number; free: number; withFood: number; tech: number };
}

async function main() {
  console.log(`${BASE}\n`);

  const all = await get<FacetResponse>('/api/events/facets?techOnly=false');
  const t = all.totals;
  console.log(`upcoming ${t.total}  ·  tech ${t.tech}  ·  free ${t.free}  ·  with food ${t.withFood}`);
  console.log(
    '\nsources: ' +
      Object.entries(all.sources)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}=${v}`)
        .join('  ')
  );
  console.log(
    `\nHardware/Robotics ${all.categories['Hardware/Robotics'] ?? 0}  ·  ` +
      `Open Source ${all.categories['Open Source'] ?? 0}  ·  ` +
      `companies with events ${Object.keys(all.companies).length}`
  );

  console.log('\n══ the list and the counts must agree ══\n');

  const techFeed = await get<FeedResponse>('/api/events?limit=20&techOnly=true');
  const techFacets = await get<FacetResponse>('/api/events/facets?techOnly=true');

  check(
    'techOnly list total == techOnly facet total',
    techFeed.pagination.total === techFacets.totals.total,
    `${techFeed.pagination.total} vs ${techFacets.totals.total}`
  );
  check(
    'techOnly facet total == unfiltered facet tech count',
    techFacets.totals.total === t.tech,
    `${techFacets.totals.total} vs ${t.tech}`
  );

  console.log('\n══ the default view must contain only tech events ══\n');
  const nonTech = techFeed.events.filter(e => !e.isTechEvent);
  check('every event on page 1 is isTechEvent', nonTech.length === 0, `${nonTech.length} not flagged`);
  for (const e of nonTech) console.log(`        ${e.title.slice(0, 60)}`);

  // The rows a user actually reads first. A count is not a ranking, so look at the ranking.
  console.log('\n══ first 10 of the default feed ══\n');
  for (const e of techFeed.events.slice(0, 10)) {
    console.log(
      `  score ${String(e.connectionScore ?? '-').padStart(3)}  ${e.title.slice(0, 48).padEnd(48)} [${(e.category || []).join(', ')}]`
    );
  }

  const covered = techFeed.events.filter(e => e.imageUrl).length;
  check(
    'cover images on page 1 >= 60%',
    covered / Math.max(1, techFeed.events.length) >= 0.6,
    `${covered}/${techFeed.events.length}`
  );

  console.log(`\n${failures === 0 ? 'OK — the API agrees with itself' : `${failures} assertion(s) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}`);
  console.error('Needs a dev server on :3000 (npm run dev), or set DIAG_BASE_URL.');
  process.exit(1);
});
