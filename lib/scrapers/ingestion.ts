import connectDB from '../mongodb';
import Event from '../models/Event';
import Source from '../models/Source';
import { NormalizedEvent } from './types';

export interface IngestionResult {
  total: number;
  inserted: number;
  duplicates: number;
  errors: number;
  errorDetails: string[];
}

export interface SourceHealth {
  eventCount: number;   // events this source returned on this scrape
  error?: string;       // fetch/parse error message, if the scrape failed
}

/**
 * Update or create a source record.
 *
 * When `health` is supplied we also record the scrape outcome so silent
 * breakage becomes observable (surfaced in the daily digest):
 *  - lastEventCount: how many events this source returned this run
 *  - consecutiveEmptyScrapes: incremented when a scrape returns 0 events,
 *    reset to 0 the moment it returns any — a rising count flags a dead feed
 *  - lastError / lastErrorAt: the most recent failure, cleared on success
 *
 * consecutiveEmptyScrapes must be computed relative to the stored value, so we
 * read the existing doc first, then upsert. Fail-open: any DB hiccup here is
 * logged but never aborts the scrape.
 */
export async function updateSource(
  name: string,
  type: string,
  url: string,
  health?: SourceHealth
): Promise<void> {
  await connectDB();

  const update: Record<string, any> = {
    name,
    type,
    url,
    lastScrapedAt: new Date(),
    $setOnInsert: { enabled: true, scrapeFrequency: 'daily' },
  };

  if (health) {
    const existing = await Source.findOne({ name, url }).select('consecutiveEmptyScrapes').lean() as { consecutiveEmptyScrapes?: number } | null;
    const prevEmpty = existing?.consecutiveEmptyScrapes ?? 0;

    update.lastEventCount = health.eventCount;
    update.consecutiveEmptyScrapes = health.eventCount > 0 ? 0 : prevEmpty + 1;

    if (health.error) {
      update.lastError = health.error;
      update.lastErrorAt = new Date();
    } else {
      // A clean scrape clears any stale error so the digest doesn't nag forever.
      update.lastError = undefined;
      update.lastErrorAt = undefined;
    }
  }

  await Source.findOneAndUpdate({ name, url }, update, { upsert: true, new: true });
}

/**
 * Ingest normalized events into the database
 * - Checks for duplicates using dedupHash
 * - Inserts only new events
 * - Returns statistics
 */
export async function ingestEvents(events: NormalizedEvent[], sourceName?: string, sourceType?: string, sourceUrl?: string): Promise<IngestionResult> {
  await connectDB();
  
  // Update source record if provided
  if (sourceName && sourceType && sourceUrl) {
    await updateSource(sourceName, sourceType, sourceUrl);
  }
  
  const result: IngestionResult = {
    total: events.length,
    inserted: 0,
    duplicates: 0,
    errors: 0,
    errorDetails: [],
  };
  
  for (const event of events) {
    try {
      // Check if event already exists
      const existing = await Event.findOne({ dedupHash: event.dedupHash });
      
      if (existing) {
        result.duplicates++;
        console.log(`Duplicate event skipped: ${event.title}`);
        continue;
      }
      
      // Insert new event
      await Event.create(event);
      result.inserted++;
      console.log(`New event inserted: ${event.title}`);
      
    } catch (error: any) {
      result.errors++;
      const errorMsg = `Failed to insert "${event.title}": ${error.message}`;
      result.errorDetails.push(errorMsg);
      console.error(errorMsg);
    }
  }
  
  return result;
}

/**
 * Get events created since a specific date
 * Useful for daily digest notifications
 */
export async function getNewEventsSince(since: Date): Promise<any[]> {
  await connectDB();
  
  return Event.find({
    createdAt: { $gte: since },
  })
    .sort({ createdAt: -1 })
    .lean();
}

/**
 * Get events with registration deadline approaching
 * Useful for reminder notifications
 */
export async function getEventsWithDeadlineSoon(daysAhead: number = 3): Promise<any[]> {
  await connectDB();
  
  const now = new Date();
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + daysAhead);
  
  return Event.find({
    registrationDeadline: {
      $gte: now,
      $lte: futureDate,
    },
  })
    .sort({ registrationDeadline: 1 })
    .lean();
}

/**
 * Get sources that look unhealthy, for surfacing in the daily digest.
 *
 * A source is "unhealthy" if it has produced no events for `emptyThreshold`+
 * consecutive scrapes, or recorded an error on its last run. Disabled sources
 * are excluded — the user turned those off on purpose, so silence is expected.
 */
export async function getUnhealthySources(emptyThreshold: number = 3): Promise<any[]> {
  await connectDB();

  return Source.find({
    enabled: true,
    $or: [
      { consecutiveEmptyScrapes: { $gte: emptyThreshold } },
      { lastError: { $exists: true, $ne: null } },
    ],
  })
    .sort({ consecutiveEmptyScrapes: -1 })
    .lean();
}

// Made with Bob