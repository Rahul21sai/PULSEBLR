// The event shape the client actually receives from /api/events.
//
// Dates arrive as ISO strings over JSON, which is why every date field is typed
// `string` here rather than `Date` — typing them as Date would compile but every
// `.getTime()` at runtime would throw.

export interface FeedEvent {
  _id: string;
  title: string;
  description?: string;
  source: string;
  sourceUrl: string;
  slug?: string;
  organizer?: string;
  hostAvatarUrl?: string;
  category: string[];
  tags?: string[];
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
  startDateTime: string;
  endDateTime?: string;
  timezone?: string;
  applyLink?: string;
  registrationDeadline?: string;
  attendeeCount?: number;
  capacity?: number;
  companies?: string[];
  connectionScore?: number;
  isTechEvent?: boolean;
  /** ISO string when an admin pinned this to the home page Spotlight. Absent = not pinned. */
  spotlightAt?: string | null;
  /** Controlled vocabulary; see `AUDIENCE_NAMES`. */
  audience?: string[];
  /** Controlled vocabulary; see `PERK_NAMES`. `hasFood` is derivable from this. */
  perks?: string[];
  /** Browse label, never a ranking; see `EVENT_TIERS`. */
  tier?: string;
  /** Sparse. Render nothing when absent rather than an empty shell. */
  agenda?: AgendaItem[];
  /** Sparse. Matched against Persons for DISPLAY ONLY -- never to create one. */
  speakers?: EventSpeaker[];
  isTargetCompany?: boolean;
  recruiterMentioned?: boolean;
  seenInSources?: string[];
  createdAt?: string;
  /**
   * Has the SIGNED-IN caller already saved this to their tracker?
   *
   * Set by `GET /api/events` per request, never stored. Absent for an anonymous caller and for
   * any row the caller has not tracked, so `undefined` and `false` mean the same thing to a
   * reader — which is what lets `SaveButton` take it as a plain optional boolean.
   */
  tracked?: boolean;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  pages: number;
  hasMore: boolean;
}

export interface Facets {
  categories: Record<string, number>;
  areas: Record<string, number>;
  sources: Record<string, number>;
  formats: Record<string, number>;
  companies: Record<string, number>;
  totals: { total: number; free: number; withFood: number; tech: number };
}

// ─────────────────────────────────────────────────────────────────────────────
// Category taxonomy
//
// This lives HERE, in the client-safe module, rather than in lib/models/Event.ts,
// for one concrete reason: the filter rail needs the group structure, and importing
// it from the Mongoose model would pull mongoose into the browser bundle. The model
// re-exports these, so there is still exactly one definition.
//
// Structure is three groups, because the taxonomy mixes two orthogonal axes and
// showing them as one flat list is what made the filter confusing: "Community/Social
// (335)" outranked every tech topic, so a user whose whole purpose is tech events had
// to scroll past the noise to reach AI/ML.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the event is ABOUT. This is the set `techOnly` is defined by, and the group
 * the product exists to serve.
 */
export const TECH_CATEGORY_NAMES = [
  'AI/ML',
  'Data/Analytics',
  'Cloud/DevOps',
  'Web/Mobile',
  'Cybersecurity',
  'Open Source',
  'Hardware/Robotics',
  'Blockchain/Web3',
  'Gaming/XR',
] as const;

/**
 * What KIND of gathering it is — orthogonal to the topic above. A Kubernetes
 * meetup is both `Cloud/DevOps` and `Meetup`, and the two answer different
 * questions ("what will I learn" vs "will I meet anyone").
 *
 * `Product/Design` sits here rather than in the tech topics because it describes a
 * discipline that attends tech events rather than a software/hardware subject.
 */
