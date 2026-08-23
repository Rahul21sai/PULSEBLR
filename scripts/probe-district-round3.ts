#!/usr/bin/env tsx
/**
 * Round 3 on District: is the yield REAL events, or evergreen adverts?
 *
 * Round 2 proved the mechanism works — sitemap for discovery, JSON-LD Event for extraction,
 * no browser needed. 6,316 event URLs, 365 with Bengaluru in the slug.
 *
 * But two of three sampled pages reported `startDate` = TODAY for a permanent attraction
 * (an amusement park, a vineyard tour). That is precisely the evergreen listing CLAUDE.md
 * records as having sat at the top of the feed forever, and `pipeline.ts` rejects such
 * listings at the source. So the decisive number is not "how many URLs" but:
 *
 *   1. how many carry a JSON-LD Event at all (sample 3 had 1, 3 and ZERO)
 *   2. how many are dated events rather than always-on attractions
 *   3. field coverage, so the adapter's value is known before it is written
 *
 * It also checks the two child sitemaps round 2 did not follow, and whether the slug's own
 * date can pre-filter the fetch list — these pages are 90-830 KB, so fetching all 365 daily
 * would be the most expensive thing in the pipeline by an order of magnitude.
 *
 * Read-only.
 *
 * Run: npx tsx scripts/probe-district-round3.ts
 */
import './load-env';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

const SAMPLE = 24;
const CONCURRENCY = 4;

async function get(url: string, accept = 'text/html') {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'en-IN,en;q=0.9' },
      signal: AbortSignal.timeout(30000),
      redirect: 'follow',
    });
    return { status: res.status, text: await res.text() };
  } catch (err) {
    return { status: 0, text: '', error: err instanceof Error ? err.message : String(err) };
  }
}

function eventNodes(html: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const block of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (!node || typeof node !== 'object') return;
        const o = node as Record<string, unknown>;
        const t = o['@type'];
        if ((Array.isArray(t) ? t : [t]).some(x => typeof x === 'string' && /^(\w*Event)$/i.test(x))) out.push(o);
        Object.values(o).forEach(walk);
      };
      walk(JSON.parse(block[1]));
    } catch {
      /* ignore */
    }
  }
  return out;
}

/** Slugs embed a date: `...-bengaluru-apr19-2026-buy-tickets`, `...-nov-2025-...`. */
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function slugDate(url: string): Date | null {
  const m = url.match(new RegExp(`-(${MONTHS.join('|')})(\\d{1,2})?-(20\\d{2})-`, 'i'));
  if (!m) return null;
  const month = MONTHS.indexOf(m[1].toLowerCase());
  const day = m[2] ? Number.parseInt(m[2], 10) : 28; // no day in slug → end of month, so we don't discard it early
  return new Date(Date.UTC(Number.parseInt(m[3], 10), month, day, 18, 30));
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}

