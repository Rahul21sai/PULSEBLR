import { describe, it, expect } from 'vitest';
import {
  derivePersonFields,
  derivePersonCounters,
  deriveNextActionAt,
  derivePersonTags,
  personUpsertSpec,
} from '@/lib/people/service';

/**
 * THE DERIVATION RULES, PINNED — because every one of them has a wrong-but-plausible reading, and
 * the wrong reading is silent.
 *
 * A `Person` is one human; a `Contact` is one encounter with them. Every displayed field on the
 * person is DERIVED from the encounters, and the whole design rests on getting four things right:
 *
 *   · per-FIELD recency, not per-ROW — the newest capture may have a name and no company
 *   · `eventCount` counts DISTINCT EVENTS, not `met` interactions and not folders
 *   · `lastInteractionAt` is max(Interaction.at), NOT `Contact.scannedAt`
 *   · a user override always wins, and survives every later recompute
 *
 * These are pure functions with plain data in and plain data out, so they are pinned here rather
 * than in a diag script — the same arrangement `canonicaliseTags` has in `tests/contact-tags.test.ts`.
 */

const t = (iso: string) => new Date(iso);

describe('derivePersonFields — per FIELD, not per ROW', () => {
  /**
   * THE RULE THAT IS EASY TO GET WRONG. "Newest wins" read as "take the newest row" makes the
   * company go EMPTY the moment somebody is scanned from a LinkedIn QR, which carries a slug and no
   * employer. You would lose a company you already knew, from a capture that told you nothing new.
   */
  it('falls back per field to the newest capture that HAD a value', () => {
    const fields = derivePersonFields([
      { scannedAt: t('2026-01-01'), name: 'Asha Rao', company: 'Razorpay', role: 'SRE' },
      // Newer, but carries only a name — a LinkedIn QR scan.
      { scannedAt: t('2026-06-01'), name: 'Asha R' },
    ]);
    expect(fields.displayName).toBe('Asha R');
    expect(fields.company).toBe('Razorpay');
    expect(fields.role).toBe('SRE');
  });

  it('does not depend on the order rows arrive in', () => {
    const rows = [
      { scannedAt: t('2026-06-01'), name: 'Asha R' },
      { scannedAt: t('2026-01-01'), name: 'Asha Rao', company: 'Razorpay' },
    ];
    expect(derivePersonFields(rows)).toEqual(derivePersonFields([...rows].reverse()));
  });

  it('treats blank and whitespace-only values as absent, not as a newer answer', () => {
    const fields = derivePersonFields([
      { scannedAt: t('2026-01-01'), name: 'Asha Rao', company: 'Razorpay' },
      { scannedAt: t('2026-06-01'), name: 'Asha Rao', company: '   ' },
    ]);
    expect(fields.company).toBe('Razorpay');
  });

  it('newest genuinely does win when it has a value', () => {
    const fields = derivePersonFields([
      { scannedAt: t('2026-01-01'), name: 'Asha Rao', company: 'Razorpay' },
      { scannedAt: t('2026-06-01'), name: 'Asha Rao', company: 'Postman' },
    ]);
    // This is the job-change case, and keeping the per-encounter rows is what makes it visible.
    expect(fields.company).toBe('Postman');
  });

  it('returns undefined for a field no encounter ever supplied', () => {
    const fields = derivePersonFields([{ scannedAt: t('2026-01-01'), name: 'Asha Rao' }]);
    expect(fields.company).toBeUndefined();
    expect(fields.headline).toBeUndefined();
  });

  it('survives an empty contact list without inventing a name', () => {
    expect(derivePersonFields([])).toEqual({});
  });
});

describe('derivePersonFields — overrides BEAT derived, always', () => {
  const encounters = [
    { scannedAt: t('2026-01-01'), name: 'A Rao', company: 'Razorpay', role: 'SRE' },
    { scannedAt: t('2026-06-01'), name: 'Asha R', company: 'Postman', role: 'Staff SRE' },
  ];

  it('wins over the newest encounter', () => {
    const fields = derivePersonFields(encounters, { displayName: 'Asha Rao' });
    expect(fields.displayName).toBe('Asha Rao');
  });

  /**
   * The reason this is pinned: a recompute runs on EVERY new encounter, every note and every
   * follow-up. If the override were applied only at the moment the user typed it, the next scan
   * would silently revert their correction — and they would have no way to tell which of the two
   * values the row is showing.
   */
  it('is re-applied by the derivation itself, so a later recompute cannot revert it', () => {
    const once = derivePersonFields(encounters, { company: 'Postman India' });
    const again = derivePersonFields(
      [...encounters, { scannedAt: t('2026-09-01'), name: 'Asha', company: 'Zerodha' }],
      { company: 'Postman India' }
    );
    expect(once.company).toBe('Postman India');
    expect(again.company).toBe('Postman India');
  });

  it('overrides only the three fields that carry one; headline stays derived', () => {
    const fields = derivePersonFields(
      [{ scannedAt: t('2026-01-01'), name: 'Asha Rao', headline: 'SRE at Razorpay' }],
      { displayName: 'A. Rao' }
    );
    expect(fields.displayName).toBe('A. Rao');
    expect(fields.headline).toBe('SRE at Razorpay');
  });

  /**
   * A blank override is "no override", not "force this field empty". Otherwise clearing the input
   * on the person page would pin an empty string forever and no later capture could ever fill it,
   * which reads as the field being broken rather than cleared.
   */
  it('ignores a blank override rather than pinning an empty value', () => {
    const fields = derivePersonFields(encounters, { displayName: '  ', company: '' });
    expect(fields.displayName).toBe('Asha R');
    expect(fields.company).toBe('Postman');
  });

  it('can name someone with no usable encounter value at all', () => {
    expect(derivePersonFields([], { displayName: 'Asha Rao' }).displayName).toBe('Asha Rao');
  });
});

