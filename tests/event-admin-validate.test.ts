/**
 * `validateEventUpdate()` — what an admin may change on a stored event.
 *
 * `PUT /api/events/[id]` used to do `{ $set: body }` with only `dedupHash` removed. The first
 * group below is the reason that had to change: those fields are identity, provenance or derived,
 * and a raw `$set` let an edit form corrupt any of them. The allowlist is only worth having if it
 * actually drops them, so that is asserted field by field rather than assumed.
 */
import { describe, it, expect } from 'vitest';
import { validateEventUpdate } from '../lib/events/admin-validate';
import { EVENT_CATEGORIES } from '../lib/event-types';

/** Field names present in the resulting $set. */
function keys(body: unknown): string[] {
  return Object.keys(validateEventUpdate(body).update).sort();
}
function issuesFor(body: unknown): string[] {
  return validateEventUpdate(body).issues.map(i => i.field).sort();
}

describe('validateEventUpdate: fields an admin must NOT be able to write', () => {
  it('drops identity fields, so an edit cannot detach an event from its cluster', () => {
    // Rewriting either means the next scrape stores a second copy and the feed shows doubles.
    expect(keys({ dedupHash: 'x', clusterKey: 'y' })).toEqual([]);
  });

  it('drops provenance fields, which decide when pruneStale() deletes the row', () => {
    expect(keys({ source: 'manual', seenInSources: ['luma'], lastSeenAt: new Date().toISOString() })).toEqual([]);
  });

  it('drops DERIVED fields, which a backfill would silently revert', () => {
    // The nastiest case to leave editable: the admin sees the change land, then a later
    // backfill-companies / backfill-connection-score run overwrites it.
    expect(keys({ connectionScore: 99, companies: ['Google'], tagConfidence: 1, isTargetCompany: true, recruiterMentioned: true })).toEqual([]);
  });

  it('drops mongo internals and timestamps', () => {
    expect(keys({ _id: 'abc', __v: 3, createdAt: '2026-01-01', updatedAt: '2026-01-01' })).toEqual([]);
  });

  it('ignores unknown keys instead of erroring', () => {
    // The form round-trips a whole event object including read-only fields, so rejecting their
    // presence would make every save fail. Dropping them is what makes the allowlist usable.
    const { update, issues } = validateEventUpdate({ title: 'Kept', notAField: 1, connectionScore: 5 });
    expect(update).toEqual({ title: 'Kept' });
    expect(issues).toEqual([]);
  });
});

describe('validateEventUpdate: fields an admin MAY write', () => {
  it('accepts the editable text, and trims it', () => {
    const { update } = validateEventUpdate({ title: '  React Meetup  ', venue: ' Koramangala ' });
    expect(update.title).toBe('React Meetup');
    expect(update.venue).toBe('Koramangala');
  });

  it('upper-cases currency, because the schema does', () => {
    expect(validateEventUpdate({ currency: 'inr' }).update.currency).toBe('INR');
  });

  it('coerces dates to Date objects', () => {
    const { update } = validateEventUpdate({ startDateTime: '2026-09-01T10:00:00Z' });
    expect(update.startDateTime).toBeInstanceOf(Date);
  });

  it('keeps spotlightAt: null, which is how UNPINNING works', () => {
    // The route can only $set, and the home page filters on { $type: 'date' } — so an explicit
    // null is not a date and correctly reads as "not pinned". Dropping it would break unpinning.
    const { update, issues } = validateEventUpdate({ spotlightAt: null });
    expect(issues).toEqual([]);
    expect(update.spotlightAt).toBeNull();
  });

  it('accepts the two toggles the dashboard already sends', () => {
    const { update, issues } = validateEventUpdate({ isTechEvent: false, soldOut: true });
    expect(issues).toEqual([]);
    expect(update).toEqual({ isTechEvent: false, soldOut: true });
  });

  it('accepts every real category and de-duplicates', () => {
    const { update, issues } = validateEventUpdate({ category: [EVENT_CATEGORIES[0], EVENT_CATEGORIES[0], EVENT_CATEGORIES[1]] });
    expect(issues).toEqual([]);
    expect(update.category).toEqual([EVENT_CATEGORIES[0], EVENT_CATEGORIES[1]]);
  });
});

describe('validateEventUpdate: rejections that must be 400s and not 500s', () => {
  it('names an unknown category rather than letting Mongoose throw', () => {
    const { issues } = validateEventUpdate({ category: ['AI/ML', 'Underwater Basket Weaving'] });
    expect(issues).toHaveLength(1);
    expect(issues[0].field).toBe('category');
    expect(issues[0].message).toContain('Underwater Basket Weaving');
  });

  it('refuses to clear the schema-required fields', () => {
    // Mongoose would reject these as a ValidationError, which the catch-all turned into a 500.
    expect(issuesFor({ title: '' })).toEqual(['title']);
    expect(issuesFor({ description: '' })).toEqual(['description']);
    expect(issuesFor({ startDateTime: '' })).toEqual(['startDateTime']);
    expect(issuesFor({ sourceUrl: '' })).toEqual(['sourceUrl']);
  });

  it('rejects a non-http URL, which would be rendered into an href', () => {
    expect(issuesFor({ applyLink: 'javascript:alert(1)' })).toEqual(['applyLink']);
    expect(issuesFor({ imageUrl: 'not a url' })).toEqual(['imageUrl']);
    expect(issuesFor({ onlineLink: 'data:text/html,<script>' })).toEqual(['onlineLink']);
  });

  it('rejects an unparseable date', () => {
    expect(issuesFor({ startDateTime: 'next tuesday-ish' })).toEqual(['startDateTime']);
  });

  it('rejects an end time before the start time', () => {
    // Nothing in the schema forbids it, and query.ts calls an event ongoing once it has started
    // and not ended — so a backwards range makes an event that can never be "now".
    const { issues } = validateEventUpdate({
      startDateTime: '2026-09-01T12:00:00Z',
      endDateTime: '2026-09-01T09:00:00Z',
    });
    expect(issues.map(i => i.field)).toEqual(['endDateTime']);
  });

  it('allows an end time after the start time', () => {
    expect(
      validateEventUpdate({
        startDateTime: '2026-09-01T09:00:00Z',
        endDateTime: '2026-09-01T12:00:00Z',
      }).issues
    ).toEqual([]);
  });

  it('rejects wrong types and out-of-range numbers', () => {
    expect(issuesFor({ isFree: 'yes' })).toEqual(['isFree']);
    expect(issuesFor({ price: -5 })).toEqual(['price']);
    expect(issuesFor({ price: 'free' })).toEqual(['price']);
    expect(issuesFor({ format: 'in-person' })).toEqual(['format']);
    expect(issuesFor({ hasFood: 'maybe' })).toEqual(['hasFood']);
    expect(issuesFor({ category: 'AI/ML' })).toEqual(['category']);
  });

  it('rejects a non-object body', () => {
    expect(issuesFor(null)).toEqual(['body']);
    expect(issuesFor([1, 2])).toEqual(['body']);
    expect(issuesFor('title=x')).toEqual(['body']);
  });

  it('reports EVERY bad field, not just the first', () => {
    // An admin fixing one field at a time through a form would otherwise need N round trips.
    expect(issuesFor({ price: -1, format: 'nope', title: '' })).toEqual(['format', 'price', 'title']);
  });
});
