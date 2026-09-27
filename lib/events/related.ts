/**
 * "Similar events" at the foot of an event page — one filter, used by both the `/events/[id]` page
 * and `GET /api/events/[id]`, which each used to hand-roll it.
 *
 * The hand-rolled version matched on ANY shared category and fell back to `Networking/Meetup`. In a
 * product whose feed is `techOnly` unconditionally, that put comedy shows, a Bollywood tribute night
 * and a board-games evening under a research mixer, measured on 2026-09-27: `Networking/Meetup` is a
 * GATHERING category that concerts share with meetups, so "similar" meant "also a gathering, also
 * soon". Two rules fix it:
 *
 *   - `isTechEvent: true`, the same flag the feed's `techOnly` filters on, so this list can never
 *     show something the feed would hide;
 *   - the match is on the event's TECH TOPICS (AI/ML, Cloud/DevOps, …). Only an event with no topic
 *     at all (a bare Hackathon) falls back to its own categories, and one with none drops the
 *     category clause and relies on the tech flag alone.
 *
 * Scope is `publicEventScope`, not `visibilityClause`, so other users' private events and
 * soft-deleted rows cannot surface here either — see the note on `publicEventScope`.
 */
import { TECH_CATEGORY_NAMES } from '@/lib/event-types';
import { publicEventScope } from './query';
import { normalizeTitleForMatch } from '@/lib/scrapers/core/text';

type EventFilter = Record<string, unknown>;

const TECH_TOPICS: ReadonlySet<string> = new Set<string>(TECH_CATEGORY_NAMES);

export function relatedEventsFilter(
  event: { _id: unknown; category?: readonly string[] | null },
  viewerId: string | null,
  now: Date
): EventFilter {
  const categories = event.category ?? [];
  const topics = categories.filter(c => TECH_TOPICS.has(c));
  const match = topics.length ? topics : categories;
  return {
    $and: [
      publicEventScope(viewerId),
      {
        _id: { $ne: event._id },
        startDateTime: { $gte: now },
        isTechEvent: true,
        ...(match.length ? { category: { $in: match } } : {}),
      },
    ],
  };
}

/**
 * Best-for-connections first, then soonest — the feed's own ranking thesis. Soonest-first alone
 * filled the list with whatever happened tomorrow: online meet-and-greets and a "certified digital
 * marketing" course, which `connectionScore` exists to bury. Mongo sorts a missing score last.
 */
export const RELATED_SORT = { connectionScore: -1, startDateTime: 1 } as const;

/** How many suggestions render, and how many rows are fetched to fill them after de-duplication. */
export const RELATED_COUNT = 6;
export const RELATED_FETCH = 24;

/**
 * One suggestion per SERIES. A monthly meetup is stored as one row per date, all with the same
 * title and score, so ranking by score let "Python Meetup" take four of the six slots under an
 * Airflow meetup (measured 2026-09-27). Keeps the first — i.e. best-ranked, then soonest — row of
 * each normalised title. `normalizeTitleForMatch` keeps digits, so "#107" and "#108" stay distinct.
 */
export function onePerSeries<T extends { title?: string | null }>(rows: readonly T[], count = RELATED_COUNT): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const key = normalizeTitleForMatch(row.title ?? '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
    if (out.length === count) break;
  }
  return out;
}
