// Small text utilities shared across adapters and the normalizer.

/** Strip HTML tags and collapse whitespace/entities into readable plain text. */
export function stripHtml(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Truncate on a word boundary, appending an ellipsis when cut. */
export function truncate(input: string, max: number): string {
  const text = input.trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** URL-safe slug used for pretty event links. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72);
}

/**
 * Aggressively normalized title used for CROSS-SOURCE duplicate detection.
 *
 * The same event listed on Luma and Meetup rarely has byte-identical titles —
 * "React Meetup #107", "React Meetup 107 | Bengaluru" and "react meetup #107 🚀"
 * are one event. So we lowercase, drop emoji/punctuation, strip common noise
 * words and city/edition suffixes, and collapse whitespace. Digits are KEPT
 * because "#107" vs "#108" are genuinely different events.
 */
const NOISE_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'in', 'at', 'on', 'for', 'with', 'to',
  'bangalore', 'bengaluru', 'blr', 'india', 'online', 'offline', 'hybrid',
  'meetup', 'event', 'edition', 'presents', 'ft', 'featuring', 'powered', 'by',
]);

export function normalizeTitleForMatch(title: string): string {
  const base = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    // Strip emoji and pictographs.
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2028}-\u{202F}]/gu, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const kept = base.split(' ').filter(word => word && !NOISE_WORDS.has(word));
  // If noise-stripping removed everything (e.g. title was "Bangalore Meetup"),
  // fall back to the un-stripped form so we never produce an empty match key.
  return (kept.length > 0 ? kept.join(' ') : base).slice(0, 120);
}

/** First non-empty string from a list of candidates. */
export function firstText(...candidates: Array<string | null | undefined>): string | undefined {
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

/** Absolutise a possibly-relative URL against a base; undefined when unusable. */
export function absoluteUrl(href: string | undefined, base: string): string | undefined {
  if (!href) return undefined;
  try {
    return new URL(href, base).toString();
  } catch {
    return undefined;
  }
}
