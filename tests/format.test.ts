import { describe, it, expect } from 'vitest';
import { dayKeyIST, istDaysSpanned } from '@/lib/format';

/**
 * `istDaysSpanned` decides whether the time rail prints an end time or a `+Nd` badge, so getting
 * it wrong shows a multi-day event as ending before it began. It is pinned here rather than left
 * to the browser check that found the bug, because the failure is silent: a wrong 0 renders a
 * plausible-looking end time and nothing throws.
 *
 * Every case below is expressed in UTC and reasoned about in IST (UTC+5:30), because that offset
 * is the whole point — see the second block.
 */
describe('istDaysSpanned', () => {
  it('is 0 for an event that starts and ends on the same IST day', () => {
    // 09:30 → 19:30 IST on 15 Aug.
    expect(istDaysSpanned('2026-08-15T04:00:00Z', '2026-08-15T14:00:00Z')).toBe(0);
  });

  it('is 0 when start and end are identical', () => {
    expect(istDaysSpanned('2026-08-15T04:00:00Z', '2026-08-15T04:00:00Z')).toBe(0);
  });

  it('never returns a negative span when the end precedes the start', () => {
    // Real corpus data does contain reversed ranges. A negative would render as "+-1d".
    expect(istDaysSpanned('2026-08-15T14:00:00Z', '2026-08-15T04:00:00Z')).toBe(0);
  });

  it('accepts Date objects as well as ISO strings', () => {
    expect(
      istDaysSpanned(new Date('2026-08-15T04:00:00Z'), new Date('2026-08-17T04:00:00Z'))
    ).toBe(2);
  });

  /**
   * THE REASON THIS IS DERIVED FROM `dayKeyIST` AND NOT FROM A MILLISECOND SUBTRACTION.
   *
   * Both timestamps below are the same UTC day, so any UTC-based or duration-based calculation
   * answers 0. In IST they straddle midnight, and the reader needs to be told the end is
   * tomorrow. CLAUDE.md's rule — never format an event time with the ambient locale, because a
   * server in UTC puts a 9 PM IST event on the wrong day — applies to spans too.
   */
  it('counts an IST day boundary that is NOT a UTC day boundary', () => {
    const start = '2026-08-15T16:00:00Z'; // 21:30 IST, 15 Aug
    const end = '2026-08-15T19:30:00Z'; // 01:00 IST, 16 Aug — same UTC day
    expect(dayKeyIST(start)).toBe('2026-08-15');
    expect(dayKeyIST(end)).toBe('2026-08-16');
    expect(istDaysSpanned(start, end)).toBe(1);
  });

  it('measures calendar days, not elapsed hours', () => {
    // Two hours long, but it ends on the next IST day, which is what the badge reports.
    expect(istDaysSpanned('2026-08-15T17:00:00Z', '2026-08-15T19:00:00Z')).toBe(1);
  });

  /**
   * The case that made the bug visible. Conference sources publish DATE-ONLY values, which parse
   * as UTC midnight = 05:30 IST — so a three-day summit rendered "05:30 / 05:30", identical start
   * and end, reading as a data error rather than a long event.
   */
  it('spans a date-only multi-day conference correctly', () => {
    const start = '2026-04-28T00:00:00Z';
    const end = '2026-04-30T00:00:00Z';
    // Both really do format to the same clock time — this is not a contrived fixture.
    expect(dayKeyIST(start)).toBe('2026-04-28');
    expect(dayKeyIST(end)).toBe('2026-04-30');
    expect(istDaysSpanned(start, end)).toBe(2);
  });

  it('handles a span across a month boundary', () => {
    expect(istDaysSpanned('2026-09-30T15:00:00Z', '2026-10-02T15:00:00Z')).toBe(2);
  });
});
