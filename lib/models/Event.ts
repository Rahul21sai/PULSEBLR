import mongoose, { Schema, Document, Model } from 'mongoose';
import crypto from 'crypto';
import { BENGALURU_AREAS } from '../scrapers/core/geo';
import { normalizeTitleForMatch } from '../scrapers/core/text';

/**
 * The shared, deduplicated Bengaluru event corpus.
 *
 * Two identity keys, for two different jobs:
 *
 *   dedupHash  — STRICT, per-source. Same source + same title + same instant +
 *                same venue ⇒ the same listing. Unique-indexed, so re-scraping
 *                is idempotent and we can upsert-and-enrich rather than skip.
 *
 *   clusterKey — FUZZY, cross-source. One event announced on both Luma and
 *                Meetup used to appear twice because the strict hash includes
 *                `source` and the venue strings differ. clusterKey is
 *                normalized-title + calendar day (IST), which collapses those
 *                into one card while keeping "React Meetup #107" and "#108"
 *                distinct (digits are preserved by normalizeTitleForMatch).
 */

/**
 * The category taxonomy — 22 buckets, tech-first.
 *
 * This was 32 and got consolidated. Two reasons: the filter rail became a long
 * scroll of near-synonyms, and the product's focus narrowed to software/hardware
 * events, which made a dozen lifestyle buckets pointless. The tech topics are
 * listed first because they are what the default (tech-only) view shows, then the
 * KIND of gathering, then a deliberately small non-tech tail for when "show all
 * events" is on.
 *
 * `CATEGORY_MIGRATION` below maps every retired value forward, so stored events
 * can be migrated without re-tagging.
 */
// The taxonomy itself lives in lib/event-types.ts, which has no mongoose import and
// is therefore safe for the filter rail to import. Re-exported here so every existing
// `from '@/lib/models/Event'` import keeps working and there is one definition.
export {
  EVENT_CATEGORIES,
  TECH_CATEGORY_NAMES,
  GATHERING_CATEGORY_NAMES,
  OTHER_CATEGORY_NAMES,
  CATEGORY_GROUPS,
} from '../event-types';
export type { EventCategory } from '../event-types';

// Imported (not just re-exported) because the schema enum below needs the value.
import { EVENT_CATEGORIES as CATEGORY_VALUES } from '../event-types';

/**
 * Retired category → current category.
 *
 * Kept permanently: `scripts/migrate-categories.ts` uses it, and it documents what
 * each old bucket became so nobody has to guess when reading old data or diffs.
 */
export const CATEGORY_MIGRATION: Record<string, string> = {
  // Renames
  'Robotics/Hardware': 'Hardware/Robotics',
  'Summit/Conference': 'Conference',
  'Networking/Meetup': 'Meetup',
  'Workshop/Training': 'Workshop',
  'Career/Job Fair': 'Career/Hiring',
  'Social/Community': 'Community/Social',
  // Fintech is a business domain, not a software/hardware topic. A genuinely
  // technical fintech talk still gets AI/ML, Web/Mobile or Cloud/DevOps from the
  // tagger, so nothing technical is lost by folding the domain label into business.
  Fintech: 'Business/Finance',
  'Marketing/Growth': 'Business/Finance',
  Corporate: 'Business/Finance',
  // Absorbed into the small non-tech tail
  'Climate/Sustainability': 'Science/Research',
  'Health/Biotech': 'Health/Fitness',
  'Sports/Fitness': 'Health/Fitness',
  'Food/Drink': 'Community/Social',
  'Music/Nightlife': 'Arts/Culture',
  'Comedy/Theatre': 'Arts/Culture',
  'Books/Writing': 'Arts/Culture',
  Government: 'Other',
};


/** Platforms we ingest from. */
export const EVENT_SOURCES = [
  'luma',
  'meetup',
  'eventbrite',
  'bevy',
  'devfolio',
  'unstop',
  'allevents',
  'devevents',
  'hasgeek',
  'fossunited',
  'district',
  'company',
  'manual',
  'other',
] as const;

