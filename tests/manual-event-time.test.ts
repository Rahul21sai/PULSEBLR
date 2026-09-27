import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseEventDateTime, toFormDateTime, validateManualEvent } from '@/lib/events/manual-input';
import { fromISTInputValue } from '@/lib/ist-datetime-input';

/**
 * THE BUG THIS PINS: a 19:00 event added by hand was stored at 00:30 THE NEXT DAY in production.
 *
 * `<input type="datetime-local">` holds zone-less wall-clock text (`2026-10-01T19:00`). The form
 * posted it as-is and `validateManualEvent` parsed it with `new Date(raw)`, which ECMAScript reads in
 * the zone of the machine doing the parsing. Vercel functions run in UTC, so 19:00 became 19:00Z,
 * which is 00:30 IST on 2 October.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE CHANGES THE PROCESS TIMEZONE, and why that is the whole point of it.
 *
 * The development machine is IN IST. There, `new Date('2026-10-01T19:00')` happens to be exactly
 * the right instant, so a test that simply asserts `13:30Z` passes against the BROKEN code — it
 * would have gone green for the entire life of the bug. The defect only exists when the parsing
 * machine is somewhere else, so the assertions run with the process clock forced into four zones
 * that a naive parse gets wrong in different directions (behind, far ahead, on the dateline) plus
 * IST itself as the control.
 *
 * Node honours an assignment to `process.env.TZ` at runtime and resets V8's zone cache (measured on
 * this Windows machine with Node 22). Deleting the variable does NOT reset it, so the original zone
 * is restored by assignment. The first case in every block is a GUARD proving the zone really took
 * effect — without it, a runtime that ignored the assignment would quietly turn every case below
 * back into the IST-only test the broken code passes.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * The second half is the IMPORT ROUND TRIP. `/api/scrape-url` emitted `toISOString().slice(0, 16)`
 * — UTC wall-clock text — and on the UTC server that error cancelled the validator's, so imported
 * events came out right by accident. The two had to change together; these cases prove the pair is
 * lossless: instant → import text → validator → the same instant, in every zone.
 */

const ORIGINAL_ZONE = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

afterEach(() => {
  process.env.TZ = ORIGINAL_ZONE;
});

/** Minutes EAST of UTC on 1 October 2026 — Los Angeles is on daylight time then. */
const OFFSET_EAST: Record<string, number> = {
  UTC: 0,
  'America/Los_Angeles': -7 * 60,
  'Pacific/Kiritimati': 14 * 60,
  'Asia/Kolkata': 5 * 60 + 30,
};

/** What the OLD parser, `new Date('2026-10-01T19:00')`, produced in each zone. Only IST is right. */
const NAIVE_19_00: Record<string, string> = {
  UTC: '2026-10-01T19:00:00.000Z',
  'America/Los_Angeles': '2026-10-02T02:00:00.000Z',
  'Pacific/Kiritimati': '2026-10-01T05:00:00.000Z',
  'Asia/Kolkata': '2026-10-01T13:30:00.000Z',
};

const ZONES = Object.keys(OFFSET_EAST);

/** 19:00 IST on 1 October 2026, as a stored instant. */
const SEVEN_PM_IST = '2026-10-01T13:30:00.000Z';

const BASE = { title: 'Platform Hack Night' };

const startOf = (startDateTime: unknown) =>
  validateManualEvent({ ...BASE, startDateTime }).fields?.startDateTime.toISOString();

