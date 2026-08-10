// RawEvent → NormalizedEvent.
//
// The normalizer's job is to turn whatever an adapter could scrape into a
// schema-valid document, and to do so WITHOUT inventing facts. The guiding rule
// throughout: a value the adapter actually observed always beats a value we could
// guess. Luma tells us `is_free` and the exact ticket price — that must never be
// overwritten by a keyword scan for the word "free" in the description, which was
// the old behaviour and mislabelled paid events as free.

import Event from '../models/Event';
import { RawEvent } from './core/types';
import { resolveArea } from './core/geo';
import { slugify, truncate, stripHtml } from './core/text';
import { tagEvents, TaggingInput, TaggingResult } from '../llm/tagger';
import { isTargetCompanyEvent, hasRecruiterMention } from '../helpers/phase6';
import { resolveCompanies } from '../companies/resolve';
import { connectionScore } from '../events/connection-score';

export interface NormalizedEvent {
  title: string;
  description: string;
  source: string;
  sourceUrl: string;
  sourceEventId?: string;
  slug: string;
  organizer?: string;
  hostAvatarUrl?: string;
  category: string[];
  tags: string[];
  format: 'online' | 'offline' | 'hybrid';
  hasFood: 'yes' | 'no' | 'unknown';
  isFree: boolean;
  price?: number;
  priceMax?: number;
  currency?: string;
  soldOut?: boolean;
  venue?: string;
  address?: string;
  area?: string;
  city?: string;
  lat?: number;
  lng?: number;
  onlineLink?: string;
  imageUrl?: string;
  startDateTime: Date;
  endDateTime?: Date;
  timezone?: string;
  applyLink?: string;
  registrationDeadline?: Date;
  attendeeCount?: number;
  capacity?: number;
  dedupHash: string;
  clusterKey: string;
  lastSeenAt: Date;
  seenInSources: string[];
  isTechEvent: boolean;
  companies: string[];
  connectionScore: number;
  tagConfidence: number;
  isTargetCompany?: boolean;
  recruiterMentioned?: boolean;
}

