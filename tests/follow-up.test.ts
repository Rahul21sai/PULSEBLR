/**
 * Follow-up dates, and the bulk-edit request contract.
 *
 * THE DECISIVE CASES ARE THE ONES WHERE THE STORED INSTANT COULD LAND ON THE WRONG IST DAY. That is
 * the whole reason `lib/scan/follow-up.ts` exists: `<input type="date">` hands over `YYYY-MM-DD`,
 * Mongoose casts it to UTC midnight, and UTC midnight is 05:30 IST — inside the right day, but only
 * just, so any later re-reading in another zone reports the day before. A reminder set for 1 April
 * surfacing as 31 March is not an error anything catches; it is simply wrong on screen.
 *
 * So these tests pin two properties rather than a formatting:
 *
 *   1. THE IST DAY IS PRESERVED. For every day handed in, `dayKeyIST` of the stored instant is that
 *      same day — checked at both ends of a month, both ends of a year, and across a leap day.
 *   2. THE INSTANT IS FAR FROM BOTH MIDNIGHTS. Noon IST leaves twelve hours of clearance either
 *      side, which is what makes property 1 robust rather than lucky. UTC midnight leaves 5½.
 *
 * `nowMs` is injected everywhere, so nothing here depends on when it runs. And nothing depends on
 * the MACHINE's timezone either, which is the point of pinning to a fixed +05:30 instead of building
 * a Date from the input text — a suite that only passes on a laptop set to IST would be worse than
 * no suite, because it would pass in Bengaluru and fail on a US-hosted runner.
 */
import { describe, it, expect } from 'vitest';
import { dayKeyIST } from '@/lib/format';
import {
  MAX_BULK_CONTACTS,
  MAX_BULK_TAGS,
  dayOffsetIST,
  followUpDayIST,
  followUpInstantForDay,
  followUpInstantInDays,
  todayDayIST,
  validateContactBulk,
} from '@/lib/scan/follow-up';

/** 10 Sept 2026, 04:00 IST — well before noon, so "today" is not clamped unless a test wants it. */
const EARLY_MORNING = Date.parse('2026-09-09T22:30:00.000Z');
/** 10 Sept 2026, 17:00 IST — after noon, which is the realistic moment somebody files their scans. */
const AFTERNOON = Date.parse('2026-09-10T11:30:00.000Z');
/**
 * Before every day named below, so the "is this day still ahead" branch never fires and the
 * assertions are about the IST-day property alone. Getting this wrong is instructive: with `now` in
 * September, `2026-04-01` is simply a past day and the function correctly returns null — which reads
 * as a conversion bug and is not one.
 */
const LONG_BEFORE = Date.parse('2025-01-01T00:00:00.000Z');

const MS_PER_HOUR = 3_600_000;

/** Hours between the stored instant and the two IST midnights bounding its day. */
function clearanceHours(iso: string): { fromStart: number; toEnd: number } {
  const day = dayKeyIST(iso);
  // A fixed +05:30, matching the module under test. India has had no DST since 1945.
  const startOfDay = Date.parse(`${day}T00:00:00+05:30`);
  const at = Date.parse(iso);
  return {
    fromStart: (at - startOfDay) / MS_PER_HOUR,
    toEnd: (startOfDay + 24 * MS_PER_HOUR - at) / MS_PER_HOUR,
  };
}

