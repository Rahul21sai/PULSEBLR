// Date, time and label formatting for the UI.
//
// EVERYTHING here is pinned to Asia/Kolkata. PulseBLR is a Bengaluru product, so
// "Tonight" and "Tomorrow" must mean the user's day even when the code runs on a
// UTC server or the browser's clock is set elsewhere. Using the ambient locale
// (what `new Date().toLocaleString()` does) would put a 9 PM IST event on the
// wrong day for a server-rendered page.

export const IST = 'Asia/Kolkata';

const timeFormatter = new Intl.DateTimeFormat('en-IN', {
  timeZone: IST,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const dayLabelFormatter = new Intl.DateTimeFormat('en-IN', {
  timeZone: IST,
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});

const fullDateFormatter = new Intl.DateTimeFormat('en-IN', {
  timeZone: IST,
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

const dayKeyFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: IST,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * No weekday, for the 42px-wide time rail on a phone.
 *
 * `dayLabelIST` ("Sat, 15 Aug") is the right label above a day GROUP, where there is a full row
 * to put it in. It does not fit the rail gutter, and the gutter is the only place a date can go
 * under a RANKED sort — that view has no day headings, because grouping a ranked list by day
 * would re-sort it chronologically and throw the ranking away.
 */
const shortDateFormatter = new Intl.DateTimeFormat('en-IN', {
  timeZone: IST,
  day: 'numeric',
  month: 'short',
});

/** 24-hour clock time in IST, e.g. "19:30". */
export function timeIST(date: Date | string): string {
  return timeFormatter.format(new Date(date));
}

/** Stable YYYY-MM-DD key for the IST calendar day — used to group the feed. */
export function dayKeyIST(date: Date | string): string {
  return dayKeyFormatter.format(new Date(date));
}

/** "Sat, 15 Aug" in IST. */
export function dayLabelIST(date: Date | string): string {
  return dayLabelFormatter.format(new Date(date));
}

/** "15 Aug" in IST — the compact form, for the time rail. See shortDateFormatter. */
export function shortDateIST(date: Date | string): string {
  return shortDateFormatter.format(new Date(date));
}

/**
 * How many IST calendar days later the end is than the start. 0 for a same-day event.
 *
 * Derived from `dayKeyIST` rather than from a millisecond subtraction, so it can never disagree
 * with the day grouping the feed renders — both answer "which IST day is this on" through the
 * same formatter. A 23:00 → 01:00 event spans 1 day here even though it lasts two hours, which
 * is the answer the reader needs: the end is tomorrow.
 *
 * WHY THIS EXISTS. The time rail printed the end time unconditionally, so a multi-day event read
 * as ending before it began. Measured on the live corpus: 15 of the first 100 tech events span
 * more than one IST day, and the conference sources are the worst case because their dates are
 * date-only — `Great International Developer Summit` (three days) and `WeAreDevelopers Conference
 * India` (one day) both rendered as "05:30 / 05:30", identical start and end, which reads as a
 * data error rather than a long event.
 *
 * The keys are YYYY-MM-DD, parsed as UTC midnight, so the subtraction is whole days exactly.
 * IST has no DST, but going through the key means that would not matter either.
 */
export function istDaysSpanned(start: Date | string, end: Date | string): number {
  const startMs = Date.parse(`${dayKeyIST(start)}T00:00:00Z`);
  const endMs = Date.parse(`${dayKeyIST(end)}T00:00:00Z`);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return 0;
  return Math.max(0, Math.round((endMs - startMs) / 86_400_000));
}

/** "Saturday, 15 August 2026" in IST. */
export function fullDateIST(date: Date | string): string {
  return fullDateFormatter.format(new Date(date));
}

/** Today's IST day key. */
export function todayKeyIST(): string {
  return dayKeyIST(new Date());
}

/** IST day key N days from today. */
export function dayKeyOffsetIST(offsetDays: number): string {
  return dayKeyIST(new Date(Date.now() + offsetDays * 24 * 3600 * 1000));
}

/**
 * Human day heading: "Today", "Tomorrow", or the dated form.
 * `Today` is deliberately not "Tonight" — the feed shows morning events too.
 *
 * The year is appended only when it differs from the current one. Without that,
 * a January 2027 event rendered as "Sat, 25 Jan" and read as a past date sitting
 * oddly in the middle of the feed.
 */
export function dayHeading(date: Date | string): string {
  const key = dayKeyIST(date);
  if (key === todayKeyIST()) return 'Today';
  if (key === dayKeyOffsetIST(1)) return 'Tomorrow';

  const year = key.slice(0, 4);
  const currentYear = todayKeyIST().slice(0, 4);
  return year === currentYear ? dayLabelIST(date) : `${dayLabelIST(date)} ${year}`;
}

/** Sentinel day key for the "Happening now" group. Sorts before any real date. */
export const NOW_GROUP_KEY = '0000-00-00';

/** True when the event has started but not yet finished. */
export function isHappeningNow(start: Date | string, end?: Date | string | null): boolean {
  const now = Date.now();
  const startMs = new Date(start).getTime();
  if (startMs > now) return false;
  // With no end time, treat a 3-hour window as "still on" — long enough to cover
  // a typical meetup, short enough that yesterday's event doesn't read as live.
  const endMs = end ? new Date(end).getTime() : startMs + 3 * 3600 * 1000;
  return endMs >= now;
}

/** "in 2h", "in 3 days", "started 40m ago" — relative to now, IST-agnostic. */
export function relativeTime(date: Date | string): string {
  const diffMs = new Date(date).getTime() - Date.now();
  const past = diffMs < 0;
  const minutes = Math.round(Math.abs(diffMs) / 60000);

  if (minutes < 1) return 'now';
  if (minutes < 60) return past ? `${minutes}m ago` : `in ${minutes}m`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return past ? `${hours}h ago` : `in ${hours}h`;

  const days = Math.round(hours / 24);
  if (days < 30) return past ? `${days}d ago` : `in ${days}d`;

  const months = Math.round(days / 30);
  return past ? `${months}mo ago` : `in ${months}mo`;
}

/** Duration like "2h", "90m", "3 days" — undefined when there's no end time. */
export function durationLabel(
  start: Date | string,
  end?: Date | string | null
): string | undefined {
  if (!end) return undefined;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms <= 0) return undefined;
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = ms / 3600000;
  if (hours < 24) return hours % 1 === 0 ? `${hours}h` : `${hours.toFixed(1)}h`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

/** Price pill text. */
export function priceLabel(event: {
  isFree?: boolean;
  price?: number | null;
  priceMax?: number | null;
  currency?: string | null;
}): string {
  if (event.isFree || !event.price) return 'Free';
  const symbol = !event.currency || event.currency === 'INR' ? '₹' : `${event.currency} `;
  if (event.priceMax && event.priceMax > event.price) {
    return `${symbol}${event.price}–${event.priceMax}`;
  }
  return `${symbol}${event.price}`;
}

/**
 * Drop comma-separated segments that an earlier segment already said.
 *
 * Scraped venue strings are address lines joined by the source, and several sources append the
 * city more than once. Measured 2026-08-24: 10 upcoming events, ALL of them `isTechEvent`, so
 * all of them in the default feed — `To Be Announced, Bangalore, Bangalore, Bangalore` and
 * `Nokia L5 Manyata Business Park, …, Bengaluru, Bengaluru`. On a card truncated at 220px the
 * repetition is often the only part still visible, so the location line reads as broken.
 *
 * Cleaned at DISPLAY time rather than at ingest, on purpose. The repetition is in the stored
 * `venue` for rows already in the database, and ingestion merges rather than replaces — a
 * scraper-side fix would leave every existing row dirty until a backfill, while this corrects
 * all six render sites at once and cannot corrupt data because it writes nothing.
 *
 * First occurrence wins so the order the source chose is preserved; comparison is
 * case-insensitive because sources vary the casing of the same segment.
 */
function dropRepeatedSegments(text: string): string {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const raw of text.split(',')) {
    const segment = raw.trim();
    if (!segment) continue;
    const key = segment.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(segment);
  }
  return kept.join(', ');
}

/** Best available single-line location string. */
export function locationLabel(event: {
  format?: string;
  venue?: string | null;
  area?: string | null;
  city?: string | null;
}): string {
  if (event.format === 'online') return 'Online';
  const venue = event.venue ? dropRepeatedSegments(event.venue) : '';
  if (venue && event.area && !venue.includes(event.area)) {
    return `${venue} · ${event.area}`;
  }
  return venue || event.area || event.city || 'Bengaluru';
}

/**
 * Deterministic accent per category, used for the cover fallback and pills.
 * Deterministic matters: the same event must not change colour between renders
 * or between the list and the detail page.
 */
const CATEGORY_ACCENTS: Record<string, string> = {
  // Tech topics — the palette users see most, so these carry the distinct hues.
  'AI/ML': '#0071E3',
  'Data/Analytics': '#5856D6',
  'Cloud/DevOps': '#5AC8FA',
  'Web/Mobile': '#FF9500',
  'Cybersecurity': '#FF3B30',
  'Open Source': '#30D158',
  'Hardware/Robotics': '#64D2FF',
  'Blockchain/Web3': '#AF52DE',
  'Gaming/XR': '#FF2D55',
  'Product/Design': '#BF5AF2',
  // Kind of gathering
  'Hackathon': '#FF375F',
  'Conference': '#32ADE6',
  'Meetup': '#FF9F0A',
  'Workshop': '#A2845E',
  'Career/Hiring': '#248A3D',
  'Startup/Founders': '#FFB340',
  // Non-tech tail — deliberately muted so tech topics stay visually dominant.
  'Business/Finance': '#8E8E93',
  'Science/Research': '#5E5CE6',
  'Community/Social': '#9A9AA0',
  'Arts/Culture': '#C77DBB',
  'Health/Fitness': '#32D74B',
  'Other': '#8E8E93',
};

export function categoryAccent(category?: string): string {
  return (category && CATEGORY_ACCENTS[category]) || '#8E8E93';
}

/** Two-letter monogram for a cover fallback. */
export function monogram(title: string): string {
  const words = title.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/);
  if (words.length === 0) return '??';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words[1][0]}`.toUpperCase();
}
