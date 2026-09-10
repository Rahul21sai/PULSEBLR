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
  AUDIENCE_NAMES,
  PERK_NAMES,
  EVENT_TIERS,
  FOOD_PERKS,
  hasFoodFromPerks,
} from '../event-types';
export type { EventCategory, EventAudience, EventPerk, EventTier } from '../event-types';
export type { AgendaItem, EventSpeaker } from '../event-types';

// Imported (not just re-exported) because the schema enums below need the values.
import {
  EVENT_CATEGORIES as CATEGORY_VALUES,
  AUDIENCE_NAMES,
  PERK_NAMES,
  EVENT_TIERS,
} from '../event-types';

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
   * When an admin pinned this event to the home page Spotlight. Absent = not pinned.
   *
   * A DATE RATHER THAN A BOOLEAN, for two reasons. It orders the Spotlight deterministically
   * (most recently pinned first) without a second field, and it records WHEN the call was made,
   * which a boolean throws away — the same reason `lastSeenAt` is a date.
   *
   * EDITORIAL, NOT DERIVED, and that distinction decides how everything else treats it.
   * `connectionScore`, `companies` and `isTechEvent` are all recomputable from the document, so
   * backfills rewrite them freely. This one cannot be recomputed from anything — a human chose
   * it. So `mergeInto()` must never touch it (it uses an explicit allowlist of SCRAPED fields,
   * which is why re-scraping is already safe), and no backfill may clear it.
   */
  spotlightAt?: Date;
  /** Who the event is for. Controlled vocabulary -- see `AUDIENCE_NAMES`. */
  audience?: string[];
  /** What you get in the room. Controlled vocabulary -- see `PERK_NAMES`. */
  perks?: string[];
  /** Browse label, NOT a ranking. See `EVENT_TIERS`. */
  tier?: string;
  /** Timed agenda. Sparse. */
  agenda?: Array<{
    startsAt?: Date;
    title: string;
    speakerName?: string;
    speakerCompany?: string;
  }>;
  /** Named speakers. Sparse. NEVER used to create a `Person`. */
  speakers?: Array<{ name: string; title?: string; company?: string; linkedin?: string }>;
  /**
   * When an admin removed this event from the corpus. Absent = present in the corpus. See the
   * schema field below for why this is a date and why nothing reads it with `$exists`.
   */
  deletedAt?: Date;
  /** Owner of a hand-entered event. Absent on everything the scraper produced. */
  createdByUserId?: string;
  /** Absent means public, which is what every scraped document is. */
  visibility?: 'private' | 'pending' | 'public';
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
    // No default: ABSENT means "not pinned". A `default: null` would store an explicit null on
    // every one of the ~1500 documents, and the query filters on `$type: 'date'` — which is also
    // the shape that avoids the compound-sparse trap documented in CLAUDE.md §9.
    spotlightAt: { type: Date },

    /*
     * CARD METADATA -- `audience`, `perks`, `tier`.
     *
     * All three are DERIVED and freely recomputable, which is what separates them
     * from `spotlightAt` directly above: a human chose that one, so nothing may
     * rewrite it. These are the tagger's output, so a backfill may.
     *
     * Enum-constrained on purpose. The whole reason these exist rather than more
     * `tags` is that a harvested free-text field cannot back a facet -- measured,
     * six distinct tag values across the entire corpus. An enum makes every value
     * a bucket, and makes a typo a validation error rather than a chip nobody
     * clicks.
     *
     * `default: []` (not absent) for the two arrays, matching `companies` and
     * `seenInSources`. NO `sparse` INDEX on either: they default to `[]`, which
     * indexes as the missing-key sentinel, so `sparse` would omit most rows and be
     * useless for the listing they exist to serve -- the same trap that capped
     * every user at one folder. And `audience`, `perks` and `companies` can never
     * share one index: MongoDB refuses two array fields in a single key and does
     * so at WRITE time, on the first document carrying both.
     */
    audience: { type: [String], default: [], enum: AUDIENCE_NAMES as unknown as string[] },
    perks: { type: [String], default: [], enum: PERK_NAMES as unknown as string[] },
    tier: { type: String, enum: EVENT_TIERS as unknown as string[] },

    /*
     * DEPTH -- `agenda` and `speakers`. Both SPARSE by nature: they come from
     * richer Luma descriptions, organiser submissions and the company-microsite
     * LLM path, not from any platform API. Absent is the normal case, so every
     * reader renders nothing rather than an empty shell.
     *
     * `_id: false` on both subdocuments. Nothing addresses an agenda row or a
     * speaker individually -- they are replaced wholesale by whatever last
     * described the event -- so per-row ids would be bytes that mean nothing.
     * Note the contrast with `Contact`, where the ABSENCE of a stable id is
     * exactly what made `markFollowUpComplete()` silently no-op on the second
     * person with a given name. The difference is that these are not people.
     */
    agenda: {
      type: [
        new mongoose.Schema(
          {
            startsAt: { type: Date },
            title: { type: String, required: true, trim: true },
            speakerName: { type: String, trim: true },
            speakerCompany: { type: String, trim: true },
          },
          { _id: false }
        ),
      ],
      default: undefined,
    },
    speakers: {
      type: [
        new mongoose.Schema(
          {
            name: { type: String, required: true, trim: true },
            title: { type: String, trim: true },
            company: { type: String, trim: true },
            linkedin: { type: String, trim: true },
          },
          { _id: false }
        ),
      ],
      default: undefined,
    },

    /**
     * SOFT DELETE. When an admin removed this event. ABSENT means it is in the corpus.
     *
     * -- WHY SOFT AT ALL ---------------------------------------------------------------------
     * A hard delete cannot be undone, and a re-scrape only brings an event back if its source
     * still lists it -- which for the junk-removal case is precisely when it does not. The
     * control room offers Undo, and Undo has to be real rather than a promise, so the row
     * survives the delete and `POST /api/admin/audit/undo` `$unset`s this field.
     *
     * -- READ IT WITH `null`, NEVER `$exists` ------------------------------------------------
     * Every read path filters `{ deletedAt: null }`, and in MongoDB that predicate matches a
     * document whose field is null AND one where the key is absent entirely. Both halves are
     * needed here and each fails differently:
     *
     *   - ABSENT must match, because ~1500 documents predate this field. Getting this backwards
     *     does not narrow the feed, it EMPTIES it -- the same class of mistake the `visibility`
     *     clause's `$exists: false` arm exists to prevent, arriving through a different door.
     *   - NULL must match too, because a future restore path writing `$set: { deletedAt: null }`
     *     rather than `$unset` would otherwise leave the row permanently invisible while every
     *     admin screen reported it restored. `spotlightAt` documents the mirror of this trap.
     *
     * NO DEFAULT, for the reason `spotlightAt` gives: `default: null` would write an explicit
     * null onto every document in the corpus to express what absence already says.
     */
    deletedAt: { type: Date },

    /**
     * Who typed this event in by hand. ABSENT for everything the scraper produced.
     *
     * A PLAIN STRING — the Google `sub`, or `devlogin:<email>` under the dev provider. Never an
     * ObjectId and never `ref: 'User'`, matching `TrackerEntry.userId` and `Contact.userId`.
     *
     * Its ABSENCE is the load-bearing state. Roughly 1500 documents predate this field, every one
     * of them scraped and public, and a great deal of code has to keep treating them that way — so
     * every ownership predicate is written as "`createdByUserId` does not exist" rather than
     * "`createdByUserId` is null", and every visibility filter has an explicit arm for documents
     * with no `visibility` key at all. Omitting that arm empties the entire feed on deploy.
     */
    createdByUserId: { type: String, index: true },

    /**
     * Who may see this event. ABSENT means public, which is what every scraped document is.
     *
     *   'private'  Only its owner. "Add it just for me" — the common case, and the reason this
     *              field exists: the corpus cannot possibly know about a company's internal
     *              hackathon or a friend's reading group.
     *   'pending'  The owner submitted it for the shared feed and it is awaiting review. Visible
     *              to its owner and to an admin, nobody else.
     *   'public'   In the shared corpus.
     *
     * WHY THERE IS A `pending` STATE RATHER THAN LETTING A USER PUBLISH DIRECTLY. `POST
     * /api/events` is `requireAdmin()` today, and the reason is written down: Google sign-in is
     * open to anyone with a Google account, so "signed in" is not a bar for an operation that
     * affects everyone. A directly-publishing user could put an arbitrary `applyLink` in front of
     * every visitor — the phishing vector that guard exists to close — and could pollute the corpus
     * the whole product depends on. Review is what makes "contribute to everyone" safe to offer.
     */
    visibility: { type: String, enum: ['private', 'pending', 'public'] },

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
/**
 * The home page Spotlight query: pinned events that have not happened yet, newest pin first.
 *
 * PARTIAL, not sparse. A single-field sparse index would work here, but the whole point of a
 * pinned set is that it is tiny — a handful of documents out of ~1500 — and a partial index only
 * stores those. It also states the intent in the index itself: this exists to find pinned rows,
 * not to order every row by a field most of them do not have. Same `$type: 'date'` predicate the
 * query filters on, so the index is actually usable by it.
 */