describe('followUpInstantForDay: the IST day survives the round trip', () => {
  it('stores noon IST, which is 06:30Z', () => {
    expect(followUpInstantForDay('2026-09-20', EARLY_MORNING)).toBe('2026-09-20T06:30:00.000Z');
  });

  it('keeps a date entered on the 1st ON the 1st — never the 31st', () => {
    // The named boundary case. UTC midnight for 1 April is 05:30 IST on the 1st, which is correct
    // and fragile: subtract six hours anywhere downstream and it is 31 March. Noon has no such edge.
    const iso = followUpInstantForDay('2026-04-01', LONG_BEFORE);
    expect(iso).not.toBeNull();
    expect(dayKeyIST(iso as string)).toBe('2026-04-01');
    expect(dayKeyIST(iso as string)).not.toBe('2026-03-31');
  });

  it('leaves at least six hours of clearance from BOTH IST midnights', () => {
    // Property 2. This is what makes the day stable rather than accidentally correct, and it is the
    // assertion that would fail if someone "simplified" noon back to `new Date(day)`.
    for (const day of ['2026-01-01', '2026-04-01', '2026-06-15', '2026-12-31']) {
      const iso = followUpInstantForDay(day, LONG_BEFORE) as string;
      const { fromStart, toEnd } = clearanceHours(iso);
      expect(fromStart).toBeGreaterThanOrEqual(6);
      expect(toEnd).toBeGreaterThanOrEqual(6);
    }
    // Stated as the contrast, so the number above is not mistaken for arbitrary: the naive cast has
    // only 5.5 hours of clearance at the start of the day.
    expect(clearanceHours('2026-04-01T00:00:00.000Z').fromStart).toBeCloseTo(5.5, 5);
  });

  it('holds across month, year and leap-day boundaries', () => {
    for (const day of ['2026-01-31', '2026-02-28', '2026-03-01', '2026-12-31', '2028-02-29']) {
      const iso = followUpInstantForDay(day, LONG_BEFORE) as string;
      expect(iso).not.toBeNull();
      expect(dayKeyIST(iso)).toBe(day);
    }
  });

  it('refuses an impossible date instead of rolling it into the next month', () => {
    // `Date.UTC(2026, 1, 30)` silently becomes 2 March. Without the day-key check inside the
    // module, a malformed body would store a reminder on a day nobody named.
    expect(followUpInstantForDay('2026-02-30', LONG_BEFORE)).toBeNull();
    expect(followUpInstantForDay('2026-13-01', LONG_BEFORE)).toBeNull();
    expect(followUpInstantForDay('2026-04-31', LONG_BEFORE)).toBeNull();
  });

  it('refuses anything that is not a day key, rather than guessing', () => {
    expect(followUpInstantForDay('', EARLY_MORNING)).toBeNull();
    expect(followUpInstantForDay('01/04/2026', EARLY_MORNING)).toBeNull();
    expect(followUpInstantForDay('2026-04-01T09:00', EARLY_MORNING)).toBeNull();
    expect(followUpInstantForDay(null, EARLY_MORNING)).toBeNull();
    expect(followUpInstantForDay(20260401, EARLY_MORNING)).toBeNull();
  });
});

describe('followUpInstantForDay: "today" is never already overdue', () => {
  it('uses noon when noon is still ahead', () => {
    const iso = followUpInstantForDay('2026-09-10', EARLY_MORNING) as string;
    expect(iso).toBe('2026-09-10T06:30:00.000Z');
    expect(Date.parse(iso)).toBeGreaterThan(EARLY_MORNING);
  });

  it('clamps to the end of the IST day once noon has gone', () => {
    // The named boundary case. At 17:00 IST, storing noon would file the reminder as overdue at the
    // instant it was created — so a picker offering "today" would look broken the moment it worked.
    const iso = followUpInstantForDay('2026-09-10', AFTERNOON) as string;
    expect(Date.parse(iso)).toBeGreaterThan(AFTERNOON);
    // Still TODAY. Pushing it to tomorrow would silently answer a different question.
    expect(dayKeyIST(iso)).toBe('2026-09-10');
    expect(iso).toBe('2026-09-10T18:29:00.000Z'); // 23:59 IST
  });

  it('refuses a day that has already finished', () => {
    expect(followUpInstantForDay('2026-09-09', AFTERNOON)).toBeNull();
    expect(followUpInstantForDay('2020-01-01', AFTERNOON)).toBeNull();
  });

  it('is never overdue for today, at any hour of the IST day', () => {
    // Swept rather than sampled: the branch changes at noon and again at 23:59, and a single
    // mid-afternoon case would not notice either edge moving.
    for (let hour = 0; hour < 24; hour++) {
      const now = Date.parse(`2026-09-10T${String(hour).padStart(2, '0')}:00:00+05:30`);
      const iso = followUpInstantForDay(todayDayIST(now), now);
      expect(iso).not.toBeNull();
      expect(Date.parse(iso as string)).toBeGreaterThan(now);
      expect(dayKeyIST(iso as string)).toBe('2026-09-10');
    }
  });
});

