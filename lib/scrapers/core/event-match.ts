// Cross-source NEAR-TWIN matching — the fallback behind the exact `clusterKey`.
//
// ── WHY THE EXACT KEY IS NOT ENOUGH ──────────────────────────────────────────────────────────
//
// `clusterKey` is normalized title + IST calendar day, and it must stay exact: it is stored,
// frozen at ingest, and grouped on by two cleanup scripts. But two real sightings of one event
// can miss it in two measured ways (scripts/diag-gids-dupe.ts, 2026-09-27):
//
//   devevents  "Great International Developer Summit (GIDS)"       2027-04-27T00:00:00Z
//   company    "Great International Developer Summit (GIDS) 2027"  2027-04-26T10:00:00Z
//
//   1. THE YEAR. One title carries the edition year and one does not, so the normalized
//      titles differ by the token "2027". The year is redundant with the date the key already
//      carries, but stripping it inside `normalizeTitleForMatch` would re-key every stored
//      event whose title has a year in it — each would stop matching its own next sighting and
//      the feed would fill with exactly the duplicates this module exists to remove. So the
//      year is ignored HERE, in a comparison, never in the stored key.
//
//   2. THE DAY. developers.events is DATE-ONLY: all 9583 date values in its dataset are
//      00:00:00.000Z (measured). A date has no time and no zone, so a sighting from it pins the
//      calendar day at best, and any other source's day can legitimately sit one either side of
//      it. For GIDS the other side is simply wrong — developersummit.com's own page says
//      "27-30 Apr 2027" while its JSON-LD says 2027-04-26 — and no key built from a day can
//      absorb a source that disagrees with itself.
//
// ── WHAT KEEPS IT NARROW ─────────────────────────────────────────────────────────────────────
//
//   · Titles must be EQUAL after normalization and year removal. Not similar — equal. Digits
//     other than the event's own year survive, so "#107" and "#108" never meet.
//   · The ±1 IST day window opens ONLY when at least one side is date-only. Two precise
//     sightings must share an IST day — a nightly show, or "Dev Days" at two different venues on
//     consecutive days (a real pair in the corpus), stays two events.
//   · Cities must not disagree.
//   · A hand-entered (owned) row is never a candidate. CLAUDE.md §12: merging into one is
//     silent data loss, not a tidy-up.

import { normalizeTitleForMatch } from './text';

/** Sources whose timestamps carry a calendar DATE only. Measured, not assumed — see header. */
export const DATE_ONLY_SOURCES: ReadonlySet<string> = new Set(['devevents']);

const DAY_MS = 86_400_000;

const istDayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** YYYY-MM-DD in IST — the same bucketing `Event.generateClusterKey` uses. */
export function istDayKey(date: Date): string {
  return istDayFormatter.format(date);
}

/** Whole IST calendar days between two instants, unsigned. */
export function istDayGap(a: Date, b: Date): number {
  const am = Date.parse(`${istDayKey(a)}T00:00:00Z`);
  const bm = Date.parse(`${istDayKey(b)}T00:00:00Z`);
  return Math.round(Math.abs(am - bm) / DAY_MS);
}

/**
 * Does this sighting know only the DATE?
 *
 * Both conditions, deliberately. The source alone is not enough once a merge has upgraded a
 * devevents document to a precise time from another source — that document is no longer
 * date-only, and treating it as such would let the next precise sighting overwrite the time
 * again. The midnight alone is not enough either: a real event can start at 05:30 IST.
 */
export function isDateOnlyStart(source: string | undefined, start: Date): boolean {
  if (!source || !DATE_ONLY_SOURCES.has(source)) return false;
  return start.toISOString().endsWith('T00:00:00.000Z');
}

/**
 * The comparison title: `normalizeTitleForMatch` minus a token equal to this sighting's own
 * IST year. Only the event's OWN year — "Foo 2025 Retrospective" on a 2027 date keeps its 2025.
 * Returns '' when nothing meaningful is left, which never matches.
 */
export function matchTitle(title: string, start: Date): string {
  const year = istDayKey(start).slice(0, 4);
  const kept = normalizeTitleForMatch(title)
    .split(' ')
    .filter(token => token && token !== year);
  const joined = kept.join(' ');
  // A title that was nothing but a year and noise is not an identity.
  return joined.replace(/\s/g, '').length >= 4 ? joined : '';
}

/** Bengaluru under any spelling folds to one value; unknown is ''. */
function canonicalCity(city: string | undefined): string {
  const text = (city || '').trim().toLowerCase();
  if (!text) return '';
  if (/\b(bengaluru|bangalore|blr)\b/.test(text)) return 'bengaluru';
  return text;
}

export interface MatchSighting {
  title: string;
  startDateTime: Date;
  source?: string;
  city?: string;
  createdByUserId?: string;
}

/** Are these two sightings the same event? The predicate — see the header for every rule. */
export function isNearTwin(a: MatchSighting, b: MatchSighting): boolean {
  if (a.createdByUserId || b.createdByUserId) return false;

  const ta = matchTitle(a.title, a.startDateTime);
  if (!ta || ta !== matchTitle(b.title, b.startDateTime)) return false;

  const ca = canonicalCity(a.city);
  const cb = canonicalCity(b.city);
  if (ca && cb && ca !== cb) return false;

  const gap = istDayGap(a.startDateTime, b.startDateTime);
  const eitherDateOnly =
    isDateOnlyStart(a.source, a.startDateTime) || isDateOnlyStart(b.source, b.startDateTime);
  return gap <= (eitherDateOnly ? 1 : 0);
}

/**
 * The best near-twin for `incoming` among `candidates`, or undefined. Same IST day beats an
 * adjacent one, then the closest start wins, so an ambiguous window resolves deterministically.
 */
export function pickNearTwin<T extends MatchSighting>(
  incoming: MatchSighting,
  candidates: readonly T[]
): T | undefined {
  let best: T | undefined;
  let bestRank = Infinity;
  for (const candidate of candidates) {
    if (!isNearTwin(incoming, candidate)) continue;
    const rank =
      istDayGap(incoming.startDateTime, candidate.startDateTime) * 1e13 +
      Math.abs(+incoming.startDateTime - +candidate.startDateTime);
    if (rank < bestRank) {
      bestRank = rank;
      best = candidate;
    }
  }
  return best;
}

/** How far either side of a sighting's start the candidate query must reach. */
export const NEAR_TWIN_QUERY_WINDOW_MS = 2 * DAY_MS;

/**
 * Should a merge replace `existing`'s time with `incoming`'s? Only to UPGRADE a date-only start to
 * a precise one on the SAME IST day.
 *
 * Never the reverse — a date-only sighting knows less. And never across days: when a precise
 * source disagrees with the date-only one about the day itself, that is a conflict, not an
 * improvement, and a merge may only fill gaps or improve values (CLAUDE.md §2). GIDS is exactly
 * this case, and the date-only side is the one its organiser's own page agrees with.
 */
export function preciseTimingUpgrade(
  existing: { source?: string; startDateTime: Date; endDateTime?: Date | null },
  incoming: { source?: string; startDateTime: Date; endDateTime?: Date | null }
): { startDateTime: Date; endDateTime?: Date } | null {
  if (!isDateOnlyStart(existing.source, existing.startDateTime)) return null;
  if (isDateOnlyStart(incoming.source, incoming.startDateTime)) return null;
  if (istDayGap(existing.startDateTime, incoming.startDateTime) !== 0) return null;
  return {
    startDateTime: incoming.startDateTime,
    endDateTime: incoming.endDateTime ?? undefined,
  };
}
