#!/usr/bin/env tsx
/**
 * Live smoke test for the HasGeek adapter. No DB writes.
 *
 * Run: npx tsx scripts/test-hasgeek.ts
 */
import './load-env';
import { scrapeHasgeek } from '../lib/scrapers/adapters/hasgeek';

async function main() {
  const r = await scrapeHasgeek();
  console.log(`${r.label} -> ${r.events.length} events in ${(r.durationMs / 1000).toFixed(1)}s\n`);

  for (const e of [...r.events].sort((a, b) => +a.startDateTime - +b.startDateTime)) {
    console.log(
      `  ${e.startDateTime.toISOString().slice(0, 10)}  ` +
        `${e.title.slice(0, 50).padEnd(50)} ` +
        `${(e.organizer || '?').slice(0, 22).padEnd(22)} ` +
        `${(e.venue || e.city || e.address || '?').slice(0, 26)}`
    );
  }

  const cov = (f: (x: (typeof r.events)[number]) => unknown) =>
    r.events.length ? Math.round((r.events.filter(f).length / r.events.length) * 100) : 0;

  console.log(
    `\nfield coverage: venue ${cov(e => e.venue)}% · image ${cov(e => e.imageUrl)}% · ` +
      `organizer ${cov(e => e.organizer)}% · coords ${cov(e => e.lat !== undefined)}% · ` +
      `timezone ${cov(e => e.timezone)}% · description ${cov(e => e.description)}%`
  );

  if (r.errors.length) {
    console.log(`\nerrors (${r.errors.length}):`);
    for (const err of r.errors.slice(0, 4)) console.log(`  ${err}`);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