describe('dayOffsetIST and the presets: IST days, not browser days', () => {
  it('counts calendar days in IST', () => {
    expect(todayDayIST(AFTERNOON)).toBe('2026-09-10');
    expect(dayOffsetIST(1, AFTERNOON)).toBe('2026-09-11');
    expect(dayOffsetIST(3, AFTERNOON)).toBe('2026-09-13');
    expect(dayOffsetIST(7, AFTERNOON)).toBe('2026-09-17');
  });

  it('uses the IST day even when UTC is still on the previous one', () => {
    // 19:00Z on the 10th is 00:30 IST on the 11th. Reading the browser's date on a UTC machine — what
    // the version this replaces did — would call the 11th "today" and book "tomorrow" for the 11th,
    // i.e. today.
    const justAfterISTMidnight = Date.parse('2026-09-10T19:00:00.000Z');
    expect(todayDayIST(justAfterISTMidnight)).toBe('2026-09-11');
    expect(dayOffsetIST(1, justAfterISTMidnight)).toBe('2026-09-12');
  });

  it('rolls over months and years', () => {
    expect(dayOffsetIST(3, Date.parse('2026-03-31T06:00:00+05:30'))).toBe('2026-04-03');
    expect(dayOffsetIST(7, Date.parse('2026-12-30T06:00:00+05:30'))).toBe('2027-01-06');
    expect(dayOffsetIST(3, Date.parse('2028-02-27T06:00:00+05:30'))).toBe('2028-03-01');
  });

  it('gives every preset an instant on the day it names, in the future', () => {
    for (const days of [1, 3, 7]) {
      const iso = followUpInstantInDays(days, AFTERNOON) as string;
      expect(iso).not.toBeNull();
      expect(dayKeyIST(iso)).toBe(dayOffsetIST(days, AFTERNOON));
      expect(Date.parse(iso)).toBeGreaterThan(AFTERNOON);
    }
  });
});

describe('followUpDayIST: filling the input back in', () => {
  it('reads the IST day, not the UTC day', () => {
    // 21:00 IST on the 20th is 15:30Z the same day — but 23:00 IST is 17:30Z, and a late evening
    // reminder crossing midnight UTC is what broke the old prefix comparison.
        expect(followUpDayIST('2026-09-20T06:30:00.000Z')).toBe('2026-09-20');
    expect(followUpDayIST('2026-09-20T18:29:00.000Z')).toBe('2026-09-20');
    // 20:00Z is 01:30 IST the NEXT day. A string-prefix comparison would say the 20th.
    expect(followUpDayIST('2026-09-20T20:00:00.000Z')).toBe('2026-09-21');
  });

  it('round-trips a picked day', () => {
    for (const day of ['2026-09-11', '2026-12-31', '2027-01-01', '2028-02-29']) {
      const iso = followUpInstantForDay(day, EARLY_MORNING) as string;
      expect(followUpDayIST(iso)).toBe(day);
    }
  });

  it('is empty for no reminder, so a cleared field shows as cleared', () => {
    expect(followUpDayIST(null)).toBe('');
    expect(followUpDayIST(undefined)).toBe('');
    expect(followUpDayIST('')).toBe('');
    expect(followUpDayIST('not a date')).toBe('');
  });

  it('accepts a Date as well as a string', () => {
    expect(followUpDayIST(new Date('2026-09-20T06:30:00.000Z'))).toBe('2026-09-20');
  });
});

/* ────────────────────────────── the bulk contract ────────────────────────────── */

const ID_A = 'a'.repeat(24);
const ID_B = 'b'.repeat(24);

describe('validateContactBulk: ids', () => {
  it('accepts a tag request and dedupes the ids', () => {
    const result = validateContactBulk(
      { action: 'tag', contactIds: [ID_A, ID_B, ID_A], add: ['Razorpay'] },
      EARLY_MORNING
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.contactIds).toEqual([ID_A, ID_B]);
  });

  it('REFUSES a malformed id rather than skipping it', () => {
    // Skipping would answer 200 for a request that changed fewer people than it named, and the
    // caller would have no way to tell which.
    const result = validateContactBulk(
      { action: 'tag', contactIds: [ID_A, 'nope'], add: ['x'] },
      EARLY_MORNING
    );
    expect(result).toMatchObject({ ok: false, field: 'contactIds' });
  });

  it('refuses an empty selection and an oversized batch', () => {
    expect(validateContactBulk({ action: 'tag', contactIds: [], add: ['x'] })).toMatchObject({
      ok: false,
      field: 'contactIds',
    });
    const many = Array.from({ length: MAX_BULK_CONTACTS + 1 }, (_, i) =>
      String(i).padStart(24, '0')
    );
    expect(validateContactBulk({ action: 'tag', contactIds: many, add: ['x'] })).toMatchObject({
      ok: false,
      field: 'contactIds',
    });
  });

  it('refuses a body that is not an object', () => {
    for (const input of [null, undefined, 'x', 42, [ID_A]]) {
      expect(validateContactBulk(input)).toMatchObject({ ok: false });
    }
  });

  it('names the action as the problem when it is unknown', () => {
    expect(validateContactBulk({ action: 'delete', contactIds: [ID_A] })).toMatchObject({
      ok: false,
      field: 'action',
    });
    expect(validateContactBulk({ contactIds: [ID_A] })).toMatchObject({ ok: false, field: 'action' });
  });
});

