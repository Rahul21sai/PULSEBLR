// Topic landing pages: the slug ↔ dimension mapping, and the copy that makes a page worth having.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS MODULE IS PURE. Everything here is a total function of a slug or a list of events, so
// it sits in the vitest tier (`tests/event-topics.test.ts`) rather than needing a database. That
// matters because the interesting property is not "does the slug parse" — it is that the SET of
// pages this app is willing to publish is small, deliberate, and cannot grow by accident.
//
// TWO FLOORS, AND BOTH ARE LOAD-BEARING. Google treats thin templated pages with a swapped noun as
// doorway pages and penalises the whole site for them, so "generate a page per dimension" is not a
// free win — it is a liability that scales. The design spec's own words: better 25 real pages than
// 300 empty ones.
//
//   FLOOR 1 — A TOPIC EXISTS ONLY IF SOMEBODY WROTE A PARAGRAPH FOR IT. `blurb` is a required
//   field on `Topic` and every entry below carries hand-written prose about that specific topic in
//   this specific city. There is no template string anywhere in this file that interpolates a name
//   into a sentence, and that absence is the point: if the only way to add a page is to write copy
//   for it, the page count cannot quietly become the full 22 × 28 matrix. `findTopic` returns null
//   for anything not in these tables, so an unwritten dimension 404s rather than rendering a stub.
//
//   FLOOR 2 — ≥ `MIN_TOPIC_EVENTS` UPCOMING EVENTS, checked at render against the live corpus.
//   Copy alone is not enough: a page headed "Cybersecurity events in Bengaluru" listing one event
//   is still thin. This floor cannot live in this file because it is a fact about the database, so
//   it is exported as a number and enforced by the page — see `MIN_TOPIC_EVENTS`.
//
// WHY THE NON-TECH CATEGORIES ARE ABSENT. `OTHER_CATEGORY_NAMES` (Arts/Culture, Health/Fitness,
// Community/Social …) get no pages at all. The public feed is `techOnly` UNCONDITIONALLY, so a
// landing page for Arts/Culture would advertise supply the product deliberately does not present —
// an orphan page, linked from nothing, about events the reader cannot then browse. Category pages
// are the tech topics plus the gathering kinds, and every listing query carries `techOnly: true`
// so a topic page and the feed cannot disagree about what this app is for.
//
// WHY AREA SLUGS CARRY AN `in-` PREFIX. Categories and areas are two dimensions in one URL space
// and they collide: 'Other' is both a category and an area, and a future area named after a
// technology would collide too. The prefix removes the whole class of ambiguity, reads correctly as
// a URL (`/topics/in-koramangala`), and makes `findTopic` a lookup rather than a search order.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { GATHERING_CATEGORY_NAMES, TECH_CATEGORY_NAMES } from '../event-types';
import { dayKeyIST } from '../format';
import type { EventQueryParams } from './query';

/**
 * How many upcoming events a topic needs before its page may exist.
 *
 * Exported rather than inlined so the page's floor and this module's documentation are the same
 * number. Three is the spec's figure, and the reasoning is worth keeping: two events is a list you
 * would not bookmark, and a page nobody would bookmark is a page Google reads as a doorway.
 */
export const MIN_TOPIC_EVENTS = 3;

export interface Topic {
  kind: 'category' | 'area';
  /** URL segment. Stable — it is a public URL, so renaming one costs a redirect. */
  slug: string;
  /** The value stored on `Event` that this topic filters on. */
  name: string;
  /** `<h1>` and the `<title>` stem. Written, not assembled. */
  heading: string;
  /**
   * The written paragraph. REQUIRED, and its existence is floor 1 above.
   *
   * Each one says something true about this topic in Bengaluru that a reader could not get from
   * the listing beneath it. None of them is a template with the topic name substituted in.
   */
  blurb: string;
}

/** Lowercase, alphanumeric, hyphen-separated. `'Cloud/DevOps'` → `'cloud-devops'`. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The category topics, in feed order: the nine tech subjects, then the gathering kinds.
 *
 * Keyed by the exact stored category value, because that string is what goes into the Mongo
 * filter. A typo here does not throw — it produces a page with zero events, which floor 2 then
 * refuses to publish. That is the failure mode by design.
 */