export interface IEvent extends Document {
  title: string;
  description: string;
  source: string;
  sourceUrl: string;
  sourceEventId?: string;
  slug?: string;
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
  /** Refreshed on every scrape that sees this event — powers staleness cleanup. */
  lastSeenAt: Date;
  /** Sources that have reported this same event, for provenance in the UI. */
  seenInSources: string[];
  isTechEvent: boolean;
  /**
   * 0-100 ranking signal for "how likely am I to leave with useful contacts".
   * Derived deterministically from format/attendees/host/title — see
   * lib/events/connection-score.ts.
   */
  connectionScore: number;
  /**
   * Canonical company names this event is attributable to, resolved from the
   * host/title/tags by lib/companies/resolve.ts. Empty for the many community
   * events no company runs — that absence is meaningful, not missing data.
   */
  companies: string[];
  /**
   * Confidence of the tagging that produced `category` / `isTechEvent`.
   * ~0.6 = keyword heuristics, 0.8-1.0 = LLM. Merging uses this to stop a
   * low-confidence pass from degrading a high-confidence one.
   */
  tagConfidence: number;
  // Phase 6 career-intelligence fields
  isTargetCompany?: boolean;
  recruiterMentioned?: boolean;
  guestCount?: number;
  createdAt: Date;
  updatedAt: Date;
}

const EventSchema = new Schema<IEvent>(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, required: true },
    source: { type: String, required: true, enum: EVENT_SOURCES },
    sourceUrl: { type: String, required: true },
    sourceEventId: { type: String, trim: true },
    slug: { type: String, trim: true },
    organizer: { type: String, trim: true },
    hostAvatarUrl: { type: String, trim: true },
    category: {
      type: [String],
      required: true,
      // `enum` on an array field validates each element.
      enum: CATEGORY_VALUES as unknown as string[],
    },
    tags: { type: [String], default: [] },
    format: { type: String, required: true, enum: ['online', 'offline', 'hybrid'] },
    hasFood: { type: String, default: 'unknown', enum: ['yes', 'no', 'unknown'] },
    isFree: { type: Boolean, default: true },
    price: { type: Number, min: 0 },
    priceMax: { type: Number, min: 0 },
    currency: { type: String, trim: true, uppercase: true },
    soldOut: { type: Boolean, default: false },
    venue: { type: String, trim: true },
    address: { type: String, trim: true },
    // Not an enum any more: the area list grew and a value outside it must never
    // reject a whole document (the old enum silently dropped events at insert).
    area: { type: String, trim: true },
    city: { type: String, trim: true },
    lat: { type: Number, min: -90, max: 90 },
    lng: { type: Number, min: -180, max: 180 },
    onlineLink: { type: String, trim: true },
    imageUrl: { type: String, trim: true },
    startDateTime: { type: Date, required: true },
    endDateTime: { type: Date },
    timezone: { type: String, trim: true },
    applyLink: { type: String, trim: true },
    registrationDeadline: { type: Date },
    attendeeCount: { type: Number, min: 0 },
    capacity: { type: Number, min: 0 },
    dedupHash: { type: String, required: true, unique: true, index: true },
    clusterKey: { type: String, required: true, index: true },
    lastSeenAt: { type: Date, default: Date.now },
    seenInSources: { type: [String], default: [] },
    isTechEvent: { type: Boolean, default: true },
    companies: { type: [String], default: [], index: true },
    connectionScore: { type: Number, default: 20, min: 0, max: 100 },
    tagConfidence: { type: Number, default: 0.6, min: 0, max: 1 },
    isTargetCompany: { type: Boolean, default: false },
    recruiterMentioned: { type: Boolean, default: false },
    guestCount: { type: Number, min: 0 },
  },
  { timestamps: true }
);

