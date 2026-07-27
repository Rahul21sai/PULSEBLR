import { RawEvent, ScraperResult } from './types';

/**
 * Devfolio hackathon scraper.
 *
 * Devfolio exposes a PUBLIC, UNAUTHENTICATED JSON API that returns the latest
 * ~1000 hackathons sorted by start date (upcoming first). Verified live
 * 2026-07-27: `GET https://api.devfolio.co/api/hackathons?page=1` →
 * HTTP 200, application/json, ~7 MB, `{ result: [ …hackathon records… ] }`.
 *
 * This is the ONLY Tier-3 event platform investigated that offers a genuine
 * machine-readable public feed. The following were checked and REJECTED — do
 * NOT add blind scrapers for them (they have no usable feed):
 *   - AllEvents.in  → /bengaluru/rss returns HTTP 200 but text/html (a page,
 *     not a feed). Would require blind HTML scraping.
 *   - 10times.com   → every RSS path guess 404s. No feed.
 *   - KonfHub       → api.konfhub.com/events → 403 "Missing Authentication
 *     Token" (auth-gated AWS API Gateway). No public feed.
 *
 * We keep only UPCOMING BENGALURU hackathons. Bengaluru detection is precise on
 * purpose: match the structured `city` field first, and only fall back to the
 * free-text `location` when it also names Karnataka. That Karnataka guard is
 * what rejects false positives like "PEC HACKS 4.0", whose location string
 * contains "Bengaluru - Chennai Highway" (a highway name) but is physically in
 * Tamil Nadu with a null city.
 */

const DEVFOLIO_API_URL = 'https://api.devfolio.co/api/hackathons?page=1';

// Exported so the orchestrator can record source health against a stable URL.
export const DEVFOLIO_SOURCE = {
  name: 'devfolio',
  type: 'api' as const,
  url: DEVFOLIO_API_URL,
};

interface DevfolioHackathonSetting {
  subdomain?: string;
  reg_ends_at?: string;
}

interface DevfolioHackathon {
  name?: string;
  desc?: string;
  tagline?: string;
  slug?: string;
  starts_at?: string;
  ends_at?: string;
  is_online?: boolean;
  location?: string;
  city?: string | null;
  status?: string;
  themes?: Array<{ name?: string }>;
  hackathon_setting?: DevfolioHackathonSetting;
}

function matchesBengaluru(text: string | null | undefined): boolean {
  return /bengaluru|bangalore/i.test(text || '');
}

/**
 * True only for hackathons we're confident are in Bengaluru, Karnataka.
 * Prefer the structured `city`; fall back to `location` but require Karnataka
 * so a highway named after Bengaluru in another state doesn't slip through.
 */
function isBengaluruEvent(h: DevfolioHackathon): boolean {
  if (matchesBengaluru(h.city)) return true;
  return matchesBengaluru(h.location) && /karnataka/i.test(h.location || '');
}

/**
 * Scrape upcoming Bengaluru hackathons from Devfolio's public API.
 */
export async function scrapeDevfolio(): Promise<ScraperResult> {
  const result: ScraperResult = {
    source: 'devfolio',
    events: [],
    errors: [],
    scrapedAt: new Date(),
  };

  try {
    console.log(`Fetching Devfolio hackathons: ${DEVFOLIO_API_URL}`);
    const response = await fetch(DEVFOLIO_API_URL, {
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      result.errors.push(`Devfolio API returned HTTP ${response.status}`);
      return result;
    }

    const data = (await response.json()) as { result?: DevfolioHackathon[] };
    const hackathons = data.result || [];

    if (hackathons.length === 0) {
      result.errors.push('Devfolio API returned no hackathons');
      return result;
    }

    const now = new Date();

    for (const h of hackathons) {
      try {
        // Keep only upcoming/ongoing Bengaluru hackathons.
        if (!h.ends_at || new Date(h.ends_at) < now) continue;
        if (!isBengaluruEvent(h)) continue;
        if (!h.name || !h.starts_at) continue;

        const subdomain = h.hackathon_setting?.subdomain;
        // Prefer the hackathon's own microsite; fall back to the Devfolio page.
        const sourceUrl = subdomain
          ? `https://${subdomain}.devfolio.co`
          : h.slug
            ? `https://devfolio.co/hackathons/${h.slug}`
            : 'https://devfolio.co';

        const description =
          h.desc || h.tagline || `${h.name} — a hackathon on Devfolio.`;

        const themes = (h.themes || [])
          .map(t => t?.name)
          .filter((n): n is string => Boolean(n));

        const regEndsAt = h.hackathon_setting?.reg_ends_at;

        const rawEvent: RawEvent = {
          title: h.name,
          description,
          sourceUrl,
          venue: h.is_online ? undefined : h.location || 'Bangalore',
          onlineLink: h.is_online ? sourceUrl : undefined,
          startDateTime: new Date(h.starts_at),
          endDateTime: new Date(h.ends_at),
          applyLink: sourceUrl,
          registrationDeadline: regEndsAt ? new Date(regEndsAt) : undefined,
          // Hints for the LLM tagger. These are all hackathons; themes such as
          // "AI" nudge classification toward the on-target categories.
          rawCategory: ['Hackathon', ...themes],
          rawFormat: h.is_online ? 'online' : 'offline',
        };

        result.events.push(rawEvent);
      } catch (error: any) {
        result.errors.push(
          `Failed to parse Devfolio hackathon "${h.name}": ${error.message}`
        );
      }
    }

    console.log(`Scraped ${result.events.length} upcoming Bengaluru hackathons from Devfolio`);
  } catch (error: any) {
    result.errors.push(`Failed to fetch Devfolio API: ${error.message}`);
    console.error('Devfolio scraper error:', error);
  }

  return result;
}

// Made with Bob