describe.each(ZONES)('with the server clock in %s', zone => {
  beforeEach(() => {
    process.env.TZ = zone;
  });

  it('GUARD: the zone is really in force, and a naive parse really is wrong here', () => {
    // `0 -` rather than unary minus: in UTC the offset is 0, and `-0` fails `toBe(0)` (Object.is).
    expect(0 - new Date('2026-10-01T12:00:00Z').getTimezoneOffset()).toBe(OFFSET_EAST[zone]);
    // This is the bug, reproduced: in every zone but IST the old parser misses 13:30Z.
    expect(new Date('2026-10-01T19:00').toISOString()).toBe(NAIVE_19_00[zone]);
  });

  it('reads a zone-less datetime-local value as IST wall-clock', () => {
    expect(startOf('2026-10-01T19:00')).toBe(SEVEN_PM_IST);
    expect(startOf('2026-10-01T19:00:30')).toBe('2026-10-01T13:30:30.000Z');
  });

  it('keeps the IST calendar day when UTC is still on the previous one', () => {
    // 02:00 IST on 1 October is 20:30Z on 30 September. `clusterKey` is built from the IST day, so
    // getting this wrong would not just shift the event — it would change its dedup identity.
    expect(startOf('2026-10-01T02:00')).toBe('2026-09-30T20:30:00.000Z');
  });

  it('takes an explicit zone or offset as exactly that instant', () => {
    expect(startOf('2026-10-01T19:00:00+05:30')).toBe(SEVEN_PM_IST);
    expect(startOf('2026-10-01T19:00+0530')).toBe(SEVEN_PM_IST);
    expect(startOf('2026-10-01T13:30:00.000Z')).toBe(SEVEN_PM_IST);
    expect(startOf('2026-10-01T15:30:00+02:00')).toBe(SEVEN_PM_IST);
    expect(startOf(new Date(SEVEN_PM_IST))).toBe(SEVEN_PM_IST);
  });

  it('reads END and REGISTRATION DEADLINE by the same rule as start', () => {
    const { fields, issues } = validateManualEvent({
      ...BASE,
      startDateTime: '2026-10-01T19:00',
      endDateTime: '2026-10-01T21:30',
      registrationDeadline: '2026-09-30T18:00',
    });
    expect(issues).toEqual([]);
    expect(fields?.endDateTime?.toISOString()).toBe('2026-10-01T16:00:00.000Z');
    expect(fields?.registrationDeadline?.toISOString()).toBe('2026-09-30T12:30:00.000Z');
  });

  it('agrees with what the form now sends: fromISTInputValue(text)', () => {
    // The page converts before posting; a PWA still running an older bundle posts the raw text.
    // Both must land on the same instant.
    expect(startOf(fromISTInputValue('2026-10-01T19:00'))).toBe(SEVEN_PM_IST);
    expect(startOf('2026-10-01T19:00')).toBe(startOf(fromISTInputValue('2026-10-01T19:00')));
  });

  it('IMPORT ROUND TRIP: instant → import text → validator → the same instant', () => {
    // Every shape a real event page publishes the same moment in: Meetup / Eventbrite style
    // offsets, Luma's UTC `Z`, a colon-less offset, and a zone-less value (read as IST).
    for (const published of [
      '2026-10-01T19:00:00+05:30',
      '2026-10-01T13:30:00.000Z',
      '2026-10-01T19:00:00.000+0530',
      '2026-10-01T19:00:00',
    ]) {
      const text = toFormDateTime(published);
      // What the datetime-local input shows: Bengaluru wall-clock, not UTC.
      expect(text).toBe('2026-10-01T19:00');
      // Posted raw (older client) and converted (current client): both reach the same instant.
      expect(startOf(text)).toBe(SEVEN_PM_IST);
      expect(startOf(fromISTInputValue(text!))).toBe(SEVEN_PM_IST);
    }
  });

  it('shows an import across the IST date line on the IST day', () => {
    // 20:30Z on 30 September is 02:00 IST on 1 October. The old `toISOString().slice(0, 16)`
    // showed "2026-09-30T20:30" — the wrong day in the form, before anyone saved anything.
    expect(toFormDateTime('2026-09-30T20:30:00Z')).toBe('2026-10-01T02:00');
    expect(startOf(toFormDateTime('2026-09-30T20:30:00Z'))).toBe('2026-09-30T20:30:00.000Z');
  });
});

