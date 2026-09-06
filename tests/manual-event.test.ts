import { describe, it, expect } from 'vitest';
import { validateManualEvent } from '@/lib/events/manual-input';
import { canViewEvent, isPendingReview, isUserAuthored } from '@/lib/events/visibility';

/**
 * `POST /api/events` used to build its document with `{ ...body }`. That was survivable while the
 * route was admin-only; the moment any signed-in user can create an event it is three separate
 * privilege escalations, all through the request body — pre-claiming a `dedupHash` so the next
 * scrape merges the real public event into a private row, setting `visibility: 'public'` to skip
 * review, and setting `spotlightAt` to pin your own event onto the home page.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * SO THE ASSERTIONS THAT MATTER HERE ARE THE NEGATIVE ONES. An allowlist is not testable by
 * checking that the fields it accepts come through — that passes just as happily if the allowlist
 * has been replaced by a spread. It is only testable by naming each field that must NOT come
 * through, which is why every dangerous key is listed individually below rather than sampled.
 *
 * `tests/tracker-validation.test.ts` makes the same argument for the same reason: "it returns 400"
 * survives a careless change that goes back to echoing `err.message`, and that still leaks.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

const VALID = {
  title: 'Internal Platform Hack Day',
  startDateTime: '2026-10-01T10:00:00+05:30',
};

/** Every field that must never be settable from a request body, with why it is dangerous. */
const FORBIDDEN: Array<[key: string, value: unknown, why: string]> = [
  ['dedupHash', 'a'.repeat(64), 'pre-claim a hash so a scrape merges the public event into this row'],
  ['clusterKey', 'react meetup|2026-10-01', 'same, via the fuzzy key'],
  ['source', 'luma', 'make a hand-entered row look scraped to every diagnostic and to pruneStale'],
  ['sourceEventId', 'evt-123', 'claim another platform’s identity'],
  ['spotlightAt', '2026-10-01T00:00:00Z', 'pin your own event into the home page Spotlight'],
  ['connectionScore', 100, 'sort your own event to the top of the default feed'],
  ['companies', ['Google'], 'fake a company attribution'],
  ['isTechEvent', true, 'force into the default tech feed regardless of category'],
  ['tagConfidence', 1, 'claim LLM-grade confidence so a merge cannot correct the tags'],
  ['lastSeenAt', '2030-01-01T00:00:00Z', 'defeat staleness pruning'],
  ['seenInSources', ['luma', 'meetup'], 'fake provenance'],
  ['createdByUserId', 'devlogin:someone-else@example.com', 'assign the event to another account'],
  ['isTargetCompany', true, 'fake a target-company badge'],
  ['recruiterMentioned', true, 'fake a recruiter flag'],
  ['guestCount', 5000, 'inflate popularity sort'],
  ['_id', '000000000000000000000000', 'overwrite an existing document'],
];

describe('validateManualEvent — what it refuses to accept', () => {
  it.each(FORBIDDEN)('never accepts %s (%s)', (key, value) => {
    const { fields } = validateManualEvent({ ...VALID, [key]: value });
    expect(fields).toBeDefined();
    expect(fields).not.toHaveProperty(key as string);
  });

  it('accepts nothing outside the allowlist at all', () => {
    // The general form of the rule: a field added to the schema later must not become writable
    // from the web just by existing. This fails loudly if `...body` ever comes back.
    const { fields } = validateManualEvent({
      ...VALID,
      somethingInventedLater: 'x',
      adminOnlyFlag: true,
    });
    expect(fields).not.toHaveProperty('somethingInventedLater');
    expect(fields).not.toHaveProperty('adminOnlyFlag');
  });
});

