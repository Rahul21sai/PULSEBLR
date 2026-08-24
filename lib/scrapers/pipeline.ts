// The scrape pipeline.
//
// Stages: DISCOVER → SCRAPE → ENRICH → NORMALIZE+TAG → INGEST → PRUNE
//
// Two design decisions worth keeping:
//
//  1. DISCOVERY IS PERSISTED. Luma host calendars and Meetup groups found in one
//     run are written to the Source collection and scraped directly on every later
//     run. Coverage therefore compounds instead of being capped by a hand-written
//     list, and company/community calendars (Razorpay Rize, Lyzr, The Product
//     Folks, GDG chapters) arrive without anyone maintaining them.
//
//  2. EVERY SOURCE IS ISOLATED. A source runs inside its own try/catch, records
//     its own health, and can only ever contribute zero events on failure. One
//     dead feed can never take down a run — that was the failure mode where a
//     single NVIDIA timeout or a 404 zeroed out the whole day.

import connectDB from '../mongodb';
import Source from '../models/Source';
import Event from '../models/Event';
import { RawEvent, ScrapeResult, DiscoveredSource } from './core/types';
import { mapPool } from './core/http';
import {
  scrapeLumaCity,
  scrapeLumaCalendar,
  enrichLumaDescriptions,
  LUMA_SEED_CALENDARS,
} from './adapters/luma';
import {
  scrapeMeetupCity,
  scrapeMeetupGroup,
  enrichMeetupEvents,
  SEED_MEETUP_GROUPS,
} from './adapters/meetup';
import { scrapeEventbrite } from './adapters/eventbrite';
import { scrapeBevy } from './adapters/bevy';
import { scrapeDevfolio, DEVFOLIO_URL } from './adapters/devfolio';
import { scrapeUnstop } from './adapters/unstop';
import { scrapeAllEvents } from './adapters/allevents';
import { scrapeDevEvents, DEVEVENTS_SOURCE_URL } from './adapters/devevents';
import { scrapeHasgeek } from './adapters/hasgeek';
import { scrapeFossUnited } from './adapters/fossunited';
import { scrapeDistrict, DISTRICT_SOURCE_URL } from './adapters/district';
import { scrapeUrlUniversal, COMPANY_EVENT_PAGES } from './adapters/universal';
import { offCityReason } from './core/geo';
import { normalizeEvents } from './normalizer';
import { ingestEvents, IngestionResult, updateSource } from './ingestion';

export interface PipelineOptions {
  /** Skip the LLM and use keyword tagging only (fast local runs). */
  skipLlm?: boolean;
  /** Max Luma event pages fetched for descriptions. */
  lumaEnrichBudget?: number;
  /** Max Meetup event pages fetched for venue/image. */
  meetupEnrichBudget?: number;
  /** Cap on discovered Luma calendars scraped per run. */
  maxLumaCalendars?: number;
  /** Cap on Meetup groups scraped per run. */
  maxMeetupGroups?: number;
  /** Include the slower Eventbrite crawl. */
  includeEventbrite?: boolean;
  /** Include the company-page sweep via the universal adapter. */
  includeCompanyPages?: boolean;
  /** Delete events that stopped appearing and are now in the past. */
  prune?: boolean;
  /**
   * Restrict the run to these source ids (`district`, `hasgeek`, `luma-city`,
   * `meetup-groups`, `company-pages`, …). Empty means every source, which is the
   * normal path — the daily cron never sets this.
   *
   * This exists because verifying a NEW adapter end-to-end otherwise costs a full run:
   * ~700 upstream requests and 5-10 minutes to exercise one feed. It is also the honest
   * way to re-ingest a single source after fixing its parser.
   *
   * SETTING THIS FORCES `prune` OFF, and that is not a convenience. `pruneStale()` deletes
   * any past event no source has reported for a week; the sources that did not run this
   * time cannot report theirs, so a partial run must never be allowed to reach the pruner.
   * Today's 7-day grace would usually absorb it, but "usually" is not a guarantee to build
   * a delete on.
   */
  onlySources?: string[];
}

