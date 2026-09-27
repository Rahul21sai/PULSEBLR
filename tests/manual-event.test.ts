import { describe, it, expect } from 'vitest';
import { buildCalendarFeed } from '@/lib/calendar/ics';
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

/**
 * SECURITY FINDING F1 (CWE-93): a link with a raw CR/LF injected lines into the calendar feed.
 *
 * `httpUrl()` validated with `new URL(raw)` and then STORED `raw`. The WHATWG parser silently deletes
 * every CR, LF and TAB before parsing, so it approved a string it did not represent — and the ICS
 * route writes `URL:${event.sourceUrl}` unescaped (a URI is not TEXT), so the CRLF became a line
 * break in the user's calendar file and whatever followed it a property. Two defences now, and each
 * is pinned separately because either alone looks sufficient:
 *   1. what is stored is the parsed `href`, which is percent-encoded ASCII; and
 *   2. a control character INSIDE a link is refused outright, naming the field.
 */
const URL_FIELDS = ['sourceUrl', 'applyLink', 'onlineLink', 'imageUrl'] as const;

/** Code-unit check, so the test does not need a control-character regex either. */
function hasControl(value: string): boolean {
  return [...value].some(ch => {
    const code = ch.charCodeAt(0);
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
  });
}

describe('validateManualEvent — link hygiene (F1)', () => {
  it('stores the PARSED href, never the string it was sent', () => {
    // Both of these differ from their input only by normalisation — which is the proof that the
    // stored value came from the parser rather than from the request.
    for (const field of URL_FIELDS) {
      const { fields } = validateManualEvent({ ...VALID, [field]: 'HTTPS://Lu.Ma/Some Event' });
      expect(fields?.[field]).toBe('https://lu.ma/Some%20Event');
      expect(validateManualEvent({ ...VALID, [field]: 'https://lu.ma' }).fields?.[field]).toBe('https://lu.ma/');
    }
  });

  it.each([
    ['CRLF', '\r\n'],
    ['a lone CR', '\r'],
    ['a lone LF', '\n'],
    ['TAB', '\t'],
    ['NUL', '\u0000'],
    ['DEL', '\u007f'],
    ['a C1 control (NEL)', '\u0085'],
    ['U+2028 LINE SEPARATOR', ' '],
    ['U+2029 PARAGRAPH SEPARATOR', ' '],
  ])('refuses %s inside a link, on every link field, naming the field', (_label, char) => {
    for (const field of URL_FIELDS) {
      const result = validateManualEvent({
        ...VALID,
        [field]: `https://example.com/a${char}ATTENDEE;CN=x:mailto:victim@example.com`,
      });
      expect(result.fields).toBeUndefined();
      expect(result.issues.map(i => i.field)).toEqual([field]);
    }
  });

  it('trims surrounding whitespace first — a pasted link with a trailing newline is fine', () => {
    const { fields, issues } = validateManualEvent({ ...VALID, sourceUrl: '  https://lu.ma/x\r\n' });
    expect(issues).toEqual([]);
    expect(fields?.sourceUrl).toBe('https://lu.ma/x');
  });

  it('refuses an over-long link instead of truncating it into a different one', () => {
    const long = `https://example.com/${'a'.repeat(2000)}`;
    const result = validateManualEvent({ ...VALID, applyLink: long });
    expect(result.fields).toBeUndefined();
    expect(result.issues.map(i => i.field)).toEqual(['applyLink']);
  });

  it('never stores a control character in any link it accepts', () => {
    const { fields } = validateManualEvent({
      ...VALID,
      sourceUrl: 'https://example.com/a b?q=ü#frag ment',
      applyLink: 'https://müller.example/pfad',
      onlineLink: 'https://meet.example.com/abc-defg',
      imageUrl: 'https://cdn.example.com/cover.png?x=1&y=2',
    });
    for (const field of URL_FIELDS) {
      expect(fields?.[field]).toBeDefined();
      expect(hasControl(fields![field]!)).toBe(false);
    }
  });
});

