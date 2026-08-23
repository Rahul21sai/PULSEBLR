#!/usr/bin/env tsx
/**
 * Characterise HasGeek's search endpoint before writing an adapter against it.
 *
 * WHY HASGEEK MATTERS: it hosts exactly the communities this product is for and that the
 * corpus is thinnest on — Rust Bangalore, The Fifth Elephant, Rootconf, Functional
 * Programming India, Bengaluru Systems Meetup, VizChitra — and none of them reliably
 * appear on Meetup or Luma.
 *
 * An earlier probe missed this endpoint entirely: hasgeek.com/api/1/events is a 404, and
 * the homepage serves 293KB of HTML with no JSON-LD, so HasGeek was written off as
 * dataless. The working route is /search with an Accept: application/json header, which
 * content-negotiates to a paginated JSON payload.
 *
 * Read-only.
 *
 * Run: npx tsx scripts/probe-hasgeek.ts
 */
import './load-env';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

interface HasgeekObj {
  title?: string;
  start_at?: string;
  end_at?: string;
  location?: string;
  timezone?: string;
  tagline?: string;
  bg_image?: string;
  buy_tickets_url?: string;
  absolute_url?: string;
  primary_venue?: { title?: string; city?: string; address?: string } | null;
  account?: { title?: string; urls?: Record<string, string> };
}

async function page(q: string, n: number) {
  const url = `https://hasgeek.com/search?q=${encodeURIComponent(q)}&type=project&page=${n}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as {
    results?: { count?: number; pages?: number; per_page?: number; items?: Array<{ obj?: HasgeekObj }> };
  };
  return body.results ?? {};
}

async function main() {
  const first = await page('bangalore', 1);
  console.log(`count=${first.count}  pages=${first.pages}  per_page=${first.per_page}\n`);

  const objs: HasgeekObj[] = [];
  const total = Math.min(first.pages ?? 1, 17);
  for (let n = 1; n <= total; n++) {
    const r = n === 1 ? first : await page('bangalore', n);
    for (const it of r.items ?? []) if (it.obj) objs.push(it.obj);
  }
  console.log(`collected ${objs.length} project(s) across ${total} page(s)\n`);

  const now = Date.now();
  const dated = objs.filter(o => o.start_at && !Number.isNaN(Date.parse(o.start_at)));
  const blr = objs.filter(o => /bengaluru|bangalore/i.test(`${o.location ?? ''} ${o.primary_venue?.city ?? ''}`));
  const upcoming = dated.filter(o => Date.parse(o.start_at!) > now);
  const upcomingBlr = upcoming.filter(o =>
    /bengaluru|bangalore/i.test(`${o.location ?? ''} ${o.primary_venue?.city ?? ''}`)
  );

  console.log(`dated:            ${dated.length}/${objs.length}`);
  console.log(`Bengaluru:        ${blr.length}/${objs.length}`);
  console.log(`UPCOMING:         ${upcoming.length}`);
  console.log(`UPCOMING + BLR:   ${upcomingBlr.length}\n`);

  console.log('Hosts (these are the point):');
  const hosts = new Map<string, number>();
  for (const o of objs) {
    const h = o.account?.title ?? '?';
    hosts.set(h, (hosts.get(h) ?? 0) + 1);
  }
  for (const [h, n] of [...hosts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18)) {
    console.log(`  ${String(n).padStart(3)}  ${h}`);
  }

  console.log('\nUpcoming, any city:');
  for (const o of upcoming.sort((a, b) => Date.parse(a.start_at!) - Date.parse(b.start_at!)).slice(0, 15)) {
    console.log(
      `  ${o.start_at!.slice(0, 10)}  ${(o.title ?? '').slice(0, 48).padEnd(48)} ${(o.location || o.primary_venue?.city || '?').slice(0, 24)}`
    );
  }

  console.log('\nField coverage on all projects:');
  const has = (f: (o: HasgeekObj) => unknown) => Math.round((objs.filter(f).length / objs.length) * 100);
  console.log(`  start_at        ${has(o => o.start_at)}%`);
  console.log(`  end_at          ${has(o => o.end_at)}%`);
  console.log(`  location        ${has(o => o.location)}%`);
  console.log(`  primary_venue   ${has(o => o.primary_venue)}%`);
  console.log(`  timezone        ${has(o => o.timezone)}%`);
  console.log(`  tagline         ${has(o => o.tagline)}%`);
  console.log(`  bg_image        ${has(o => o.bg_image)}%`);
  console.log(`  buy_tickets_url ${has(o => o.buy_tickets_url)}%`);
  console.log(`  absolute_url    ${has(o => o.absolute_url)}%`);
  console.log(`  account.title   ${has(o => o.account?.title)}%`);

  console.log('\nSample raw object:');
  console.log(JSON.stringify(upcoming[0] ?? objs[0], null, 2).slice(0, 900));
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