export interface SourceReport {
  sourceId: string;
  label: string;
  events: number;
  errors: number;
  durationMs: number;
  firstError?: string;
}

export interface PipelineResult {
  totalScraped: number;
  uniqueRaw: number;
  totalNormalized: number;
  ingestion: IngestionResult;
  sources: SourceReport[];
  discovered: { lumaCalendars: number; meetupGroups: number };
  enrichment: { lumaDescriptions: number; meetupEvents: number };
  pruned: number;
  errors: string[];
  durationMs: number;
  timestamp: Date;
}

/**
 * Exported so diagnostics report the REAL caps rather than a mirrored copy.
 *
 * `scripts/diag-source-caps.ts` kept its own `MAX_MEETUP_GROUPS = 120` with a comment saying it
 * mirrored this object, and it went stale the moment the cap was raised — so the script that
 * exists to detect silently-dropped sources was itself silently reporting the wrong cap. Second
 * time a duplicated constant drifted within this session (see `CATEGORY_KEYWORDS`). A diagnostic
 * that mirrors the value it checks eventually checks the mirror.
 */
export const DEFAULTS: Required<PipelineOptions> = {
  skipLlm: false,
  // Budgets sized from a measured run: ~90 Luma and ~480 Meetup events arrive per
  // day, and Meetup's ICS supplies neither venue nor image, so it needs the larger
  // share. Enrichment is what takes the feed from 45% to ~90% image coverage.
  lumaEnrichBudget: 150,
  // Raised 450 → 800 because the group cap fix changed the input volume this is sized against.
  // The old figure was measured when ~480 Meetup events arrived per day; scraping 221 groups
  // instead of 120 brings ~931, and the budget was being exhausted exactly at 450 — which showed
  // up as cover-image coverage falling 83% → 77%. Meetup's ICS carries neither venue nor image,
  // so enrichment is the ONLY thing that gets them, and a cover is one of the four fields the
  // event card renders. Costs one event-page fetch each, so this is the expensive knob in the
  // run; re-check with diag-scorecard.ts ("Feed data the UI renders") before raising it further.
  //
  // THIS KNOB ALSO GOVERNS THE RECALL OF THE STAGE-5c CITY GATE, which is not obvious from
  // either end and is why it is written down here rather than only in geo.ts. Meetup's ICS
  // carries no LOCATION, so enrichment is what fills venue/address/city/coords — and
  // `enrichMeetupEvents` builds its candidate list by sorting ascending on start date and THEN
  // truncating to the budget. So the overflow is not a random sample: it is specifically the
  // furthest-future events, and each one reaches stage 5c with no city, no venue and no
  // address, leaving only its title to be judged on. At 800 against ~931 Meetup events that
  // tail is real. Lowering this number silently lowers off-city recall on the largest source in
  // the corpus; it does not merely cost cover images.
  meetupEnrichBudget: 800,
  // Sized ABOVE the known set with headroom, because discovery compounds and a cap that bites
  // is a permanent blind spot (see loadDiscovered). Measured 2026-08-23: 200 Meetup groups and
  // 55 Luma calendars known. A Meetup group costs exactly ONE request (its ICS feed), so
  // raising 120 → 260 adds ~80 requests to a run that already makes ~700 — cheap next to
  // never scraping Microsoft Reactor or OWASP Bangalore again.
  maxLumaCalendars: 120,
  maxMeetupGroups: 260,
  includeEventbrite: true,
  includeCompanyPages: true,
  prune: true,
  onlySources: [],
};

/** URLs the user has switched off in Settings. Fail-open: unknown ⇒ enabled. */
async function disabledUrls(): Promise<Set<string>> {
  try {
    await connectDB();
    const rows = await Source.find({ enabled: false }).select('url handle').lean();
    const set = new Set<string>();
    for (const row of rows as Array<{ url?: string; handle?: string }>) {
      if (row.url) set.add(row.url);
      if (row.handle) set.add(row.handle);
    }
    return set;
  } catch (error) {
    console.warn(
      `Could not load disabled sources (scraping all): ${error instanceof Error ? error.message : String(error)}`
    );
    return new Set();
  }
}