/** Price extracted from free text — used ONLY when the adapter gave us nothing. */
function extractPriceFromText(text: string): number | undefined {
  const match = text.match(/(?:₹|Rs\.?\s*|INR\s*)(\d[\d,]*)/i);
  if (!match) return undefined;
  const value = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Decide free/paid, trusting adapter data first. */
function resolvePricing(raw: RawEvent): {
  isFree: boolean;
  price?: number;
  priceMax?: number;
  currency?: string;
} {
  // 1. The adapter observed it. Believe it.
  if (raw.isFree === true) return { isFree: true, currency: raw.currency };
  if (raw.isFree === false || raw.price !== undefined) {
    return {
      isFree: false,
      price: raw.price,
      priceMax: raw.priceMax,
      currency: raw.currency || (raw.price ? 'INR' : undefined),
    };
  }

  // 2. Nothing observed — fall back to text, but only on an explicit price token.
  const text = `${raw.title} ${raw.description}`;
  const price = extractPriceFromText(text);
  if (price !== undefined) return { isFree: false, price, currency: 'INR' };

  // 3. Genuinely unknown. Community tech events in Bengaluru are overwhelmingly
  // free, so default to free rather than showing a misleading price-unknown state.
  return { isFree: true, currency: undefined };
}

/** Resolve format, preferring the adapter's structured signal. */
function resolveFormat(raw: RawEvent, tagged: TaggingResult): 'online' | 'offline' | 'hybrid' {
  if (raw.rawFormat === 'online' || raw.rawFormat === 'offline' || raw.rawFormat === 'hybrid') {
    // Trust the adapter unless it said "offline" while giving us no venue at all
    // and the LLM saw clear online signals in the text.
    if (raw.rawFormat === 'offline' && !raw.venue && tagged.format === 'online') return 'online';
    return raw.rawFormat;
  }
  return tagged.format;
}

/** Build the tagger input for one raw event. */
function toTaggingInput(raw: RawEvent): TaggingInput {
  return {
    title: raw.title,
    description: raw.description,
    venue: raw.venue,
    onlineLink: raw.onlineLink,
    hints: [...(raw.rawCategory || []), ...(raw.tags || [])].filter(
      // Internal marker tags (kw:*, __cancelled) are plumbing, not signal.
      t => !t.startsWith('kw:') && !t.startsWith('__')
    ),
  };
}

/** Apply a tagging result to a raw event, producing a storable document. */
function assemble(raw: RawEvent, tagged: TaggingResult): NormalizedEvent {
  const format = resolveFormat(raw, tagged);
  const pricing = resolvePricing(raw);

  const area =
    format === 'online'
      ? undefined
      : resolveArea({
          venue: raw.venue,
          address: raw.address,
          city: raw.city,
          lat: raw.lat,
          lng: raw.lng,
        });

  const title = raw.title.trim();
  const description = truncate(stripHtml(raw.description || title), 6000) || title;

  const dedupHash = Event.generateDedupHash(title, raw.startDateTime, raw.venue, raw.source);
  const clusterKey = Event.generateClusterKey(title, raw.startDateTime);

  const companies = resolveCompanies({
    organizer: raw.organizer,
    title,
    description,
    tags: raw.tags,
  });

  // Public tags: drop the internal markers, keep organiser-supplied topics.
  const tags = [...new Set((raw.tags || []).filter(t => !t.startsWith('__') && !t.startsWith('kw:')))]
    .slice(0, 12);

  return {
    title,
    description,
    source: raw.source,
    sourceUrl: raw.sourceUrl,
    sourceEventId: raw.sourceEventId,
    slug: slugify(title) || 'event',
    organizer: raw.organizer?.trim(),
    hostAvatarUrl: raw.hostAvatarUrl,
    category: tagged.categories,
    tags,
    format,
    hasFood: raw.rawHasFood === 'yes' ? 'yes' : tagged.hasFood,
    isFree: pricing.isFree,
    price: pricing.price,
    priceMax: pricing.priceMax,
    currency: pricing.currency,
    soldOut: raw.soldOut ?? false,
    venue: raw.venue?.trim(),
    address: raw.address?.trim(),
    area,
    city: raw.city?.trim() || (area ? 'Bengaluru' : undefined),
    lat: raw.lat,
    lng: raw.lng,
    onlineLink: raw.onlineLink?.trim(),
    imageUrl: raw.imageUrl,
    startDateTime: raw.startDateTime,
    endDateTime: raw.endDateTime,
    timezone: raw.timezone,
    applyLink: raw.applyLink?.trim() || raw.sourceUrl,
    registrationDeadline: raw.registrationDeadline,
    attendeeCount: raw.attendeeCount,
    capacity: raw.capacity,
    dedupHash,
    clusterKey,
    lastSeenAt: new Date(),
    seenInSources: [raw.source],
    isTechEvent: tagged.isTechEvent,
    companies,
    // Derived last, because it depends on the resolved format/companies/food above.
    connectionScore: connectionScore({
      format,
      hasFood: raw.rawHasFood === 'yes' ? 'yes' : tagged.hasFood,
      attendeeCount: raw.attendeeCount,
      capacity: raw.capacity,
      category: tagged.categories,
      companies,
      organizer: raw.organizer,
      title,
      isFree: pricing.isFree,
      price: pricing.price,
    }),
    tagConfidence: tagged.confidence,
    isTargetCompany: isTargetCompanyEvent(raw.organizer, raw.description),
    recruiterMentioned: hasRecruiterMention(raw.description),
  };
}

/**
 * Normalize a batch of raw events, tagging them in bulk.
 *
 * Bulk tagging is the point: it turns N LLM round-trips into N/8, which is what
 * makes a 400-event run finish in minutes rather than tens of minutes.
 */
export async function normalizeEvents(rawEvents: RawEvent[]): Promise<NormalizedEvent[]> {
  if (rawEvents.length === 0) return [];
  const tagged = await tagEvents(rawEvents.map(toTaggingInput));
  return rawEvents.map((raw, index) => assemble(raw, tagged[index]));
}

/** Normalize one event (used by the manual add-event path). */
export async function normalizeEvent(raw: RawEvent): Promise<NormalizedEvent> {
  const [normalized] = await normalizeEvents([raw]);
  return normalized;
}
