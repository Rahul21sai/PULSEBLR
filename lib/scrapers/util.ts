// Shared low-level fetch + structured-data extraction for HTML-based scrapers.
//
// Both the Meetup and Luma scrapers need the same two things: fetch a page with a
// browser-like User-Agent (Meetup/Luma serve minimal or bot-blocked markup to the
// default fetch/rss-parser UA) and pull structured data out of it. Event dates on
// both sites live in machine-readable blocks — JSON-LD `Event` on Meetup event
// pages, `__NEXT_DATA__` JSON on Luma calendars — NOT in the human-facing HTML or
// the RSS `pubDate` (which is the publish date, not the event date). Parsing those
// blocks is what makes the dates reliable.

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Fetch a URL as text with a browser-like UA and a hard timeout.
 * Follows redirects (lu.ma → luma.com, /bangalore → /bengaluru). Throws on
 * non-2xx or timeout so callers can record the failure against the source.
 */
export async function fetchHtml(url: string, timeoutMs = 20000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': DEFAULT_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract and JSON-parse every JSON-LD block on a page.
 *
 * Deliberately tolerant: the strict `<script type="application/ld+json">` match
 * misses blocks that carry extra attributes or order them differently (verified
 * on live Meetup pages — the strict form found 0 blocks, this form found 4). We
 * match any <script> whose type attribute mentions ld+json and skip blocks that
 * fail to parse (a page may embed several, only some well-formed).
 */
export function extractJsonLdBlocks(html: string): unknown[] {
  const blocks: unknown[] = [];
  const re = /<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      blocks.push(JSON.parse(m[1].trim()));
    } catch {
      // Malformed block — ignore and keep scanning.
    }
  }
  return blocks;
}

/**
 * Parse the Next.js `__NEXT_DATA__` payload if present. Luma embeds its full
 * calendar/event state here; returns the parsed object or null.
 */
export function extractNextData(html: string): unknown | null {
  const m = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/
  );
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

// Made with Bob