/** Persist newly discovered sources so later runs scrape them directly. */
async function persistDiscovered(discovered: DiscoveredSource[]): Promise<number> {
  if (discovered.length === 0) return 0;
  await connectDB();

  let added = 0;
  for (const item of discovered) {
    try {
      const url =
        item.kind === 'luma-calendar'
          ? `https://luma.com/calendar/${item.handle}`
          : item.kind === 'meetup-group'
            ? `https://www.meetup.com/${item.handle}/`
            : item.handle;

      const outcome = await Source.updateOne(
        { kind: item.kind, handle: item.handle },
        {
          $set: { name: item.label, url, type: item.kind === 'meetup-group' ? 'ical' : 'api' },
          $setOnInsert: {
            enabled: true,
            scrapeFrequency: 'daily',
            discoveredAt: new Date(),
            consecutiveEmptyScrapes: 0,
          },
        },
        { upsert: true }
      );
      if (outcome.upsertedCount > 0) added++;
    } catch {
      // A racing upsert on the unique (kind,handle) index is harmless.
    }
  }
  return added;
}

/** Previously discovered sources of a given kind, minus any the user disabled. */
/**
 * Load every discovered source of a kind, ORDERED BY EXPECTED YIELD.
 *
 * The order matters because callers `.slice(0, cap)` the result, and discovery is designed to
 * compound — the known set only grows, so sooner or later it passes the cap. Measured
 * 2026-08-23 with scripts/diag-source-caps.ts: 200 Meetup groups known against a cap of 120,
 * so 80 were dropped. Silently, with no log line and no health signal, and — because the
 * previous query had no sort and Mongo returned a stable order — it was the SAME 80 on every
 * run. A permanent blind spot, not a rotation, and indistinguishable in the feed from 80
 * groups with nothing scheduled.
 *
 * What was in that tail: `microsoft-reactor-bengaluru`, `microsoft-365ug`,
 * `owasp-bangalore-chapter`, `lfdt-bengaluru` (Linux Foundation) and `makers-tribe` — company
 * events, security and makers, i.e. precisely the coverage that looked like a supply gap.
 *
 * Ordering, best first:
 *   1. never scraped — a new discovery must get its first look, or it can never prove itself
 *   2. produced events last time, most productive first
 *   3. quiet, fewest consecutive empty scrapes first
 *   4. long dead — the only sensible thing to drop
 */
async function loadDiscovered(kind: string): Promise<DiscoveredSource[]> {
  try {
    await connectDB();
    const rows = await Source.find({ kind, enabled: true })
      .select('name handle lastScrapedAt lastEventCount consecutiveEmptyScrapes')
      .lean();

    type Row = {
      name?: string;
      handle?: string;
      lastScrapedAt?: Date;
      lastEventCount?: number;
      consecutiveEmptyScrapes?: number;
    };

    const rank = (row: Row): number => {
      if (!row.lastScrapedAt) return 0; // never scraped
      if ((row.lastEventCount ?? 0) > 0) return 1; // productive
      return 2; // empty last time
    };

    return (rows as Row[])
      .filter(row => row.handle)
      .sort((a, b) => {
        const byRank = rank(a) - rank(b);
        if (byRank !== 0) return byRank;
        // Within "productive", more events first. Within "empty", fewer dead runs first.
        const byYield = (b.lastEventCount ?? 0) - (a.lastEventCount ?? 0);
        if (byYield !== 0) return byYield;
        return (a.consecutiveEmptyScrapes ?? 0) - (b.consecutiveEmptyScrapes ?? 0);
      })
      .map(row => ({ kind, handle: row.handle!, label: row.name || row.handle! }));
  } catch {
    return [];
  }
}

/**
 * Apply a per-run cap and SAY SO when it bites.
 *
 * The whole defect above was that the drop was silent. A cap is a legitimate cost control; a
 * cap you cannot see in the logs is a coverage bug that presents as a supply problem.
 */
