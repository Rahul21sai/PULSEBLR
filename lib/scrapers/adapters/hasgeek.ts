// HasGeek adapter.
//
// WHY THIS SOURCE MATTERS: HasGeek hosts the practitioner communities this product exists
// for and that the corpus was thinnest on — Rust Bangalore, The Fifth Elephant, Rootconf,
// Functional Programming India, JSFoo, ReactFoo, Bangalore Observability Meetup, VizChitra,
// Papers We Love Bangalore, droidconIN. None of them reliably appear on Meetup or Luma, so
// before this adapter they were simply absent from the feed.
//
// MECHANISM (verified live, scripts/probe-hasgeek.ts + round2.ts):
//
//   1. SEARCH. `hasgeek.com/search?q=<term>&type=project` returns paginated JSON when
//      asked with `Accept: application/json` — the same URL serves HTML to a browser.
//      That content negotiation is why an earlier probe wrote HasGeek off as dataless:
//      /api/1/events is a 404 and the homepage is 293 KB of markup with no JSON-LD.
//      q=bangalore alone returns 336 projects across 17 pages, 282 of them Bengaluru.
//
//   2. ACCOUNT PAGES. `hasgeek.com/<account>` also content-negotiates to JSON, exposing
//      `featured_project` and `open_cfp_projects`. This is the Luma pattern: the search is
//      largely an ARCHIVE (measured: 336 projects, only 3 upcoming), while the accounts
//      keep publishing. Reading them is what makes this source forward-looking rather
//      than a one-off backfill.
//
// HONEST EXPECTED YIELD: 3-6 upcoming Bengaluru events at any moment — measured 3 at
// build time (Fifth Elephant's DPDP round table, Rootconf's Platform Engineering meetup).
// Small, but they are exactly the high-signal practitioner events the product wants, and
// the whole adapter costs about a dozen requests per run.
//
// FIELD COVERAGE, measured across 336 projects: location 100%, timezone 100%, tagline
// 100%, absolute_url 100%, account.title 100%, start_at 94%, end_at 94%,
// primary_venue 76%, bg_image 63%. Rich enough that no enrichment pass is needed.

import { RawEvent, ScrapeResult } from '../core/types';
import { fetchJson } from '../core/http';
import { truncate } from '../core/text';
import { isBengaluru } from '../core/geo';

const HASGEEK_SOURCE = 'hasgeek';
const BASE = 'https://hasgeek.com';

/**
 * Search terms. Breadth is cheap here — one request each — and different terms surface
 * different projects, the same reason the Meetup adapter fans out over keywords rather
 * than paginating.
 */
const SEARCH_TERMS = ['bangalore', 'bengaluru', 'meetup'];

/** Pages per term. 17 exist for q=bangalore, but upcoming events cluster on the first. */
const MAX_PAGES_PER_TERM = 3;

/**
 * Accounts to read directly, harvested from the search results by volume.
 *
 * Every one was verified to return HTTP 200 JSON. `blrsystems` is deliberately absent:
 * it 404s, so the real slug for Bengaluru Systems Meetup is something else and guessing
 * is what this project has repeatedly proven does not work.
 */
