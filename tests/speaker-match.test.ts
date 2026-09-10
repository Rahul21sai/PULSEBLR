import { describe, it, expect } from 'vitest';
import type { EventSpeaker } from '@/lib/event-types';
import {
  companyKey,
  matchSpeaker,
  matchSpeakers,
  nameTokens,
  speakerNameTokens,
  type MatchablePerson,
} from '@/lib/events/speaker-match';

/**
 * Matching a speaker on an event's bill to somebody already in the viewer's people list.
 *
 * MOST OF THIS SUITE IS REFUSALS, and that is the point — the same shape as `tests/off-city.test.ts`
 * and for the same kind of reason. A miss here costs a little delight. A false positive is a
 * confident claim about the reader's own memory ("you met her at IndiaFOSS") which the reader cannot
 * check, because not remembering is exactly why they are reading it. So the assertions that matter
 * are the ones where a looser rule would have said yes.
 *
 * The matcher is also pure by construction: it takes people as data and has no model, so it cannot
 * create a `Person` from a speaker even by accident. Nothing below needs a database.
 */

function person(overrides: Partial<MatchablePerson> & { _id: string; displayName: string }): MatchablePerson {
  return { eventCount: 1, ...overrides };
}

const ASHA = person({
  _id: 'p1',
  displayName: 'Asha Rao',
  company: 'Razorpay',
  companies: ['Razorpay'],
  eventCount: 2,
  lastInteractionAt: '2026-07-18T12:00:00.000Z',
  recent: [
    { at: '2026-07-18T12:00:00.000Z', eventTitle: 'IndiaFOSS 2026' },
    { at: '2026-03-02T12:00:00.000Z', eventTitle: 'Bangalore Kubernetes Meetup' },
  ],
});

const speaker = (s: Partial<EventSpeaker> & { name: string }): EventSpeaker => s;

describe('matchSpeaker — what it accepts', () => {
  it('matches on a full name plus an agreeing company', () => {
    const match = matchSpeaker(speaker({ name: 'Asha Rao', company: 'Razorpay' }), [ASHA]);
    expect(match).not.toBeNull();
    expect(match!.personId).toBe('p1');
    expect(match!.basis).toBe('name+company');
  });

  it('reports the encounter, newest first, with the event that is still in the corpus', () => {
    const match = matchSpeaker(speaker({ name: 'Asha Rao' }), [ASHA]);
    expect(match!.metAtTitle).toBe('IndiaFOSS 2026');
    expect(match!.metAt).toBe('2026-07-18T12:00:00.000Z');
    expect(match!.eventCount).toBe(2);
  });

  it('falls back to the interaction date when the event has been pruned', () => {
    // `pruneStale()` deletes events a week past without touching what references them, so a
    // titleless encounter is normal. It still happened, so the date is still worth showing.
    const pruned = person({
      _id: 'p2',
      displayName: 'Pravein Kannan',
      recent: [{ at: '2026-05-04T09:00:00.000Z', eventTitle: null }],
      lastInteractionAt: '2026-05-04T09:00:00.000Z',
    });
    const match = matchSpeaker(speaker({ name: 'Pravein Kannan' }), [pruned]);
    expect(match!.metAtTitle).toBeNull();
    expect(match!.metAt).toBe('2026-05-04T09:00:00.000Z');
  });

  it('prefers a titled encounter over a more recent untitled one', () => {
    // A note written last week is more recent than the meeting, but "you met them at X" is the claim
    // being made, so the titled row wins even though it is older.
    const mixed = person({
      _id: 'p3',
      displayName: 'Asha Rao',
      recent: [
        { at: '2026-08-01T00:00:00.000Z', eventTitle: null },
        { at: '2026-07-18T00:00:00.000Z', eventTitle: 'IndiaFOSS 2026' },
      ],
    });
    expect(matchSpeaker(speaker({ name: 'Asha Rao' }), [mixed])!.metAtTitle).toBe('IndiaFOSS 2026');
  });

  it('accepts a name whose tokens are in the other order', () => {
    // Surname-first is ordinary in South India, and the same tokens in a different order are
    // overwhelmingly the same human. This is the ONLY widening the rule allows.
    const surnameFirst = person({ _id: 'p4', displayName: 'Vudumula Naga Sai Rahul' });
    expect(matchSpeaker(speaker({ name: 'Naga Sai Rahul Vudumula' }), [surnameFirst])).not.toBeNull();
  });

  it('sees through honorifics, credentials, punctuation and diacritics', () => {
    const plain = person({ _id: 'p5', displayName: 'Asha Rao' });
    for (const name of ['Dr. Asha Rao', 'Asha Rao, PhD', 'Prof Asha  Rao', 'Ashā Rao']) {
      expect(matchSpeaker(speaker({ name }), [plain]), name).not.toBeNull();
    }
  });

  it('falls back to name alone when only one side states a company', () => {
    const noCompany = person({ _id: 'p6', displayName: 'Asha Rao' });
    expect(matchSpeaker(speaker({ name: 'Asha Rao', company: 'Razorpay' }), [noCompany])!.basis).toBe('name');
    expect(matchSpeaker(speaker({ name: 'Asha Rao' }), [ASHA])!.basis).toBe('name');
  });
});

