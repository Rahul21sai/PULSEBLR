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

/**
 * Update or create a source record
 */
export async function updateSource(name: string, type: string, url: string): Promise<void> {
  await connectDB();
  
  await Source.findOneAndUpdate(
    { name, url },
    {
      name,
      type,
      url,
      lastScrapedAt: new Date(),
      $setOnInsert: { enabled: true, scrapeFrequency: 'daily' },
    },
    { upsert: true, new: true }
  );
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

// Made with Bob