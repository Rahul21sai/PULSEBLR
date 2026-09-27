/**
 * Control characters, and the line breaks hiding among them: one definition for every sink that
 * writes untrusted text into a line-oriented format.
 *
 * ── WHY THIS MODULE EXISTS ───────────────────────────────────────────────────────────────────
 * Two sinks made the same mistake independently, and one security review found both:
 *
 *   · `lib/calendar/ics.ts` (CWE-93). TEXT escaping handled `\r?\n` and nothing else, so a LONE CR
 *     went out raw. A parser that ends a line on a bare CR starts a new content line there, and
 *     event text (scraped from third-party pages, or typed by any signed-in user) could inject
 *     properties or a whole VEVENT into a subscriber's calendar feed.
 *   · `lib/notifications/push.ts` (CWE-117). Up to 200 characters of a push service's response body
 *     went into the run report, and `scripts/send-push-reminders.ts` printed it verbatim. The
 *     endpoint is a URL any signed-in user registers, so "the push service" can be the attacker's
 *     own server, and its body could forge report lines, drive the operator's terminal with ESC
 *     sequences, or issue GitHub Actions workflow commands if the script ever runs in CI.
 *
 * `\r?\n` is the tell in both. It names the two characters a Unix-and-Windows developer thinks of,
 * and "something some reader treats as the end of a line" is a much larger set than that.
 *
 * ── WHAT COUNTS AS A LINE BREAK: MEASURED, AND IT DIFFERS BY PARSER ──────────────────────────
 *   · Python's `str.splitlines()` breaks on CR, LF, VT, FF, FS, GS, RS, NEL, U+2028 and U+2029
 *     (measured 2026-09-27, Python 3.13). The `icalendar` package splits content lines with it.
 *     That one is recalled rather than measured, since `icalendar` is not installed here.
 *   · ical.js 2.2.1 (installed, `lib/ical/parse.js` `_eachLine`) splits on LF only. A lone CR is
 *     NOT a break to it, which is why a test using ical.js as its oracle cannot see the CR bug.
 *   · ical4j, behind Android's ICSx5 and DAVx5, ends a line on a bare CR. That is the security
 *     panel's finding and the reason this module exists.
 *
 * No single parser is the reference. So the rule is the UNION: every Unicode mandatory break
 * (UAX #14: CR, LF, CRLF, NEL, VT, FF, LS, PS) becomes the format's own line break, and every
 * other control character is removed. FS/GS/RS fall in the second group, since they are C0
 * controls, and that covers the rest of Python's list.
 *
 * ── C1 (U+0080–U+009F) IS REMOVED, EVEN THOUGH RFC 5545 WOULD ALLOW IT ───────────────────────
 * The iCalendar grammar's NON-US-ASCII admits any UTF-8 sequence, C1 included, so this is stricter
 * than the RFC on purpose. Three reasons:
 *   1. NEL (U+0085) is a line terminator to `splitlines()` and to UAX #14. Leaving it would be the
 *      lone-CR bug again with a different code point. It is handled as a break, not dropped.
 *   2. CSI (U+009B) and OSC (U+009D) are the single-code-point forms of `ESC [` and `ESC ]`. A log
 *      sanitiser that removed ESC but kept those would let the same terminal attack through on
 *      any terminal that honours 8-bit controls.
 *   3. In scraped copy these code points are almost never text. They are usually Windows-1252
 *      punctuation mis-decoded as Latin-1 (0x85 is the cp1252 ellipsis, 0x93/0x94 its curly
 *      quotes), and they render as nothing or as a box either way. Dropping them loses nothing a
 *      reader could have seen.
 *
 * HTAB (U+0009) is the one C0 character kept, because RFC 5545's TSAFE-CHAR allows it and it
 * breaks no line. `toLogLine` turns it into a space anyway.
 *
 * Escapes above U+00FF are written in brace form (`\u{2028}`, with the `u` flag). Keep them
 * escaped: a raw U+2028 inside a regex literal is a syntax error, and a raw bidi control in source
 * is the very hazard `toLogLine` removes from logs.
 *
 * Pure and dependency-free, so `tests/control-chars.test.ts` can sweep every code point it
 * classifies.
 */

/**
 * Every line-break form, longest first so CRLF is one break rather than two.
 *
 * `\v` is VT (U+000B) and `\f` is FF (U+000C). Global, so it is only ever used with `replace`: a
 * `/g` regex keeps `lastIndex` between `test()` calls, and a shared one would answer
 * differently on alternate calls.
 */
const LINE_BREAKS = /\r\n|[\n\v\f\r\u0085\u{2028}\u{2029}]/gu;

/**
 * C0 except HTAB, DEL, and C1. Run AFTER `LINE_BREAKS`: CR, LF, VT, FF and NEL are in this range
 * too, and removing them before they became breaks would weld two lines into one word.
 */
const CONTROLS = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/g;

/** Presence test for anything either pattern above would touch. Not global, so `test()` is stateless. */
const CONTROL_OR_BREAK = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u{2028}\u{2029}]/u;

