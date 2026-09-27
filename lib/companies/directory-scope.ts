/**
 * WHICH EVENTS THE PUBLIC COMPANIES DIRECTORY MAY COUNT: upcoming, public, not deleted.
 *
 * `GET /api/companies` used to match on `startDateTime` alone, so it read every stored event
 * regardless of who could see it. The damage was in the "unmatched hosts" list: it selects events
 * with an EMPTY `companies` array, and every private or pending hand-added event has exactly that
 * (`lib/models/Event.ts` defaults it to `[]`) — so a user's private event put its ORGANISER NAME
 * and a count on a public page (`app/companies/page.tsx`). Once attribution is backfilled onto
 * such rows the same gap would feed `upcoming`, `nextEventAt` and the cover image
 * (`$first: '$imageUrl'`). Soft-deleted events were counted too.
 *
 * THE ANONYMOUS SCOPE, FOR EVERY CALLER, AND THE BUILDERS TAKE NO VIEWER AT ALL. The directory is
 * a statement about the shared corpus; a signed-in owner's private events are not "company events
 * in Bengaluru", and a response that varied by viewer would stop being safe to cache anywhere. So
 * there is no parameter a caller could pass a user id through.
 *
 * COMPOSED WITH `$and`, NEVER SPREAD. `publicEventScope()` carries a top-level `$or` (the visibility
 * arms), and the unmatched-hosts stage needs its OWN `$or` over the two shapes of "unattributed".
 * Spreading both into one object keeps whichever was written last and silently drops the other —
 * the collision `visibilityClause()`'s own comment warns about. `$and` cannot collide.
 *
 * `publicEventScope(null)` is imported, not re-typed: its `{ visibility: { $exists: false } }` arm
 * is what keeps the ~1500 legacy documents public, and omitting it empties this page rather than
 * narrowing it. `tests/companies-directory-scope.test.ts` pins both halves.
 */
import { publicEventScope } from '@/lib/events/query';

type Match = Record<string, unknown>;

function directoryClauses(now: Date): Match[] {
  return [publicEventScope(null), { startDateTime: { $gte: now } }];
}

/** Events attributed to at least one registry company — the per-company counts. */
export function attributedEventsMatch(now: Date): Match {
  return { $and: [...directoryClauses(now), { companies: { $ne: [] } }] };
}

/**
 * Events with a named organiser and NO company attribution — the coverage-gap list. Covers both
 * shapes of unattributed: an explicitly empty array, and documents that predate the field.
 */
export function unmatchedHostsMatch(now: Date): Match {
  return {
    $and: [
      ...directoryClauses(now),
      { organizer: { $nin: [null, ''] } },
      { $or: [{ companies: { $size: 0 } }, { companies: { $exists: false } }] },
    ],
  };
}
