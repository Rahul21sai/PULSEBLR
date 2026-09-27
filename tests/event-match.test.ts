import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  isDateOnlyStart,
  isNearTwin,
  matchTitle,
  pickNearTwin,
  preciseTimingUpgrade,
  type MatchSighting,
} from '@/lib/scrapers/core/event-match';
import { eventNodeToRawEvent } from '@/lib/scrapers/core/jsonld';

/*
 * The two live GIDS rows, field for field (scripts/diag-gids-dupe.ts, 2026-09-27). Most of this
 * file is the NEGATIVE half: a near-twin false positive does not mis-tag an event, it merges two
 * real events into one card, and the loser's own next sighting then merges into it forever.
 */
const GIDS_DEVEVENTS: MatchSighting = {
  title: 'Great International Developer Summit (GIDS)',
  startDateTime: new Date('2027-04-27T00:00:00.000Z'),
  source: 'devevents',
  city: 'Bengaluru',
};
const GIDS_COMPANY: MatchSighting = {
  title: 'Great International Developer Summit (GIDS) 2027',
  startDateTime: new Date('2027-04-26T10:00:00.000Z'),
  source: 'company',
  city: 'Bengaluru',
};

const at = (iso: string) => new Date(iso);
const s = (title: string, iso: string, source: string, city = 'Bengaluru'): MatchSighting => ({
  title,
  startDateTime: at(iso),
  source,
  city,
});

describe('isNearTwin — the pairs that ARE one event', () => {
  it('collapses the live GIDS pair (year suffix + date-only source one IST day off)', () => {
    expect(isNearTwin(GIDS_DEVEVENTS, GIDS_COMPANY)).toBe(true);
    expect(isNearTwin(GIDS_COMPANY, GIDS_DEVEVENTS)).toBe(true);
  });

  it('collapses a devevents record the dataset lists twice, with and without the year', () => {
    // flutterCon India / flutterCon India 2026, both 2026-11-21T00:00Z — measured in the dataset.
    expect(
      isNearTwin(
        s('flutterCon India', '2026-11-21T00:00:00.000Z', 'devevents'),
        s('flutterCon India 2026', '2026-11-21T00:00:00.000Z', 'devevents', 'Bangalore')
      )
    ).toBe(true);
  });

  it('collapses two precise sightings on the same IST day that differ only by the year', () => {
    expect(
      isNearTwin(
        s('Hacktoberfest 2026 Meetup', '2026-10-10T04:30:00Z', 'meetup'),
        s('Hacktoberfest', '2026-10-10T05:00:00Z', 'luma')
      )
    ).toBe(true);
  });
});

describe('isNearTwin — the pairs that must STAY SEPARATE', () => {
  it('keeps numbered editions apart (#107 vs #108), even on one day', () => {
    expect(
      isNearTwin(
        s('React Meetup #107', '2026-10-10T12:30:00Z', 'meetup'),
        s('React Meetup #108', '2026-10-10T12:30:00Z', 'luma')
      )
    ).toBe(false);
  });

  it('keeps two PRECISE same-title sightings on consecutive days apart (the live Dev Days pair)', () => {
    // meetup 10 Oct 10:00 at JRC Palladio, luma 9 Oct 10:00 at Alliance University.
    expect(
      isNearTwin(
        s('Dev Days | Bangalore, India', '2026-10-10T04:30:00Z', 'meetup'),
        s('Dev Days | Bangalore, India', '2026-10-09T04:30:00Z', 'luma')
      )
    ).toBe(false);
  });

  it('keeps a nightly run of one show apart', () => {
    expect(
      isNearTwin(
        s('Comedy Night', '2026-10-10T14:30:00Z', 'district'),
        s('Comedy Night', '2026-10-11T14:30:00Z', 'allevents')
      )
    ).toBe(false);
  });

  it('refuses a date-only match TWO IST days away', () => {
    expect(
      isNearTwin(
        GIDS_DEVEVENTS,
        { ...GIDS_COMPANY, startDateTime: at('2027-04-25T10:00:00Z') }
      )
    ).toBe(false);
  });

  it('keeps a weekly series apart', () => {
    expect(
      isNearTwin(
        s('droidCon India', '2026-11-20T00:00:00.000Z', 'devevents'),
        s('droidCon India', '2026-11-27T04:30:00Z', 'meetup')
      )
    ).toBe(false);
  });

  it('refuses when the cities disagree', () => {
    expect(isNearTwin(GIDS_DEVEVENTS, { ...GIDS_COMPANY, city: 'Chennai' })).toBe(false);
  });

  it('never matches a hand-entered event, from either side (CLAUDE.md §12)', () => {
    expect(isNearTwin(GIDS_DEVEVENTS, { ...GIDS_COMPANY, createdByUserId: 'u1' })).toBe(false);
    expect(isNearTwin({ ...GIDS_DEVEVENTS, createdByUserId: 'u1' }, GIDS_COMPANY)).toBe(false);
  });

  it('strips only the event\'s OWN year — a different year is a different title', () => {
    expect(
      isNearTwin(
        s('Summit 2026 Retrospective', '2027-04-27T00:00:00.000Z', 'devevents'),
        s('Summit Retrospective', '2027-04-27T04:30:00Z', 'company')
      )
    ).toBe(false);
  });

  it('does not treat a non-date-only source at 00:00Z as date-only', () => {
    // A real 05:30 IST start from Meetup is precise; the ±1 day window must not open for it.
    expect(
      isNearTwin(
        s('Sunrise Run Club', '2026-10-10T00:00:00.000Z', 'meetup'),
        s('Sunrise Run Club', '2026-10-11T00:30:00Z', 'luma')
      )
    ).toBe(false);
  });

  it('never matches on a title that is nothing but the year', () => {
    expect(
      isNearTwin(
        s('2026', '2026-10-10T00:00:00.000Z', 'devevents'),
        s('2026', '2026-10-10T04:30:00Z', 'meetup')
      )
    ).toBe(false);
  });

  it('never matches on a leftover too short to be an identity ("AI 2026" -> "ai")', () => {
    expect(
      isNearTwin(
        s('AI 2026', '2026-10-10T00:00:00.000Z', 'devevents'),
        s('AI', '2026-10-10T04:30:00Z', 'meetup')
      )
    ).toBe(false);
  });
});

