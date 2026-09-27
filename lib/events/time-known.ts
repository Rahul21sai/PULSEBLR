/**
 * WHETHER AN EVENT'S START TIME IS REAL, decided at render time.
 *
 * developers.events publishes a DATE, not a time: all 9583 of its date values are midnight UTC
 * (measured 2026-09-27). Stored as-is, that renders as a confident "05:30" IST start — GIDS read
 * "27 Apr 05:30", and a multi-day conference read "05:30 – 05:30". The day is right (midnight UTC is
 * 05:30 IST on the same date); only the clock is invented.
 *
 * Derived rather than stored, on purpose: `isDateOnlyStart` (source is date-only AND the instant is
 * exactly midnight UTC) needs no schema field, no backfill and no stale-schema restart, and it stops
 * applying by itself the moment ingest upgrades the row to a precise time from another source —
 * see `preciseTimingUpgrade` in `lib/scrapers/core/event-match.ts`.
 */
import { isDateOnlyStart } from '@/lib/scrapers/core/event-match';

export const TIME_TBA = 'Time TBA';

export function startTimeKnown(event: { source?: string | null; startDateTime: string | Date }): boolean {
  return !isDateOnlyStart(event.source ?? undefined, new Date(event.startDateTime));
}
