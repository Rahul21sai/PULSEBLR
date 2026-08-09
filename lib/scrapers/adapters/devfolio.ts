// Devfolio adapter — hackathons.
//
// Devfolio exposes a public, unauthenticated JSON API returning the latest ~1000
// hackathons sorted by start date. Verified live: GET
// https://api.devfolio.co/api/hackathons?page=1 → 200, ~7 MB, { result: [...] }.
//
// Other Tier-3 platforms were checked and REJECTED — do not add blind scrapers:
//   AllEvents.in /rss → HTML, not a feed (a separate JSON-LD adapter exists instead)
//   10times.com        → every RSS path 404s
//   KonfHub           → api.konfhub.com/events → 403, auth-gated
//   Townscript        → /api/v1/event/search → 401 unauthorized
//
// Bengaluru detection is deliberately strict: prefer the structured `city`, and
// only fall back to free-text `location` when it also names Karnataka. That guard
// is what rejects "PEC HACKS 4.0", whose address contains "Bengaluru - Chennai
// Highway" but which is physically in Tamil Nadu with a null city.

import { ScrapeResult } from '../core/types';
import { fetchJson } from '../core/http';
import { stripHtml, truncate } from '../core/text';

const DEVFOLIO_API_URL = 'https://api.devfolio.co/api/hackathons?page=1';
const DEVFOLIO_SOURCE = 'devfolio';

export const DEVFOLIO_URL = DEVFOLIO_API_URL;

interface DevfolioHackathon {
  uuid?: string;
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
  cover_img?: string;
  themes?: Array<{ name?: string }>;
  hackathon_setting?: { subdomain?: string; reg_ends_at?: string };
}

function matchesBengaluru(text: string | null | undefined): boolean {
  return /bengaluru|bangalore/i.test(text || '');
}

function isBengaluruHackathon(h: DevfolioHackathon): boolean {
  if (matchesBengaluru(h.city)) return true;
  return matchesBengaluru(h.location) && /karnataka/i.test(h.location || '');
}

export async function scrapeDevfolio(): Promise<ScrapeResult> {
  const startedAt = new Date();
  const result: ScrapeResult = {
    sourceId: 'devfolio',
    label: 'Devfolio — hackathons',
    events: [],
    errors: [],
    startedAt,
    durationMs: 0,
  };

  try {
    const data = await fetchJson<{ result?: DevfolioHackathon[] }>(DEVFOLIO_API_URL, {
      timeoutMs: 45000, // ~7 MB payload
      retries: 2,
    });
    const hackathons = data.result || [];
    if (hackathons.length === 0) result.errors.push('Devfolio API returned no hackathons');

    const now = Date.now();

    for (const h of hackathons) {
      try {
        if (!h.name || !h.starts_at) continue;
        if (!h.ends_at || new Date(h.ends_at).getTime() < now) continue;
        if (!isBengaluruHackathon(h)) continue;
        // Devfolio's public API includes the team's own sandbox entries — live
        // testing surfaced "(Demo) Push to Prod" and "Fake Push to Prod", both
        // with far-future end dates so the upcoming filter alone lets them
        // through. They are not real events and must not reach the feed.
        if (/\b(demo|fake|test|sample|dummy)\b/i.test(h.name)) continue;

        const startDateTime = new Date(h.starts_at);
        if (Number.isNaN(startDateTime.getTime())) continue;
        // A start more than a week past means the listing is stale even if its
        // end date says otherwise; a genuinely ongoing hackathon stays.
        if (startDateTime.getTime() < now - 7 * 24 * 3600 * 1000) continue;

        const subdomain = h.hackathon_setting?.subdomain;
        const sourceUrl = subdomain
          ? `https://${subdomain}.devfolio.co`
          : h.slug
            ? `https://devfolio.co/hackathons/${h.slug}`
            : 'https://devfolio.co';

        const themes = (h.themes || [])
          .map(t => t?.name)
          .filter((n): n is string => Boolean(n));

        const regEndsAt = h.hackathon_setting?.reg_ends_at;

        result.events.push({
          title: h.name,
          description: truncate(
            stripHtml(h.desc || h.tagline || `${h.name} — a hackathon on Devfolio.`),
            4000
          ),
          sourceUrl,
          source: DEVFOLIO_SOURCE,
          sourceEventId: h.uuid || h.slug || sourceUrl,
          organizer: 'Devfolio',
          venue: h.is_online ? undefined : h.location || 'Bengaluru',
          address: h.is_online ? undefined : h.location,
          city: h.city || undefined,
          onlineLink: h.is_online ? sourceUrl : undefined,
          startDateTime,
          endDateTime: new Date(h.ends_at),
          imageUrl: h.cover_img,
          isFree: true,
          applyLink: sourceUrl,
          registrationDeadline: regEndsAt ? new Date(regEndsAt) : undefined,
          rawCategory: ['Hackathon', ...themes],
          rawFormat: h.is_online ? 'online' : 'offline',
          tags: themes,
        });
      } catch (err) {
        result.errors.push(
          `parse "${h.name}": ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  } catch (err) {
    result.errors.push(`fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  result.durationMs = Date.now() - startedAt.getTime();
  return result;
}
