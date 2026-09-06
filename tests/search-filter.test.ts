import { describe, it, expect } from 'vitest';
import {
  buildEventFilter,
  MIN_SEARCH_CHARS,
  DESCRIPTION_SEARCH_CHARS,
} from '@/lib/events/query';

/**
 * The search filter had a defect that made the whole feature a no-op: an unanchored
 * substring regex across descriptions meant q="a" matched 815 of 815 events, q="AI" matched
 * 519 (through "tr-AI-ning", "ch-AI-r"), and q="rust" matched "t-RUST".
 *
 * A query that returns everything is indistinguishable from no query. These tests pin the
 * shape of the filter so that cannot come back — they inspect the Mongo filter object
 * rather than needing a database.
 */

/**
 * Pull the SEARCH $or clause the single-word path pushes onto $and.
 *
 * It must skip the visibility clause, which is now `$and[0]` and is also an `$or`. Taking the
 * first `$or` blindly — which this did — silently starts asserting about visibility arms instead of
 * searched fields, and every field-coverage test below would pass while measuring nothing.
 */
function isVisibilityClause(clause: Record<string, unknown>): boolean {
  const arms = (clause as { $or?: Array<Record<string, unknown>> }).$or;
  return Boolean(arms?.some(arm => 'visibility' in arm));
}

function searchOr(filter: unknown): Array<Record<string, unknown>> | undefined {
  const and = (filter as { $and?: Array<Record<string, unknown>> }).$and ?? [];
  const withOr = and.find(
    c => Array.isArray((c as { $or?: unknown[] }).$or) && !isVisibilityClause(c)
  );
  return (withOr as { $or?: Array<Record<string, unknown>> } | undefined)?.$or;
}

function orClause(q: string): Array<Record<string, unknown>> | undefined {
  return searchOr(buildEventFilter({ q } as Parameters<typeof buildEventFilter>[0], null));
}

function fieldsSearched(q: string): string[] {
  return (orClause(q) ?? []).flatMap(c => Object.keys(c));
}

describe('single-word search', () => {
  it('anchors to a word START, not to any substring', () => {
    const or = orClause('rust');
    expect(or).toBeDefined();
    const titleClause = or!.find(c => 'title' in c) as { title: RegExp };
    // The anchor is the entire fix: \brust matches "Rust" and "Rustacean", never "trust".
    expect(titleClause.title.source.startsWith('\\b')).toBe(true);
    expect(titleClause.title.test('Rust Bangalore Meetup')).toBe(true);
    expect(titleClause.title.test('Building trust in AI')).toBe(false);
  });

  it('still matches mid-typing, which is why a regex is used at all', () => {
    const or = orClause('kub');
    const titleClause = or!.find(c => 'title' in c) as { title: RegExp };
    expect(titleClause.title.test('Bangalore Kubernetes Meetup')).toBe(true);
  });

  it('ignores a term shorter than MIN_SEARCH_CHARS instead of returning everything', () => {
    expect(orClause('a')).toBeUndefined();
    expect(MIN_SEARCH_CHARS).toBe(2);
  });

  it('searches titles and hosts for short terms but NOT descriptions', () => {
    // A 2-char prefix still reaches nearly every event through multi-KB descriptions and
    // buries the title hits.
    const fields = fieldsSearched('ai');
    expect(fields).toContain('title');
    expect(fields).toContain('organizer');
    expect(fields).not.toContain('description');
  });

  it('adds descriptions once a term is specific enough', () => {
    const term = 'kubernetes';
    expect(term.length).toBeGreaterThanOrEqual(DESCRIPTION_SEARCH_CHARS);
    expect(fieldsSearched(term)).toContain('description');
  });

  it('escapes regex metacharacters so a query cannot break the filter', () => {
    // "c++" would otherwise be an invalid quantifier and throw.
    expect(() =>
      buildEventFilter({ q: 'c++' } as Parameters<typeof buildEventFilter>[0], null)
    ).not.toThrow();
    const or = orClause('c++');
    const titleClause = or!.find(c => 'title' in c) as { title: RegExp };
    expect(titleClause.title.test('Modern C++ workshop')).toBe(true);
    expect(titleClause.title.test('C plus plus')).toBe(false);
  });

  it('is case-insensitive', () => {
    const or = orClause('devops');
    const titleClause = or!.find(c => 'title' in c) as { title: RegExp };
    expect(titleClause.title.flags).toContain('i');
    expect(titleClause.title.test('DevOps Day Bengaluru')).toBe(true);
  });
});

