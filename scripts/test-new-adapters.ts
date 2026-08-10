#!/usr/bin/env tsx
/**
 * Live smoke test for the newest adapters: developers.events conferences and the
 * expanded Bevy tenant list. No DB writes.
 *
 * Run: npx tsx scripts/test-new-adapters.ts
 */
import './load-env';
import { scrapeDevEvents } from '../lib/scrapers/adapters/devevents';
import { scrapeBevy } from '../lib/scrapers/adapters/bevy';
import { ScrapeResult } from '../lib/scrapers/core/types';

function report(result: ScrapeResult) {
  console.log(
    `\n${result.events.length > 0 ? 'OK  ' : ' -  '} ${result.label} → ${result.events.length} events in ${(result.durationMs / 1000).toFixed(1)}s`
  );
  const sorted = [...result.events].sort(
    (a, b) => a.startDateTime.getTime() - b.startDateTime.getTime()
  );
  for (const e of sorted.slice(0, 14)) {
    console.log(
      `      ${e.startDateTime.toISOString().slice(0, 10)}  ${e.title.slice(0, 50).padEnd(50)} ${String(e.venue || e.city || '').slice(0, 26)}`
    );
  }
  if (result.errors.length) {
    console.log(`      errors (${result.errors.length}): ${result.errors.slice(0, 2).join(' | ').slice(0, 200)}`);
  }
}

async function main() {
  report(await scrapeDevEvents());
  report(await scrapeBevy());
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