const CATEGORY_COPY: Record<string, { heading: string; blurb: string }> = {
  'AI/ML': {
    heading: 'AI and machine learning events in Bengaluru',
    blurb:
      'This is the densest corner of the calendar, and the most uneven. The same week will offer a ' +
      'genuine inference-engine deep dive hosted at a company office and half a dozen "get certified in ' +
      'agentic AI" sessions that are lead generation for a paid course. The listings below are ranked by ' +
      'how likely you are to leave with a useful contact rather than by how recently they were posted, ' +
      'which is what pushes the practitioner meetups above the funnels.',
  },
  'Data/Analytics': {
    heading: 'Data and analytics events in Bengaluru',
    blurb:
      'Warehouse, streaming and analytics engineering, which in this city means a lot of Kafka, dbt, ' +
      'Snowflake and ClickHouse — several of those vendors run their own Bengaluru community events, so ' +
      'the host is often the company that builds the tool. Expect a heavier tilt toward evening talks at ' +
      'offices than toward weekend workshops.',
  },
  'Cloud/DevOps': {
    heading: 'Cloud and DevOps events in Bengaluru',
    blurb:
      'Kubernetes, platform engineering, observability and the CNCF orbit. Bengaluru has an unusually ' +
      'active set of vendor-neutral chapters here — the CNCF and Linux Foundation groups, Docker and ' +
      'HashiCorp meetups, plus the cloud providers’ own community days — so the same topic recurs ' +
      'monthly rather than annually. Good for repeat attendance, which is how you actually build a ' +
      'network rather than collect business cards.',
  },
  'Web/Mobile': {
    heading: 'Web and mobile engineering events in Bengaluru',
    blurb:
      'Frontend, React Native, Android and Flutter. This is the category where the community groups ' +
      'outnumber the corporate hosts, and where the numbered-series meetups live — a group on its ' +
      'hundredth edition tells you more about whether the room will be worth your evening than any ' +
      'description does.',
  },
  Cybersecurity: {
    heading: 'Cybersecurity events in Bengaluru',
    blurb:
      'Application security, cloud security, red-team practice and the local OWASP chapter. Supply here ' +
      'is thinner than in AI or cloud, and it clusters: a quiet month, then a conference weekend that ' +
      'pulls the whole community into one room. Worth watching the calendar rather than checking once.',
  },
  'Open Source': {
    heading: 'Open source events in Bengaluru',
    blurb:
      'Contributor-facing rather than product-facing: FOSS United’s Bengaluru chapter, the Apache and ' +
      'Linux Foundation groups, Hacktoberfest season, and the India-scale conferences that happen to land ' +
      'here. These are the events where the person next to you maintains something you depend on, which ' +
      'is a different kind of room from a vendor talk.',
  },
  'Hardware/Robotics': {
    heading: 'Hardware, embedded and robotics events in Bengaluru',
    blurb:
      'The hardest category to fill, and the reason is supply rather than search: Bengaluru is a silicon ' +
      'city — VLSI, RISC-V, embedded, test and measurement — but almost none of that community publishes ' +
      'to a machine-readable calendar. What does surface tends to come from makerspaces and the ' +
      'university-adjacent groups. A short list here is an accurate picture of what is publicly listed, ' +
      'not of what is happening.',
  },
  'Blockchain/Web3': {
    heading: 'Blockchain and Web3 events in Bengaluru',
    blurb:
      'Mostly hackathons and builder residencies rather than talks, and heavily seasonal — a protocol’s ' +
      'India tour will fill a fortnight and then leave nothing for two months. Read the format field ' +
      'carefully in this category: a lot of it is online, and an online hackathon kickoff is not a room ' +
      'you can network in.',
  },
  'Gaming/XR': {
    heading: 'Games and XR engineering events in Bengaluru',
    blurb:
      'Games engineering, engine work and spatial computing — not games as a leisure activity, which is a ' +
      'distinction this app has had to enforce deliberately, because "gaming" is the word a classifier ' +
      'reaches for when it is unsure. If a board-game night has slipped in below, it is a bug rather than ' +
      'the category working as intended.',
  },
  Hackathon: {
    heading: 'Hackathons in Bengaluru',
    blurb:
      'Weekend builds, campus fests and sponsor-run challenges. Two things to check before committing a ' +
      'weekend: whether it is actually in person, since a large share of what gets listed as a hackathon ' +
      'is an online submission deadline with no room to walk into, and whether the listed date is the ' +
      'event or the registration cutoff. The detail page names which one it is.',
  },
  Conference: {
    heading: 'Tech conferences in Bengaluru',
    blurb:
      'The multi-day, paid-ticket end of the calendar — the summits and community conferences that draw ' +
      'speakers from outside the city. These are the highest-value events for meeting people and the ' +
      'ones you have to plan around, so they are listed here well ahead of their dates. Several run ' +
      'across three days and appear on each of them.',
  },
  Meetup: {
    heading: 'Tech meetups in Bengaluru',
    blurb:
      'The recurring evening format that most of this city’s engineering community actually runs on: ' +
      'two talks, food, and an hour of standing around afterwards. That last hour is the point, and it is ' +
      'why an in-person meetup with catering outranks a webinar on the same subject in the ordering below.',
  },
  Workshop: {
    heading: 'Hands-on tech workshops in Bengaluru',
    blurb:
      'Bring a laptop. The useful ones are capped small and run by someone who does the work daily; the ' +
      'ones to avoid are the free "demo classes" that exist to sell a course, which this app penalises ' +
      'hard in its ranking but does not remove. If a workshop is free, three hours long, and hosted by a ' +
      'training institute, read it as a sales session.',
  },
  'Career/Hiring': {
    heading: 'Hiring and career events for engineers in Bengaluru',
    blurb:
      'Hiring drives, referral evenings and career-switch panels. The signal worth filtering on is whether ' +
      'engineers from the hiring team are in the room or whether it is a recruiter funnel — an event hosted ' +
      'at a company office by its own engineering group is usually the former. Events mentioning open roles ' +
      'are flagged on their detail page.',
  },
  'Startup/Founders': {
    heading: 'Startup and founder events in Bengaluru',
    blurb:
      'Demo days, founder dinners and early-stage showcases. Note the deliberate ambiguity this app has ' +
      'had to handle: "Demo Day" and "Demo Night" are networking-dense and genuinely worth attending, ' +
      'while "Demo Class" is a coaching centre. The ranking treats them as opposites, which is why the ' +
      'order below is not chronological.',
  },
  'Product/Design': {
    heading: 'Product and design events in Bengaluru',
    blurb:
      'Product management, research and design practice — disciplines that attend tech events rather than ' +
      'being a software subject themselves, which is why they sit apart from the engineering topics here. ' +
      'A good one is the fastest way for an engineer to meet the people who decide what gets built.',
  },
};

