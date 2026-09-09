import { describe, it, expect } from 'vitest';
import {
  buildPersonFilter,
  buildPersonSort,
  parsePersonQuery,
  PERSON_SEARCH_FIELDS,
  REPEAT_MIN_EVENTS,
} from '@/lib/people/query';

/**
 * `lib/people/query.ts` is the THIRD instance of an established pattern — `buildEventFilter`,
 * `buildContactFilter`, and now this — and the pattern exists because a filter, its
 * `countDocuments` and its facet counts must be computed from ONE definition. When they are not,
 * a chip says 12 and shows 9, and nobody notices for weeks.
 *
 * Two things here are regressions this repo has ALREADY shipped once, on the Contact version of
 * this page, which is why they are pinned rather than trusted:
 *
 *   1. `repeatOnly` was a TWO-STAGE query — resolve the qualifying `contactKey`s, then match
 *      `{ $in: keys }`. The first attempt post-filtered the page instead, so the list correctly
 *      narrowed to 2 rows while the heading beside it still read "6 people", because
 *      `countDocuments` had run against the unfiltered filter. Pagination was broken too. On
 *      `Person` the count is denormalised, so "met more than once" is finally ONE predicate — and
 *      a test that asserts it is one predicate is what stops somebody reintroducing the aggregate.
 *
 *   2. A MERGED person must never appear in a list. `mergedInto` is a soft tombstone so old URLs
 *      still resolve, which means the row is still in the collection and still matches every other
 *      arm of the filter. Forget to exclude it and the merge appears not to have worked: the whole
 *      point of merging is one row per human.
 */

const UID = 'google-sub-1001';

describe('buildPersonFilter — scoping', () => {
  it('always scopes to the user, from a REQUIRED positional argument', () => {
    expect(buildPersonFilter(UID)).toMatchObject({ userId: UID });
  });

  /**
   * Positional and non-optional, exactly like the other two builders. An unscoped people query
   * returns other users' private notes and follow-up dates, and this repo has already served
   * exactly that (`generateDailyDigest` ran two unfiltered `TrackerEntry` queries and served the
   * result anonymously). A field on a params object can be forgotten by omitting a key; a
   * positional argument cannot.
   */
  it('cannot be built without a userId', () => {
    // @ts-expect-error — the signature is the guard; this is what it refuses.
    expect(() => buildPersonFilter()).toBeDefined();
  });
});

describe('mergedInto — the tombstone must not be listed', () => {
  it('excludes merged persons by default', () => {
    expect(buildPersonFilter(UID).mergedInto).toEqual(null);
  });

  /**
   * `mergedInto: null` rather than `{ $exists: false }`, and the difference is load-bearing here in
   * the same way `{ $type: 'date' }` is for `Event.spotlightAt`. Mongo's equality-to-null matches
   * BOTH a missing field and an explicitly-null one. Every Person written before a merge lacks the
   * key entirely, and an unmerge that writes `mergedInto: null` would fail an `$exists: false` arm
   * — so the unmerged person would stay invisible and the reversal would look like it did nothing.
   */
  it('matches both an absent field and an explicit null', () => {
    expect(buildPersonFilter(UID).mergedInto).not.toEqual({ $exists: false });
  });

  it('can be opted into, for the merge UI that has to show both sides', () => {
    expect('mergedInto' in buildPersonFilter(UID, { includeMerged: true })).toBe(false);
  });
});

describe('repeatOnly is ONE predicate', () => {
  it('is a range on the denormalised counter, not an $in over resolved keys', () => {
    const filter = buildPersonFilter(UID, { repeatOnly: true });
    expect(filter.eventCount).toEqual({ $gte: REPEAT_MIN_EVENTS });
  });

  it('counts DISTINCT EVENTS, so the threshold is 2 and it is spelled once', () => {
    // The number lives in one exported constant so the list, the facet count and any badge that
    // says "met 3x" cannot disagree about whether two counts as a repeat.
    expect(REPEAT_MIN_EVENTS).toBe(2);
  });

  it('adds no $in, no $expr and no aggregation-shaped clause', () => {
    const filter = buildPersonFilter(UID, { repeatOnly: true });
    const serialised = JSON.stringify(filter);
    expect(serialised).not.toContain('$in');
    expect(serialised).not.toContain('$expr');
    expect(serialised).not.toContain('contactKey');
  });

  it('is absent entirely when not asked for', () => {
    expect('eventCount' in buildPersonFilter(UID)).toBe(false);
  });
});

describe('facet dimensions', () => {
  /**
   * Exact match, not a regex. `companies[]` holds canonical registry names the resolver produced,
   * so there is nothing to normalise — and a regex would let "Meta" match "Metabase", which is the
   * false-attribution class `strength` exists to prevent arriving through the back door.
   */
  it('matches a company exactly', () => {
    expect(buildPersonFilter(UID, { company: 'Razorpay' }).companies).toBe('Razorpay');
  });

  it('matches a tag exactly, because tags are canonicalised on write', () => {
    expect(buildPersonFilter(UID, { tag: 'ai/ml' }).tags).toBe('ai/ml');
  });

  it('narrows to target companies', () => {
    expect(buildPersonFilter(UID, { targetOnly: true }).isTargetCompany).toBe(true);
  });

  it('leaves every dimension absent when not asked for', () => {
    const filter = buildPersonFilter(UID);
    for (const key of ['companies', 'tags', 'isTargetCompany', 'nextActionAt', '$or']) {
      expect(key in filter).toBe(false);
    }
  });
});

