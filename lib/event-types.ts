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
  isTargetCompany?: boolean;
  recruiterMentioned?: boolean;
  seenInSources?: string[];
  createdAt?: string;
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