/**
 * The areas with a page, and the copy that earns each one.
 *
 * DELIBERATELY NOT ALL 28 CANONICAL AREAS. `BENGALURU_AREAS` is the full gazetteer the scraper
 * resolves against, and most of its entries are residential neighbourhoods that host no tech
 * events — a page for each would be the doorway-page pattern exactly. These twelve are where the
 * city’s tech events actually happen. `Other`, which sits on a large share of the corpus, gets
 * no page at all: "events in Other" is not a place.
 */
const AREA_COPY: Record<string, { heading: string; blurb: string }> = {
  Koramangala: {
    heading: 'Tech events in Koramangala',
    blurb:
      'The startup core, and the easiest area in the city to attend an event in on a weeknight — most ' +
      'venues here are a short walk from each other, so a 6pm talk and a 9pm founder dinner are a ' +
      'realistic same-evening pair. Expect small rooms, early-stage companies and a lot of repeat faces.',
  },
  Indiranagar: {
    heading: 'Tech events in Indiranagar',
    blurb:
      'Co-working spaces and company offices along the 100ft Road corridor, with the best post-event ' +
      'options in the city within walking distance — which matters more than it sounds, because the ' +
      'conversation that makes an event worth attending usually happens after it ends.',
  },
  Whitefield: {
    heading: 'Tech events in Whitefield',
    blurb:
      'Large enterprise campuses — ITPL and the tech parks around it — so the events here skew corporate, ' +
      'bigger and better catered than the Koramangala end of town. Budget for the commute: crossing the ' +
      'city to Whitefield on a weekday evening is the single most common reason people skip an event they ' +
      'registered for.',
  },
  'HSR Layout': {
    heading: 'Tech events in HSR Layout',
    blurb:
      'Dense with small product companies and co-working floors, and close enough to Koramangala that the ' +
      'two share a community. Sector-based addresses are worth reading twice — HSR is large, and two ' +
      'events in the same "area" can be four kilometres apart.',
  },
  'Electronic City': {
    heading: 'Tech events in Electronic City',
    blurb:
      'The services-and-silicon end of the city: large campuses, hardware and embedded employers, and a ' +
      'notable share of training-institute adverts dressed as free workshops. Worth being sceptical of ' +
      'anything here promising placement. Genuine company-hosted events do happen, usually on campus and ' +
      'usually needing registration in advance for gate entry.',
  },
  'MG Road': {
    heading: 'Tech events around MG Road and Church Street',
    blurb:
      'Central, transit-friendly and the most reliable place to hold something that people from all over ' +
      'the city can reach — which is why conferences and cross-community events land here. Metro access is ' +
      'the practical advantage over every other area on this list.',
  },
  Marathahalli: {
    heading: 'Tech events in Marathahalli',
    blurb:
      'Offices along the Marathahalli–Kundalahalli stretch, and a useful middle ground between the ' +
      'Whitefield campuses and the central areas. Traffic here is the constraint, not the venue: an event ' +
      'that starts at 6.30pm is usually pitched at people who already work in the neighbourhood.',
  },
  'Outer Ring Road': {
    heading: 'Tech events on the Outer Ring Road',
    blurb:
      'The Bellandur–Devarabisanahalli tech-park belt, where a large share of the city’s engineers ' +
      'work — so it hosts the biggest weekday-evening turnouts, in the best-equipped auditoriums. Check ' +
      'which park and which building: the addresses look interchangeable and are not.',
  },
  'Sarjapur Road': {
    heading: 'Tech events on Sarjapur Road',
    blurb:
      'A newer cluster of product-company offices, and increasingly where teams that outgrew Koramangala ' +
      'end up. Events here are typically hosted by a single company for its own community, which tends to ' +
      'mean a smaller room and a better conversation.',
  },
  Domlur: {
    heading: 'Tech events in Domlur',
    blurb:
      'Old Airport Road and the Embassy Golf Links campuses — a concentration of large engineering ' +
      'organisations in a small footprint, close to the centre. One of the few areas where a big-company ' +
      'event is genuinely convenient to reach from anywhere in the city.',
  },
  Hebbal: {
    heading: 'Tech events in Hebbal',
    blurb:
      'The Manyata Tech Park side of north Bengaluru, which runs its own event circuit largely independent ' +
      'of the south. If you work north of the city, these are the events you can actually get to on a ' +
      'weeknight; if you do not, plan for the flyover.',
  },
  Jayanagar: {
    heading: 'Tech events in Jayanagar',
    blurb:
      'South Bengaluru’s quieter scene — community groups, student chapters and weekend formats rather ' +
      'than corporate evenings. Smaller and less frequent than the tech-park areas, and correspondingly ' +
      'easier to have a real conversation at.',
  },
};

