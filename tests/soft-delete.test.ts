import { describe, it, expect } from 'vitest';
import {
  buildEventFilter,
  parseEventParams,
  publicEventScope,
  notDeletedClause,
  visibilityClause,
} from '@/lib/events/query';
import { canViewEvent } from '@/lib/events/visibility';

/**
 * SOFT DELETE — `Event.deletedAt`.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A hard delete cannot be undone, and a re-scrape only restores an event if its source still lists
 * it, which for junk removal is exactly when it does not. So the control room sets `deletedAt` and
 * every read path filters it out.
 *
 * WHY THIS SUITE EXISTS RATHER THAN A DIAG SCRIPT. Two of the three ways this feature can fail are
 * silent, and neither shows up as a wrong count:
 *
 *   1. `{ deletedAt: null }` vs `{ deletedAt: { $exists: false } }`. In MongoDB the first matches a
 *      null field AND an absent one; the second matches only absence. ~1500 documents predate the
 *      field, so the wrong predicate here does not narrow the feed — and if a restore path ever
 *      writes an explicit null rather than `$unset`, `$exists: false` strands the row as invisible
 *      while every admin screen reports it restored. The predicate is asserted structurally, because
 *      no count over today's corpus can distinguish the two (nothing is deleted yet).
 *   2. `canViewEvent` treating an unfetched field as permissive. It reads fields off a document, and
 *      absence is the common case for scraped rows, so every check is written to admit on absence.
 *      Hand it a projection missing `deletedAt` and it returns true for a deleted event, on every
 *      request, with no error. `POST /api/folders` shipped precisely this bug once with
 *      `visibility`.
 *
 * The third failure is loud (a deleted event still in the feed) and is what the filter test covers.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

const ME = 'user-me';
const THEM = 'user-them';
const DELETED = new Date('2026-09-01T10:00:00Z');

describe('canViewEvent — the deleted arm', () => {
  it('refuses a deleted event to an anonymous visitor', () => {
    expect(canViewEvent({ deletedAt: DELETED }, null)).toBe(false);
  });

  it('refuses a deleted event to a signed-in stranger', () => {
    expect(canViewEvent({ visibility: 'public', deletedAt: DELETED }, ME)).toBe(false);
  });

  /**
   * THE OWNER GETS NO EXEMPTION, and this is the case worth stating out loud.
   *
   * A hand-entered event belongs to its author, and everywhere else in this app that means they can
   * see it when nobody else can. Deletion is different: the row is retained so an ADMIN can undo,
   * not so it stays readable by the person whose event was removed. If the owner could still open
   * it, "deleted" would mean "hidden from everyone except the one person most likely to re-share
   * the link".
   */
  it('refuses a deleted event to its own author', () => {
    expect(
      canViewEvent({ visibility: 'private', createdByUserId: ME, deletedAt: DELETED }, ME)
    ).toBe(false);
    expect(
      canViewEvent({ visibility: 'pending', createdByUserId: ME, deletedAt: DELETED }, ME)
    ).toBe(false);
  });

  /**
   * The load-bearing negative half: absence and null must both read as "present in the corpus".
   * Getting this backwards refuses the entire scraped corpus to everybody, signed-out included.
   */
  it('admits every shape that means "not deleted"', () => {
    expect(canViewEvent({}, null)).toBe(true);
    expect(canViewEvent({ deletedAt: null }, null)).toBe(true);
    expect(canViewEvent({ deletedAt: undefined }, null)).toBe(true);
    // A lean document round-tripped through JSON carries an ISO string, not a Date.
    expect(canViewEvent({ deletedAt: DELETED.toISOString() }, null)).toBe(false);
  });

  /** Deletion is checked FIRST, so it cannot be short-circuited by a permissive visibility. */
  it('outranks a public visibility', () => {
    expect(canViewEvent({ visibility: 'public' }, null)).toBe(true);
    expect(canViewEvent({ visibility: 'public', deletedAt: DELETED }, null)).toBe(false);
  });
});

