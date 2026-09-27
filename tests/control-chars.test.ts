import { describe, expect, it } from 'vitest';
import {
  hasControlChars,
  replaceLineBreaks,
  stripControlChars,
  toLogLine,
} from '@/lib/security/control-chars';

/**
 * The character classes behind both line-injection fixes: the ICS generator (CWE-93) and the
 * push-reminder report (CWE-117).
 *
 * THE SWEEP IS THE POINT. The defect in both sinks was a hand-picked list (`\r?\n`) that looked
 * complete and was not. A handful of examples would pin the same kind of list again, so these walk
 * every code point from U+0000 to U+2FFF and assert the EXACT set each function acts on. Anything
 * added or dropped fails here by name. U+2FFF is past every class involved (the highest is U+2069)
 * and stops short of the surrogates.
 *
 * The sink-level cases (hostile titles, the panel's exploit URL, a 10 KB push body) live in
 * `tests/calendar-ics.test.ts` and `tests/push-policy.test.ts`. This file pins the definitions they
 * share.
 */

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** Every code point in the sweep for which `predicate` holds. */
function sweep(predicate: (char: string) => boolean): number[] {
  const hits: number[] = [];
  for (let codePoint = 0; codePoint <= 0x2fff; codePoint += 1) {
    if (predicate(String.fromCodePoint(codePoint))) hits.push(codePoint);
  }
  return hits;
}

describe('replaceLineBreaks: exactly the Unicode mandatory breaks', () => {
  it('treats LF, VT, FF, CR, NEL, LS and PS as breaks, and nothing else in the sweep', () => {
    // UAX #14's mandatory breaks. FS/GS/RS are NOT here on purpose: they are C0 controls, and
    // `stripControlChars` removes them.
    // Replaced with NOTHING, so the only way to come back empty is to have been a break. A visible
    // token such as '|' also "matches" when the swept character IS that token.
    expect(sweep(char => replaceLineBreaks(char, '') === '')).toEqual([
      0x0a, 0x0b, 0x0c, 0x0d, 0x85, 0x2028, 0x2029,
    ]);
  });

  it('counts CRLF as ONE break, not two', () => {
    // Otherwise every Windows-authored description would gain a blank line per line.
    expect(replaceLineBreaks('a\r\nb', '|')).toBe('a|b');
    expect(replaceLineBreaks('a\n\rb', '|')).toBe('a||b');
  });
});

describe('stripControlChars: C0 except HTAB, DEL and C1', () => {
  it('removes exactly that set', () => {
    expect(sweep(char => stripControlChars(char) === '')).toEqual([
      ...range(0x00, 0x08),
      ...range(0x0a, 0x1f),
      0x7f,
      ...range(0x80, 0x9f),
    ]);
  });

  it('keeps HTAB, which RFC 5545 TSAFE-CHAR allows (control)', () => {
    expect(stripControlChars('a\tb')).toBe('a\tb');
  });
});

describe('hasControlChars: anything either function above would touch', () => {
  it('flags that union exactly', () => {
    expect(sweep(hasControlChars)).toEqual([
      ...range(0x00, 0x08),
      ...range(0x0a, 0x1f),
      0x7f,
      ...range(0x80, 0x9f),
      0x2028,
      0x2029,
    ]);
  });

  it('gives the same answer on every call', () => {
    // The trap it avoids: a GLOBAL regex keeps `lastIndex` between `test()` calls, so a shared
    // `/…/g` answers true, then false, then true for the same input.
    expect([1, 2, 3].map(() => hasControlChars('x\ry'))).toEqual([true, true, true]);
  });
});

describe('the union covers every line terminator measured in a real consumer', () => {
  it("leaves none of Python's str.splitlines() terminators behind", () => {
    // Measured 2026-09-27, Python 3.13: these ten and no others split a line.
    const splitlines = ['\r', '\n', '\v', '\f', '\x1c', '\x1d', '\x1e', '\x85', '\u{2028}', '\u{2029}'];
    for (const terminator of splitlines) {
      expect(hasControlChars(terminator)).toBe(true);
      const cleaned = stripControlChars(replaceLineBreaks(`a${terminator}b`, ' '));
      expect(cleaned).not.toContain(terminator);
      expect(cleaned.length).toBeGreaterThan(1);
    }
  });
});

describe('toLogLine: the shape of its output', () => {
  it('puts the apostrophe in front of a leading `::` INSIDE the bound', () => {
    // The marker counts toward maxLength, or a body exactly at the limit would come out one over.
    const line = toLogLine(`::${'x'.repeat(50)}`, 10);
    expect(line.startsWith("'::")).toBe(true);
    expect([...line].length).toBeLessThanOrEqual(10);
  });

  it('never splits a surrogate pair at the cut', () => {
    // An ODD limit on purpose. A UTF-16 `.slice(0, 9)` of emoji keeps 4 pairs and half of a fifth,
    // while an even limit would pass by luck.
    const line = toLogLine('\u{1F389}'.repeat(50), 9);
    expect([...line].length).toBeLessThanOrEqual(9);
    expect(Buffer.from(line, 'utf8').toString('utf8')).toBe(line);
  });
});