function buildTopics(): Topic[] {
  const categories = [...TECH_CATEGORY_NAMES, ...GATHERING_CATEGORY_NAMES]
    // A category with no written copy gets no page. See floor 1.
    .filter(name => name in CATEGORY_COPY)
    .map<Topic>(name => ({
      kind: 'category',
      slug: slugify(name),
      name,
      heading: CATEGORY_COPY[name].heading,
      blurb: CATEGORY_COPY[name].blurb,
    }));

  const areas = Object.keys(AREA_COPY).map<Topic>(name => ({
    kind: 'area',
    // `in-` prefixed, so a category and an area can never claim the same URL. See the header.
    slug: `in-${slugify(name)}`,
    name,
    heading: AREA_COPY[name].heading,
    blurb: AREA_COPY[name].blurb,
  }));

  return [...categories, ...areas];
}

/**
 * Every topic this app is willing to publish a page for, categories first.
 *
 * This is the full candidate set, not the published set: floor 2 (≥ `MIN_TOPIC_EVENTS` upcoming
 * events) is a fact about the database and is applied by the page, so a slug appearing here is a
 * page that MAY exist, not one that does.
 */
export const TOPICS: readonly Topic[] = buildTopics();

const BY_SLUG = new Map(TOPICS.map(t => [t.slug, t]));

