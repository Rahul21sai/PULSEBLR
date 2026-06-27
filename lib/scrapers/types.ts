// Common types for all scrapers

export interface RawEvent {
  title: string;
  description: string;
  sourceUrl: string;
  organizer?: string;
  venue?: string;
  onlineLink?: string;
  startDateTime: Date;
  endDateTime?: Date;
  applyLink?: string;
  registrationDeadline?: Date;
  // These will be auto-tagged by LLM in Phase 3
  rawCategory?: string[];
  rawFormat?: string;
  rawHasFood?: string;
}

export interface NormalizedEvent {
  title: string;
  description: string;
  source: string;
  sourceUrl: string;
  organizer?: string;
  category: string[];
  format: 'online' | 'offline' | 'hybrid';
  hasFood: 'yes' | 'no' | 'unknown';
  isFree: boolean;
  price?: number;
  venue?: string;
  area?: string;
  onlineLink?: string;
  startDateTime: Date;
  endDateTime?: Date;
  applyLink?: string;
  registrationDeadline?: Date;
  dedupHash: string;
  // Phase 6 fields
  isTargetCompany?: boolean;
  recruiterMentioned?: boolean;
  guestCount?: number;
}

export interface ScraperConfig {
  name: string;
  type: 'ical' | 'rss' | 'api' | 'scrape';
  url: string;
  enabled: boolean;
}

export interface ScraperResult {
  source: string;
  events: RawEvent[];
  errors: string[];
  scrapedAt: Date;
}

// Made with Bob