describe('followUpDue', () => {
  /**
   * ONE predicate on the denormalised `nextActionAt`, where the Contact version needed two
   * (`followUpAt != null` AND `followedUp != true`). `recomputePerson` sets `nextActionAt` to the
   * SOONEST OUTSTANDING follow-up and to null when there is none, so "still owes me something" is
   * already answered on the row.
   */
  it('selects on nextActionAt being set, not on a followedUp boolean', () => {
    const filter = buildPersonFilter(UID, { followUpDue: true });
    expect(filter.nextActionAt).toEqual({ $ne: null });
    expect('followedUp' in filter).toBe(false);
  });

  /**
   * Deliberately NOT `nextActionAt <= now`. The People page shows what is OUTSTANDING, and a
   * follow-up scheduled for Friday is outstanding on Wednesday. `getPendingFollowUps` keeps its own
   * overdue-vs-upcoming window for the dashboard and the digest; the two silently disagreeing is a
   * bug this repo has already paid for once.
   */
  it('does not narrow to overdue', () => {
    expect(JSON.stringify(buildPersonFilter(UID, { followUpDue: true }))).not.toContain('$lte');
  });
});

describe('free-text search', () => {
  function orClause(q: string): Array<Record<string, unknown>> {
    return (buildPersonFilter(UID, { q }).$or ?? []) as Array<Record<string, unknown>>;
  }

  it('searches the person fields, and searches displayName rather than name', () => {
    const fields = orClause('asha').flatMap(Object.keys);
    expect(fields).toEqual([...PERSON_SEARCH_FIELDS]);
    expect(fields).toContain('displayName');
    expect(fields).not.toContain('name');
  });

  it('is case-insensitive and matches mid-typing', () => {
    const clause = orClause('razor').find(c => 'company' in c) as { company: RegExp };
    expect(clause.company.flags).toContain('i');
    expect(clause.company.test('Razorpay')).toBe(true);
  });

  /**
   * Load-bearing, not defensive. The search box feeds this directly, so an unescaped `(` from
   * somebody typing "Ola (Krutrim)" throws a SyntaxError inside the driver and the request 500s,
   * and a bare `.*` would scan the collection.
   */
  it('escapes regex metacharacters typed into the box', () => {
    expect(() => buildPersonFilter(UID, { q: 'Ola (Krutrim)' })).not.toThrow();
    const clause = orClause('Ola (Krutrim)').find(c => 'displayName' in c) as {
      displayName: RegExp;
    };
    expect(clause.displayName.test('Ola (Krutrim) Labs')).toBe(true);
    expect(clause.displayName.test('Ola Krutrim')).toBe(false);
  });

  it('ignores a blank or whitespace-only query rather than matching everything', () => {
    expect('$or' in buildPersonFilter(UID, { q: '   ' })).toBe(false);
  });
});

describe('buildPersonSort', () => {
  it('defaults to last-contacted, newest first', () => {
    expect(buildPersonSort()).toEqual({ lastInteractionAt: -1 });
    expect(buildPersonSort('recent')).toEqual({ lastInteractionAt: -1 });
  });

  it('offers the three sorts that were previously impossible because the fields did not exist', () => {
    expect(buildPersonSort('oldest')).toEqual({ lastInteractionAt: 1 });
    expect(buildPersonSort('followUp')).toEqual({ nextActionAt: 1 });
    expect(buildPersonSort('met')).toEqual({ eventCount: -1, lastInteractionAt: -1 });
  });

  it('sorts by the effective display name, which is where an override has already landed', () => {
    expect(buildPersonSort('name')).toEqual({ displayName: 1 });
    expect(buildPersonSort('company')).toEqual({ company: 1, displayName: 1 });
  });

  it('falls back to the default for an unknown value rather than emitting an empty sort', () => {
    expect(buildPersonSort('nonsense' as never)).toEqual({ lastInteractionAt: -1 });
  });
});

describe('parsePersonQuery', () => {
  it('parses the whole surface off a URL', () => {
    const params = parsePersonQuery(
      new URLSearchParams(
        'q=asha&company=Razorpay&tag=AI%2FML&targetOnly=true&followUpDue=true&repeatOnly=true'
      )
    );
    expect(params).toEqual({
      q: 'asha',
      company: 'Razorpay',
      tag: 'ai/ml',
      targetOnly: true,
      followUpDue: true,
      repeatOnly: true,
    });
  });

  /**
   * Lowercased to match how tags are stored by `canonicaliseTags`. Without this a chip built from a
   * URL somebody shared with different casing matches nothing and reads as an empty facet.
   */
  it('lowercases the tag but not the company', () => {
    const params = parsePersonQuery(new URLSearchParams('tag=Ai%2FMl&company=Razorpay'));
    expect(params.tag).toBe('ai/ml');
    expect(params.company).toBe('Razorpay');
  });

  it('caps input length — both feed a regex or an index probe', () => {
    const params = parsePersonQuery(new URLSearchParams(`q=${'a'.repeat(5000)}`));
    expect(params.q!.length).toBe(200);
  });

  it('treats anything but the literal "true" as false, and blanks as absent', () => {
    const params = parsePersonQuery(new URLSearchParams('q=+++&targetOnly=1&repeatOnly=yes'));
    expect(params.q).toBeUndefined();
    expect(params.targetOnly).toBe(false);
    expect(params.repeatOnly).toBe(false);
  });

  it('never parses includeMerged off the URL — showing tombstones is not a reader-facing option', () => {
    const params = parsePersonQuery(new URLSearchParams('includeMerged=true'));
    expect(params.includeMerged).toBeUndefined();
  });
});