/** The topic for a URL segment, or null — which the page must turn into a 404. */
export function findTopic(slug: string | null | undefined): Topic | null {
  if (!slug) return null;
  return BY_SLUG.get(slug.toLowerCase()) ?? null;
}

const BY_DIMENSION = new Map(TOPICS.map(t => [`${t.kind}:${t.name}`, t]));

/**
 * The topic page for a stored `category` or `area` value, or null when this app publishes none.
 *
 * FOR LINKING, and the null is the whole reason it exists. An event page wants to link its
 * categories to their topic pages, but only 16 of the 22 categories and 12 of the 28 areas have
 * one — so a caller that slugified the name itself would emit links to pages that 404. This is a
 * lookup in the published set, not a string transform.
 */
export function topicForDimension(kind: Topic['kind'], name: string | null | undefined): Topic | null {
  if (!name) return null;
  return BY_DIMENSION.get(`${kind}:${name}`) ?? null;
}

/** Params for `generateStaticParams`. Pure, so it needs no database at build time. */
export function topicStaticParams(): Array<{ slug: string }> {
  return TOPICS.map(t => ({ slug: t.slug }));
}

/**
 * The corpus query behind a topic page.
 *
 * `techOnly: true` on BOTH kinds, deliberately. The public feed is tech-only unconditionally, so a
 * topic page that showed non-tech events would be the one surface in the app disagreeing with every
 * other one about what this product is — and for an area page it is the difference between "tech
 * events in Koramangala" and a listings site for the neighbourhood.
 *
 * Returns `EventQueryParams` for `buildEventFilter`, never a hand-rolled `$match`: the visibility
 * clause is load-bearing (~1500 documents predate the `visibility` field, and omitting its
 * `$exists: false` arm empties the feed rather than narrowing it), and it is not something a page
 * should be reassembling.
 */
export function topicQueryParams(topic: Topic): EventQueryParams {
  const base: EventQueryParams = { techOnly: true, includeOngoing: true };
  return topic.kind === 'category'
    ? { ...base, category: [topic.name] }
    : { ...base, area: [topic.name] };
}

/** `<title>` text. Kept out of the page so the index and the page cannot word it differently. */
export function topicPageTitle(topic: Topic): string {
  return `${topic.heading} · PulseBLR`;
}

/**
 * `<meta name="description">`.
 *
 * The first sentence of the written blurb rather than a generated line, so the description is the
 * page’s own prose. Cut on a sentence boundary where there is one within the budget, because a
 * description truncated mid-clause reads as broken in a search result — and failing that, on a WORD
 * boundary, because a search result ending mid-word reads as a rendering fault rather than an
 * elision.
 *
 * 160 characters is what Google typically shows on desktop. Longer is not an error, it is simply
 * cut by somebody else at a place we did not choose.
 */