describe('derivePersonCounters — eventCount counts DISTINCT EVENTS', () => {
  /**
   * `detectRepeatConnections` already carries this bug's scar: it keyed on the FOLDER, so two
   * folders for one event read as two events. `met N x` has to mean N distinct events or the badge
   * is a lie, and the lie is flattering — it inflates every number on the page.
   */
  it('does not count met-interactions', () => {
    const counters = derivePersonCounters([
      { at: t('2026-01-01'), eventId: 'evt-A' },
      { at: t('2026-01-01'), eventId: 'evt-A' },
      { at: t('2026-02-01'), eventId: 'evt-A' },
    ]);
    expect(counters.eventCount).toBe(1);
    expect(counters.interactionCount).toBe(3);
  });

  it('counts each distinct event once', () => {
    const counters = derivePersonCounters([
      { at: t('2026-01-01'), eventId: 'evt-A' },
      { at: t('2026-02-01'), eventId: 'evt-B' },
      { at: t('2026-03-01'), eventId: 'evt-C' },
    ]);
    expect(counters.eventCount).toBe(3);
  });

  /**
   * An off-event capture, a note and a follow-up all carry no `eventId`. They are real interactions
   * and must raise `interactionCount`, but they are not events — counting a null as an event would
   * make somebody you have merely emailed read as somebody you met.
   */
  it('ignores null and absent eventIds entirely', () => {
    const counters = derivePersonCounters([
      { at: t('2026-01-01'), eventId: 'evt-A' },
      { at: t('2026-02-01'), eventId: null },
      { at: t('2026-03-01') },
    ]);
    expect(counters.eventCount).toBe(1);
    expect(counters.interactionCount).toBe(3);
  });

  it('compares event ids by their string form, so an ObjectId and its string agree', () => {
    const counters = derivePersonCounters([
      { at: t('2026-01-01'), eventId: { toString: () => 'evt-A' } as unknown as string },
      { at: t('2026-02-01'), eventId: 'evt-A' },
    ]);
    expect(counters.eventCount).toBe(1);
  });

  it('is zero-and-null on an empty timeline, never NaN or a stale value', () => {
    expect(derivePersonCounters([])).toEqual({
      eventCount: 0,
      interactionCount: 0,
      lastInteractionAt: null,
    });
  });
});