export const HASGEEK_SEED_ACCOUNTS = [
  'fifthelephant',          // The Fifth Elephant — data/ML, 77 projects
  'rootconf',               // Rootconf — infra/DevOps/SRE, 77 projects
  'rustbangalore',          // Rust Bangalore — the one 0/35 Meetup slug guesses missed
  'jsfoo',                  // JSFoo — JavaScript
  'fpindia',                // Functional Programming India
  'VizChitra',              // VizChitra — data visualisation
  'anthillinside',          // Anthill Inside — applied ML

  // Resolved from the search results by scripts/probe-hasgeek-accounts.ts, which harvests
  // slugs rather than guessing them. That mattered: `blrsystems` was a hand-guessed 404,
  // and the real slug is `bengalurusystemsmeetup`. 33 of 34 harvested accounts return JSON.
  'bengalurusystemsmeetup', // Bengaluru Systems Meetup — the 404 guess, corrected
  'pwl_bangalore',          // Papers We Love Bangalore — CS papers, reading group
  'spcblr',                 // South Park Commons Bangalore
  'open_source_ai',         // Open Source AI Community
  'wcblr',                  // WordCamp Bengaluru — WordPress/open source

  // DELIBERATELY NOT SEEDED, though they resolve: rustpune, keralars, gdgraipur, lucknow,
  // eventmanagementdelhi, TMBC (Madras), SHRMIndia, SHRM__MENA_UAE, fosscell (NIT Calicut)
  // and homebrew. None are Bengaluru communities, so every event they publish would be
  // geo-gated out — the request is spent to import nothing. `socbangalore` ("SOC 2
  // certification in Bangalore") and `help` are not communities at all.
];

interface HasgeekProject {
  title?: string;
  start_at?: string;
  end_at?: string;
  location?: string;
  timezone?: string;
  tagline?: string;
  bg_image?: string;
  buy_tickets_url?: string;
  absolute_url?: string;
  primary_venue?: {
    title?: string;
    city?: string;
    address1?: string;
    address2?: string;
    coordinates?: [number, number] | null;
  } | null;
  account?: { title?: string; logo_url?: string; absolute_url?: string };
}

interface SearchResponse {
  results?: {
    count?: number;
    pages?: number;
    items?: Array<{ obj?: HasgeekProject }>;
  };
}

interface AccountResponse {
  featured_project?: HasgeekProject | null;
  open_cfp_projects?: HasgeekProject[] | null;
  draft_projects?: HasgeekProject[] | null;
}

/** HasGeek serves JSON from the same URLs it serves HTML from, given this header. */
const JSON_HEADERS = { Accept: 'application/json' };

/**
 * Convert a project to a RawEvent, or null if it cannot be one.
 *
 * Rejects anything without a parseable start, anything already finished, and anything the
 * geo gate positively places outside Bengaluru. A project with no location signal at all
 * is KEPT: it was reached through a Bengaluru-scoped search, so the city is already
 * evidence, and the pipeline geo-gates again downstream.
 */
function toRawEvent(project: HasgeekProject): RawEvent | null {
  const title = (project.title || '').trim();
  const start = project.start_at ? new Date(project.start_at) : null;
  if (!title || !start || Number.isNaN(start.getTime())) return null;

  const end = project.end_at ? new Date(project.end_at) : undefined;
  // Finished events are the archive, which is 99% of what search returns.
  const finished = (end && end.getTime() < Date.now()) || start.getTime() < Date.now();
  if (finished) return null;

  const venue = project.primary_venue;
  const url = project.absolute_url || BASE;

  /**
   * Everything that can name a city, not just the location field.
   *
   * HasGeek's `location` is free text and frequently useless: "Rust Pune Meetup: August
   * 2026" ships `location: "TBD"` with `primary_venue: null`, so on the location alone it
   * is indistinguishable from a Bengaluru event. The city is stated three other places —
   * the title, the account name ("Rust Pune"), and the URL slug (/rustpune/) — and all
   * three are real evidence.
   *
   * The URL slug is included with its separators stripped to spaces, because `rustpune`
   * as one word would not match a \bpune\b hint.
   */
  const geoHints = [
    project.location,
    venue?.title,
    venue?.city,
    venue?.address1,
    title,
    project.account?.title,
    url.replace(`${BASE}/`, '').replace(/[/_-]+/g, ' '),
  ]
    .filter(Boolean)
    .join(', ');

  // Passed as `address`, NOT as `text`. Those take different branches: `address` reaches
  // the branch that REJECTS a string naming another city, while `text` is the weakest
  // signal and returns null (unknown, therefore kept) for anything without a positive
  // Bengaluru mention. Searching q=meetup surfaces plenty of Pune, Hyderabad and Chennai
  // events, so the difference is whether they end up in a Bengaluru feed.
  //
  // `false` means positively somewhere else; `null` means unknown, which is kept, because
  // a project reached through a Bengaluru-scoped search already carries city evidence and
  // the pipeline geo-gates again downstream.
  if (isBengaluru({ address: geoHints, city: venue?.city, venue: venue?.title }) === false) {
    return null;
  }

  const coords = venue?.coordinates;

  return {
    title,
    // tagline is present on 100% of projects and is a real one-line summary, which is
    // more than several other adapters manage.
    description: truncate(project.tagline || title, 600),
    sourceUrl: url,
    source: HASGEEK_SOURCE,
    // The URL path is stable and unique per project, so it works as the platform id.
    sourceEventId: url.replace(`${BASE}/`, '').replace(/\/$/, '') || undefined,
    organizer: project.account?.title?.trim() || undefined,
    hostAvatarUrl: project.account?.logo_url || undefined,
    venue: venue?.title?.trim() || undefined,
    address: [venue?.address1, venue?.address2].filter(Boolean).join(', ') || undefined,
    city: venue?.city?.trim() || undefined,
    lat: Array.isArray(coords) ? coords[0] : undefined,
    lng: Array.isArray(coords) ? coords[1] : undefined,
    startDateTime: start,
    endDateTime: end && !Number.isNaN(end.getTime()) ? end : undefined,
    timezone: project.timezone || undefined,
    imageUrl: project.bg_image || undefined,
    applyLink: project.buy_tickets_url || url,
    // Hybrid/online is stated in the location string rather than a field.
    rawFormat: /\bonline\b/i.test(project.location || '')
      ? 'online'
      : /\bhybrid\b/i.test(project.location || '')
        ? 'hybrid'
        : 'offline',
  };
}