export function topicMetaDescription(topic: Topic): string {
  const text = topic.blurb.replace(/\s+/g, ' ').trim();
  if (text.length <= 160) return text;

  const sentence = text.lastIndexOf('. ', 160);
  if (sentence > 80) return text.slice(0, sentence + 1);

  const cut = text.slice(0, 157);
  const word = cut.lastIndexOf(' ');
  return `${(word > 100 ? cut.slice(0, word) : cut).trimEnd()}…`;
}

/* ────────────────────────── "when do these usually happen" ────────────────────────── */

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * IST weekday name for an instant.
 *
 * Routed through `dayKeyIST` rather than a second `Intl` formatter, so it cannot disagree with the
 * day the feed and the calendar put an event on. The key is `YYYY-MM-DD`, parsed as UTC midnight,
 * so `getUTCDay()` is the IST weekday exactly.
 *
 * THE VALIDITY CHECK COMES FIRST, and it is not defensive noise: `dayKeyIST` goes through
 * `Intl.DateTimeFormat.format`, which THROWS `RangeError: Invalid time value` on an invalid date
 * rather than returning `Invalid Date`. Every date here is scraped, so an unparseable one is a
 * question of when, not if — and a throw inside a rhythm sentence would take the whole topic page
 * down over one bad row. Returns '' so the caller can simply skip it.
 */
export function istWeekdayName(date: string | Date): string {
  const ms = new Date(date).getTime();
  if (Number.isNaN(ms)) return '';
  const dayMs = Date.parse(`${dayKeyIST(new Date(ms))}T00:00:00Z`);
  if (Number.isNaN(dayMs)) return '';
  return WEEKDAYS[new Date(dayMs).getUTCDay()];
}

/** The subset of an event a rhythm sentence reads. Narrow, so a lean projection satisfies it. */
export interface RhythmInput {
  startDateTime: string;
  format: 'online' | 'offline' | 'hybrid';
  isFree: boolean;
}

/**
 * A written answer to "when do these usually happen", computed from the events on the page.
 *
 * This is the half of a topic page that a template cannot fake: it is a real measurement over the
 * live corpus, it differs per topic, and it changes as the calendar does. Returns null below the
 * floor rather than a sentence about two events — a claim about a pattern needs enough rows to be a
 * pattern, and an honest silence is better than "these usually happen on a Tuesday" derived from
 * one Tuesday.
 */
export function describeRhythm(events: RhythmInput[]): string | null {
  if (events.length < MIN_TOPIC_EVENTS) return null;

  const dayCounts = new Map<string, number>();
  const hours: number[] = [];
  let inPerson = 0;
  let free = 0;

  for (const event of events) {
    const day = istWeekdayName(event.startDateTime);
    if (day) dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1);

    // IST is UTC+5:30 with no DST, so the hour is a fixed shift — no formatter needed, and this
    // stays pure. Half-hour starts round down to the hour they begin in.
    const ms = Date.parse(event.startDateTime);
    if (!Number.isNaN(ms)) hours.push(Math.floor(((ms + 5.5 * 3600_000) / 3600_000) % 24));

    if (event.format !== 'online') inPerson += 1;
    if (event.isFree) free += 1;
  }

  const total = events.length;
  const busiest = [...dayCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  const parts: string[] = [];

  // Only claim a busiest day when it is actually concentrated. A "most common" day holding two of
  // eleven events is arithmetic, not a pattern, and stating it would be the kind of confident
  // nonsense that makes a generated paragraph read as generated.
  if (busiest && busiest[1] >= 2 && busiest[1] / total >= 0.25) {
    const hoursOnDay = hours.length > 0 ? median(hours) : null;
    parts.push(
      hoursOnDay === null
        ? `Most fall on a ${busiest[0]}.`
        : `${busiest[0]} is the busiest day, and these typically start around ${String(hoursOnDay).padStart(2, '0')}:00.`
    );
  } else if (hours.length > 0) {
    parts.push(
      `These are spread across the week, typically starting around ${String(median(hours)).padStart(2, '0')}:00.`
    );
  }

  parts.push(
    `${inPerson} of the ${total} upcoming are in person${free > 0 ? `, and ${free} are free to attend` : ''}.`
  );

  return parts.join(' ');
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
