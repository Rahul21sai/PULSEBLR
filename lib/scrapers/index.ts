import { scrapeMeetupRSS, scrapeMeetupGroups, BANGALORE_MEETUP_GROUPS } from './meetup-rss';
import { scrapeLumaCalendar, scrapeLumaCalendars, BANGALORE_LUMA_CALENDARS } from './luma';
import { scrapeDevfolio, DEVFOLIO_SOURCE } from './devfolio';
import { normalizeEvents, normalizeEventWithLLM } from './normalizer';
import { ingestEvents, IngestionResult, updateSource } from './ingestion';
import { ScraperResult } from './types';
import connectDB from '../mongodb';
import Source from '../models/Source';

export interface ScraperRunResult {
  totalScraped: number;
  totalNormalized: number;
  ingestion: IngestionResult;
  errors: string[];
  duration: number;
  timestamp: Date;
}

/**
 * Load the URLs of sources the user has explicitly disabled in Settings.
 *
 * The hardcoded BANGALORE_* arrays are canonical — they define which sources
 * exist. The Source collection is a mirror populated as a side-effect of
 * scraping, but its `enabled` flag is the ONE piece of state the user controls
 * from the Settings UI. Honoring it here is what makes the toggle real.
 *
 * Fail-open by design: if the DB is unreachable or empty (e.g. first-ever run),
 * we return an empty set so every source is scraped. A user must have
 * deliberately toggled a source off for it to be skipped — we never silently
 * drop a source because of an infra hiccup.
 */
async function getDisabledSourceUrls(): Promise<Set<string>> {
  try {
    await connectDB();
    const disabled = await Source.find({ enabled: false }).select('url').lean();
    return new Set(disabled.map((s: any) => s.url));
  } catch (error: any) {
    console.warn(`⚠️  Could not load disabled sources (scraping all): ${error.message}`);
    return new Set();
  }
}

/**
 * Main scraper orchestrator
 * Runs all scrapers, normalizes events, and ingests into database
 */
