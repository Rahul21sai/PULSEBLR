import { describe, it, expect } from 'vitest';
import {
  mergePreferences,
  readPreferences,
  preferenceError,
  DEFAULT_PREFERENCES,
  FORMAT_PREFERENCES,
  DIGEST_FREQUENCIES,
  TOPIC_CHOICES,
  AREA_CHOICES,
  type UserPreferences,
} from '@/lib/events/relevance';
import { EVENT_CATEGORIES, OTHER_CATEGORY_NAMES } from '@/lib/event-types';

/**
 * `mergePreferences` is the "validate" half of GUARD FIRST, VALIDATE SECOND for
 * `PUT /api/me/preferences`. It is pure, so it runs BEFORE `connectDB()` — a malformed body needs
 * no database to refuse — and it returns field-named issues rather than throwing, so a bad
 * `format` value can never reach Mongoose and come back as a 500 carrying the model name and
 * schema path. That exact leak is documented on the tracker write paths; this exists so it is not
 * repeated.
 *
 * The suite is mostly about two properties that are easy to lose in a refactor:
 *   · it is a PATCH, so an absent key must leave the stored value alone, and
 *   · a rejected payload must be rejected WHOLE, never applied in part.
 */

function current(patch: Partial<UserPreferences> = {}): UserPreferences {
  return { ...DEFAULT_PREFERENCES, ...patch };
}

describe('mergePreferences — accepts what the vocabulary allows', () => {
  it('stores a full valid payload', () => {
    const { preferences, issues } = mergePreferences(current(), {
      topics: ['AI/ML', 'Cloud/DevOps'],
      areas: ['Koramangala', 'Indiranagar'],
      format: 'offline',
      evenings: [2, 3, 4],
      remindersEnabled: false,
      digestFrequency: 'daily',
    });
    expect(issues).toEqual([]);
    expect(preferences).toEqual({
      topics: ['AI/ML', 'Cloud/DevOps'],
      areas: ['Koramangala', 'Indiranagar'],
      format: 'offline',
      evenings: [2, 3, 4],
      remindersEnabled: false,
      digestFrequency: 'daily',
    });
  });

  it('accepts every value in each vocabulary, so no legal choice is unreachable', () => {
    for (const format of FORMAT_PREFERENCES) {
      expect(mergePreferences(current(), { format }).preferences?.format).toBe(format);
    }
    for (const digestFrequency of DIGEST_FREQUENCIES) {
      expect(mergePreferences(current(), { digestFrequency }).preferences?.digestFrequency).toBe(
        digestFrequency
      );
    }
    // All 22 categories are valid topics even though onboarding only OFFERS 16 — see TOPIC_CHOICES.
    expect(mergePreferences(current(), { topics: [...EVENT_CATEGORIES] }).issues).toEqual([]);
    expect(mergePreferences(current(), { areas: [...AREA_CHOICES] }).issues).toEqual([]);
  });

  /**
   * Onboarding offers tech topics and gathering kinds only, because the feed is unconditionally
   * `techOnly` and a chip for `Arts/Culture` could only ever match nothing. Validation is wider on
   * purpose: a preference set through some other path is stored rather than silently dropped.
   */
  it('offers fewer topics than it accepts, and the gap is exactly the non-tech tail', () => {
    for (const name of OTHER_CATEGORY_NAMES) {
      expect(TOPIC_CHOICES).not.toContain(name);
      expect(mergePreferences(current(), { topics: [name] }).issues).toEqual([]);
    }
    expect(TOPIC_CHOICES.length).toBe(EVENT_CATEGORIES.length - OTHER_CATEGORY_NAMES.length);
  });

  it('de-duplicates and sorts evenings, so a repeat cannot score twice', () => {
    const { preferences } = mergePreferences(current(), { evenings: [5, 1, 5, 1, 0] });
    expect(preferences?.evenings).toEqual([0, 1, 5]);
  });

  it('de-duplicates topics and areas and drops blank entries', () => {
    const { preferences } = mergePreferences(current(), {
      topics: ['AI/ML', '  ', 'AI/ML'],
      areas: ['Koramangala', 'Koramangala'],
    });
    expect(preferences?.topics).toEqual(['AI/ML']);
    expect(preferences?.areas).toEqual(['Koramangala']);
  });

  it('trims surrounding whitespace before matching the vocabulary', () => {
    expect(mergePreferences(current(), { topics: ['  AI/ML  '] }).preferences?.topics).toEqual([
      'AI/ML',
    ]);
  });

  it('lets an explicit empty array CLEAR a list', () => {
    // Distinct from omitting the key. "I deselected everything" has to be expressible, or the
    // onboarding screen would be unable to undo a choice.
    const { preferences } = mergePreferences(current({ topics: ['AI/ML'], areas: ['Hebbal'] }), {
      topics: [],
      areas: [],
    });
    expect(preferences?.topics).toEqual([]);
    expect(preferences?.areas).toEqual([]);
  });
});

