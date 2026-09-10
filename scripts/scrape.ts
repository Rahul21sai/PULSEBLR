#!/usr/bin/env tsx
/**
 * Scraper runner.
 *
 * Usage:
 *   npm run scrape                  full run (LLM tagging, all sources)
 *   npx tsx scripts/scrape.ts --no-llm        keyword tagging only (fast)
 *   npx tsx scripts/scrape.ts --fast          skip Eventbrite + company sweep
 *   npx tsx scripts/scrape.ts --no-prune      keep stale past events
 *   npx tsx scripts/scrape.ts --only=district,hasgeek   run just those sources
 *   npx tsx scripts/scrape.ts --no-second-pass  skip the Meetup /events/ follow-up
 *   npx tsx scripts/scrape.ts --render          allow a headless browser as the LAST-RESORT
 *                                               fallback for a Meetup group page (Actions only)
 *
 * `--only` exists to verify ONE adapter end-to-end without paying for a full run
 * (~700 upstream requests, 5-10 min). It forces pruning off — see PipelineOptions.
 * Source ids: luma-city, luma-calendars, meetup-city, meetup-groups, bevy, devfolio,
 * unstop, allevents, devevents, hasgeek, fossunited, district, eventbrite, company-pages.
 *
 * ── `--render` BELONGS TO THIS SCRIPT AND TO NOWHERE ELSE ────────────────────────────────────
 *
 * Meetup's per-group ICS feed caps at ten events; the second pass reads the group's `/events/`
 * page to recover the rest and is ON by default, because 74 of 261 groups were sitting on that
 * ceiling. It needs no browser — the events are server-rendered into the page's `__NEXT_DATA__`
 * island and a plain fetch reads them in ~1 s.
 *
 * `--render` turns on a headless-browser FALLBACK for the day that stops being true. It is a flag
 * on this runner and not a default anywhere, because the other caller of `runPipeline` is
 * `POST /api/scrape`, i.e. a Vercel function, which cannot run Chromium and should not carry a
 * ~470 MB dependency for a path it can never take. `daily-scrape.yml` runs THIS script on a
 * GitHub runner, which can — see the workflow for why that split is what makes serverless
 * hosting viable at all.
 *
 * `--no-second-pass` exists for cost triage, not for normal use: the run still counts and REPORTS
 * every truncated group when it is set, so switching the fix off cannot quietly restore a silent
 * ceiling.
 * ────────────────────────────────────────────────────────────────────────────────────────────
 */

import './load-env'; // MUST be first — populates process.env before lib/mongodb reads it
import { runPipeline, PipelineOptions } from '../lib/scrapers/pipeline';

function parseArgs(): PipelineOptions {
  const argv = process.argv.slice(2);
  const fast = argv.includes('--fast');

  const onlyArg = argv.find(a => a.startsWith('--only='));
  const onlySources = onlyArg
    ? onlyArg
        .slice('--only='.length)
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
    : [];

  return {
    skipLlm: argv.includes('--no-llm'),
    includeEventbrite: !fast,
    includeCompanyPages: !fast,
    prune: !argv.includes('--no-prune'),
    // Default ON — see the header. `--fast` deliberately does NOT switch it off: the whole point
    // of `--fast` is to skip the two SLOW sweeps (Eventbrite, company pages), and the second pass
    // is ~74 plain requests that roughly double the largest source in the corpus.
    meetupSecondPass: !argv.includes('--no-second-pass'),
    renderCappedGroups: argv.includes('--render'),
    onlySources,
    ...(fast ? { lumaEnrichBudget: 20, meetupEnrichBudget: 20 } : {}),
  };
}

async function main() {
  console.log('='.repeat(60));
  console.log('PulseBLR Event Scraper');
  console.log('='.repeat(60));

  try {
    const result = await runPipeline(parseArgs());

    if (result.errors.length > 0) {
      console.log(`Warnings/errors (${result.errors.length}):`);
      result.errors.slice(0, 25).forEach((error, i) => console.log(`  ${i + 1}. ${error}`));
      if (result.errors.length > 25) console.log(`  … and ${result.errors.length - 25} more`);
      console.log('');
    }

    if (result.ingestion.errorDetails.length > 0) {
      console.log('Ingestion errors:');
      result.ingestion.errorDetails
        .slice(0, 15)
        .forEach((error, i) => console.log(`  ${i + 1}. ${error}`));
      console.log('');
    }

    // Only a genuine ingestion failure is a non-zero exit. Per-source warnings are
    // expected in normal operation (a group with no upcoming events, a company page
    // that publishes no structured data) and must not fail the scheduled workflow.
    process.exit(result.ingestion.errors > 0 ? 1 : 0);
  } catch (error) {
    console.error('\nFatal error running scrapers:');
    console.error(error);
    process.exit(1);
  }
}

main();
