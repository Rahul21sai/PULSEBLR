import { scrapeMeetupGroups, BANGALORE_MEETUP_GROUPS } from './meetup-rss';
import { scrapeLumaCalendars, BANGALORE_LUMA_CALENDARS } from './luma';
import { normalizeEvents, normalizeEventWithLLM } from './normalizer';
import { ingestEvents, IngestionResult, updateSource } from './ingestion';
import { ScraperResult } from './types';

export interface ScraperRunResult {
  totalScraped: number;
  totalNormalized: number;
  ingestion: IngestionResult;
  errors: string[];
  duration: number;
  timestamp: Date;
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
  
  // 1. Scrape Meetup RSS feeds
  try {
    console.log('📡 Scraping Meetup groups...');
    const meetupResult = await scrapeMeetupGroups(BANGALORE_MEETUP_GROUPS);
    allRawEvents.push(...meetupResult.events);
    allErrors.push(...meetupResult.errors);
    console.log(`✅ Meetup: ${meetupResult.events.length} events, ${meetupResult.errors.length} errors`);
    
    // Update source records for each Meetup group
    for (const group of BANGALORE_MEETUP_GROUPS) {
      await updateSource(group.name, 'rss', group.rssUrl);
    }
  } catch (error: any) {
    allErrors.push(`Meetup scraper failed: ${error.message}`);
    console.error('❌ Meetup scraper error:', error);
  }
  
  // 2. Scrape Luma calendars
  try {
    console.log('📡 Scraping Luma calendars...');
    const lumaResult = await scrapeLumaCalendars(BANGALORE_LUMA_CALENDARS);
    allRawEvents.push(...lumaResult.events);
    allErrors.push(...lumaResult.errors);
    console.log(`✅ Luma: ${lumaResult.events.length} events, ${lumaResult.errors.length} errors`);
    
    // Update source records for each Luma calendar
    for (const calendar of BANGALORE_LUMA_CALENDARS) {
      await updateSource(calendar.name, 'scrape', calendar.url);
    }
  } catch (error: any) {
    allErrors.push(`Luma scraper failed: ${error.message}`);
    console.error('❌ Luma scraper error:', error);
  }
  
  // 3. Normalize events with LLM tagging
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
  
  // 4. Ingest into database
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

// Made with Bob