describe('matchTitle / isDateOnlyStart', () => {
  it('folds the GIDS titles to one comparison string', () => {
    expect(matchTitle(GIDS_COMPANY.title, GIDS_COMPANY.startDateTime)).toBe(
      'great international developer summit gids'
    );
    expect(matchTitle(GIDS_DEVEVENTS.title, GIDS_DEVEVENTS.startDateTime)).toBe(
      'great international developer summit gids'
    );
  });

  it('is date-only only for a date-only source AT UTC midnight', () => {
    expect(isDateOnlyStart('devevents', at('2027-04-27T00:00:00.000Z'))).toBe(true);
    expect(isDateOnlyStart('devevents', at('2027-04-27T04:30:00.000Z'))).toBe(false);
    expect(isDateOnlyStart('meetup', at('2027-04-27T00:00:00.000Z'))).toBe(false);
  });
});

describe('pickNearTwin', () => {
  it('prefers the same IST day over an adjacent one', () => {
    const incoming = s('droidCon India', '2026-11-20T00:00:00.000Z', 'devevents');
    // 23:30 IST on the 19th — CLOSER in milliseconds than the same-day candidate, so this only
    // passes if the day rank really outranks raw distance.
    const dayBefore = s('droidCon India', '2026-11-19T18:00:00Z', 'meetup');
    const sameDay = s('droidCon India', '2026-11-20T12:30:00Z', 'luma');
    expect(pickNearTwin(incoming, [dayBefore, sameDay])).toBe(sameDay);
  });

  it('returns undefined when nothing qualifies', () => {
    expect(pickNearTwin(GIDS_DEVEVENTS, [{ ...GIDS_COMPANY, city: 'Pune' }])).toBeUndefined();
  });
});

describe('preciseTimingUpgrade', () => {
  it('adopts a precise start on the same IST day over a date-only one', () => {
    const existing = { source: 'devevents', startDateTime: at('2026-11-20T00:00:00.000Z') };
    const incoming = {
      source: 'meetup',
      startDateTime: at('2026-11-20T03:30:00Z'),
      endDateTime: at('2026-11-20T12:30:00Z'),
    };
    expect(preciseTimingUpgrade(existing, incoming)).toEqual({
      startDateTime: incoming.startDateTime,
      endDateTime: incoming.endDateTime,
    });
  });

  it('never moves the day — GIDS keeps the 27th its organiser page states', () => {
    expect(preciseTimingUpgrade(GIDS_DEVEVENTS, GIDS_COMPANY)).toBeNull();
  });

  it('never downgrades a precise start to a date-only one', () => {
    expect(
      preciseTimingUpgrade(
        { source: 'meetup', startDateTime: at('2026-11-20T03:30:00Z') },
        { source: 'devevents', startDateTime: at('2026-11-20T00:00:00.000Z') }
      )
    ).toBeNull();
  });

  it('treats two date-only sightings as no upgrade at all', () => {
    expect(
      preciseTimingUpgrade(
        { source: 'devevents', startDateTime: at('2026-11-20T00:00:00.000Z') },
        { source: 'devevents', startDateTime: at('2026-11-20T00:00:00.000Z') }
      )
    ).toBeNull();
  });

  it('does not re-upgrade a devevents row whose time was already made precise', () => {
    expect(
      preciseTimingUpgrade(
        { source: 'devevents', startDateTime: at('2026-11-20T03:30:00Z') },
        { source: 'luma', startDateTime: at('2026-11-20T08:30:00Z') }
      )
    ).toBeNull();
  });
});

describe('JSON-LD zoneless date-times are IST, not the runner\'s zone', () => {
  // Run as the daily cron does — on a UTC GitHub runner. On a laptop in IST the bug is invisible,
  // because the process zone happens to be the right one; that is how it shipped.
  const previousTZ = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'UTC';
  });
  afterAll(() => {
    if (previousTZ === undefined) delete process.env.TZ;
    else process.env.TZ = previousTZ;
  });

  const node = (startDate: string, endDate?: string) =>
    eventNodeToRawEvent(
      { '@type': 'Event', name: 'GIDS', startDate, ...(endDate ? { endDate } : {}) },
      { baseUrl: 'https://developersummit.com/', source: 'company' }
    );

  it('pins developersummit.com\'s "2027-04-26 10:00:00" to 10:00 IST', () => {
    const raw = node('2027-04-26 10:00:00', '2027-04-29 20:00:00');
    expect(raw?.startDateTime?.toISOString()).toBe('2027-04-26T04:30:00.000Z');
    expect(raw?.endDateTime?.toISOString()).toBe('2027-04-29T14:30:00.000Z');
  });

  it('pins the T-separated and minute-precision forms too', () => {
    expect(node('2027-04-26T10:00')?.startDateTime?.toISOString()).toBe('2027-04-26T04:30:00.000Z');
  });

  it('leaves values with an explicit zone exactly as they were', () => {
    expect(node('2027-04-26T10:00:00Z')?.startDateTime?.toISOString()).toBe('2027-04-26T10:00:00.000Z');
    expect(node('2027-04-26T10:00:00+01:00')?.startDateTime?.toISOString()).toBe(
      '2027-04-26T09:00:00.000Z'
    );
  });
});
