/**
 * May this viewer see this event? One definition, for the paths that fetch an event BY ID.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS SEPARATELY FROM `visibilityClause()`. That function builds a Mongo predicate and
 * protects everything that goes through the feed — the list, its count, and all six facet
 * aggregations. But four read paths never touch the feed builder at all, and each of them fetches a
 * single document by id:
 *
 *   GET /api/events/[id]            the detail endpoint
 *   …its `related` query             "similar events" on every public detail page
 *   GET /api/events/[id]/ics        a calendar file carrying title, description, venue, address
 *   POST /api/tracker               tracks an event by id and returns it populated
 *
 * A Mongo ObjectId IS NOT A SECRET. It embeds a timestamp and an incrementing counter, so one known
 * id makes its neighbours enumerable — "nobody will guess it" is not an access-control argument.
 * And `related` needs no guessing at all: it would surface other users' private events as
 * suggestions at the bottom of every public event page.
 *
 * ALWAYS 404, NEVER 403. A 403 confirms the row exists, which is itself the disclosure — the same
 * reason `findOwnedFolder()` returns the same 404 for "not yours" as for "not there".
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

/** The only fields this decision reads. Keeps callers free to pass a lean doc or a full document. */
export interface ViewableEvent {
  visibility?: string | null;
  createdByUserId?: string | null;
  /** Set when an admin soft-deleted the event. See the `.select()` warning below. */
  deletedAt?: Date | string | null;
}

/**
 * -- IF YOU FETCH WITH `.select()`, SELECT EVERY FIELD THIS READS ----------------------------
 *
 * This decides from fields on the document, so a field it reads that the query did not fetch
 * arrives as `undefined` -- and every check here treats absence as the PERMISSIVE case, because
 * absence genuinely is the common case across the ~1500 scraped documents. An incomplete
 * `.select()` therefore does not throw and does not deny: it silently returns true for everything.
 *
 * Not hypothetical. `POST /api/folders` shipped with exactly this bug, calling `canViewEvent` on a
 * projection that omitted `visibility` and `createdByUserId`. The guard was present, ran on every
 * request, and admitted every private event. The fields to carry are `visibility`,
 * `createdByUserId` and `deletedAt`.
 */
export function canViewEvent(event: ViewableEvent, viewerId: string | null): boolean {
  // A soft-deleted event is gone as far as every public path is concerned -- checked FIRST, because
  // an admin removing junk must not leave it reachable by direct link, by ICS, or as a "similar
  // event" at the foot of somebody else's page. The owner of a hand-entered event gets no exemption
  // either: the row is retained so an admin can undo, not so it stays readable.
  if (event.deletedAt) return false;

  // ABSENT visibility means public. Roughly 1500 stored documents predate the field and every one
  // of them is a scraped, public event — so this is the common case, not a fallback.
  if (!event.visibility || event.visibility === 'public') return true;

  // 'private' and 'pending' are both owner-only. An admin sees pending submissions through the
  // review listing, which asks a different question and is guarded by `requireAdmin()`; it does not
  // come through here, so this function has no admin branch and cannot be widened by accident.
  return Boolean(viewerId && event.createdByUserId === viewerId);
}

/**
 * Is this event still awaiting review?
 *
 * Its own predicate rather than an inline string compare, so the review queue and any UI badge
 * cannot drift from each other over what 'pending' means.
 */
export function isPendingReview(event: ViewableEvent): boolean {
  return event.visibility === 'pending';
}

/** Did a user type this in by hand, rather than the scraper finding it? */
export function isUserAuthored(event: ViewableEvent): boolean {
  return Boolean(event.createdByUserId);
}
