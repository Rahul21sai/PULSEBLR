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

/** Pull the $or clause the single-word path pushes onto $and. */
function orClause(q: string): Array<Record<string, unknown>> | undefined {
  const filter = buildEventFilter({ q } as Parameters<typeof buildEventFilter>[0]);
  const and = (filter as { $and?: Array<Record<string, unknown>> }).$and ?? [];
  const withOr = and.find(c => Array.isArray((c as { $or?: unknown[] }).$or));
  return (withOr as { $or?: Array<Record<string, unknown>> } | undefined)?.$or;
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
    expect(() => buildEventFilter({ q: 'c++' } as Parameters<typeof buildEventFilter>[0])).not.toThrow();
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
    const filter = buildEventFilter({ q: 'open source conference' } as Parameters<typeof buildEventFilter>[0]);
    expect((filter as { $text?: { $search: string } }).$text).toEqual({
      $search: 'open source conference',
    });
    // And must NOT also add a regex clause, which would narrow $text's own ranking.
    expect(orClause('open source conference')).toBeUndefined();
  });
});

describe('no search term', () => {
  it('adds neither a text nor a regex clause', () => {
    const filter = buildEventFilter({} as Parameters<typeof buildEventFilter>[0]);
    expect((filter as { $text?: unknown }).$text).toBeUndefined();
  });
});