export async function runAllScrapers(): Promise<ScraperRunResult> {
  const startTime = Date.now();
  const timestamp = new Date();
  
  console.log('🚀 Starting scraper run...');
  
  const allErrors: string[] = [];
  const allRawEvents: any[] = [];

  // Respect the Settings enable/disable toggle: drop any source the user has
  // turned off. Defaults stay canonical; the DB can only subtract (fail-open).
  const disabledUrls = await getDisabledSourceUrls();
  const meetupGroups = BANGALORE_MEETUP_GROUPS.filter(u => !disabledUrls.has(u));
  const lumaCalendars = BANGALORE_LUMA_CALENDARS.filter(u => !disabledUrls.has(u));
  if (disabledUrls.size > 0) {
    console.log(`🔕 ${disabledUrls.size} source(s) disabled in Settings — skipping them.`);
  }

  // 1. Scrape Meetup RSS feeds — per-source so we can record each feed's health.
  // Scraping one URL at a time (vs the combined scrapeMeetupGroups) lets us
  // attribute event counts and errors to the exact source that produced them,
  // which is what makes the digest's "dead source" alert meaningful.
  console.log('📡 Scraping Meetup groups...');
  for (const url of meetupGroups) {
    const name = url.split('/')[4] || url;
    try {
      const result = await scrapeMeetupRSS(url);
      allRawEvents.push(...result.events);
      allErrors.push(...result.errors);
      await updateSource(name, 'rss', url, {
        eventCount: result.events.length,
        error: result.errors.length > 0 ? result.errors.join('; ') : undefined,
      });
    } catch (error: any) {
      allErrors.push(`Meetup scraper failed (${name}): ${error.message}`);
      console.error(`❌ Meetup scraper error (${name}):`, error);
      await updateSource(name, 'rss', url, { eventCount: 0, error: error.message });
    }
  }

  // 2. Scrape Luma calendars — same per-source health recording.
  console.log('📡 Scraping Luma calendars...');
  for (const url of lumaCalendars) {
    const name = url.split('/').pop() || url;
    try {
      const result = await scrapeLumaCalendar(url);
      allRawEvents.push(...result.events);
      allErrors.push(...result.errors);
      await updateSource(name, 'scrape', url, {
        eventCount: result.events.length,
        error: result.errors.length > 0 ? result.errors.join('; ') : undefined,
      });
      // Rate limiting — match the spacing scrapeLumaCalendars used.
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (error: any) {
      allErrors.push(`Luma scraper failed (${name}): ${error.message}`);
      console.error(`❌ Luma scraper error (${name}):`, error);
      await updateSource(name, 'scrape', url, { eventCount: 0, error: error.message });
    }
  }
  
  // 3. Scrape Devfolio hackathons — a single public JSON API call, so no
  // per-URL loop. Same fail-open disable toggle and per-source health recording
  // as the feeds above. (Devfolio is the only Tier-3 platform with a usable
  // public feed; AllEvents.in / 10times / KonfHub were investigated and
  // rejected — see the comment block in devfolio.ts.)
  if (!disabledUrls.has(DEVFOLIO_SOURCE.url)) {
    console.log('📡 Scraping Devfolio hackathons...');
    try {
      const result = await scrapeDevfolio();
      allRawEvents.push(...result.events);
      allErrors.push(...result.errors);
      await updateSource(DEVFOLIO_SOURCE.name, DEVFOLIO_SOURCE.type, DEVFOLIO_SOURCE.url, {
        eventCount: result.events.length,
        error: result.errors.length > 0 ? result.errors.join('; ') : undefined,
      });
    } catch (error: any) {
      allErrors.push(`Devfolio scraper failed: ${error.message}`);
      console.error('❌ Devfolio scraper error:', error);
      await updateSource(DEVFOLIO_SOURCE.name, DEVFOLIO_SOURCE.type, DEVFOLIO_SOURCE.url, {
        eventCount: 0,
        error: error.message,
      });
    }
  }

  // 4. Normalize events with LLM tagging
  console.log('🔄 Normalizing events with LLM tagging...');
  const normalizedEvents = [];
  
  for (const event of allRawEvents) {
    try {
      const source = event.source || 'unknown';
      const normalized = await normalizeEventWithLLM(event, source);
      normalizedEvents.push(normalized);
    } catch (error: any) {
      console.error(`Failed to normalize event: ${error.message}`);
      allErrors.push(`Normalization error: ${error.message}`);
    }
  }
  
  console.log(`✅ Normalized ${normalizedEvents.length} events`);
  
  // 5. Ingest into database
  console.log('💾 Ingesting events into database...');
  const ingestionResult = await ingestEvents(normalizedEvents);
  
  console.log(`✅ Ingestion complete: ${ingestionResult.inserted} new, ${ingestionResult.duplicates} duplicates, ${ingestionResult.errors} errors`);
  
  const duration = Date.now() - startTime;
  
  const result: ScraperRunResult = {
    totalScraped: allRawEvents.length,
    totalNormalized: normalizedEvents.length,
    ingestion: ingestionResult,
    errors: allErrors,
    duration,
    timestamp,
  };
  
  console.log(`🎉 Scraper run complete in ${(duration / 1000).toFixed(2)}s`);
  console.log(`📊 Summary: ${result.totalScraped} scraped → ${result.totalNormalized} normalized → ${ingestionResult.inserted} inserted`);
  
  return result;
}

/**
 * Run specific scrapers
 */
export async function runMeetupScraper(): Promise<ScraperResult> {
  return scrapeMeetupGroups(BANGALORE_MEETUP_GROUPS);
}

export async function runLumaScraper(): Promise<ScraperResult> {
  return scrapeLumaCalendars(BANGALORE_LUMA_CALENDARS);
}

// Export all scraper functions
export * from './types';
export * from './normalizer';
export * from './ingestion';
export * from './meetup-rss';
export * from './luma';
export * from './devfolio';

// Made with Bob