describe('validateManualEvent — visibility', () => {
  it('defaults to private when the field is absent', () => {
    // The safe default is the one that does not publish. A default of 'public' would mean a client
    // that forgot the field published to everybody.
    expect(validateManualEvent(VALID).visibility).toBe('private');
  });

  it('accepts exactly the three known values', () => {
    for (const v of ['private', 'pending', 'public'] as const) {
      const result = validateManualEvent({ ...VALID, visibility: v });
      expect(result.visibility).toBe(v);
      expect(result.issues).toHaveLength(0);
    }
  });

  it('refuses an unknown value rather than silently falling back', () => {
    // Falling back to private would be safe but silent; the caller asked for something that does
    // not exist and should be told. The route re-checks 'public' against the admin allowlist
    // separately — this only parses the request.
    const result = validateManualEvent({ ...VALID, visibility: 'everyone' });
    expect(result.issues.map(i => i.field)).toContain('visibility');
    expect(result.fields).toBeUndefined();
  });
});

describe('validateManualEvent — links', () => {
  it('drops a javascript: URL', () => {
    // `app/events/[id]/page.tsx` renders `applyLink` straight into an href, so this is stored XSS
    // against every visitor — and, for a pending submission, against the admin reviewing it.
    const { fields } = validateManualEvent({
      ...VALID,
      applyLink: 'javascript:alert(document.cookie)',
    });
    expect(fields?.applyLink).toBeUndefined();
  });

  it('drops data: and other non-http schemes on every link field', () => {
    for (const field of ['applyLink', 'sourceUrl', 'onlineLink', 'imageUrl']) {
      for (const bad of ['data:text/html,<script>x</script>', 'vbscript:x', 'file:///etc/passwd', 'not a url']) {
        const { fields } = validateManualEvent({ ...VALID, [field]: bad });
        expect(fields?.[field as keyof typeof fields]).toBeUndefined();
      }
    }
  });

  it('keeps ordinary http and https URLs', () => {
    const { fields } = validateManualEvent({
      ...VALID,
      applyLink: 'https://lu.ma/some-event',
      sourceUrl: 'http://example.com/e',
    });
    expect(fields?.applyLink).toBe('https://lu.ma/some-event');
    expect(fields?.sourceUrl).toBe('http://example.com/e');
  });
});

describe('validateManualEvent — dates and categories', () => {
  it('requires a title and a start time', () => {
    expect(validateManualEvent({}).issues.map(i => i.field)).toEqual(
      expect.arrayContaining(['title', 'startDateTime'])
    );
    expect(validateManualEvent({}).fields).toBeUndefined();
  });

  it('rejects an unparseable start date instead of storing Invalid Date', () => {
    const result = validateManualEvent({ ...VALID, startDateTime: 'next tuesday' });
    expect(result.issues.map(i => i.field)).toContain('startDateTime');
    expect(result.fields).toBeUndefined();
  });

  it('rejects an end before the start', () => {
    // Always a typo, and it renders as a negative duration everywhere downstream.
    const result = validateManualEvent({
      ...VALID,
      endDateTime: '2026-09-30T10:00:00+05:30',
    });
    expect(result.issues.map(i => i.field)).toContain('endDateTime');
  });

  it('treats an empty end date as absent, not as invalid', () => {
    // A form sends '' for an untouched optional date. Refusing it would 400 every submission from
    // the one screen that creates events — the same leniency `lib/tracker/validate.ts` documents
    // for `followUpAt`.
    const result = validateManualEvent({ ...VALID, endDateTime: '' });
    expect(result.issues).toHaveLength(0);
    expect(result.fields?.endDateTime).toBeUndefined();
  });

  it('names an unknown category rather than letting the schema enum 500', () => {
    const result = validateManualEvent({ ...VALID, category: ['Nonsense'] });
    expect(result.issues.map(i => i.field)).toContain('category');
  });

  it('defaults to Meetup — the current taxonomy value, not the retired one', () => {
    // 'Networking/Meetup' was dropped in the 32 → 22 consolidation, and defaulting to it made every
    // manual creation fail on the enum.
    expect(validateManualEvent(VALID).fields?.category).toEqual(['Meetup']);
    expect(validateManualEvent({ ...VALID, category: [] }).fields?.category).toEqual(['Meetup']);
  });

  it('derives isFree from price so the two cannot disagree', () => {
    expect(validateManualEvent({ ...VALID, price: 500, isFree: true }).fields?.isFree).toBe(false);
    expect(validateManualEvent({ ...VALID, price: 0, isFree: false }).fields?.isFree).toBe(true);
    expect(validateManualEvent({ ...VALID, isFree: false }).fields?.isFree).toBe(true);
  });

  it('never quotes Mongoose in a message', () => {
    const all = [
      ...validateManualEvent({}).issues,
      ...validateManualEvent({ ...VALID, category: ['Nope'] }).issues,
      ...validateManualEvent({ ...VALID, visibility: 'x' }).issues,
    ]
      .map(i => i.message)
      .join(' ');
    for (const leak of ['ValidationError', 'CastError', 'Path `', 'enum value', 'ObjectId']) {
      expect(all).not.toContain(leak);
    }
  });
});

