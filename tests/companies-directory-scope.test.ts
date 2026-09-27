import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import sift from 'sift';
import { attributedEventsMatch, unmatchedHostsMatch } from '@/lib/companies/directory-scope';
import { publicEventScope } from '@/lib/events/query';
import { stripComments } from './support/strip-comments';

/**
 * The PUBLIC companies directory must count only public, not-deleted events — for everyone.
 *
 * BEHAVIOUR, NOT JUST SHAPE. Each `$match` is run against representative documents with `sift`,
 * the in-memory MongoDB matcher mongoose itself depends on (mongoose/package.json pins 17.1.3; it
 * is in the lockfile already, so this adds no dependency). Its semantics were checked against the
 * exact predicates used here — `{ deletedAt: null }` matching an absent field, `$exists: false`,
 * `$nin: [null, '']` excluding a missing organiser. If mongoose ever drops it, this import fails
 * loudly at collection rather than silently.
 *
 * The two halves that matter, and fail in opposite directions:
 *   - a PRIVATE or PENDING event must not match — that was the leak (organiser names in the
 *     unmatched-hosts list);
 *   - a LEGACY event with no `visibility` key must still match — omitting that arm does not narrow
 *     the directory, it empties it.
 */

type Doc = Record<string, unknown>;
const matches = (filter: Doc) => sift(filter as unknown as Parameters<typeof sift>[0]);

const NOW = new Date('2026-09-27T00:00:00Z');
const LATER = new Date('2026-10-04T12:00:00Z');
const EARLIER = new Date('2026-09-01T12:00:00Z');

const base = { startDateTime: LATER, organizer: 'Bangalore Rust Meetup' };
const unattributed = {
  legacy: { ...base, companies: [] },
  legacyNoField: { ...base },
  public: { ...base, companies: [], visibility: 'public' },
  restoredWithNull: { ...base, companies: [], deletedAt: null },
  private: { ...base, organizer: 'My Private Reading Group', companies: [], visibility: 'private', createdByUserId: 'u1' },
  pending: { ...base, organizer: 'Pending Submission Host', companies: [], visibility: 'pending', createdByUserId: 'u1' },
  deleted: { ...base, companies: [], deletedAt: new Date('2026-09-20') },
  past: { ...base, startDateTime: EARLIER, companies: [] },
  noOrganizer: { ...base, organizer: '', companies: [] },
};
const attributed = {
  legacy: { ...base, companies: ['Razorpay'] },
  public: { ...base, companies: ['Razorpay'], visibility: 'public' },
  private: { ...base, companies: ['Razorpay'], visibility: 'private', createdByUserId: 'u1' },
  pending: { ...base, companies: ['Razorpay'], visibility: 'pending', createdByUserId: 'u1' },
  deleted: { ...base, companies: ['Razorpay'], deletedAt: new Date('2026-09-20') },
  past: { ...base, startDateTime: EARLIER, companies: ['Razorpay'] },
};

describe('unmatchedHostsMatch — the stage that leaked', () => {
  const m = matches(unmatchedHostsMatch(NOW));

  it('excludes private and pending events, whose organiser names it used to publish', () => {
    expect(m(unattributed.private)).toBe(false);
    expect(m(unattributed.pending)).toBe(false);
  });

  it('excludes soft-deleted and past events', () => {
    expect(m(unattributed.deleted)).toBe(false);
    expect(m(unattributed.past)).toBe(false);
  });

  it('KEEPS legacy rows with no visibility key — the arm whose omission empties the page', () => {
    expect(m(unattributed.legacy)).toBe(true);
    expect(m(unattributed.legacyNoField)).toBe(true);
    expect(m(unattributed.public)).toBe(true);
    expect(m(unattributed.restoredWithNull)).toBe(true);
  });

  it('still means "unattributed, with a named host"', () => {
    expect(m(attributed.legacy)).toBe(false);
    expect(m(unattributed.noOrganizer)).toBe(false);
  });
});

describe('attributedEventsMatch — the per-company counts, cover image and next date', () => {
  const m = matches(attributedEventsMatch(NOW));

  it('counts public and legacy attributed events', () => {
    expect(m(attributed.legacy)).toBe(true);
    expect(m(attributed.public)).toBe(true);
  });

  it('does not let a private, pending, deleted or past event feed a company', () => {
    expect(m(attributed.private)).toBe(false);
    expect(m(attributed.pending)).toBe(false);
    expect(m(attributed.deleted)).toBe(false);
    expect(m(attributed.past)).toBe(false);
  });
});

describe('the shape: the shared scope, imported, composed without collision', () => {
  for (const [name, build] of [
    ['attributedEventsMatch', attributedEventsMatch],
    ['unmatchedHostsMatch', unmatchedHostsMatch],
  ] as const) {
    it(`${name} carries publicEventScope(null) intact as an $and clause`, () => {
      const clauses = (build(NOW).$and ?? []) as Doc[];
      expect(clauses).toContainEqual(publicEventScope(null));
      expect(JSON.stringify(build(NOW))).toContain('{"visibility":{"$exists":false}}');
      expect(JSON.stringify(build(NOW))).toContain('"deletedAt":null');
    });

    it(`${name} is the ANONYMOUS scope — no owner arm, for any caller`, () => {
      expect(JSON.stringify(build(NOW))).not.toContain('createdByUserId');
    });
  }

  it('the unattributed $or survives beside the visibility $or', () => {
    // Spread into one object, one of the two `$or` keys silently replaces the other.
    const json = JSON.stringify(unmatchedHostsMatch(NOW));
    expect(json).toContain('{"companies":{"$size":0}}');
    expect(json).toContain('{"visibility":"public"}');
  });
});

describe('app/api/companies/route.ts builds every $match from the scoped builders', () => {
  const route = stripComments(
    readFileSync(path.join(import.meta.dirname, '..', 'app', 'api', 'companies', 'route.ts'), 'utf8')
  );

  it('every aggregation opens with a builder-made $match, and there is no other Event read', () => {
    // The "fifth call site" guard: a new aggregation written with an inline filter fails here.
    const aggregations = route.match(/Event\.aggregate\(/g) ?? [];
    const scoped = route.match(/Event\.aggregate\(\[\s*\{\s*\$match:\s*(attributedEventsMatch|unmatchedHostsMatch)\(now\)\s*\}/g) ?? [];
    expect(aggregations.length).toBe(2);
    expect(scoped.length).toBe(aggregations.length);
    expect(route).not.toMatch(/Event\.(find|findOne|countDocuments|distinct|exists)\(/);
  });
});
