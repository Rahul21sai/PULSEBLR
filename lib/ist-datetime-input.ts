/**
 * Converting between a stored UTC instant and the value an `<input type="datetime-local">` holds.
 *
 * WHY THIS IS NOT `new Date(iso).toISOString().slice(0, 16)`.
 *
 * A `datetime-local` input has no timezone: it holds wall-clock text, `YYYY-MM-DDTHH:mm`, and the
 * browser interprets it in the machine's LOCAL zone when you build a Date from it. This app pins
 * every displayed time to Asia/Kolkata (`lib/format.ts`), and an event's IST calendar day is
 * load-bearing — `clusterKey` is built from it, so cross-source dedup depends on it.
 *
 * So the naive conversions are both wrong, in opposite directions:
 *
 *   · `toISOString().slice(0,16)` shows UTC in a field the admin reads as IST, so a 9 PM IST event
 *     displays as 15:30 and any save moves it 5.5 hours earlier.
 *   · `new Date(inputValue)` parses as the BROWSER's zone. Correct for an admin sitting in
 *     Bengaluru and silently wrong for one on a laptop still set to UTC or on a US-hosted VM —
 *     the failure is invisible, because the form round-trips a value that merely looks right.
 *
 * Pinning to a fixed +05:30 removes the machine from the question entirely. India has no DST and
 * has not changed offset since 1945, so a constant is correct here in a way it would not be for
 * a zone with summer time.
 */

/** Asia/Kolkata is UTC+05:30, year round. */
const IST_OFFSET_MINUTES = 5 * 60 + 30;
const MS_PER_MINUTE = 60_000;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * A stored instant → the `YYYY-MM-DDTHH:mm` text a datetime-local input expects, in IST.
 *
 * Returns '' for absent or unparseable input, which is what an empty input holds — so a missing
 * `endDateTime` round-trips as "no value" rather than as the epoch.
 */
export function toISTInputValue(value: string | Date | null | undefined): string {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  // Shift the instant so that reading its UTC parts yields IST wall-clock parts.
  const shifted = new Date(date.getTime() + IST_OFFSET_MINUTES * MS_PER_MINUTE);
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
    `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`
  );
}

/**
 * The text from a datetime-local input, read as IST → an ISO instant for storage.
 *
 * Returns null for an empty field, so a cleared optional date is sent as an explicit null (which
 * the admin validator turns into "unset this") rather than as an invalid date.
 */
export function fromISTInputValue(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) return null;

  const [, y, mo, d, h, mi, s] = match;
  // Build the instant as if the wall-clock were UTC, then subtract the IST offset.
  const asUtc = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s ?? 0)
  );
  const instant = new Date(asUtc - IST_OFFSET_MINUTES * MS_PER_MINUTE);
  if (Number.isNaN(instant.getTime())) return null;
  return instant.toISOString();
}
