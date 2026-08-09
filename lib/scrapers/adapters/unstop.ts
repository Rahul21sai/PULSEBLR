// Unstop adapter — hackathons, CTFs, case competitions and campus hiring drives.
//
// Recon: `unstop.com/api/public/opportunity/search-result` is open and returns
// { data: { data: [...] } }. Two quirks drove the design here:
//
//   1. NO USABLE START DATE. Records carry `end_date` and `regn_open` but no
//      `start_date`. A recursive search for any `*start*` key was tried and
//      REJECTED: it latched onto unrelated nested timestamps and produced four
//      different competitions all stamped "07 Jun 11:53", months in the past.
//      Unstop listings are opportunities with a REGISTRATION DEADLINE rather than
//      scheduled events, so we use `end_date` as both the date shown and the
//      recorded deadline. That is honest about what the field means; inventing a
//      start time from an unrelated key was not.
//   2. LOCATION IS OFTEN EMPTY. `region` is just "offline"/"online" and
//      `locations` is frequently []. Unstop is a national platform, so we require
//      positive Bengaluru evidence for EVERY record — including online ones.
//      Without that gate the adapter returned national college competitions
//      ("Pitcher Perfect", "Meme-Reelia") that have nothing to do with the city.

import { RawEvent, ScrapeResult } from '../core/types';
import { fetchJson } from '../core/http';
import { stripHtml, truncate } from '../core/text';

const UNSTOP_SOURCE = 'unstop';

interface UnstopItem {
  id?: number | string;
  title?: string;
  public_url?: string;
  seo_url?: string;
  type?: string;
  subtype?: string;
  region?: string;
  status?: string;
  logoUrl2?: string;
  logoUrl?: string;
  thumb?: string;
  banner_mobile?: { image_url?: string };
  isPaid?: boolean | number;
  end_date?: string;
  start_date?: string;
  organisation?: { name?: string };
  locations?: Array<string | { name?: string; city?: string }>;
  tags?: Array<string | { name?: string }>;
  [key: string]: unknown;
}

function locationText(item: UnstopItem): string {
  const parts: string[] = [];
  for (const loc of item.locations || []) {
    if (typeof loc === 'string') parts.push(loc);
    else if (loc) parts.push([loc.name, loc.city].filter(Boolean).join(' '));
  }
  return parts.join(', ');
}

const OPPORTUNITIES = ['hackathons', 'competitions', 'workshops-webinars', 'jobs'];

export async function scrapeUnstop(): Promise<ScrapeResult> {
  const startedAt = new Date();
  const result: ScrapeResult = {
    sourceId: 'unstop',
    label: 'Unstop — competitions & hackathons',
    events: [],
    errors: [],
    startedAt,
    durationMs: 0,
  };

  const byId = new Map<string, RawEvent>();
  const now = Date.now();

  for (const opportunity of OPPORTUNITIES) {
    const url =
      `https://unstop.com/api/public/opportunity/search-result` +
      `?opportunity=${encodeURIComponent(opportunity)}&per_page=50&page=1&searchTerm=bangalore`;
    try {
      const payload = await fetchJson<{ data?: { data?: UnstopItem[] } | UnstopItem[] }>(url, {
        timeoutMs: 30000,
        retries: 2,
      });
      const container = payload.data;
      const items: UnstopItem[] = Array.isArray(container)
        ? container
        : container?.data || [];

      for (const item of items) {
        if (!item.title) continue;

        // The deadline IS the date for an Unstop opportunity — see the header note.
        const deadline = item.end_date ? new Date(item.end_date) : undefined;
        if (!deadline || Number.isNaN(deadline.getTime())) continue;
        if (deadline.getTime() < now) continue;

        const isOnline = /online/i.test(String(item.region || ''));
        const where = locationText(item);

        // ONLINE-ONLY LISTINGS ARE EXCLUDED. Matching on the organisation name
        // let national online B-school competitions in simply because an IIM
        // Bangalore ran them ("Meme-Reelia", "Drawdown", "Vyaparneeti"). Those are
        // not Bengaluru events, and because Unstop supplies no start time they also
        // rendered with a meaningless clock time taken from the deadline. Keep only
        // in-person opportunities with Bengaluru in the LOCATION.
        if (isOnline) continue;
        if (!/bengaluru|bangalore/i.test(where)) continue;

        const sourceUrl =
          item.public_url ||
          (item.seo_url ? `https://unstop.com/${item.seo_url}` : 'https://unstop.com');

        const tags = (item.tags || [])
          .map(t => (typeof t === 'string' ? t : t?.name))
          .filter((t): t is string => Boolean(t));

        const key = String(item.id ?? sourceUrl);
        if (byId.has(key)) continue;

        byId.set(key, {
          title: item.title.trim(),
          description: truncate(
            stripHtml(String(item.title)) +
              (item.organisation?.name ? ` — hosted by ${item.organisation.name}.` : ''),
            4000
          ),
          sourceUrl,
          source: UNSTOP_SOURCE,
          sourceEventId: `unstop-${key}`,
          organizer: item.organisation?.name || 'Unstop',
          venue: where || 'Bengaluru',
          city: 'Bengaluru',
          startDateTime: deadline,
          imageUrl: item.banner_mobile?.image_url || item.logoUrl2 || item.logoUrl || item.thumb,
          isFree: !item.isPaid,
          applyLink: sourceUrl,
          registrationDeadline: deadline,
          rawCategory: opportunity === 'hackathons' ? ['Hackathon'] : undefined,
          rawFormat: 'offline',
          tags,
        });
      }
    } catch (err) {
      result.errors.push(`${opportunity}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  result.events = [...byId.values()];
  result.durationMs = Date.now() - startedAt.getTime();
  return result;
}
