#!/usr/bin/env tsx
/**
 * Live smoke test for the FOSS United adapter. No DB writes.
 *
 * Also exercises the IST parsing directly, because that is the one piece most likely to be
 * silently wrong: the site's <time datetime> values carry no timezone, so a bare
 * `new Date()` would read a 2 PM Bengaluru meetup in the server's zone.
 *
 * Run: npx tsx scripts/test-fossunited.ts
 */
import './load-env';
import { scrapeFossUnited } from '../lib/scrapers/adapters/fossunited';

async function main() {
  const r = await scrapeFossUnited();
  console.log(`${r.label} -> ${r.events.length} upcoming event(s) in ${(r.durationMs / 1000).toFixed(1)}s\n`);

  for (const e of [...r.events].sort((a, b) => +a.startDateTime - +b.startDateTime)) {
    console.log(`  ${e.startDateTime.toISOString()}  ${e.title.slice(0, 52)}`);
    console.log(`      host=${e.organizer}  tz=${e.timezone}  image=${e.imageUrl ? 'yes' : 'no'}`);
    console.log(`      ${e.sourceUrl}`);
  }

  if (r.events.length === 0) {
    console.log('  (none upcoming — expected when the monthly meetup for next month is not posted yet)');
  }

  if (r.errors.length) {
    console.log(`\nerrors (${r.errors.length}):`);
    for (const err of r.errors.slice(0, 4)) console.log(`  ${err}`);
  }

  // The timezone check, run against a known page rather than trusting the adapter's output.
  console.log('\nIST parsing check — a 2 PM Bengaluru meetup must be 08:30 UTC:');
  const { default: fetchModule } = await import('../lib/scrapers/core/http').then(m => ({ default: m }));
  const html = await fetchModule.fetchText('https://fossunited.org/c/bengaluru/july-2026', {
    timeoutMs: 25000,
  });
  const times = [...html.matchAll(/<time[^>]*datetime=["']([^"']+)["']/gi)].map(m => m[1]);
  console.log(`  raw datetime values: ${times.slice(0, 2).join(', ')}`);
  if (times[0]) {
    const naive = new Date(times[0]);
    console.log(`  new Date() (wrong on a UTC server): ${naive.toISOString()}`);
    console.log('  adapter treats it as Asia/Kolkata, so 14:00 IST -> 08:30 UTC');
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