describe('derivePersonCounters — lastInteractionAt is max(Interaction.at)', () => {
  /**
   * NOT `Contact.scannedAt`, and that substitution is exactly today's defect. A note written in
   * September about somebody scanned in January means the last contact was September;
   * `completeContactFollowUp()` currently flips a boolean and records no timestamp at all, so
   * "when did I last talk to her" is unanswerable. The whole point of the Interaction timeline is
   * that a note and a completed follow-up ARE contact.
   */
  it('takes the latest of every kind, not just the capture', () => {
    const counters = derivePersonCounters([
      { at: t('2026-01-10T00:00:00Z'), eventId: 'evt-A' }, // met
      { at: t('2026-09-01T00:00:00Z') }, // a note
      { at: t('2026-03-01T00:00:00Z') }, // a follow-up completed
    ]);
    expect(counters.lastInteractionAt?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('does not care what order the rows arrive in', () => {
    const rows = [{ at: t('2026-09-01') }, { at: t('2026-01-10') }];
    expect(derivePersonCounters(rows).lastInteractionAt).toEqual(
      derivePersonCounters([...rows].reverse()).lastInteractionAt
    );
  });
});

describe('deriveNextActionAt — the SOONEST OUTSTANDING follow-up', () => {
  /**
   * Follow-ups are per-ENCOUNTER, so someone met three times can carry three dates while the person
   * card shows one. The soonest outstanding one is the actionable one; the others are not lost, they
   * are just not what to do next.
   */
  it('takes the minimum across the person encounters', () => {
    const next = deriveNextActionAt([
      { scannedAt: t('2026-01-01'), followUpAt: t('2026-10-01'), followedUp: false },
      { scannedAt: t('2026-02-01'), followUpAt: t('2026-09-15'), followedUp: false },
    ]);
    expect(next?.toISOString()).toBe(t('2026-09-15').toISOString());
  });

  it('ignores follow-ups already marked done — that is the whole point of "outstanding"', () => {
    const next = deriveNextActionAt([
      { scannedAt: t('2026-01-01'), followUpAt: t('2026-09-01'), followedUp: true },
      { scannedAt: t('2026-02-01'), followUpAt: t('2026-10-01'), followedUp: false },
    ]);
    expect(next?.toISOString()).toBe(t('2026-10-01').toISOString());
  });

  it('is null when nothing is outstanding, which is what the followUpDue filter selects against', () => {
    expect(deriveNextActionAt([{ scannedAt: t('2026-01-01') }])).toBeNull();
    expect(
      deriveNextActionAt([{ scannedAt: t('2026-01-01'), followUpAt: t('2026-09-01'), followedUp: true }])
    ).toBeNull();
    expect(deriveNextActionAt([])).toBeNull();
  });

  it('treats a missing followedUp as not-done, matching the schema default', () => {
    const next = deriveNextActionAt([{ scannedAt: t('2026-01-01'), followUpAt: t('2026-09-01') }]);
    expect(next?.toISOString()).toBe(t('2026-09-01').toISOString());
  });
});

describe('derivePersonTags — RECOMPUTED, never unioned', () => {
  /**
   * A union is forever, and this repo has already reversed exactly this mistake once:
   * "`Event.companies` is RECOMPUTED at ingest, not unioned — and that had to change… True at the
   * moment of writing; union is forever." Unioned here, removing a tag from a Contact would leave
   * it on the Person permanently with no UI able to clear it — the same shape as a bad category that
   * re-scraping can never remove.
   */
  it('drops a tag that no longer exists on any contact', () => {
    const before = derivePersonTags([{ scannedAt: t('2026-01-01'), tags: ['sre', 'kafka'] }], []);
    expect(before).toEqual(['sre', 'kafka']);
    const after = derivePersonTags([{ scannedAt: t('2026-01-01'), tags: ['sre'] }], []);
    expect(after).toEqual(['sre']);
  });

  /**
   * `personOwnTags` are stored SEPARATELY precisely so a recompute cannot erase them — a tag added
   * on the person page belongs to no single encounter, so a recompute driven by contacts alone would
   * silently delete it.
   */
  it('keeps tags added directly on the person', () => {
    expect(derivePersonTags([{ scannedAt: t('2026-01-01'), tags: ['sre'] }], ['mentor'])).toEqual([
      'sre',
      'mentor',
    ]);
  });

  it('canonicalises and de-duplicates across encounters, because a tag is a FACET KEY', () => {
    const tags = derivePersonTags(
      [
        { scannedAt: t('2026-01-01'), tags: ['AI/ML'] },
        { scannedAt: t('2026-02-01'), tags: ['ai/ml', ' Senior  SRE '] },
      ],
      ['AI/ML']
    );
    expect(tags).toEqual(['ai/ml', 'senior sre']);
  });

  it('is an empty array, never undefined, when there is nothing to show', () => {
    expect(derivePersonTags([], [])).toEqual([]);
  });
});

describe('personUpsertSpec — the create race, and the array-shape trap', () => {
  /**
   * Two devices draining the outbox at once both resolve the same new `contactKey`, both find
   * nothing, and both insert. `contactKeys` is an ARRAY so it cannot carry a unique index, so the
   * create is an atomic upsert instead.
   *
   * THE TRAP: an equality filter on an array field (`{ contactKeys: 'li:asha' }`) makes Mongo
   * synthesise that field on insert as a SCALAR — `contactKeys: 'li:asha'` — not a one-element
   * array. Every later `$addToSet` then fails and the document shape is corrupt. Naming the field
   * explicitly in `$setOnInsert` is what prevents it, and this asserts the built document rather
   * than trusting the driver.
   */
  it('seeds contactKeys as a one-element ARRAY in $setOnInsert', () => {
    const spec = personUpsertSpec('uid-1', 'li:asha-rao-123', { displayName: 'Asha Rao' });
    const seeded = (spec.update.$setOnInsert as Record<string, unknown>).contactKeys;
    expect(Array.isArray(seeded)).toBe(true);
    expect(seeded).toEqual(['li:asha-rao-123']);
  });

  it('filters on the key and scopes to the user', () => {
    const spec = personUpsertSpec('uid-1', 'li:asha-rao-123', {});
    expect(spec.filter).toEqual({ userId: 'uid-1', contactKeys: 'li:asha-rao-123' });
  });

  it('upserts, and returns the document either way', () => {
    const spec = personUpsertSpec('uid-1', 'nm:asha rao', {});
    expect(spec.options.upsert).toBe(true);
    expect(spec.options.new).toBe(true);
    expect(spec.options.setDefaultsOnInsert).toBe(true);
  });

  /**
   * `$setOnInsert` only — never `$set`. An upsert that also `$set`s would overwrite a person that a
   * racing request created a millisecond earlier, so the loser of the race would clobber the
   * winner's derived fields with its own single-encounter view.
   */
  it('never writes $set, so losing the race is harmless', () => {
    const spec = personUpsertSpec('uid-1', 'nm:asha rao', { displayName: 'Asha Rao' });
    expect('$set' in spec.update).toBe(false);
  });
});
