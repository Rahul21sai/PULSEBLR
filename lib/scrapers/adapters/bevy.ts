// Bevy adapter — GDG / Google Developer Group chapters and other Bevy communities.
//
// Recon: `gdg.community.dev/api/search/event/?q=<city>` is an open, unauthenticated
// search API returning fully structured records — title, description_short,
// start_date_iso/end_date_iso, venue_name/address/city, chapter_title, picture_url
// and cropped_banner_url, plus _geoloc coordinates. q=bangalore returned 202
// results and q=bengaluru 327, all in a single response (no pagination needed).
//
// This is how GDG Cloud Bengaluru, GDG Bangalore, Women Techmakers and the many
// company-sponsored chapter events get covered. `/api/event_slim/` was rejected:
// it returns all 70k+ global Bevy events and has no city filter.

import { RawEvent, ScrapeResult } from '../core/types';
import { fetchJson } from '../core/http';
import { stripHtml, truncate } from '../core/text';
import { isBengaluru } from '../core/geo';

const BEVY_SOURCE = 'bevy';

interface BevyResult {
  id?: number | string;
  title?: string;
  description_short?: string;
  start_date_iso?: string;
  end_date_iso?: string;
  url?: string;
  relative_url?: string;
  picture_url?: string;
  cropped_banner_url?: string;
  banner?: string;
  venue_name?: string;
  venue_address?: string;
  venue_city?: string;
  chapter_title?: string;
  chapter_city?: string;
  event_timezone?: string;
  event_type_title?: string;
  virtual_event_type?: string | null;
  _geoloc?: { lat?: number; lng?: number };
}

interface BevySearchResponse {
  count?: number;
  results?: BevyResult[];
}

/**
 * Bevy communities to search. gdg.community.dev is by far the largest in
 * Bengaluru; the others are separate Bevy tenants that host India chapters.
 */
// mlh.community.dev was removed: it does not resolve (DNS failure in testing),
// so it only ever contributed two error lines per run.
const BEVY_HOSTS = [
  'https://gdg.community.dev',
  'https://community.cncf.io',
];

const QUERIES = ['bangalore', 'bengaluru'];

function toRawEvent(item: BevyResult, host: string): RawEvent | null {
  if (!item.title || !item.start_date_iso) return null;

  const startDateTime = new Date(item.start_date_iso);
  if (Number.isNaN(startDateTime.getTime())) return null;

  const endDateTime = item.end_date_iso ? new Date(item.end_date_iso) : undefined;
  const isOnline = Boolean(item.virtual_event_type);

  const url = item.url || (item.relative_url ? `${host}${item.relative_url}` : host);
  const description = stripHtml(item.description_short || item.title);

  return {
    title: item.title.trim(),
    description: truncate(description, 4000),
    sourceUrl: url,
    source: BEVY_SOURCE,
    sourceEventId: item.id !== undefined ? `bevy-${item.id}` : url,
    organizer: item.chapter_title,
    venue: isOnline ? undefined : item.venue_name || item.venue_address,
    address: isOnline ? undefined : item.venue_address,
    city: item.venue_city || item.chapter_city,
    lat: item._geoloc?.lat,
    lng: item._geoloc?.lng,
    onlineLink: isOnline ? url : undefined,
    startDateTime,
    endDateTime: endDateTime && !Number.isNaN(endDateTime.getTime()) ? endDateTime : undefined,
    timezone: item.event_timezone,
    imageUrl: item.cropped_banner_url || item.picture_url || item.banner,
    // GDG/CNCF chapter events are free essentially without exception.
    isFree: true,
    applyLink: url,
    rawFormat: isOnline ? 'online' : 'offline',
    tags: item.event_type_title ? [item.event_type_title] : undefined,
  };
}

export async function scrapeBevy(): Promise<ScrapeResult> {
  const startedAt = new Date();
  const result: ScrapeResult = {
    sourceId: 'bevy-communities',
    label: 'Bevy — GDG / CNCF chapters',
    events: [],
    errors: [],
    startedAt,
    durationMs: 0,
  };

  const byId = new Map<string, RawEvent>();
  const now = Date.now();

  for (const host of BEVY_HOSTS) {
    for (const query of QUERIES) {
      const url = `${host}/api/search/event/?q=${encodeURIComponent(query)}`;
      try {
        const data = await fetchJson<BevySearchResponse>(url, { timeoutMs: 25000, retries: 2 });
        for (const item of data.results || []) {
          const event = toRawEvent(item, host);
          if (!event) continue;

          // The search index includes past events; the feed is upcoming-only.
          const effectiveEnd = (event.endDateTime ?? event.startDateTime).getTime();
          if (effectiveEnd < now) continue;

          // A text search for "bangalore" also matches chapters merely named after
          // it while meeting elsewhere, so re-verify geography.
          const verdict = isBengaluru({
            venue: event.venue,
            address: event.address,
            city: event.city,
            lat: event.lat,
            lng: event.lng,
          });
          const isOnline = event.rawFormat === 'online';
          if (verdict === false) continue;
          if (verdict === null && !isOnline) continue;

          const key = event.sourceEventId || event.sourceUrl;
          if (!byId.has(key)) byId.set(key, event);
        }
      } catch (err) {
        // A Bevy tenant that doesn't exist or blocks us shouldn't fail the source.
        result.errors.push(`${host} q=${query}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  result.events = [...byId.values()];
  result.durationMs = Date.now() - startedAt.getTime();
  return result;
}