describe('mergePreferences — is a PATCH, not a replace', () => {
  /**
   * Three callers depend on this and each would break under a whole-object replace: onboarding's
   * SKIP sends `{}`; each onboarding card saves without carrying the other two cards' answers; and
   * the notifications stream sets `digestFrequency` alone and must not clear a topic list it knows
   * nothing about.
   */
  it('leaves every absent key untouched', () => {
    const stored = current({
      topics: ['AI/ML'],
      areas: ['Whitefield'],
      format: 'offline',
      evenings: [3],
      remindersEnabled: false,
      digestFrequency: 'off',
    });
    expect(mergePreferences(stored, {}).preferences).toEqual(stored);
    expect(mergePreferences(stored, { digestFrequency: 'weekly' }).preferences).toEqual({
      ...stored,
      digestFrequency: 'weekly',
    });
  });

  it('does not alias the caller’s stored arrays', () => {
    // A returned object that shares an array instance with the input is how a "process-global
    // shared by every user" bug starts — the one `getTargetCompanies()` had.
    const stored = current({ topics: ['AI/ML'] });
    const { preferences } = mergePreferences(stored, {});
    expect(preferences?.topics).toEqual(['AI/ML']);
    expect(preferences?.topics).not.toBe(stored.topics);
  });

  it('accepts an unknown key without storing it', () => {
    // Not an allowlist violation to reject loudly — a forward-compatible client sending a field
    // this build does not know should still be able to save the fields it does.
    const { preferences, issues } = mergePreferences(current(), {
      topics: ['AI/ML'],
      somethingElse: 'ignored',
    });
    expect(issues).toEqual([]);
    expect(preferences).not.toHaveProperty('somethingElse');
    expect(preferences?.topics).toEqual(['AI/ML']);
  });

  /**
   * `onboardedAt` is server-set bookkeeping, not a preference. A body must not be able to claim it
   * — otherwise a client could mark itself onboarded without answering anything, and the prompt
   * would disappear for a user who never saw the flow.
   */
  it('refuses to let a body set onboardedAt', () => {
    const { preferences } = mergePreferences(current(), { onboardedAt: new Date().toISOString() });
    expect(preferences).not.toHaveProperty('onboardedAt');
  });
});

