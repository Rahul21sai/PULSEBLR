// Core types shared by every scraper adapter.
//
// RawEvent is deliberately richer than what any single platform returns: it is the
// union of everything we can get from the best sources (Luma gives cover image,
// coordinates, guest count, ticket price; Bevy gives banner + venue; Meetup ICS
// gives only date/venue). Adapters fill what they have and leave the rest
// undefined — the normalizer never invents values.

/** A single event as returned by an adapter, before normalization/tagging. */
export interface RawEvent {
  // ── identity ──────────────────────────────────────────────────────────────
  title: string;
  description: string;
  /** Canonical public URL for the event. */
  sourceUrl: string;
  /** Which platform produced this (must be a valid Event.source value). */
  source: string;
  /** Stable per-platform id (Luma api_id, Meetup UID, Bevy id). Enables exact re-match. */
  sourceEventId?: string;

  // ── who ───────────────────────────────────────────────────────────────────
  organizer?: string;
  /** Host/organizer avatar or logo, used in the feed UI. */
  hostAvatarUrl?: string;

  // ── where ─────────────────────────────────────────────────────────────────
  venue?: string;
  address?: string;
  city?: string;
  lat?: number;
  lng?: number;
  onlineLink?: string;

  // ── when (always absolute instants; adapters resolve timezones themselves) ─
  startDateTime: Date;
  endDateTime?: Date;
  /** IANA zone the organizer published in, e.g. "Asia/Kolkata". */
  timezone?: string;

  // ── presentation ──────────────────────────────────────────────────────────
  imageUrl?: string;

  // ── commerce ──────────────────────────────────────────────────────────────
  isFree?: boolean;
  price?: number;
  priceMax?: number;
  currency?: string;
  soldOut?: boolean;

  // ── social proof ──────────────────────────────────────────────────────────
  attendeeCount?: number;
  capacity?: number;

  // ── registration ──────────────────────────────────────────────────────────
  applyLink?: string;
  registrationDeadline?: Date;

  // ── hints for the tagger (free-form; never trusted as final categories) ───
  tags?: string[];
  rawCategory?: string[];
  rawFormat?: string;
  rawHasFood?: string;
}

/** Outcome of scraping ONE source, including its own health signal. */
export interface ScrapeResult {
  /** Registry id of the source that produced this. */
  sourceId: string;
  /** Human label for logs/UI. */
  label: string;
  events: RawEvent[];
  errors: string[];
  /** Sources this run discovered that should be scraped in future runs. */
  discovered?: DiscoveredSource[];
  startedAt: Date;
  durationMs: number;
}

/**
 * A source found at runtime (a Luma host calendar, a Meetup group) that the
 * pipeline persists so the next run scrapes it directly. This is what makes
 * coverage compound instead of being capped by a hand-written list.
 */
export interface DiscoveredSource {
  /** Adapter that knows how to scrape it, e.g. 'luma-calendar' | 'meetup-group'. */
  kind: string;
  /** Adapter-specific handle: a Luma calendar api_id, a Meetup group slug, a URL. */
  handle: string;
  label: string;
}

/** A declarative source entry the pipeline can execute. */
export interface SourceDescriptor {
  /** Stable unique id — also the key used for health tracking. */
  id: string;
  label: string;
  /** Source value written onto events (must match the Event.source enum). */
  source: string;
  type: 'api' | 'rss' | 'ical' | 'scrape';
  /** Representative URL, shown in Settings and used for the disable toggle. */
  url: string;
  run: () => Promise<ScrapeResult>;
  /** Lower runs first; used to prioritise high-yield sources. */
  priority?: number;
}