describe('validateManualEvent — text hygiene', () => {
  it('flattens single-line fields: breaks and tabs become spaces, other controls vanish', () => {
    const { fields } = validateManualEvent({
      ...VALID,
      title: 'AI\r\nMeetup\u0000 \tNight',
      organizer: 'GDG\rBangalore',
      venue: 'WeWork Galaxy\u0007',
      area: 'HSR\u0085Layout',
    });
    expect(fields?.title).toBe('AI Meetup Night');
    expect(fields?.organizer).toBe('GDG Bangalore');
    expect(fields?.venue).toBe('WeWork Galaxy');
    expect(fields?.area).toBe('HSR Layout');
  });

  it('keeps newlines and tabs in the description, and leaves no CR behind', () => {
    const { fields } = validateManualEvent({
      ...VALID,
      description: 'One\r\nTwo\rThree Four\u0000\u0007 end\tTabbed',
    });
    expect(fields?.description).toBe('One\nTwo\nThree\nFour end\tTabbed');
  });

  it('cleans tags the same way, and does not let an empty-after-cleaning tag through', () => {
    const { fields } = validateManualEvent({ ...VALID, tags: ['rust\r\nlang', '\u0000', 'go'] });
    expect(fields?.tags).toEqual(['rust lang', 'go']);
  });

  it('cannot inject a line into the calendar feed through ANY field, end to end', () => {
    // The chain the finding was about: request body → validator → stored fields → ICS. A bare CR
    // is the case that matters for text, because `escapeIcsText` used to escape `\r?\n` but not a
    // lone CR.
    //
    // A COMBINED INVARIANT, NOT A GUARD ON THE VALIDATOR ALONE. `lib/calendar/ics.ts` has since been
    // hardened on the OUTPUT side too, so disabling the validator's cleaning does not make this fail
    // — measured: with `toSingleLine` / `toMultiline` reduced to `return value`, this case still
    // passes. The input-side cases above ("flattens single-line fields", "keeps newlines ... no CR")
    // are what pin the validator; this one pins that the two layers together never emit a raw break.
    const { fields } = validateManualEvent({
      ...VALID,
      title: 'Hack\rATTENDEE:mailto:a@x',
      description: 'Body\rATTENDEE:mailto:b@x',
      organizer: 'Org\rATTENDEE:mailto:c@x',
      venue: 'Venue\rATTENDEE:mailto:d@x',
      onlineLink: 'https://meet.example.com/x',
      sourceUrl: 'https://lu.ma/x',
    });
    expect(fields).toBeDefined();
    const feed = buildCalendarFeed({
      calendarName: 'Test',
      calendarDescription: 'Test',
      events: [{ id: 'e1', updatedAt: '2026-09-01T00:00:00Z', ...fields! }],
    });
    const lines = feed.split('\r\n');
    for (const line of lines) {
      expect(line.includes('\r') || line.includes('\n')).toBe(false);
      expect(line.startsWith('ATTENDEE')).toBe(false);
    }
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

  it('DOES NOT default the category at all — it used to, and that was the bug', () => {
    /**
     * INVERTED DELIBERATELY, and the most useful thing about this case is that it passed for as long
     * as the defect existed: the old contract was written down, tested, and wrong.
     *
     * The original reasoning was only ever about WHICH value to invent — `'Networking/Meetup'` was
     * dropped in the 32 → 22 consolidation and defaulting to it made every manual creation fail on
     * the schema enum, so it became `'Meetup'`. Nobody asked whether to invent one at all.
     *
     * `'Meetup'` is excluded from `TECH_FLAG_CATEGORIES` on purpose, so `POST /api/events` derived
     * `isTechEvent: false` from the invented value and the unconditionally-`techOnly` feed hid the
     * row. Measured 2026-09-20: 12 of 12 hand-added events owned by a real user stored `["Meetup"]`
     * with `isTechEvent: false`, and 0 of the 5 future-dated ones matched the feed.
     *
     * The route now runs `keywordTagging()` over the title and description and refuses the save when
     * even that finds no topic, so a category is either chosen by a human or justified from the text.
     * `tests/manual-event-category.test.ts` pins that; this case pins only that the validator keeps
     * its hands off.
     */
    expect(validateManualEvent(VALID).fields?.category).toEqual([]);
    expect(validateManualEvent({ ...VALID, category: [] }).fields?.category).toEqual([]);
    // A value the caller DID choose still survives untouched — the half that was always right.
    expect(validateManualEvent({ ...VALID, category: ['Meetup'] }).fields?.category).toEqual(['Meetup']);
  });

  /**
   * FREE OR PAID — REWRITTEN DELIBERATELY, because the case it replaces pinned the bug.
   *
   * This used to be one test, "derives isFree from price so the two cannot disagree", whose last line
   * was `expect(validateManualEvent({ ...VALID, isFree: false }).fields?.isFree).toBe(true)`. That is
   * the defect written down as the contract: the form sends `price: undefined` when the box is blank,
   * so switching "Free event" OFF and forgetting the price stored the event as FREE — the opposite of
   * what the person had just said, with a 201. Its first two lines were the same overrule (an
   * explicit answer silently replaced by one derived from the price), in both directions.
   *
   * The goal it stated is kept — a stored "free" and a stored price can still never disagree — but
   * by REFUSING a contradiction instead of resolving it on the caller's behalf. Derivation now only
   * happens when `isFree` is absent.
   */
  it('refuses a PAID event with no price, naming `price` — it used to be stored as free', () => {
    for (const paid of [{ isFree: false }, { isFree: false, price: '' }, { isFree: false, price: 0 }]) {
      const result = validateManualEvent({ ...VALID, ...paid });
      expect(result.fields).toBeUndefined();
      expect(result.issues.map(i => i.field)).toEqual(['price']);
    }
  });

  it('honours an explicit paid answer that carries a price', () => {
    for (const price of [500, '500']) {
      const { fields, issues } = validateManualEvent({ ...VALID, isFree: false, price });
      expect(issues).toEqual([]);
      expect(fields?.isFree).toBe(false);
      expect(fields?.price).toBe(500);
    }
  });

  it('refuses "free" with a positive price rather than silently storing it as paid', () => {
    const result = validateManualEvent({ ...VALID, isFree: true, price: 500 });
    expect(result.fields).toBeUndefined();
    expect(result.issues.map(i => i.field)).toEqual(['isFree']);
    // Free at ₹0 is consistent, and stays free.
    expect(validateManualEvent({ ...VALID, isFree: true, price: 0 }).fields?.isFree).toBe(true);
  });

  it('derives isFree from the price only when the caller did not say', () => {
    expect(validateManualEvent({ ...VALID, price: 500 }).fields?.isFree).toBe(false);
    expect(validateManualEvent({ ...VALID, price: 0 }).fields?.isFree).toBe(true);
    expect(validateManualEvent(VALID).fields?.isFree).toBe(true);
  });

  it('refuses a non-boolean isFree and a non-numeric price instead of coercing them', () => {
    // `Number(true)` is 1 and `Number([5])` is 5 — the old coercion turned both into prices.
    expect(validateManualEvent({ ...VALID, isFree: 'false' }).issues.map(i => i.field)).toEqual(['isFree']);
    expect(validateManualEvent({ ...VALID, price: true }).issues.map(i => i.field)).toEqual(['price']);
    expect(validateManualEvent({ ...VALID, price: [5] }).issues.map(i => i.field)).toEqual(['price']);
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
