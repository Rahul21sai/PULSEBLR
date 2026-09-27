/**
 * WHAT THE OPERATOR CONSOLE'S CORPUS METRICS COUNT: the shared corpus, and nothing else.
 *
 * `GET /api/admin/stats` used to run every Event query unscoped, which mixed three populations
 * into one number and did worse in one place: its "Next up" list returned the title, venue and
 * organiser of the soonest tech events — and a user's PRIVATE event is as soon as anybody's. An
 * admin is not the owner, and the allowlist is a bar for operating the corpus, not for reading a
 * stranger's calendar.
 *
 * So:
 *   - every corpus metric (totals, breakdowns, the clusterKey banner, spotlight pins, Next up) is
 *     `corpusFilter(...)`: public, not deleted — what any visitor can see, and therefore what the
 *     dashboard's own copy ("the soonest tech events a user will see") actually claims;
 *   - private and pending user events are reported as COUNTS ONLY, via `userEventsFilter()`, so
 *     the operator can still see that they exist without seeing them.
 *
 * `$and` rather than spreading, for the reason `lib/companies/directory-scope.ts` gives: the scope
 * carries a top-level `$or`, and the clusterKey metric carries its own. Spread, one is dropped.
 */
import { notDeletedClause, publicEventScope } from '@/lib/events/query';

type EventFilter = Record<string, unknown>;

/** The shared corpus (anonymous scope, not deleted), narrowed by any further clauses. */
export function corpusFilter(...clauses: EventFilter[]): EventFilter {
  return { $and: [publicEventScope(null), ...clauses] };
}

export type UserEventState = 'private' | 'pending';

/**
 * User-added events OUTSIDE the corpus, for a count and nothing else. `pending` is the same
 * predicate the Submissions queue lists (`app/api/admin/submissions/route.ts`), so the two agree.
 */
export function userEventsFilter(state: UserEventState): EventFilter {
  return { visibility: state, ...notDeletedClause() };
}