EventSchema.index(
  { spotlightAt: -1, startDateTime: 1 },
  { partialFilterExpression: { spotlightAt: { $type: 'date' } } }
);
/**
 * Deleted rows, most recently removed first.
 *
 * NO QUERY USES THIS YET, and that is stated rather than implied. Undo is reached through the audit
 * log, which selects on `AuditLog` and never on this field, so there is currently no "recently
 * deleted" listing for it to serve. It is here because `deletedAt` is brand new and deleted rows
 * only accumulate: any listing of them sorts by exactly this, and adding the index with the field
 * costs less thought than rediscovering the need later.
 *
 * PARTIAL, and the predicate is the point. It indexes only the deleted minority, and deliberately
 * does NOT try to serve the far more common `{ deletedAt: null }` that every feed query now
 * carries -- that predicate matches ~100% of the corpus and is worthless as an index lead. The
 * existing `startDateTime` / `connectionScore` indexes still drive those queries and this one adds
 * nothing to their cost.
 */
EventSchema.index(
  { deletedAt: -1 },
  { partialFilterExpression: { deletedAt: { $type: 'date' } } }
);
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
  source?: string,
  /**
   * Owner of a hand-entered event, folded into the hash.
   *
   * NOT optional politeness — without it the feature is broken and leaky. `dedupHash` is
   * unique-indexed, and every hand-entered event has `source: 'manual'`, so two DIFFERENT users
   * adding the same event compute the identical hash. `POST /api/events` answers a hash collision
   * with `409 { error: 'Event already exists', event: existing }` — so the second user would be
   * refused their own event AND handed the first user's document, private or not.
   */
  ownerId?: string
): string {
  const input = `${title.toLowerCase().trim()}-${startDateTime.toISOString()}-${venue || ''}-${source || ''}-${ownerId || ''}`;
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
  startDateTime: Date,
  /**
   * Owner of a hand-entered event. Present ⇒ the key is NAMESPACED, and that is the whole defence
   * for user-created events.
   *
   * ─────────────────────────────────────────────────────────────────────────────────────────────
   * WHY NAMESPACE RATHER THAN GUARD THE LOOKUPS. `clusterKey` is normalized title + IST day, with
   * no source in it, so a hand-entered "React Meetup" on the same day as the scraped one shares a
   * key BY CONSTRUCTION — `normalizeTitleForMatch` strips city words and noise, so collisions are
   * easy rather than exotic. What happens then is not a duplicate card, it is silent loss:
   * `ingestEvents` finds the user's document first, `mergeInto` overwrites its description, venue,
   * categories and `isTechEvent`, `Event.create` is never reached, and the merge is counted as a
   * success. If the user's row was private, the whole city loses that event from the feed and the
   * scrape reports no error.
   *
   * The lookups could each be guarded, and they are — but there are four of them plus two cleanup
   * scripts that group by this key, and "remember to exclude owned documents" is a rule a fifth
   * call site will break. A namespaced key makes an owned document STRUCTURALLY incapable of
   * entering a scraped cluster, so a new lookup written next year inherits the protection.
   *
   * THE COST, STATED PLAINLY: an approved public user event keeps its namespaced key, so if the
   * scraper later finds the same event the city gets two cards for it. That is a visible duplicate
   * rather than invisible data loss, which is the right way round — and the review step is exactly
   * where somebody can notice the event is already in the corpus and reject the submission.
   * De-namespacing on approval was considered and rejected: it would mutate an identity mid-life,
   * which is the thing `clusterKey` being frozen at ingest exists to prevent.
   * ─────────────────────────────────────────────────────────────────────────────────────────────
   */
  ownerId?: string
): string {
  const istDay = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(startDateTime);
  const base = `${normalizeTitleForMatch(title)}|${istDay}`;
  return ownerId ? `user:${ownerId}|${base}` : base;
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
    generateDedupHash: (t: string, d: Date, v?: string, s?: string, o?: string) => string;
    generateClusterKey: (t: string, d: Date, o?: string) => string;
  };

  // Both generators read `startDateTime`, and `generateClusterKey` throws
  // RangeError on an invalid Date. Bail out rather than throw: letting the
  // required-field validator report a clean message beats an opaque RangeError.
  const start = self.startDateTime;
  if (!(start instanceof Date) || Number.isNaN(start.getTime())) return;

  // Threaded into BOTH generators. Absent for every scraped document, so their keys are byte
  // identical to what they were before ownership existed — no migration, no re-keying.
  const owner = self.createdByUserId;

  if (!self.dedupHash) {
    self.dedupHash = statics.generateDedupHash(
      self.title,
      start,
      self.venue,
      self.source,
      owner
    );
  }
  if (!self.clusterKey) {
    self.clusterKey = statics.generateClusterKey(self.title, start, owner);
  }
});

export interface EventModel extends Model<IEvent> {
  generateDedupHash(
    title: string,
    startDateTime: Date,
    venue?: string,
    source?: string,
    ownerId?: string
  ): string;
  generateClusterKey(title: string, startDateTime: Date, ownerId?: string): string;
}

const Event =
  (mongoose.models.Event as EventModel) ||
  mongoose.model<IEvent, EventModel>('Event', EventSchema);

export default Event;

export { BENGALURU_AREAS };