function applyCap<T>(items: T[], cap: number, label: string, errors: string[]): T[] {
  if (items.length <= cap) return items;
  const message = `${label}: capped at ${cap} of ${items.length} — ${items.length - cap} not scraped this run (lowest expected yield first)`;
  console.log(`  ! ${message}`);
  errors.push(message);
  return items.slice(0, cap);
}

/** Run one source with isolation + health recording. */
async function runSource(
  descriptor: { id: string; label: string; type: string; url: string },
  run: () => Promise<ScrapeResult>,
  collector: { events: RawEvent[]; reports: SourceReport[]; errors: string[]; discovered: DiscoveredSource[] }
): Promise<void> {
  try {
    const result = await run();
    collector.events.push(...result.events);
    if (result.discovered?.length) collector.discovered.push(...result.discovered);

    collector.reports.push({
      sourceId: result.sourceId,
      label: result.label,
      events: result.events.length,
      errors: result.errors.length,
      durationMs: result.durationMs,
      firstError: result.errors[0],
    });
    collector.errors.push(...result.errors.map(e => `${result.label}: ${e}`));

    await updateSource(descriptor.label, descriptor.type, descriptor.url, {
      eventCount: result.events.length,
      // Only record an error when the source produced NOTHING. A source that
      // returned 40 events and logged one bad record is healthy, and flagging it
      // would train the reader to ignore the health report.
      error: result.events.length === 0 ? result.errors[0] : undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    collector.errors.push(`${descriptor.label}: ${message}`);
    collector.reports.push({
      sourceId: descriptor.id,
      label: descriptor.label,
      events: 0,
      errors: 1,
      durationMs: 0,
      firstError: message,
    });
    await updateSource(descriptor.label, descriptor.type, descriptor.url, {
      eventCount: 0,
      error: message,
    });
  }
}

/**
 * Delete events that have gone stale: their start time has passed AND no source
 * has reported them for a week. Past events are kept for a while on purpose —
 * the tracker references them and users look back at what they attended.
 */
async function pruneStale(): Promise<number> {
  await connectDB();
  const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const outcome = await Event.deleteMany({
    startDateTime: { $lt: cutoff },
    lastSeenAt: { $lt: cutoff },
  });
  return outcome.deletedCount || 0;
}

export async function runPipeline(options: PipelineOptions = {}): Promise<PipelineResult> {
  const opts = { ...DEFAULTS, ...options };
  const startedAt = Date.now();
  const timestamp = new Date();

  console.log('Starting scrape pipeline…');

  const collector = {
    events: [] as RawEvent[],
    reports: [] as SourceReport[],
    errors: [] as string[],
    discovered: [] as DiscoveredSource[],
  };

  const disabled = await disabledUrls();
  const isEnabled = (...keys: string[]) => !keys.some(key => disabled.has(key));

  /**
   * Source-id gate for `onlySources`. Empty list ⇒ everything runs, which is the daily path.
   * See PipelineOptions.onlySources for why this also disables pruning.
   */
  const only = new Set(opts.onlySources ?? []);
  const wants = (id: string) => only.size === 0 || only.has(id);
  if (only.size > 0) {
    console.log(`Restricted run: ${[...only].join(', ')} (pruning disabled)`);
    opts.prune = false;
  }

  // ── 1. City-level feeds (also the discovery engines) ──────────────────────
  console.log('Scraping city feeds…');
  if (wants('luma-city') && isEnabled('https://luma.com/bengaluru')) {
    await runSource(
      { id: 'luma-city', label: 'Luma — Bengaluru', type: 'api', url: 'https://luma.com/bengaluru' },
      () => scrapeLumaCity('bengaluru'),
      collector
    );
  }
  if (wants('meetup-city') && isEnabled('https://www.meetup.com/find/')) {
    await runSource(
      { id: 'meetup-city', label: 'Meetup — Bengaluru search', type: 'scrape', url: 'https://www.meetup.com/find/' },
      () => scrapeMeetupCity(),
      collector
    );
  }

  // Persist what discovery just found, then load the FULL historical set so this
  // run benefits from every calendar/group ever discovered.
  // Seed the verified company/community calendars before loading, so they persist
  // and get scraped even when they have nothing in the current city window.
  await persistDiscovered(
    LUMA_SEED_CALENDARS.map(c => ({ kind: 'luma-calendar', handle: c.handle, label: c.label }))
  );
  const newlyDiscovered = await persistDiscovered(collector.discovered);
  const lumaCalendars = wants('luma-calendars')
    ? applyCap(await loadDiscovered('luma-calendar'), opts.maxLumaCalendars, 'Luma calendars', collector.errors)
    : [];
  const meetupGroupsFromDb = wants('meetup-groups') ? await loadDiscovered('meetup-group') : [];

  // Seeds go FIRST: they are hand-verified, so they must never be the ones a cap drops.
  // loadDiscovered has already ordered the rest by expected yield.
  const meetupSlugs = !wants('meetup-groups')
    ? []
    : applyCap(
        [...new Set([...SEED_MEETUP_GROUPS, ...meetupGroupsFromDb.map(d => d.handle)])].filter(slug =>
          isEnabled(slug, `https://www.meetup.com/${slug}/`)
        ),
        opts.maxMeetupGroups,
        'Meetup groups',
        collector.errors
      );

  console.log(
    `Discovery: ${newlyDiscovered} new source(s); scraping ${lumaCalendars.length} Luma calendars + ${meetupSlugs.length} Meetup groups`
  );

  // ── 2. Per-host feeds, concurrently ───────────────────────────────────────
  // Health is recorded PER CALENDAR, not only as an aggregate. Without this, every
  // discovered source showed "Not scraped yet" in Settings — 147 of 198 rows — which
  // made a healthy scraper look broken and hid which specific calendar had died.
  const calendarResults = await mapPool(lumaCalendars, 6, async cal => {
    const one = await scrapeLumaCalendar(cal.handle, cal.label);
    await updateSource(cal.label, 'api', `https://luma.com/calendar/${cal.handle}`, {
      eventCount: one.events.length,
      error: one.events.length === 0 ? one.errors[0] : undefined,
    });
    return one;
  });
  let calendarEvents = 0;
  let calendarErrors = 0;
  for (const result of calendarResults) {
    if (!result) continue;
    collector.events.push(...result.events);
    calendarEvents += result.events.length;
    calendarErrors += result.errors.length;
  }
  collector.reports.push({
    sourceId: 'luma-calendars',
    label: `Luma — ${lumaCalendars.length} host calendars`,
    events: calendarEvents,
    errors: calendarErrors,
    durationMs: 0,
  });

  if (meetupSlugs.length > 0) {
    // Per-group health, for the same reason as the Luma calendars above: the
    // aggregate row alone cannot tell you WHICH group stopped producing.
    const groupResults = await mapPool(meetupSlugs, 8, async slug => {
      const one = await scrapeMeetupGroup(slug);
      await updateSource(slug.replace(/-/g, ' '), 'ical', `https://www.meetup.com/${slug}/`, {
        eventCount: one.events.length,
        error: one.events.length === 0 ? one.errors[0] : undefined,
      });
      return one;
    });

    let groupEvents = 0;
    let groupErrors = 0;
    for (const one of groupResults) {
      if (!one) continue;
      collector.events.push(...one.events);
      groupEvents += one.events.length;
      groupErrors += one.errors.length;
      collector.errors.push(...one.errors.map(e => `${one.sourceId}: ${e}`));
    }
    collector.reports.push({
      sourceId: 'meetup-groups',
      label: `Meetup — ${meetupSlugs.length} groups`,
      events: groupEvents,
      errors: groupErrors,
      durationMs: 0,
    });
  }

  // ── 3. Remaining platforms ────────────────────────────────────────────────
  console.log('Scraping platform feeds…');
  const platformSources: Array<[{ id: string; label: string; type: string; url: string }, () => Promise<ScrapeResult>]> = [
    [{ id: 'bevy', label: 'Bevy — GDG / CNCF', type: 'api', url: 'https://gdg.community.dev' }, scrapeBevy],
    [{ id: 'devfolio', label: 'Devfolio — hackathons', type: 'api', url: DEVFOLIO_URL }, scrapeDevfolio],
    [{ id: 'unstop', label: 'Unstop', type: 'api', url: 'https://unstop.com' }, scrapeUnstop],
    [{ id: 'allevents', label: 'AllEvents.in — Bengaluru', type: 'scrape', url: 'https://allevents.in/bengaluru/all' }, scrapeAllEvents],
    [{ id: 'devevents', label: 'developers.events — conferences', type: 'api', url: DEVEVENTS_SOURCE_URL }, scrapeDevEvents],
    // HasGeek carries the practitioner communities Meetup and Luma do not: Rust
    // Bangalore, The Fifth Elephant, Rootconf, Functional Programming India, JSFoo.
    // Yield is small (2-6 upcoming) but net new, and the accounts keep publishing, so
    // it grows on its own rather than being a one-off backfill.
    [{ id: 'hasgeek', label: 'HasGeek — Fifth Elephant, Rootconf, Rust Bangalore', type: 'api', url: 'https://hasgeek.com' }, scrapeHasgeek],
    // FOSS United runs India's open-source community — the Bengaluru monthly meetup plus
    // IndiaFOSS. Extraction is from <time datetime> and Open Graph tags, which are standards
    // rather than CSS classes; see the adapter header for why the two earlier rejections of
    // this source were asking the wrong question.
    [{ id: 'fossunited', label: 'FOSS United — Bengaluru + IndiaFOSS', type: 'scrape', url: 'https://fossunited.org/c/bengaluru' }, scrapeFossUnited],
    // District (ex-Paytm Insider, now Zomato's) is the CITY-BREADTH source, not a tech one:
    // comedy, concerts, theatre, cultural festivals, runs, business networking. It exists to
    // serve "every Bengaluru event"; the tech feed is gated by isTechEvent so it cannot
    // dilute it. Costs ~27 requests because the slug pre-filter drops 287 past and 57
    // always-on listings without fetching them — see the adapter header.
    [{ id: 'district', label: 'District — Bengaluru city events', type: 'scrape', url: DISTRICT_SOURCE_URL }, scrapeDistrict],
  ];
  if (opts.includeEventbrite) {
    platformSources.push([
      { id: 'eventbrite', label: 'Eventbrite — Bengaluru', type: 'scrape', url: 'https://www.eventbrite.com/d/india--bengaluru/all-events/' },
      () => scrapeEventbrite(),
    ]);
  }

  for (const [descriptor, run] of platformSources) {
    if (!wants(descriptor.id)) continue;
    if (!isEnabled(descriptor.url)) continue;
    await runSource(descriptor, run, collector);
  }

  // ── 4. Company / community pages via the universal adapter ────────────────
  if (opts.includeCompanyPages && wants('company-pages')) {
    console.log(`Sweeping ${COMPANY_EVENT_PAGES.length} company/community pages…`);
    const pages = COMPANY_EVENT_PAGES.filter(page => isEnabled(page.url));
    const results = await mapPool(pages, 5, page =>
      scrapeUrlUniversal(page.url, {
        organizer: page.organizer,
        source: 'company',
        geoPolicy: 'require',
      }).then(async result => {
        await updateSource(`Company — ${page.organizer}`, 'scrape', page.url, {
          eventCount: result.events.length,
          error: result.events.length === 0 ? result.errors[0] : undefined,
        });
        return result;
      })
    );

    let companyEvents = 0;
    let workingPages = 0;
    for (const result of results) {
      if (!result) continue;
      collector.events.push(...result.events);
      companyEvents += result.events.length;
      if (result.events.length > 0) workingPages++;
    }
    collector.reports.push({
      sourceId: 'company-pages',
      label: `Company pages (${workingPages}/${pages.length} yielding)`,
      events: companyEvents,
      errors: pages.length - workingPages,
      durationMs: 0,
    });
  }

  const totalScraped = collector.events.length;

  // ── 5. Enrichment ─────────────────────────────────────────────────────────
  console.log('Enriching events…');
  const lumaDescriptions = await enrichLumaDescriptions(collector.events, opts.lumaEnrichBudget);
  const meetupEnriched = await enrichMeetupEvents(collector.events, opts.meetupEnrichBudget);
  console.log(
    `Enriched ${lumaDescriptions} Luma descriptions, ${meetupEnriched} Meetup events`
  );

  // ── 5b. Reject implausible listings ───────────────────────────────────────
  // Live finding: Eventbrite carries "evergreen" course listings with absurd
  // ranges — one PMP training course was published as 2015-06-30 → 2030-04-30.
  // Because the feed treats an event as still-on while its END date is in the
  // future, that single row sorted to the very top of "upcoming" and stayed there.
  // These are standing adverts, not events, so they're dropped at the source.
  const MAX_DURATION_DAYS = 30;
  const MAX_PAST_START_DAYS = 2;
  const MAX_FUTURE_START_DAYS = 550;
  const nowMs = Date.now();

  const plausible = collector.events.filter(event => {
    const start = event.startDateTime.getTime();
    if (!Number.isFinite(start)) return false;

    // Started too long ago to still be "on", regardless of what its end says.
    if (start < nowMs - MAX_PAST_START_DAYS * 24 * 3600 * 1000) return false;
    // Implausibly far out — almost always a placeholder or a parsing error.
    if (start > nowMs + MAX_FUTURE_START_DAYS * 24 * 3600 * 1000) return false;

    if (event.endDateTime) {
      const durationDays = (event.endDateTime.getTime() - start) / (24 * 3600 * 1000);
      // A negative duration is a parse error; a month-plus "event" is a standing
      // listing. Drop the end date rather than the event when only the end is odd,
      // so a real event with a sloppy end time still shows up.
      if (durationDays < 0 || durationDays > MAX_DURATION_DAYS) {
        event.endDateTime = undefined;
      }
    }
    return true;
  });

  const rejected = collector.events.length - plausible.length;
  if (rejected > 0) console.log(`Rejected ${rejected} implausible listing(s)`);
  collector.events = plausible;

  // ── 5c. Reject events in another city ─────────────────────────────────────
  // The product is one city, and a wrong-city event is not noise a filter can rescue: no
  // category and no `techOnly` toggle expresses "not in Bengaluru", so it sits in the feed
  // looking exactly like a real option. Measured 2026-08-24 with scripts/diag-offcity.ts: 29
  // upcoming events belonged to another city, and 10 of them were flagged isTechEvent — so
  // they were in the DEFAULT feed. Six named their city in the TITLE alone ("Chennai - Build
  // Your First AI Agent"), which is why the per-adapter gate missed them: `isBengaluru()` reads
  // coordinates and location fields, never the title, and returns null when there is nothing to
  // judge on — a verdict adapters must accept, because Meetup's ICS carries no LOCATION at all.
  //
  // HERE rather than in each adapter, because the leak was not one source's bug: the same
  // Meetup group listing produces a Chennai row from the ICS feed and a Chennai row from the
  // city fan-out. And BEFORE tagging (stage 7), so an off-city listing also costs no LLM call.
  //
  // The gate rejects only on a POSITIVE signal of another city — see lib/scrapers/core/geo.ts
  // for why requiring a positive Bengaluru match instead would delete most of the corpus, and
  // tests/off-city.test.ts for the false positives it is built to survive.
  const offCity: string[] = [];
  const inCity = collector.events.filter(event => {
    const verdict = offCityReason(event);
    if (!verdict) return true;
    offCity.push(`${verdict.city} (${verdict.field}): ${event.title}`);
    return false;
  });
  if (offCity.length > 0) {
    // Named, not just counted. A silent drop is the failure mode this pipeline has already been
    // bitten by twice (the source cap, the enrichment budget), and this one DELETES events.
    // Deliberately NOT pushed to collector.errors: off-city rejections happen on every run, and
    // a permanent entry in the error list is how a health report gets ignored.
    console.log(`Rejected ${offCity.length} off-city listing(s):`);
    for (const entry of offCity.slice(0, 12)) console.log(`  ! ${entry.slice(0, 110)}`);
    if (offCity.length > 12) console.log(`  ! … and ${offCity.length - 12} more`);
  }
  collector.events = inCity;

  // ── 6. Collapse obvious in-run repeats before paying for LLM tagging ──────
  // Adapters overlap heavily (a Luma event appears in both the city feed and its
  // host calendar). Tagging the same event five times is pure waste, so collapse
  // on canonical URL + start instant first. Cross-source fuzzy matching still
  // happens at ingest via clusterKey.
  const byKey = new Map<string, RawEvent>();
  for (const event of collector.events) {
    const key = `${event.sourceUrl}|${event.startDateTime.getTime()}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, event);
      continue;
    }
    // Keep whichever copy carries more information.
    const score = (e: RawEvent) =>
      (e.imageUrl ? 2 : 0) + (e.venue ? 1 : 0) + (e.description.length > e.title.length ? 2 : 0);
    if (score(event) > score(existing)) byKey.set(key, event);
  }
  const uniqueRaw = [...byKey.values()];
  console.log(`${totalScraped} scraped → ${uniqueRaw.length} unique before tagging`);

  // ── 7. Normalize + tag ────────────────────────────────────────────────────
  console.log('Normalizing and tagging…');
  if (opts.skipLlm) {
    // The tagger reads this and returns keyword tagging only.
    process.env.PULSEBLR_SKIP_LLM = '1';
  }
  const normalized = await normalizeEvents(uniqueRaw);

  // ── 8. Ingest ─────────────────────────────────────────────────────────────
  console.log(`Ingesting ${normalized.length} events…`);
  const ingestion = await ingestEvents(normalized);

  // ── 9. Prune ──────────────────────────────────────────────────────────────
  let pruned = 0;
  if (opts.prune) {
    try {
      pruned = await pruneStale();
    } catch (error) {
      collector.errors.push(
        `prune failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const result: PipelineResult = {
    totalScraped,
    uniqueRaw: uniqueRaw.length,
    totalNormalized: normalized.length,
    ingestion,
    sources: collector.reports.sort((a, b) => b.events - a.events),
    discovered: {
      lumaCalendars: lumaCalendars.length,
      meetupGroups: meetupSlugs.length,
    },
    enrichment: { lumaDescriptions, meetupEvents: meetupEnriched },
    pruned,
    errors: collector.errors,
    durationMs: Date.now() - startedAt,
    timestamp,
  };

  printReport(result);
  return result;
}

function printReport(result: PipelineResult): void {
  console.log('\n───────────────── SCRAPE REPORT ─────────────────');
  for (const source of result.sources) {
    const mark = source.events > 0 ? 'ok  ' : source.errors > 0 ? 'FAIL' : 'none';
    console.log(
      `  [${mark}] ${String(source.events).padStart(4)} events  ${source.label}` +
        (source.events === 0 && source.firstError ? `\n           ↳ ${source.firstError.slice(0, 120)}` : '')
    );
  }
  const { ingestion } = result;
  console.log('  ' + '─'.repeat(46));
  console.log(`  scraped        ${result.totalScraped}`);
  console.log(`  unique         ${result.uniqueRaw}`);
  console.log(`  inserted       ${ingestion.inserted}`);
  console.log(`  updated        ${ingestion.updated}`);
  console.log(`  cross-source   ${ingestion.crossSourceMerged} merged`);
  console.log(`  duplicates     ${ingestion.duplicates}`);
  console.log(`  errors         ${ingestion.errors}`);
  console.log(`  pruned         ${result.pruned}`);
  console.log(`  duration       ${(result.durationMs / 1000).toFixed(1)}s`);
  console.log('─────────────────────────────────────────────────\n');
}

/** Back-compat entry point used by scripts/scrape.ts and /api/scrape. */
export async function runAllScrapers(): Promise<PipelineResult> {
  return runPipeline();
}
