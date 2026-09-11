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
 *   npx tsx scripts/scrape.ts --microsites-llm  arm LLM extraction on the microsite watchlist;
 *                                              lands rows as visibility:'pending' for review
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
    /*
     * ARM THE MICROSITE LLM EXTRACTION. Off unless asked, and this flag had to exist for the
     * pipeline's own log line to be true — it tells the operator to "pass --microsites-llm" and
     * nothing parsed it, so the LLM half was unreachable even with intent.
     *
     * The JSON-LD and platform-detection halves of that stage need no flag and run on every scrape:
     * they cost one HTTP request per watchlist page and deliver Bengaluru Tech Summit and GIDS
     * directly from the organisers' own schema.org markup. Only the render + model step is gated,
     * because it launches a browser, spends frontier-model budget, and lands rows as
     * `visibility: 'pending'` — a queue a human then has to empty.
     *
     * DO NOT PUT THIS IN `daily-scrape.yml` UNTIL THE REVIEW QUEUE CAN EDIT. The submissions panel
     * approves or rejects; it cannot correct a field. The one live extraction so far took the page's
     * `<title>`, so approving it unedited would publish "Open Source India | India's #1 Open Source
     * Event" as an event name. That is a UI gap, not an extraction one, and it is the reason this is
     * a manual flag rather than a nightly default.
     */
    micrositeCandidates: argv.includes('--microsites-llm'),
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