// ── Indexes ─────────────────────────────────────────────────────────────────
// The feed's default query is "upcoming, soonest first", optionally narrowed by
// facets, so startDateTime leads every compound index.
EventSchema.index({ startDateTime: 1 });
EventSchema.index({ startDateTime: 1, category: 1 });
EventSchema.index({ startDateTime: 1, format: 1 });
EventSchema.index({ startDateTime: 1, area: 1 });
EventSchema.index({ startDateTime: 1, isTechEvent: 1 });
// Powers the companies browse page and the feed's company filter.
EventSchema.index({ startDateTime: 1, companies: 1 });
// Powers the "best for connections" sort within the tech-only default view.
EventSchema.index({ isTechEvent: 1, connectionScore: -1, startDateTime: 1 });
EventSchema.index({ source: 1 });
EventSchema.index({ createdAt: -1 });
EventSchema.index({ isTargetCompany: 1 });
EventSchema.index({ lastSeenAt: -1 });
// Free-text search over the fields users actually type into a search box.
// Weights favour the title so "python" ranks a Python meetup above an event that
// merely mentions Python in its description.
EventSchema.index(
  { title: 'text', description: 'text', organizer: 'text', venue: 'text', tags: 'text' },
  {
    weights: { title: 10, organizer: 4, tags: 3, venue: 2, description: 1 },
    name: 'event_text_search',
  }
);

/** Strict per-source identity. */
EventSchema.statics.generateDedupHash = function (
  title: string,
  startDateTime: Date,
  venue?: string,
  source?: string
): string {
  const input = `${title.toLowerCase().trim()}-${startDateTime.toISOString()}-${venue || ''}-${source || ''}`;
  return crypto.createHash('sha256').update(input).digest('hex');
};

/**
 * Fuzzy cross-source identity: normalized title + the IST calendar day.
 *
 * The day is computed in Asia/Kolkata on purpose. Two sources often publish the
 * same event with slightly different times (or one stores UTC and the other a
 * local wall time), and a UTC-day bucket would split a 9 PM IST event across two
 * days. Bucketing by IST day matches how a Bengaluru user thinks about "when".
 */
EventSchema.statics.generateClusterKey = function (
  title: string,
  startDateTime: Date
): string {
  const istDay = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(startDateTime);
  return `${normalizeTitleForMatch(title)}|${istDay}`;
};

/**
 * Derive the two dedup keys for any document that reaches the database without
 * them.
 *
 * This MUST be `pre('validate')`, not `pre('save')`. Mongoose registers its own
 * validation as the first pre-save hook, so a `pre('save')` hook that fills a
 * `required` field runs too late — it never runs at all, because validation has
 * already rejected the document. Measured (scripts/diag-hook-order.ts): deriving a
 * required field in `pre('save')` fails with "Path `x` is required" and the hook
 * body is never entered, while the identical logic in `pre('validate')` saves fine.
 *
 * That was not academic. Six documents predating `clusterKey` were stored without
 * it, and when a fresh sighting merged into one, `existing.save()` threw
 * "clusterKey: Path `clusterKey` is required" and the event was dropped — 3 lost in
 * a single run. Self-healing here means a legacy document repairs itself the next
 * time it is touched.
 */
EventSchema.pre('validate', function () {
  const self = this as unknown as IEvent;
  const statics = this.constructor as unknown as {
    generateDedupHash: (t: string, d: Date, v?: string, s?: string) => string;
    generateClusterKey: (t: string, d: Date) => string;
  };

  // Both generators read `startDateTime`, and `generateClusterKey` throws
  // RangeError on an invalid Date. Bail out rather than throw: letting the
  // required-field validator report a clean message beats an opaque RangeError.
  const start = self.startDateTime;
  if (!(start instanceof Date) || Number.isNaN(start.getTime())) return;

  if (!self.dedupHash) {
    self.dedupHash = statics.generateDedupHash(
      self.title,
      start,
      self.venue,
      self.source
    );
  }
  if (!self.clusterKey) {
    self.clusterKey = statics.generateClusterKey(self.title, start);
  }
});

export interface EventModel extends Model<IEvent> {
  generateDedupHash(title: string, startDateTime: Date, venue?: string, source?: string): string;
  generateClusterKey(title: string, startDateTime: Date): string;
}

const Event =
  (mongoose.models.Event as EventModel) ||
  mongoose.model<IEvent, EventModel>('Event', EventSchema);

export default Event;

export { BENGALURU_AREAS };
