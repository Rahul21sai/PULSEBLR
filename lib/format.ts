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

/** Best available single-line location string. */
export function locationLabel(event: {
  format?: string;
  venue?: string | null;
  area?: string | null;
  city?: string | null;
}): string {
  if (event.format === 'online') return 'Online';
  if (event.venue && event.area && !event.venue.includes(event.area)) {
    return `${event.venue} · ${event.area}`;
  }
  return event.venue || event.area || event.city || 'Bengaluru';
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