/**
 * The bidi embedding, override and isolate controls. Removed from LOG LINES only.
 *
 * They break no line, but they reorder how a terminal that implements bidi (VTE, Konsole, mlterm)
 * DRAWS one, so a push service could make its line read differently from its bytes (Trojan
 * Source, CVE-2021-42574). They are NOT removed from calendar text: they are legitimate in RTL
 * titles and cannot start a content line.
 */
const BIDI_CONTROLS = /[\u{202a}-\u{202e}\u{2066}-\u{2069}]/gu;

/**
 * The GitHub Actions LEGACY workflow-command prefix. Matched ANYWHERE in a line, not only at the
 * start.
 *
 * Read from the actions/runner source on 2026-09-27: `ActionCommand.TryParse` locates it with
 * `message.IndexOf("##[")`, and `ActionCommandManager.TryProcessCommand` falls back to that parser
 * whenever the `::` one declines, with no flag gating it. So a body printed mid-line, after the
 * `↳ ` the script puts in front of it, is still a command in CI unless this is broken up. The
 * `::` form is different: `TryParseV2` does `TrimStart()` then `StartsWith("::")`, so only the
 * start of a line matters, and leading whitespace does NOT neutralise it.
 */
const LEGACY_WORKFLOW_COMMAND = /##\[/g;

/** Replace every line-break form, including CRLF as ONE break, with `replacement`. */
export function replaceLineBreaks(value: string, replacement: string): string {
  return value.replace(LINE_BREAKS, replacement);
}

/**
 * Remove C0 (except HTAB), DEL and C1.
 *
 * On its own this also removes CR and LF, which JOINS lines rather than breaking them. That is
 * safe, but it loses the separation, so call `replaceLineBreaks` first wherever a break carries
 * meaning.
 */
export function stripControlChars(value: string): string {
  return value.replace(CONTROLS, '');
}

/** True if `value` holds any control character (HTAB excepted) or any line-break form. */
export function hasControlChars(value: string): boolean {
  return CONTROL_OR_BREAK.test(value);
}

/**
 * Keep at most `max` code points, never splitting a surrogate pair, and mark a cut with an
 * ellipsis that counts toward `max`.
 *
 * A LONE surrogate is dropped. It cannot be printed (UTF-8 encoding turns it into U+FFFD), and
 * the pre-slice in `toLogLine` can leave one at the end.
 */
function clipCodePoints(value: string, max: number): string {
  if (max <= 0) return '';
  const points: string[] = [];
  for (const point of value) {
    const code = point.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) continue;
    points.push(point);
  }
  if (points.length <= max) return points.join('');
  return `${points.slice(0, max - 1).join('').trimEnd()}…`;
}

/**
 * Render untrusted text as ONE bounded, inert line for a terminal or a log.
 *
 * The guarantees, each pinned in `tests/push-policy.test.ts`:
 *   · no line break of any form (every one becomes a space), so the text cannot start a line of
 *     its own or forge a line of the report it sits in
 *   · no C0, DEL or C1 control, which removes ESC and with it every ANSI/OSC sequence, and the
 *     8-bit CSI/OSC forms too. What is left of a sequence is printable debris like `[31m`.
 *   · no bidi override, so the line cannot be drawn differently from what it contains
 *   · whitespace runs collapsed to one space and trimmed
 *   · never a leading `::`, and never `##[` anywhere, so it cannot be a GitHub Actions workflow
 *     command wherever the caller prints it. A leading `::` gets an apostrophe in front, the
 *     marker `lib/scan/csv.ts` already uses to disarm a spreadsheet formula.
 *   · at most `maxLength` code points, ellipsis included
 *
 * The raw input is cut to `maxLength * 4` UTF-16 units BEFORE any of that, because its length is
 * chosen by whoever runs the endpoint and a regex pass over an unbounded body is work spent on
 * text that will be thrown away.
 *
 * It never throws. It runs inside `catch` blocks, where a throw would escape the handler and turn
 * one device's failure into an aborted run for every user.
 */
export function toLogLine(value: unknown, maxLength: number): string {
  let raw = '';
  try {
    raw = typeof value === 'string' ? value : value == null ? '' : String(value);
  } catch {
    // An object whose toString throws. There is nothing worth printing, so print nothing.
  }
  let line = raw
    .slice(0, Math.max(0, maxLength) * 4)
    .replace(LINE_BREAKS, ' ')
    .replace(CONTROLS, '')
    .replace(BIDI_CONTROLS, '')
    .replace(/\s+/g, ' ')
    .trim()
    // AFTER the removals: `#` ESC `#[` and `:` NUL `:` only BECOME dangerous once the control
    // between them is gone, so neutralising first would pass them straight through.
    .replace(LEGACY_WORKFLOW_COMMAND, '# #[');
  if (line.startsWith('::')) line = `'${line}`;
  return clipCodePoints(line, maxLength);
}