describe('multi-word search', () => {
  it('uses the weighted text index rather than a regex', () => {
    const filter = buildEventFilter(
      { q: 'open source conference' } as Parameters<typeof buildEventFilter>[0],
      null
    );
    expect((filter as { $text?: { $search: string } }).$text).toEqual({
      $search: 'open source conference',
    });
    // And must NOT also add a regex clause, which would narrow $text's own ranking.
    expect(orClause('open source conference')).toBeUndefined();
  });
});

describe('no search term', () => {
  it('adds neither a text nor a regex clause', () => {
    const filter = buildEventFilter({} as Parameters<typeof buildEventFilter>[0], null);
    expect((filter as { $text?: unknown }).$text).toBeUndefined();
  });
});

/**
 * VISIBILITY IS THE PRIMARY PRIVACY BOUNDARY OF USER-ADDED EVENTS, and `buildEventFilter` is the
 * only place it is enforced — one builder feeds the list, its `countDocuments`, and all six facet
 * aggregations. Every one of these assertions corresponds to a way the clause can be broken while
 * still looking correct.
 */
describe('visibility', () => {
  function visibilityArms(viewerId: string | null): Array<Record<string, unknown>> {
    const filter = buildEventFilter({} as Parameters<typeof buildEventFilter>[0], viewerId);
    const and = (filter as { $and?: Array<Record<string, unknown>> }).$and ?? [];
    const clause = and.find(isVisibilityClause);
    return (clause as { $or?: Array<Record<string, unknown>> } | undefined)?.$or ?? [];
  }

  it('ALWAYS includes the no-visibility-key arm', () => {
    // ~1500 stored documents predate the field. Without this arm the feed does not narrow, it
    // EMPTIES — for everyone, including signed-out visitors. This is the arm most likely to be
    // deleted as redundant, so it is asserted for both viewer states.
    for (const viewer of [null, 'devlogin:someone@example.com']) {
      expect(visibilityArms(viewer)).toEqual(
        expect.arrayContaining([{ visibility: { $exists: false } }])
      );
    }
  });

  it('gives an anonymous visitor exactly the two public arms', () => {
    const arms = visibilityArms(null);
    expect(arms).toHaveLength(2);
    expect(arms).toEqual(
      expect.arrayContaining([{ visibility: 'public' }, { visibility: { $exists: false } }])
    );
    // And nothing that could match an owned document.
    expect(JSON.stringify(arms)).not.toContain('createdByUserId');
  });

  it('adds an ownership arm for a signed-in viewer, scoped to THEM', () => {
    const arms = visibilityArms('devlogin:me@example.com');
    expect(arms).toHaveLength(3);
    expect(arms).toEqual(
      expect.arrayContaining([{ createdByUserId: 'devlogin:me@example.com' }])
    );
    // Never a bare `createdByUserId: { $exists: true }`, which would show everybody's.
    expect(JSON.stringify(arms)).not.toContain('$exists":true');
  });

  it('never puts the clause at the TOP level, where it would be clobbered', () => {
    // The top-level keys are assigned unconditionally and the search branch owns `$or` inside
    // `$and`. A top-level `$or` here would be silently overwritten or collide with `$text`.
    const filter = buildEventFilter({} as Parameters<typeof buildEventFilter>[0], 'u') as Record<
      string,
      unknown
    >;
    expect(filter.$or).toBeUndefined();
    expect(Array.isArray(filter.$and)).toBe(true);
  });

  it('coexists with a search term rather than replacing it', () => {
    // Both clauses live in `$and`, so a searching user must still be scoped. If these ever merge,
    // one of the two silently stops applying.
    const filter = buildEventFilter(
      { q: 'kubernetes' } as Parameters<typeof buildEventFilter>[0],
      'devlogin:me@example.com'
    );
    const and = (filter as { $and?: Array<Record<string, unknown>> }).$and ?? [];
    expect(and.filter(isVisibilityClause)).toHaveLength(1);
    expect(searchOr(filter)?.length).toBeGreaterThan(0);
  });
});
