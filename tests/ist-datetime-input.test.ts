/**
 * IST wall-clock ↔ stored instant, for the admin edit form's datetime-local fields.
 *
 * The decisive cases are the ones where UTC and IST fall on DIFFERENT CALENDAR DAYS. An event's
 * IST day is not cosmetic here — `clusterKey` is built from it, so cross-source dedup depends on
 * it, and a 5.5-hour drift introduced by an edit would split one event into two.
 *
 * These must also pass regardless of the machine's timezone, which is the whole point of pinning
 * to a fixed +05:30 instead of using `new Date(inputValue)`. A test that only passes on a laptop
 * set to IST would be worse than no test.
 */
import { describe, it, expect } from 'vitest';
import { toISTInputValue, fromISTInputValue } from '../lib/ist-datetime-input';

describe('toISTInputValue: stored instant → IST wall clock', () => {
  it('renders a late-evening event on its IST day, not its UTC day', () => {
    // 16:00Z is 21:30 IST the SAME day.
    expect(toISTInputValue('2026-08-15T16:00:00Z')).toBe('2026-08-15T21:30');
  });

  it('rolls over the date when UTC is still on the previous day', () => {
    // 19:30Z on the 15th is 01:00 IST on the 16th. Reading UTC parts here would show the 15th
    // and move the event a day earlier on save.
    expect(toISTInputValue('2026-08-15T19:30:00Z')).toBe('2026-08-16T01:00');
  });

  it('handles the other edge: early-morning UTC is the same IST day', () => {
    expect(toISTInputValue('2026-08-15T00:30:00Z')).toBe('2026-08-15T06:00');
  });

  it('accepts a Date as well as a string', () => {
    expect(toISTInputValue(new Date('2026-08-15T16:00:00Z'))).toBe('2026-08-15T21:30');
  });

  it('returns an EMPTY string for absent or unparseable input', () => {
    // An empty input is what a missing endDateTime must look like — not the epoch.
    expect(toISTInputValue(null)).toBe('');
    expect(toISTInputValue(undefined)).toBe('');
    expect(toISTInputValue('')).toBe('');
    expect(toISTInputValue('not a date')).toBe('');
  });
});

describe('fromISTInputValue: IST wall clock → stored instant', () => {
  it('reads the field as IST, never as the browser timezone', () => {
    expect(fromISTInputValue('2026-08-15T21:30')).toBe('2026-08-15T16:00:00.000Z');
  });

  it('carries back across the date boundary', () => {
    expect(fromISTInputValue('2026-08-16T01:00')).toBe('2026-08-15T19:30:00.000Z');
  });

  it('accepts an optional seconds component', () => {
    expect(fromISTInputValue('2026-08-15T21:30:45')).toBe('2026-08-15T16:00:45.000Z');
  });

  it('returns null for an empty field, so a cleared date unsets rather than erroring', () => {
    expect(fromISTInputValue('')).toBeNull();
    expect(fromISTInputValue(null)).toBeNull();
    expect(fromISTInputValue(undefined)).toBeNull();
  });

  it('returns null for a malformed value instead of guessing', () => {
    expect(fromISTInputValue('2026-08-15')).toBeNull();
    expect(fromISTInputValue('15/08/2026 21:30')).toBeNull();
    expect(fromISTInputValue('2026-08-15 21:30')).toBeNull();
  });
});

describe('round trip', () => {
  it('is lossless to the minute, across the day boundary', () => {
    // The property that matters: opening the form and saving without touching anything must not
    // move the event. This is the regression that a naive toISOString().slice(0,16) would cause.
    for (const iso of [
      '2026-08-15T16:00:00.000Z',
      '2026-08-15T19:30:00.000Z', // 01:00 IST next day
      '2026-01-01T18:31:00.000Z', // 00:01 IST next day
      '2026-12-31T18:29:00.000Z',
    ]) {
      expect(fromISTInputValue(toISTInputValue(iso))).toBe(iso);
    }
  });
});
