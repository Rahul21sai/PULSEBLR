import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import sift from 'sift';
import { corpusFilter, userEventsFilter } from '@/lib/admin/stats-scope';
import { publicEventScope } from '@/lib/events/query';
import { stripComments } from './support/strip-comments';

/**
 * The operator console counts the SHARED corpus and never lists a private event.
 *
 * Behaviour is checked with `sift` — see tests/companies-directory-scope.test.ts for its
 * provenance and why it is trustworthy for these predicates.
 */

type Doc = Record<string, unknown>;
const matches = (filter: Doc) => sift(filter as unknown as Parameters<typeof sift>[0]);

const NOW = new Date('2026-09-27T00:00:00Z');
const LATER = new Date('2026-10-04T12:00:00Z');
const upcomingOnly = { startDateTime: { $gte: NOW } };
const techOnly = { isTechEvent: true };

const tech = { startDateTime: LATER, isTechEvent: true, clusterKey: 'k' };
const docs = {
  legacy: { ...tech },
  public: { ...tech, visibility: 'public' },
  private: { ...tech, visibility: 'private', createdByUserId: 'u1', title: 'My private offsite' },
  pending: { ...tech, visibility: 'pending', createdByUserId: 'u1' },
  deleted: { ...tech, deletedAt: new Date('2026-09-20') },
  privateDeleted: { ...tech, visibility: 'private', createdByUserId: 'u1', deletedAt: new Date('2026-09-20') },
  pendingDeleted: { ...tech, visibility: 'pending', createdByUserId: 'u1', deletedAt: new Date('2026-09-20') },
};

describe('corpusFilter — every corpus metric, and the "Next up" list', () => {
  const nextUp = matches(corpusFilter(upcomingOnly, techOnly));

  it('lists public and legacy events', () => {
    expect(nextUp(docs.legacy)).toBe(true);
    expect(nextUp(docs.public)).toBe(true);
  });

  it('never a private or pending one — "Next up" carries title, venue and organiser', () => {
    expect(nextUp(docs.private)).toBe(false);
    expect(nextUp(docs.pending)).toBe(false);
  });

  it('never a soft-deleted one', () => {
    expect(nextUp(docs.deleted)).toBe(false);
  });

  it('keeps an extra $or (the clusterKey metric) beside the visibility $or', () => {
    const missingKey = matches(
      corpusFilter({ $or: [{ clusterKey: { $exists: false } }, { clusterKey: null }, { clusterKey: '' }] })
    );
    expect(missingKey({ startDateTime: LATER })).toBe(true);
    expect(missingKey({ startDateTime: LATER, visibility: 'private' })).toBe(false);
    expect(missingKey(docs.legacy)).toBe(false);
  });

  it('is the shared scope, imported: anonymous arms only, the absent-visibility arm present', () => {
    const f = corpusFilter(upcomingOnly);
    expect(f.$and as Doc[]).toContainEqual(publicEventScope(null));
    expect(JSON.stringify(f)).toContain('{"visibility":{"$exists":false}}');
    expect(JSON.stringify(f)).not.toContain('createdByUserId');
  });
});

describe('userEventsFilter — counts of what the corpus excludes', () => {
  it('private counts private, non-deleted rows and nothing else', () => {
    const m = matches(userEventsFilter('private'));
    expect(m(docs.private)).toBe(true);
    for (const d of [docs.legacy, docs.public, docs.pending, docs.privateDeleted]) expect(m(d)).toBe(false);
  });

  it('pending counts pending, non-deleted rows and nothing else', () => {
    const m = matches(userEventsFilter('pending'));
    expect(m(docs.pending)).toBe(true);
    for (const d of [docs.legacy, docs.public, docs.private, docs.pendingDeleted]) expect(m(d)).toBe(false);
  });
});

describe('app/api/admin/stats/route.ts routes every Event query through the builders', () => {
  const route = stripComments(
    readFileSync(path.join(import.meta.dirname, '..', 'app', 'api', 'admin', 'stats', 'route.ts'), 'utf8')
  );

  it('every Event read is built by corpusFilter or userEventsFilter', () => {
    const calls = [...route.matchAll(/Event\.(\w+)\(/g)];
    expect(calls.length).toBeGreaterThanOrEqual(10);
    const unscoped = calls.filter(c => {
      const after = route.slice(c.index! + c[0].length, c.index! + c[0].length + 120);
      if (c[1] === 'aggregate') return !/^\[\s*\{\s*\$match:\s*corpusFilter\(/.test(after);
      return !/^\s*(corpusFilter|userEventsFilter)\(/.test(after);
    });
    expect(unscoped.map(c => c[0]), 'Event queries not built by the scope builders').toEqual([]);
  });

  it('private and pending rows appear only as counts', () => {
    expect(route).toMatch(/Event\.countDocuments\(userEventsFilter\('private'\)\)/);
    expect(route).toMatch(/Event\.countDocuments\(userEventsFilter\('pending'\)\)/);
    expect(route).not.toMatch(/Event\.(find|findOne|aggregate)\(\s*userEventsFilter/);
  });
});