async function main() {
  const now = new Date();

  console.log('══ 1. All three child sitemaps ══\n');
  const index = await get('https://www.district.in/events/search-sitemap/sitemap-events.xml', 'application/xml');
  const children = [...index.text.matchAll(/<loc>([^<]+\.xml)<\/loc>/g)].map(m => m[1]);
  const allUrls = new Set<string>();
  for (const child of children) {
    const r = await get(child, 'application/xml');
    const locs = [...r.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]).filter(l => !l.endsWith('.xml'));
    locs.forEach(l => allUrls.add(l));
    const blr = locs.filter(l => /bengaluru|bangalore/i.test(l)).length;
    console.log(`  ${r.status}  ${String(locs.length).padStart(5)} URL(s), ${String(blr).padStart(4)} Bengaluru  ${child.split('/').pop()}`);
  }

  const blrUrls = [...allUrls].filter(u => /bengaluru|bangalore/i.test(u));
  console.log(`\n  union: ${allUrls.size} URLs, ${blrUrls.length} Bengaluru`);

  console.log('\n══ 2. Can the slug pre-filter the fetch list? ══\n');
  let past = 0, future = 0, undated = 0;
  const fetchable: string[] = [];
  for (const u of blrUrls) {
    const d = slugDate(u);
    if (!d) { undated++; fetchable.push(u); continue; }
    if (d < now) { past++; continue; }
    future++; fetchable.push(u);
  }
  console.log(`  slug date in the past:   ${past}  (skippable without a request)`);
  console.log(`  slug date in the future: ${future}`);
  console.log(`  no date in the slug:     ${undated}  (must fetch to know)`);
  console.log(`  → daily fetch list: ${fetchable.length} of ${blrUrls.length} (${Math.round((fetchable.length / blrUrls.length) * 100)}%)`);

  console.log(`\n══ 3. ${SAMPLE} pages — how many are REAL dated events? ══\n`);
  // Sample across the list rather than the head, so we don't measure one publisher.
  const step = Math.max(1, Math.floor(fetchable.length / SAMPLE));
  const sample = fetchable.filter((_, i) => i % step === 0).slice(0, SAMPLE);

  const rows = await mapPool(sample, CONCURRENCY, async url => {
    const page = await get(url);
    const nodes = eventNodes(page.text);
    const e = nodes[0];
    if (!e) return { url, ok: false as const, bytes: page.text.length };

    const start = e.startDate ? new Date(String(e.startDate)) : null;
    const end = e.endDate ? new Date(String(e.endDate)) : null;
    const valid = start && !Number.isNaN(start.getTime());
    const spanDays = valid && end && !Number.isNaN(end.getTime())
      ? Math.round((end.getTime() - start.getTime()) / 86400000)
      : 0;

    const loc = e.location as Record<string, unknown> | undefined;
    const offers = e.offers as Record<string, unknown> | undefined;
    return {
      url,
      ok: true as const,
      bytes: page.text.length,
      name: String(e.name ?? ''),
      start: valid ? start! : null,
      spanDays,
      venue: typeof loc?.name === 'string' ? loc.name : '',
      address: typeof loc?.address === 'string' ? loc.address : (loc?.address ? 'obj' : ''),
      image: Boolean(e.image),
      description: typeof e.description === 'string' ? e.description.length : 0,
      price: offers?.price ?? offers?.lowPrice ?? '',
      organizer: (e.organizer as Record<string, unknown> | undefined)?.name ?? '',
    };
  });

  const withEvent = rows.filter(r => r.ok);
  const startToday = withEvent.filter(r => r.start && Math.abs(r.start.getTime() - now.getTime()) < 36 * 3600e3);
  const longSpan = withEvent.filter(r => r.spanDays > 30);
  const realDated = withEvent.filter(r => r.start && r.spanDays <= 30 && !(Math.abs(r.start.getTime() - now.getTime()) < 36 * 3600e3));

  console.log(`  fetched               ${rows.length}`);
  console.log(`  JSON-LD Event present ${withEvent.length}  (${Math.round((withEvent.length / rows.length) * 100)}%)`);
  console.log(`  starts ~today         ${startToday.length}  ← evergreen attraction signature`);
  console.log(`  span > 30 days        ${longSpan.length}  ← pipeline.ts rejects these`);
  console.log(`  REAL dated events     ${realDated.length}  (${Math.round((realDated.length / rows.length) * 100)}% of fetched)`);
  console.log(`  avg page size         ${Math.round(rows.reduce((s, r) => s + r.bytes, 0) / rows.length / 1024)} KB`);

  if (withEvent.length) {
    const pct = (n: number) => `${Math.round((n / withEvent.length) * 100)}%`;
    console.log('\n  field coverage (of pages with an Event node):');
    console.log(`    venue        ${pct(withEvent.filter(r => r.ok && r.venue).length)}`);
    console.log(`    address      ${pct(withEvent.filter(r => r.ok && r.address).length)}`);
    console.log(`    image        ${pct(withEvent.filter(r => r.ok && r.image).length)}`);
    console.log(`    description  ${pct(withEvent.filter(r => r.ok && r.description > 50).length)}`);
    console.log(`    price        ${pct(withEvent.filter(r => r.ok && r.price !== '' ).length)}`);
    console.log(`    organizer    ${pct(withEvent.filter(r => r.ok && r.organizer).length)}`);
  }

  console.log('\n  the real dated ones:');
  for (const r of realDated.slice(0, 12)) {
    if (!r.ok) continue;
    console.log(`    ${r.start!.toISOString().slice(0, 10)}  ${r.name.slice(0, 52).padEnd(52)} ${r.venue.slice(0, 26)}`);
  }

  console.log('\n  rejected, and why:');
  for (const r of rows) {
    if (!r.ok) { console.log(`    no Event node   ${r.url.split('/').pop()?.slice(0, 62)}`); continue; }
    if (startToday.includes(r)) console.log(`    starts today    ${r.name.slice(0, 46)} (span ${r.spanDays}d)`);
    else if (longSpan.includes(r)) console.log(`    span ${String(r.spanDays).padStart(4)}d      ${r.name.slice(0, 46)}`);
  }

  console.log('\n  is ANY of this tech?');
  const techish = withEvent.filter(r => r.ok && /\b(tech|dev|developer|ai|ml|data|cloud|code|coding|hack|startup|founder|product|design|engineer|python|java|linux|open ?source|devops|cyber|security|api|web3|blockchain)\b/i.test(`${r.name} ${r.venue}`));
  console.log(`    ${techish.length} of ${withEvent.length} sampled titles carry tech vocabulary`);
  for (const r of techish.slice(0, 8)) if (r.ok) console.log(`      ${r.name.slice(0, 66)}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
