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
import { scrapeUrlUniversal, COMPANY_EVENT_PAGES } from './adapters/universal';
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

const DEFAULTS: Required<PipelineOptions> = {
  skipLlm: false,
  // Budgets sized from a measured run: ~90 Luma and ~480 Meetup events arrive per
  // day, and Meetup's ICS supplies neither venue nor image, so it needs the larger
  // share. Enrichment is what takes the feed from 45% to ~90% image coverage.
  lumaEnrichBudget: 150,
  meetupEnrichBudget: 450,
  maxLumaCalendars: 60,
  maxMeetupGroups: 120,
  includeEventbrite: true,
  includeCompanyPages: true,
  prune: true,
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
async function loadDiscovered(kind: string): Promise<DiscoveredSource[]> {
  try {
    await connectDB();
    const rows = await Source.find({ kind, enabled: true })
      .select('name handle')
      .lean();
    return (rows as Array<{ name?: string; handle?: string }>)
      .filter(row => row.handle)
      .map(row => ({ kind, handle: row.handle!, label: row.name || row.handle! }));
  } catch {
    return [];
  }
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

  // ── 1. City-level feeds (also the discovery engines) ──────────────────────
  console.log('Scraping city feeds…');
  if (isEnabled('https://luma.com/bengaluru')) {
    await runSource(
      { id: 'luma-city', label: 'Luma — Bengaluru', type: 'api', url: 'https://luma.com/bengaluru' },
      () => scrapeLumaCity('bengaluru'),
      collector
    );
  }
  if (isEnabled('https://www.meetup.com/find/')) {
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
  const lumaCalendars = (await loadDiscovered('luma-calendar')).slice(0, opts.maxLumaCalendars);
  const meetupGroupsFromDb = await loadDiscovered('meetup-group');

  const meetupSlugs = [
    ...new Set([...meetupGroupsFromDb.map(d => d.handle), ...SEED_MEETUP_GROUPS]),
  ]
    .filter(slug => isEnabled(slug, `https://www.meetup.com/${slug}/`))
    .slice(0, opts.maxMeetupGroups);

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
  ];
  if (opts.includeEventbrite) {
    platformSources.push([
      { id: 'eventbrite', label: 'Eventbrite — Bengaluru', type: 'scrape', url: 'https://www.eventbrite.com/d/india--bengaluru/all-events/' },
      () => scrapeEventbrite(),
    ]);
  }

  for (const [descriptor, run] of platformSources) {
    if (!isEnabled(descriptor.url)) continue;
    await runSource(descriptor, run, collector);
  }

  // ── 4. Company / community pages via the universal adapter ────────────────
  if (opts.includeCompanyPages) {
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