/**
 * The categories that make `isTechEvent` true when it is derived from categories alone.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * ONE DEFINITION, EXPORTED, because "tech" is already defined twice in this app and the two can
 * disagree — CLAUDE.md §3 documents the measurement: 75 of 1048 upcoming events where `isTechEvent`
 * and membership of `TECH_CATEGORY_NAMES` contradicted each other, with `IndiaFOSS 2026` hidden from
 * the default feed as a result. A third copy is not affordable.
 *
 * It is `TECH_CATEGORY_NAMES` PLUS `Hackathon`, and that addition is the whole reason this exists
 * rather than callers using `TECH_CATEGORY_NAMES` directly. `Hackathon` lives in
 * `GATHERING_CATEGORY_NAMES` because it describes the KIND of gathering rather than a topic — but a
 * hackathon is unambiguously a software engineering event, so for the tech FLAG it counts.
 * `lib/llm/tagger.ts`'s keyword floor has always made that distinction; this is that set, exported.
 *
 * Found by verifying rather than reading: a hand-entered "Internal Hack Day" categorised only
 * `Hackathon` was stored `isTechEvent: false`, so it did not appear in the default (tech-only) feed —
 * the user adds their own event and it seems to vanish.
 *
 * This file has no mongoose and no LLM imports, so a route may import it freely.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * ── `Conference` AND `Workshop` ARE DELIBERATELY NOT HERE. MEASURED, NOT ASSUMED. ────────────
 *
 * The argument FOR adding them is sound as far as it goes: `Conference`, `Workshop` and `Meetup`
 * describe the KIND of gathering, not the topic, so an event tagged only `{Conference}` is
 * excluded from the default tech-only feed even when it is unambiguously a tech conference. That
 * is real recall loss, and `Hackathon` above is precedent for fixing it by widening this set.
 *
 * `Hackathon` is precedent for exactly one thing, though, and it is the thing that does not
 * generalise: the WORD is technical. There is no such thing as a non-software hackathon. There
 * are a great many non-software conferences, and this corpus is full of them. Measured against
 * live Atlas on 2026-09-10, upcoming events carrying `Conference` with NO existing member of this
 * set — i.e. exactly the rows a blanket add would flip into the tech feed — 20 rows, and 17 of
 * them are not tech events at all:
 *
 *     Kudremukh New Year Trek          ← "summit". A mountain one.
 *     Kudremukha Trek
 *     Tadiandamol Coorg Trek
 *     Property Expo at Pritech Park
 *     Dubai Real Estate Expo in Bangalore
 *     Garment Technology Expo (GTE) 2026
 *     Apparel Sourcing Week 2026
 *     Global Food Pro 2027 – International Food Processing Expo
 *     Global Hospitality Education Expo 2026
 *     World Healthcare Expo & Summit 2026
 *     Annual Trauma Summit
 *     Manotsava | National Mental Health Festival
 *     Bangalore HR Summit 2026
 *     Bengaluru 2026 Venture Capital World Summit
 *     Bangalore's Big Business, Tech & Entrepreneur Professional Networking Event
 *     How Non-Techies Can Launch Successful Tech Startups
 *     RACEx360 Emerging Technology Conference 2026
 *     ─ genuinely tech, and the whole gain: ─
 *     MCP Community Connect - Bengaluru · Grace Hopper Celebration India 2027 · ELCIA Tech Summit
 *
 * 17 false positives to buy 3 true ones. The trek is the case worth remembering, because it shows
 * the mechanism rather than just the ratio: `lib/llm/tagger.ts`'s `Conference` pattern lists
 * `summit`, and a trek goes to one. This is the `\bpm\b` → "6 PM" mistake with a different word.
 *
 * `Workshop` is worse, and it is barred by a decision already documented rather than by a new
 * measurement. Its pattern is `workshop|bootcamp|training|masterclass|certification|course|…`,
 * and CLAUDE.md §3 records that `isTechEvent` excludes course-selling sessions EVEN WHEN FREE —
 * the word "paid" in an earlier version of that rule is precisely what let "Free DevOps Demo Class
 * in Electronic City" and "Java Training with Placement" into the tech feed. Adding `Workshop`
 * re-opens that by definition. The 60 upcoming `Workshop`-without-a-tech-topic rows are meditation
 * challenges, Garba workshops, Law of Attraction sessions and nine copies of "Scrum Master product
 * owner Unique scrum master interview questions".
 *
 * `Meetup` is not even arguable: 323 upcoming rows, mostly Toastmasters, board games and treks.
 *
 * SO WHERE DOES THE RECALL LOSS GET FIXED? At the tagger, not here. A tech conference that carries
 * no tech topic is a TAGGING defect — `droidCon India | Android Development Conference 2026`,
 * `UbuCon India 2026`, `The Fifth Elephant Winter Edition 2026` and `TechSparks 2026` are all
 * stored `[Meetup]`, so widening this set would not rescue any of them either. The tool for it is
 * `scripts/retag-category.ts --match=<title regex>`, which CLAUDE.md §3 documents as the only
 * thing that reaches an agreed-upon wrong tag. A category array that reads `[Conference]` simply
 * does not contain the information needed to tell "Annual Trauma Summit" from "MCP Community
 * Connect" — both are `Conference` and nothing else — and no rule over this set can invent it.
 *
 * `tests/tech-flag.test.ts` pins both halves. If you add `Conference` anyway, that suite fails on
 * purpose so the change is deliberate; re-measure first with the query in its header.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
export const TECH_FLAG_CATEGORIES: ReadonlySet<string> = new Set<string>([
  ...TECH_CATEGORY_NAMES,
  'Hackathon',
]);

export const GATHERING_CATEGORY_NAMES = [
  'Hackathon',
  'Conference',
  'Meetup',
  'Workshop',
  'Career/Hiring',
  'Startup/Founders',
  'Product/Design',
] as const;

/**
 * The non-tech tail. Deliberately short: these exist so "show all events" is
 * honest about the rest of the city, not so the taxonomy can describe it well.
 */