describe('matchSpeaker — what it refuses', () => {
  it('refuses a single-token name on either side', () => {
    // "Asha" matching "Asha" is not evidence. This is the cheapest false positive to prevent and the
    // one a naive implementation makes first.
    expect(matchSpeaker(speaker({ name: 'Asha' }), [ASHA])).toBeNull();
    expect(matchSpeaker(speaker({ name: 'Asha Rao' }), [person({ _id: 'x', displayName: 'Asha' })])).toBeNull();
    // Including when an honorific is all that made it two tokens.
    expect(matchSpeaker(speaker({ name: 'Dr. Asha' }), [ASHA])).toBeNull();
  });

  it('refuses a company that disagrees', () => {
    // The important refusal: two real people share a name and work in different places.
    expect(matchSpeaker(speaker({ name: 'Asha Rao', company: 'Google' }), [ASHA])).toBeNull();
  });

  it('refuses a partial name — no initials, no subsets, no fuzz', () => {
    for (const name of ['A Rao', 'Asha R Rao', 'Rao', 'Asha Raoo', 'Ashaa Rao']) {
      expect(matchSpeaker(speaker({ name }), [ASHA]), name).toBeNull();
    }
  });

  it('refuses when two of the viewer’s people answer to the same name', () => {
    // The case where a guess does the most damage, so it declines outright rather than picking the
    // one with more encounters or the more recent one.
    const twins = [
      person({ _id: 'a', displayName: 'Rahul Sharma' }),
      person({ _id: 'b', displayName: 'Rahul Sharma' }),
    ];
    expect(matchSpeaker(speaker({ name: 'Rahul Sharma' }), twins)).toBeNull();
  });

  it('refuses when two people answer to the name AND both agree on the company', () => {
    const twins = [
      person({ _id: 'a', displayName: 'Rahul Sharma', company: 'Infosys' }),
      person({ _id: 'b', displayName: 'Rahul Sharma', company: 'Infosys' }),
    ];
    expect(matchSpeaker(speaker({ name: 'Rahul Sharma', company: 'Infosys' }), twins)).toBeNull();
  });

  it('lets a company break a tie between two people of the same name', () => {
    // One candidate is corroborated and the other only conflicts, so there is no ambiguity left.
    const twins = [
      person({ _id: 'a', displayName: 'Rahul Sharma', company: 'Infosys' }),
      person({ _id: 'b', displayName: 'Rahul Sharma', company: 'Razorpay' }),
    ];
    const match = matchSpeaker(speaker({ name: 'Rahul Sharma', company: 'Razorpay' }), twins);
    expect(match!.personId).toBe('b');
    expect(match!.basis).toBe('name+company');
  });

  it('prefers a corroborated candidate over a name-only one', () => {
    const twins = [
      person({ _id: 'a', displayName: 'Rahul Sharma' }),
      person({ _id: 'b', displayName: 'Rahul Sharma', company: 'Razorpay' }),
    ];
    expect(matchSpeaker(speaker({ name: 'Rahul Sharma', company: 'Razorpay' }), twins)!.personId).toBe('b');
  });

  it('returns nothing for an empty people list — the anonymous-visitor case', () => {
    // An event page is public. A signed-out reader has no Persons, so there is nothing to leak.
    expect(matchSpeaker(speaker({ name: 'Asha Rao' }), [])).toBeNull();
    expect(matchSpeakers([speaker({ name: 'Asha Rao' })], [])).toEqual([null]);
    expect(matchSpeakers([speaker({ name: 'Asha Rao' })], null)).toEqual([null]);
  });
});

