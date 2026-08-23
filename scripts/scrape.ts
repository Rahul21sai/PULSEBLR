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
 *
 * `--only` exists to verify ONE adapter end-to-end without paying for a full run
 * (~700 upstream requests, 5-10 min). It forces pruning off — see PipelineOptions.
 * Source ids: luma-city, luma-calendars, meetup-city, meetup-groups, bevy, devfolio,
 * unstop, allevents, devevents, hasgeek, fossunited, district, eventbrite, company-pages.
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