/**
 * `canViewEvent` guards the four read paths that fetch an event BY ID and never touch the feed's
 * filter builder. A Mongo ObjectId is not a secret — it embeds a timestamp and a counter — so
 * "nobody will guess it" is not an access-control argument, and these cases are the boundary.
 */
describe('canViewEvent', () => {
  const ME = 'devlogin:me@example.com';
  const THEM = 'devlogin:them@example.com';

  it('treats an ABSENT visibility as public', () => {
    // ~1500 scraped documents have no such key. If this ever returns false the entire corpus
    // becomes unreadable, including to signed-out visitors.
    expect(canViewEvent({}, null)).toBe(true);
    expect(canViewEvent({ visibility: null }, null)).toBe(true);
    expect(canViewEvent({ visibility: '' }, null)).toBe(true);
  });

  it('lets anyone see an explicitly public event', () => {
    expect(canViewEvent({ visibility: 'public', createdByUserId: THEM }, null)).toBe(true);
    expect(canViewEvent({ visibility: 'public', createdByUserId: THEM }, ME)).toBe(true);
  });

  it('hides a private event from everyone but its owner', () => {
    expect(canViewEvent({ visibility: 'private', createdByUserId: THEM }, ME)).toBe(false);
    expect(canViewEvent({ visibility: 'private', createdByUserId: THEM }, null)).toBe(false);
    expect(canViewEvent({ visibility: 'private', createdByUserId: ME }, ME)).toBe(true);
  });

  it('hides a PENDING event too — awaiting review is not published', () => {
    // The submitter still sees their own; nobody else does. An admin reviews through a separate
    // guarded listing, which is why there is no admin branch here to widen by accident.
    expect(canViewEvent({ visibility: 'pending', createdByUserId: THEM }, ME)).toBe(false);
    expect(canViewEvent({ visibility: 'pending', createdByUserId: ME }, ME)).toBe(true);
  });

  it('never grants access on a null/undefined owner match', () => {
    // The trap: `undefined === undefined` is true. A private row with no owner must not be visible
    // to an anonymous caller just because both sides are absent.
    expect(canViewEvent({ visibility: 'private' }, null)).toBe(false);
    expect(canViewEvent({ visibility: 'private', createdByUserId: null }, null)).toBe(false);
    expect(canViewEvent({ visibility: 'private', createdByUserId: undefined }, undefined as never)).toBe(
      false
    );
  });
});

describe('isPendingReview / isUserAuthored', () => {
  it('distinguishes the three states', () => {
    expect(isPendingReview({ visibility: 'pending' })).toBe(true);
    expect(isPendingReview({ visibility: 'private' })).toBe(false);
    expect(isPendingReview({})).toBe(false);
  });

  it('reads authorship from the owner field, not from visibility', () => {
    // An APPROVED user event has no `visibility` key but keeps its owner — that is what keeps it
    // out of `pruneStale()`. So authorship cannot be inferred from visibility.
    expect(isUserAuthored({ createdByUserId: 'devlogin:me@example.com' })).toBe(true);
    expect(isUserAuthored({})).toBe(false);
    expect(isUserAuthored({ visibility: 'public', createdByUserId: 'x' })).toBe(true);
  });
});