describe('validateContactBulk: tag', () => {
  it('carries tags through UNCHANGED — canonicalisation is the route’s job', () => {
    // Deliberate: a second lowercaser is how "AI/ML" and "ai/ml" become two chips for one idea.
    const result = validateContactBulk(
      { action: 'tag', contactIds: [ID_A], add: ['AI/ML'], remove: ['  Old  '] },
      EARLY_MORNING
    );
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.action !== 'tag') return;
    expect(result.value.add).toEqual(['AI/ML']);
    expect(result.value.remove).toEqual(['Old']);
  });

  it('drops blank tags but refuses a request that would change nothing', () => {
    expect(
      validateContactBulk({ action: 'tag', contactIds: [ID_A], add: ['', '  '] })
    ).toMatchObject({ ok: false, field: 'add' });
    expect(validateContactBulk({ action: 'tag', contactIds: [ID_A] })).toMatchObject({
      ok: false,
      field: 'add',
    });
  });

  it('refuses a non-string tag, an over-long one, and too many', () => {
    expect(
      validateContactBulk({ action: 'tag', contactIds: [ID_A], add: [42] })
    ).toMatchObject({ ok: false, field: 'add' });
    expect(
      validateContactBulk({ action: 'tag', contactIds: [ID_A], add: ['x'.repeat(41)] })
    ).toMatchObject({ ok: false, field: 'add' });
    expect(
      validateContactBulk({
        action: 'tag',
        contactIds: [ID_A],
        remove: Array.from({ length: MAX_BULK_TAGS + 1 }, (_, i) => `t${i}`),
      })
    ).toMatchObject({ ok: false, field: 'remove' });
  });
});

describe('validateContactBulk: followUp', () => {
  it('resolves the day to noon IST, so the SERVER owns the conversion', () => {
    // The point of doing it here: a client sending the raw `YYYY-MM-DD`, or an old build replaying a
    // queued body, cannot store 05:30 IST.
    const result = validateContactBulk(
      { action: 'followUp', contactIds: [ID_A], day: '2026-09-20' },
      EARLY_MORNING
    );
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.action !== 'followUp') return;
    expect(result.value.followUpAt).toBe('2026-09-20T06:30:00.000Z');
  });

  it('accepts an explicit null to clear the reminder', () => {
    const result = validateContactBulk(
      { action: 'followUp', contactIds: [ID_A], day: null },
      EARLY_MORNING
    );
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.action !== 'followUp') return;
    expect(result.value.followUpAt).toBeNull();
  });

  it('refuses a MISSING day, so forty reminders cannot be cleared by omission', () => {
    expect(validateContactBulk({ action: 'followUp', contactIds: [ID_A] })).toMatchObject({
      ok: false,
      field: 'day',
    });
  });

  it('refuses a past day and an impossible one', () => {
    expect(
      validateContactBulk({ action: 'followUp', contactIds: [ID_A], day: '2026-09-09' }, AFTERNOON)
    ).toMatchObject({ ok: false, field: 'day' });
    expect(
      validateContactBulk({ action: 'followUp', contactIds: [ID_A], day: '2026-02-30' }, AFTERNOON)
    ).toMatchObject({ ok: false, field: 'day' });
  });

  it('accepts TODAY in the afternoon, and the instant it resolves to is still ahead', () => {
    const result = validateContactBulk(
      { action: 'followUp', contactIds: [ID_A], day: '2026-09-10' },
      AFTERNOON
    );
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.action !== 'followUp') return;
    expect(Date.parse(result.value.followUpAt as string)).toBeGreaterThan(AFTERNOON);
  });
});

describe('validateContactBulk: move', () => {
  it('requires a folder id', () => {
    const result = validateContactBulk(
      { action: 'move', contactIds: [ID_A], folderId: ID_B },
      EARLY_MORNING
    );
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.action !== 'move') return;
    expect(result.value.folderId).toBe(ID_B);
  });

  it('refuses a missing or malformed folder id', () => {
    for (const folderId of [undefined, null, '', 'not-an-id', 123]) {
      expect(
        validateContactBulk({ action: 'move', contactIds: [ID_A], folderId })
      ).toMatchObject({ ok: false, field: 'folderId' });
    }
  });
});

describe('prototype pollution', () => {
  it('reads own properties only', () => {
    // The input is a parsed request body. A payload carrying `action` on the prototype must not be
    // able to smuggle a verdict past the switch.
    const hostile = Object.create({ action: 'tag', contactIds: [ID_A], add: ['x'] });
    expect(validateContactBulk(hostile)).toMatchObject({ ok: false });
  });
});