describe('notDeletedClause', () => {
  /**
   * Asserted as an exact object rather than "contains deletedAt", because the two candidate
   * predicates differ only in the value and both look plausible in review. `$exists: false` here
   * would pass a laxer test and strand any restored row.
   */
  it('is `{ deletedAt: null }` — matching absent AND null, not `$exists`', () => {
    expect(notDeletedClause()).toEqual({ deletedAt: null });
  });

  it('does not use $exists or $ne anywhere', () => {
    const serialised = JSON.stringify(notDeletedClause());
    expect(serialised).not.toContain('$exists');
    expect(serialised).not.toContain('$ne');
    expect(serialised).not.toContain('$type');
  });
});

describe('buildEventFilter — deleted rows leave every listing by default', () => {
  it('excludes deleted rows with no parameters at all', () => {
    expect(buildEventFilter({}, null).deletedAt).toBeNull();
  });

  it('excludes them for a signed-in viewer too', () => {
    expect(buildEventFilter({ techOnly: true }, ME).deletedAt).toBeNull();
  });

  /** Every window and mode, since each takes a different branch through the builder. */
  it.each([
    ['upcoming', { includeOngoing: true }],
    ['past', { includePast: true }],
    ['calendar span', { spanning: true, from: new Date(), to: new Date() }],
    ['spotlight', { spotlight: true }],
    ['searched', { q: 'kubernetes meetup' }],
    ['single-word search', { q: 'kafka' }],
  ])('excludes them on the %s branch', (_label, params) => {
    expect(buildEventFilter(params, null).deletedAt).toBeNull();
  });

  it('includes them only when a caller explicitly opts in', () => {
    expect('deletedAt' in buildEventFilter({ includeDeleted: true }, null)).toBe(false);
  });

  /**
   * The opt-in must not be reachable from a URL. Otherwise anyone appending
   * `?includeDeleted=true` pages through everything an admin removed — which for the junk and
   * off-city cases is the whole reason it was removed.
   */
  it('cannot be turned on from a querystring', () => {
    const params = parseEventParams(
      new URLSearchParams('includeDeleted=true&includeDeleted=1&techOnly=true')
    );
    expect(params.includeDeleted).toBeUndefined();
    expect(buildEventFilter(params, null).deletedAt).toBeNull();
  });

  /** The visibility arms must survive untouched — this change may only ever ADD a constraint. */
  it('leaves the three visibility arms exactly as they were', () => {
    const and = buildEventFilter({}, ME).$and as Array<Record<string, unknown>>;
    expect(and[0]).toEqual(visibilityClause(ME));
    expect((and[0].$or as unknown[]).length).toBe(3);
  });
});

describe('publicEventScope — for the hand-rolled queries buildEventFilter never sees', () => {
  /**
   * Two "similar events" queries spread this instead of `visibilityClause`. They are the reason it
   * exists: they hand-roll a filter, so they could not inherit the deleted arm from
   * `buildEventFilter`, and without it an event an admin had just removed would keep appearing as a
   * suggestion at the foot of every related event's page.
   */
  it('is the visibility clause plus the deleted clause, byte for byte', () => {
    for (const viewer of [null, ME, THEM]) {
      expect(publicEventScope(viewer)).toEqual({
        ...visibilityClause(viewer),
        ...notDeletedClause(),
      });
    }
  });

  it('keeps the anonymous case at two visibility arms', () => {
    // A control: if the clause were broken rather than correctly anonymous, this would not be 2.
    expect((publicEventScope(null).$or as unknown[]).length).toBe(2);
    expect((publicEventScope(ME).$or as unknown[]).length).toBe(3);
  });

  it('never mentions createdByUserId for an anonymous viewer', () => {
    expect(JSON.stringify(publicEventScope(null))).not.toContain('createdByUserId');
  });
});