describe('mergePreferences — rejects, WHOLE and with the field named', () => {
  const reject = (patch: unknown) => mergePreferences(current({ topics: ['AI/ML'] }), patch);

  it('names the offending field on every bad value', () => {
    const cases: Array<[unknown, string]> = [
      [{ topics: 'AI/ML' }, 'topics'],
      [{ topics: [1] }, 'topics'],
      [{ topics: ['Not A Category'] }, 'topics'],
      [{ areas: ['Mars'] }, 'areas'],
      [{ areas: {} }, 'areas'],
      [{ format: 'in-person' }, 'format'],
      [{ format: true }, 'format'],
      [{ evenings: [7] }, 'evenings'],
      [{ evenings: [-1] }, 'evenings'],
      [{ evenings: [1.5] }, 'evenings'],
      [{ evenings: ['Tue'] }, 'evenings'],
      [{ evenings: 3 }, 'evenings'],
      [{ remindersEnabled: 'yes' }, 'remindersEnabled'],
      [{ digestFrequency: 'hourly' }, 'digestFrequency'],
    ];
    for (const [patch, field] of cases) {
      const { preferences, issues } = reject(patch);
      expect(preferences, JSON.stringify(patch)).toBeNull();
      expect(issues.map(i => i.field), JSON.stringify(patch)).toContain(field);
    }
  });

  it('applies NOTHING when any field is rejected', () => {
    // A partial application is the worst outcome: the user sees an error and their preferences
    // have changed anyway. This mirrors the tracker validator's "no rejected write was a partial
    // update" assertion.
    const { preferences } = mergePreferences(current({ topics: ['AI/ML'] }), {
      areas: ['Koramangala'],
      format: 'teleport',
    });
    expect(preferences).toBeNull();
  });

  it('rejects a non-object body, which is what a non-JSON request parses to', () => {
    for (const body of [null, undefined, 'string', 42, [], [{ topics: [] }]]) {
      const { preferences, issues } = mergePreferences(current(), body);
      expect(preferences).toBeNull();
      expect(issues[0].field).toBe('body');
    }
  });

  it('produces an error body with a human first message and no Mongoose wording', () => {
    const { issues } = reject({ format: 'in-person' });
    const body = preferenceError(issues);
    expect(body.error).toContain('format');
    expect(body.issues).toEqual(issues);
    expect(body.error).not.toMatch(/validation failed|enum value|path `/i);
  });

  it('has a fallback message, so an empty issue list cannot produce an empty error', () => {
    expect(preferenceError([]).error).toBeTruthy();
  });
});

describe('readPreferences — absence is the normal state', () => {
  /**
   * Every user predates this field, so a missing value is not an error condition to handle at each
   * call site. It also has to survive a value that has gone invalid in the database — a category
   * removed from the taxonomy, say — by degrading that FIELD rather than the whole object, which
   * is the opposite of what a request body should do and is why this is not `mergePreferences`.
   */
  it('returns the defaults for undefined, null and an empty object', () => {
    for (const stored of [undefined, null, {}]) {
      expect(readPreferences(stored)).toEqual(DEFAULT_PREFERENCES);
    }
  });

  it('keeps valid stored values and drops only the invalid ones', () => {
    expect(
      readPreferences({
        topics: ['AI/ML', 'A Category That Was Retired'],
        areas: ['Koramangala', 'Atlantis'],
        format: 'offline',
        evenings: [2, 9, 'Tue'],
        digestFrequency: 'weekly',
      })
    ).toEqual({
      topics: ['AI/ML'],
      areas: ['Koramangala'],
      format: 'offline',
      evenings: [2],
      remindersEnabled: true,
      digestFrequency: 'weekly',
    });
  });

  it('falls back per-field, not wholesale, when one field is nonsense', () => {
    const read = readPreferences({ topics: ['AI/ML'], format: 'teleport', digestFrequency: 7 });
    expect(read.topics).toEqual(['AI/ML']);
    expect(read.format).toBe(DEFAULT_PREFERENCES.format);
    expect(read.digestFrequency).toBe(DEFAULT_PREFERENCES.digestFrequency);
  });

  it('ignores a stored onboardedAt, which is not part of the preference shape', () => {
    expect(readPreferences({ onboardedAt: new Date() })).toEqual(DEFAULT_PREFERENCES);
  });

  it('never returns the DEFAULT_PREFERENCES object itself', () => {
    // Returning the module-level literal would let one caller's mutation reach every user.
    const read = readPreferences(undefined);
    expect(read).not.toBe(DEFAULT_PREFERENCES);
    expect(read.topics).not.toBe(DEFAULT_PREFERENCES.topics);
  });
});

describe('the notification defaults are the ones the plan argued for', () => {
  /**
   * Not arbitrary. A DAILY email to engineers gets muted, and a muted sender is gone for good — so
   * weekly is the default and daily is an explicit opt-in. Reminders default ON because a reminder
   * for an event you saved yourself is relevant by construction, which is the one kind of message
   * that does not need to earn its place.
   */
  it('defaults to a weekly digest with reminders on', () => {
    expect(DEFAULT_PREFERENCES.digestFrequency).toBe('weekly');
    expect(DEFAULT_PREFERENCES.remindersEnabled).toBe(true);
  });

  it('leaves every ranking preference empty, so a skipped onboarding changes nothing', () => {
    expect(DEFAULT_PREFERENCES.topics).toEqual([]);
    expect(DEFAULT_PREFERENCES.areas).toEqual([]);
    expect(DEFAULT_PREFERENCES.evenings).toEqual([]);
    expect(DEFAULT_PREFERENCES.format).toBe('any');
  });
});
