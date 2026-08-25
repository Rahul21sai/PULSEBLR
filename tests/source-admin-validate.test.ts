/**
 * `validateNewSource()` — what an admin may supply when registering a scrape source.
 *
 * A `Source` row is not inert data, it is an INSTRUCTION to the scraper: whatever lands in `url`
 * gets fetched on the next scheduled run by a job with no user in front of it. `POST /api/sources`
 * previously did `Source.create(body)` on the raw request body, and its own header comment already
 * described the consequence — "an attacker could inject a handle that the NEXT pipeline run will
 * dutifully fetch". These tests are that comment turned into something that fails.
 */
import { describe, it, expect } from 'vitest';
import { validateNewSource, SOURCE_TYPES } from '../lib/sources/admin-validate';

const VALID = {
  name: 'Bengaluru Python User Group',
  type: 'ical',
  url: 'https://example.com/events.ics',
};

function issuesFor(body: unknown): string[] {
  return validateNewSource(body).issues.map(i => i.field).sort();
}

describe('validateNewSource: the happy path', () => {
  it('accepts the four fields a human fills in', () => {
    const { doc, issues } = validateNewSource({ ...VALID, kind: 'meetup', handle: 'blr-python', enabled: false });
    expect(issues).toEqual([]);
    expect(doc).toEqual({
      name: 'Bengaluru Python User Group',
      type: 'ical',
      url: 'https://example.com/events.ics',
      kind: 'meetup',
      handle: 'blr-python',
      enabled: false,
    });
  });

  it('trims text and accepts every schema type', () => {
    for (const type of SOURCE_TYPES) {
      const { doc, issues } = validateNewSource({ ...VALID, type, name: '  Padded  ' });
      expect(issues).toEqual([]);
      expect(doc.type).toBe(type);
      expect(doc.name).toBe('Padded');
    }
  });
});

describe('validateNewSource: fields that must be DROPPED, not stored', () => {
  it('drops the scraper health bookkeeping', () => {
    /*
     * `consecutiveEmptyScrapes` feeds the digest's unhealthy-source report and the ordering in
     * loadDiscovered(), so a seeded value could hide a dead feed or push a good source to the
     * back of the scrape queue. `lastError` would fake a fault that never happened.
     */
    const { doc, issues } = validateNewSource({
      ...VALID,
      lastScrapedAt: '2026-01-01T00:00:00Z',
      lastEventCount: 9999,
      consecutiveEmptyScrapes: 0,
      lastError: 'nothing to see here',
      lastErrorAt: '2026-01-01T00:00:00Z',
      discoveredAt: '2020-01-01T00:00:00Z',
    });
    expect(issues).toEqual([]);
    expect(Object.keys(doc).sort()).toEqual(['name', 'type', 'url']);
  });

  it('drops mongo internals', () => {
    const { doc } = validateNewSource({ ...VALID, _id: 'abc', __v: 2, createdAt: '2020-01-01' });
    expect(Object.keys(doc).sort()).toEqual(['name', 'type', 'url']);
  });
});

describe('validateNewSource: the URL is fetched by the scraper, so it is restricted', () => {
  it('refuses a non-http scheme', () => {
    // file:// would aim the scheduled job at the runner's own filesystem.
    expect(issuesFor({ ...VALID, url: 'file:///etc/passwd' })).toEqual(['url']);
    expect(issuesFor({ ...VALID, url: 'javascript:alert(1)' })).toEqual(['url']);
    expect(issuesFor({ ...VALID, url: 'ftp://example.com/a.ics' })).toEqual(['url']);
  });

  it('refuses a value that is not a URL at all', () => {
    expect(issuesFor({ ...VALID, url: 'example.com/events' })).toEqual(['url']);
    expect(issuesFor({ ...VALID, url: '' })).toEqual(['url']);
  });

  it('accepts plain http as well as https', () => {
    expect(validateNewSource({ ...VALID, url: 'http://example.com/a.ics' }).issues).toEqual([]);
  });
});

describe('validateNewSource: kind and handle are an identity PAIR', () => {
  /*
   * `Source.index({ kind, handle }, { unique: true, sparse: true })` is a compound sparse index,
   * which omits a document only when EVERY indexed field is missing — so a row with a `kind` and
   * no `handle` gets indexed with handle: null, and the NEXT such row collides. Requiring the pair
   * keeps half-identified rows out. See CLAUDE.md §9.
   */
  it('rejects one without the other', () => {
    expect(issuesFor({ ...VALID, kind: 'meetup' })).toEqual(['handle']);
    expect(issuesFor({ ...VALID, handle: 'blr-python' })).toEqual(['kind']);
  });

  it('accepts neither', () => {
    expect(validateNewSource(VALID).issues).toEqual([]);
  });

  it('accepts both', () => {
    expect(validateNewSource({ ...VALID, kind: 'luma', handle: 'razorpay-rize' }).issues).toEqual([]);
  });
});

describe('validateNewSource: required fields and wrong types', () => {
  it('requires name, type and url', () => {
    expect(issuesFor({})).toEqual(['name', 'type', 'url']);
  });

  it('rejects an unknown type rather than letting the schema enum 500', () => {
    const { issues } = validateNewSource({ ...VALID, type: 'graphql' });
    expect(issues).toHaveLength(1);
    expect(issues[0].field).toBe('type');
    expect(issues[0].message).toContain('ical');
  });

  it('rejects a non-boolean enabled', () => {
    expect(issuesFor({ ...VALID, enabled: 'yes' })).toEqual(['enabled']);
  });

  it('rejects a non-object body', () => {
    expect(issuesFor(null)).toEqual(['body']);
    expect(issuesFor([VALID])).toEqual(['body']);
    expect(issuesFor('name=x')).toEqual(['body']);
  });

  it('reports EVERY bad field, not just the first', () => {
    expect(issuesFor({ name: '', type: 'nope', url: 'file:///x' })).toEqual(['name', 'type', 'url']);
  });
});