/** Scrape HasGeek: search fan-out plus the seeded account pages. */
export async function scrapeHasgeek(): Promise<ScrapeResult> {
  const startedAt = new Date();
  const result: ScrapeResult = {
    sourceId: 'hasgeek',
    label: 'HasGeek — Rust Bangalore, Fifth Elephant, Rootconf',
    events: [],
    errors: [],
    startedAt,
    durationMs: 0,
  };

  // Collapse on URL: the same project appears under several search terms and again on
  // its account page.
  const byUrl = new Map<string, RawEvent>();

  const keep = (project: HasgeekProject | null | undefined) => {
    if (!project) return;
    const event = toRawEvent(project);
    if (event && !byUrl.has(event.sourceUrl)) byUrl.set(event.sourceUrl, event);
  };

  // ── 1. Search fan-out ─────────────────────────────────────────────────────
  for (const term of SEARCH_TERMS) {
    for (let page = 1; page <= MAX_PAGES_PER_TERM; page++) {
      const url =
        `${BASE}/search?q=${encodeURIComponent(term)}&type=project&page=${page}`;
      try {
        const data = await fetchJson<SearchResponse>(url, {
          timeoutMs: 25000,
          retries: 2,
          headers: JSON_HEADERS,
        });
        const items = data.results?.items ?? [];
        if (items.length === 0) break; // past the last page
        for (const item of items) keep(item.obj);
      } catch (err) {
        result.errors.push(
          `search "${term}" p${page}: ${err instanceof Error ? err.message : String(err)}`
        );
        break;
      }
    }
  }

  // ── 2. Account pages — the forward-looking half ────────────────────────────
  for (const account of HASGEEK_SEED_ACCOUNTS) {
    try {
      const data = await fetchJson<AccountResponse>(`${BASE}/${account}`, {
        timeoutMs: 20000,
        retries: 1,
        headers: JSON_HEADERS,
      });
      keep(data.featured_project);
      for (const project of data.open_cfp_projects ?? []) keep(project);
      // draft_projects are deliberately ignored: unpublished by the organiser.
    } catch (err) {
      result.errors.push(
        `account ${account}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  result.events = [...byUrl.values()];
  result.durationMs = Date.now() - startedAt.getTime();
  return result;
}