export const OTHER_CATEGORY_NAMES = [
  'Business/Finance',
  'Science/Research',
  'Community/Social',
  'Arts/Culture',
  'Health/Fitness',
  'Other',
] as const;

/** Groups the filter rail renders, in display order. */
export const CATEGORY_GROUPS: Array<{
  id: 'tech' | 'gathering' | 'other';
  label: string;
  hint: string;
  names: readonly string[];
  /** Collapsed by default — the non-tech tail should not dominate the rail. */
  collapsed?: boolean;
}> = [
  {
    id: 'tech',
    label: 'Tech topic',
    hint: 'What the event is about',
    names: TECH_CATEGORY_NAMES,
  },
  {
    id: 'gathering',
    label: 'Event type',
    hint: 'What kind of gathering',
    names: GATHERING_CATEGORY_NAMES,
  },
  {
    id: 'other',
    label: 'Everything else',
    hint: 'Shown when "Tech only" is off',
    names: OTHER_CATEGORY_NAMES,
    collapsed: true,
  },
];

/**
 * Every valid category, ordered tech → gathering → tail.
 * Derived from the groups so a new category cannot be added to the enum and then
 * silently go missing from the filter UI.
 */
export const EVENT_CATEGORIES = [
  ...TECH_CATEGORY_NAMES,
  ...GATHERING_CATEGORY_NAMES,
  ...OTHER_CATEGORY_NAMES,
] as const;

export type EventCategory = (typeof EVENT_CATEGORIES)[number];

// -----------------------------------------------------------------------------
// Card metadata: audience, perks, tier
//
// These live here, beside the category taxonomy, for the reason that comment
// gives: the filter rail needs them and importing from lib/models/Event.ts would
// pull mongoose into the browser bundle. The model re-exports them, so there is
// still exactly one definition of each.
//
// ALL THREE ARE CONTROLLED VOCABULARIES, NOT FREE TEXT. `Event.tags` is the
// cautionary tale: 32 of 1212 upcoming events carry any tag, 8 of 334 tech ones,
// six distinct values in the whole corpus -- harvested free text cannot back a
// facet. These are derived by the tagger from a fixed list, so every value is a
// bucket something else can count.
// -----------------------------------------------------------------------------