describe('parseEventDateTime — refuses what it cannot read unambiguously', () => {
  it.each([
    // A date alone is UTC midnight to V8 (05:30 IST) — an invented time.
    ['a date with no time', '2026-10-01'],
    // V8's legacy parser reads this in the MACHINE zone: the original bug, one spelling over.
    ['a slash-separated date', '2026/10/01 19:00'],
    ['prose', 'next tuesday'],
    // V8 and Date.UTC both ROLL these over instead of failing (30 Feb → 2 Mar).
    ['30 February', '2026-02-30T10:00'],
    ['hour 24', '2026-10-01T24:00'],
    ['minute 60', '2026-10-01T19:60'],
    ['second 60', '2026-10-01T19:00:60'],
    ['month 13', '2026-13-01T10:00'],
    // Date.UTC maps years 0-99 onto 1900-1999.
    ['a two-digit year padded to four', '0026-10-01T10:00'],
    ['an offset past 23 hours', '2026-10-01T10:00:00+25:00'],
    ['a five-digit year', '20266-10-01T10:00'],
  ])('%s', (_label, value) => {
    expect(parseEventDateTime(value)).toBeUndefined();
    expect(validateManualEvent({ ...BASE, startDateTime: value }).issues.map(i => i.field)).toContain(
      'startDateTime'
    );
  });

  it('refuses non-strings and an Invalid Date', () => {
    for (const value of [1759325400000, true, {}, [], new Date('nope')]) {
      expect(parseEventDateTime(value)).toBeUndefined();
    }
  });

  it('accepts the separators and letter case the standards allow', () => {
    // HTML `<time datetime>` permits a space; RFC 3339 permits lowercase t and z.
    expect(parseEventDateTime('2026-10-01 19:00')?.toISOString()).toBe(SEVEN_PM_IST);
    expect(parseEventDateTime('2026-10-01t13:30:00z')?.toISOString()).toBe(SEVEN_PM_IST);
  });

  it('keeps sub-second precision on an explicit instant, and copies a Date rather than aliasing it', () => {
    expect(parseEventDateTime('2026-10-01T13:30:00.123456Z')?.toISOString()).toBe('2026-10-01T13:30:00.123Z');
    const original = new Date(SEVEN_PM_IST);
    const parsed = parseEventDateTime(original);
    expect(parsed?.toISOString()).toBe(SEVEN_PM_IST);
    expect(parsed).not.toBe(original);
  });
});

describe('toFormDateTime — what the importer hands the form', () => {
  it('declines a date with no time instead of inventing midnight', () => {
    expect(toFormDateTime('2026-11-12')).toBeUndefined();
  });

  it('declines anything unreadable', () => {
    for (const value of [undefined, null, '', 'TBA', 42, { '@value': '2026-10-01' }]) {
      expect(toFormDateTime(value)).toBeUndefined();
    }
  });
});

describe('registrationDeadline — persisted, and bounded by the event', () => {
  const START = '2026-10-01T19:00:00+05:30';
  const END = '2026-10-03T18:00:00+05:30';

  const deadline = (extra: Record<string, unknown>) => validateManualEvent({ ...BASE, startDateTime: START, ...extra });

  it('is stored — it used to be dropped by the allowlist with a 201', () => {
    const { fields } = deadline({ registrationDeadline: '2026-09-28T23:59:00+05:30' });
    expect(fields?.registrationDeadline?.toISOString()).toBe('2026-09-28T18:29:00.000Z');
  });

  it('may fall DURING a multi-day event, up to and including its end', () => {
    // On-site registration on day 2 of a three-day conference is a fact, not a typo.
    expect(deadline({ endDateTime: END, registrationDeadline: '2026-10-02T10:00:00+05:30' }).issues).toEqual([]);
    expect(deadline({ endDateTime: END, registrationDeadline: END }).fields?.registrationDeadline?.toISOString()).toBe(
      '2026-10-03T12:30:00.000Z'
    );
  });

  it('is refused AFTER the end, naming the field', () => {
    const result = deadline({ endDateTime: END, registrationDeadline: '2026-10-03T18:01:00+05:30' });
    expect(result.fields).toBeUndefined();
    expect(result.issues).toEqual([
      { field: 'registrationDeadline', message: 'Registration cannot close after the event ends.' },
    ]);
  });

  it('is refused after the START when there is no end — the start is the latest moment known', () => {
    const result = deadline({ registrationDeadline: '2026-10-01T19:01:00+05:30' });
    expect(result.fields).toBeUndefined();
    expect(result.issues.map(i => i.field)).toEqual(['registrationDeadline']);
    expect(result.issues[0].message).toContain('Add an end time');
    // Exactly at the start is fine.
    expect(deadline({ registrationDeadline: START }).issues).toEqual([]);
  });

  it('accepts a deadline that has already passed — "registration has closed" is information', () => {
    expect(deadline({ registrationDeadline: '2020-01-01T10:00:00Z' }).fields?.registrationDeadline?.toISOString()).toBe(
      '2020-01-01T10:00:00.000Z'
    );
  });

  it('treats blank as absent and garbage as a named 400', () => {
    for (const blank of ['', '   ', null, undefined]) {
      const result = deadline({ registrationDeadline: blank });
      expect(result.issues).toEqual([]);
      expect(result.fields).not.toHaveProperty('registrationDeadline');
    }
    expect(deadline({ registrationDeadline: 'soon' }).issues.map(i => i.field)).toEqual(['registrationDeadline']);
  });
});