describe('company comparison', () => {
  it('treats legal and geographic noise as saying nothing about which company it is', () => {
    expect(companyKey('Google India')).toBe(companyKey('Google'));
    expect(companyKey('Zoho Technologies Pvt Ltd')).toBe(companyKey('Zoho'));
    expect(companyKey('Razorpay Software Private Limited')).toBe(companyKey('razorpay'));
  });

  it('returns null when nothing distinguishing survives, so it reads as unknown not as a conflict', () => {
    // A company field holding only "Pvt Ltd" must not veto an otherwise exact name match.
    expect(companyKey('Pvt Ltd')).toBeNull();
    expect(companyKey('')).toBeNull();
    expect(companyKey(null)).toBeNull();
    expect(matchSpeaker(speaker({ name: 'Asha Rao', company: 'Ltd' }), [ASHA])!.basis).toBe('name');
  });

  it('does not confuse two different companies', () => {
    expect(companyKey('Meta')).not.toBe(companyKey('Metadata'));
    expect(companyKey('Google')).not.toBe(companyKey('Googol'));
  });

  it('matches against a registry-resolved company as well as the raw one', () => {
    // `Person.companies` is what `lib/companies/resolve.ts` produced; `company` is the effective
    // free-text value. A speaker may state either.
    const resolved = person({
      _id: 'p7',
      displayName: 'Asha Rao',
      company: 'Razorpay Software Pvt Ltd',
      companies: ['Razorpay'],
    });
    expect(matchSpeaker(speaker({ name: 'Asha Rao', company: 'Razorpay' }), [resolved])!.basis).toBe(
      'name+company'
    );
  });
});

describe('matchSpeakers', () => {
  it('stays index-aligned with the bill so unmatched speakers still render', () => {
    const bill = [
      speaker({ name: 'Asha Rao', company: 'Razorpay' }),
      speaker({ name: 'Pravein Kannan', company: 'IBM' }),
      speaker({ name: 'Asha' }),
    ];
    const matches = matchSpeakers(bill, [ASHA]);
    expect(matches).toHaveLength(3);
    expect(matches[0]?.personId).toBe('p1');
    expect(matches[1]).toBeNull();
    expect(matches[2]).toBeNull();
  });

  it('returns an empty list for an event with no speakers', () => {
    expect(matchSpeakers(undefined, [ASHA])).toEqual([]);
    expect(matchSpeakers([], [ASHA])).toEqual([]);
  });
});

describe('nameTokens and the query prefilter', () => {
  it('folds a name to comparable tokens', () => {
    expect(nameTokens('Dr. Ashā  Rao, PhD')).toEqual(['asha', 'rao']);
    expect(nameTokens('Jean-Luc Picard')).toEqual(['jean', 'luc', 'picard']);
    expect(nameTokens('  ')).toEqual([]);
    expect(nameTokens(null)).toEqual([]);
    // A punctuation-only separator must SPLIT rather than fuse, or one side tokenises differently
    // from the other and an exact comparison silently stops working.
    expect(nameTokens("O'Brien Sam")).toEqual(['o', 'brien', 'sam']);
  });

  it('offers no query for names that could never match anyway', () => {
    // A bill of mononyms costs no database round trip at all, because rule 1 would refuse them.
    expect(speakerNameTokens([speaker({ name: 'Asha' }), speaker({ name: 'Dr' })])).toEqual([]);
    expect(speakerNameTokens([])).toEqual([]);
    expect(speakerNameTokens(null)).toEqual([]);
  });

  it('de-duplicates a bill that names the same person twice in different orders', () => {
    const tokens = speakerNameTokens([
      speaker({ name: 'Asha Rao' }),
      speaker({ name: 'Rao Asha' }),
      speaker({ name: 'Pravein Kannan' }),
    ]);
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).toEqual(['asha', 'rao']);
  });
});