/**
 * Who the event is FOR. Answers "is this for someone like me" better than any
 * topic tag does -- which is why a competitor's blurred cards still create
 * desire from nothing but "Founders · Leaders & execs".
 */
export const AUDIENCE_NAMES = [
  'students',
  'juniors',
  'senior-engineers',
  'founders',
  'leaders',
  'product',
  'data',
  'security',
  'sre',
  'researchers',
] as const;

export type EventAudience = (typeof AUDIENCE_NAMES)[number];

/** What you actually get in the room. */
export const PERK_NAMES = [
  'breakfast',
  'lunch',
  'snacks',
  'swag',
  'certificate',
  'recording',
  'drinks',
] as const;

export type EventPerk = (typeof PERK_NAMES)[number];

/**
 * The perks that constitute food, and the ONLY definition of that.
 *
 * `hasFood` predates `perks` and TWO shipped things read it: the `hasFood`
 * filter in `buildEventFilter`, and `connectionScore`'s `hasFood === 'yes'`
 * bonus. So `perks` may not replace it -- both stay, and `hasFood` becomes
 * derivable from `perks` through `hasFoodFromPerks()` below. Replacing it
 * outright would silently move every event's score and break a live filter.
 */
export const FOOD_PERKS: ReadonlySet<string> = new Set<string>([
  'breakfast',
  'lunch',
  'snacks',
]);

/**
 * `hasFood` implied by a perk list, or `null` when the perks say nothing about
 * food.
 *
 * RETURNS `null` RATHER THAN `'unknown'`, and the distinction is the whole
 * point. An empty perk list is not evidence that there is no food -- it is the
 * normal state for the ~1500 documents that predate this field and for every
 * source that does not mention catering. A caller must be able to tell "perks
 * say no food" from "perks say nothing", because only the first should overwrite
 * a value an adapter already set.
 */
export function hasFoodFromPerks(
  perks: readonly string[] | undefined | null
): 'yes' | null {
  if (!perks || perks.length === 0) return null;
  return perks.some(p => FOOD_PERKS.has(p)) ? 'yes' : null;
}

/**
 * A browse label, NOT a second ranking.
 *
 * `connectionScore` remains the only ordering signal. If `tier` also ordered
 * things the two would disagree on the same page, and the user would be looking
 * at two rankings pretending to be one.
 *
 * Freely recomputable, unlike `spotlightAt` -- which is EDITORIAL, chosen by a
 * human, and which nothing may recompute or clear. Do not overload that field to
 * mean "flagship"; they answer different questions and only one of them has a
 * person behind it.
 *
 * Useful side effect: `advert` gives the operator console a real handle on the
 * coaching-centre junk that `connectionScore` buries but does not exclude.
 */
export const EVENT_TIERS = ['flagship', 'community', 'advert'] as const;

export type EventTier = (typeof EVENT_TIERS)[number];

/** One row of a timed agenda. Sparse: render nothing when absent. */
export interface AgendaItem {
  /** ISO string over JSON, like every other date on `FeedEvent`. */
  startsAt?: string;
  title: string;
  speakerName?: string;
  speakerCompany?: string;
}

/**
 * A named speaker.
 *
 * NEVER AUTO-CREATE A `Person` FROM ONE OF THESE. A speaker is not your contact.
 * The event page matches a speaker against existing Persons by name and company
 * FOR DISPLAY ONLY ("you met her at IndiaFOSS, Jul"). Creating rows would fill
 * /people with people you have never met and corrupt every `eventCount`.
 */
export interface EventSpeaker {
  name: string;
  title?: string;
  company?: string;
  linkedin?: string;
}
