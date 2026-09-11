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
//
//  3. NOTHING IS DROPPED SILENTLY, AND NOTHING IS FETCHED POINTLESSLY. Two ledgers
//     added 2026-09-10, both because this pipeline has now been bitten three times
//     by the same class of bug — the source cap, the enrichment budget, and the
//     Bevy "202 results" that was an index total including history and got filed as
//     a supply bug:
//
//       · A GATE LEDGER (`createGateLedger`). Every row a gate throws away is
//         charged to the source that produced it, with a reason and a few example
//         titles, and the source's health row records what SURVIVED rather than what
//         the adapter returned. "Devfolio: 0 events" and "Devfolio: 12 rows, all
//         Chennai" are opposite problems that used to print identically.
//       · A BACK-OFF SCHEDULE (`sourceSchedule`). 148 of 430 enabled sources had 15+
//         consecutive empty scrapes and were re-fetched every night for nothing.
//         They now move to weekly, then monthly. The skip is logged and reported,
//         because a limit you cannot see in the logs is a coverage bug that presents
//         as a supply problem.

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
  scrapeMeetupGroupsSweep,
  enrichMeetupEvents,
  MEETUP_ICS_CAP,
  MEETUP_PAGE_CAP,
  SEED_MEETUP_GROUPS,
  type MeetupGroupOutcome,
  type MeetupSweepSummary,
  type PageRenderer,
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
import {
  scrapeMicrosites,
  candidateToRawEvent,
  candidateToExtraction,
  fingerprintSourceEventId,
  fingerprintFromSourceEventId,
  FINGERPRINT_PREFIX,
  MICROSITE_WATCHLIST,
  DEFAULT_MAX_EXTRACTIONS,
  type MicrositeCandidate,
} from './adapters/microsite';
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
  /**
   * Follow up a Meetup group whose ICS feed came back at `MEETUP_ICS_CAP` with a read of its
   * `/events/` page, which carries up to 30.
   *
   * ON BY DEFAULT, because leaving it off is the bug: measured 2026-09-07, 74 of 261 groups sat
   * on that ceiling and ~550 upcoming events were invisible. It costs one extra plain HTTP
   * request for roughly 28% of groups (~74 of ~700 in a run) and needs no browser — see the
   * `scrapeMeetupGroupsSweep` block comment for why the audit's "this needs Playwright" was
   * wrong.
   *
   * When it is off, the run still COUNTS the truncated groups and says so in the report, so
   * turning it off cannot quietly return the corpus to a silent ceiling.
   */
  meetupSecondPass?: boolean;
  /**
   * Cap on second passes per run. Sized above the known truncated set with headroom, and it logs
   * when it bites — same rule as `maxMeetupGroups`.
   */
  maxMeetupSecondPass?: number;
  /**
   * Allow a HEADLESS BROWSER as the fallback when a group's `/events/` page yields nothing to a
   * plain fetch.
   *
   * OFF BY DEFAULT AND MUST STAY OFF ANYWHERE SERVERLESS. `app/api/scrape/route.ts` imports this
   * module, so this file is traced into a Vercel function — which cannot run Chromium. The flag
   * is honoured only by `scripts/scrape.ts` (`--render`), which runs on a GitHub runner where a
   * browser is available. `core/render.ts` is reached by a dynamic `import()` guarded on this
   * flag, and its own Playwright import is deliberately untraceable, so a bundler cannot pull a
   * ~470 MB dependency into a serverless build on the strength of a flag nobody set.
   *
   * It is expected to be UNUSED: the plain-fetch path currently answers for every group measured.
   * It exists so the day Meetup stops server-rendering its data island degrades the source
   * instead of killing it.
   */
  renderCappedGroups?: boolean;
  /** Include the slower Eventbrite crawl. */
  includeEventbrite?: boolean;
  /** Include the company-page sweep via the universal adapter. */
  includeCompanyPages?: boolean;
  /**
   * Run the company-MICROSITE pass: render a hand-curated watchlist and, where no cheaper path
   * answers, read the rendered text with a frontier model and land the result as
   * `visibility: 'pending'` for human review.
   *
   * ── OFF BY DEFAULT, AND FOR THREE INDEPENDENT REASONS ──────────────────────────────────────
   *
   *  1. IT NEEDS A BROWSER. Same constraint as `renderCappedGroups` and the same consequence:
   *     `app/api/scrape/route.ts` imports this module into a Vercel function that cannot run
   *     Chromium. Only `scripts/scrape.ts` on a GitHub runner may turn it on.
   *  2. IT SPENDS A FRONTIER MODEL PER CHANGED PAGE. ICA is the only working tier and it is
   *     shared, so this is the one stage in the pipeline whose cost is not a fetch.
   *  3. IT PRODUCES WORK FOR A HUMAN. Every candidate is a row somebody has to judge in
   *     `/admin` → Submissions. A stage that fills a review queue must be turned on by the
   *     person who will empty it.
   *
   * WHAT IT MAY AND MAY NOT WRITE. The JSON-LD half of the pass produces ordinary scraped events
   * that join the public path like any other source. The LLM half may ONLY ever write
   * `visibility: 'pending'` rows — see `landMicrositeCandidates`, which is the only writer and
   * hard-codes it. That separation is the entire reason the LLM path is permissible at all.
   */
  micrositeCandidates?: boolean;
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
   * any past SCRAPED event no source has reported for a week (hand-entered events are excluded
   * outright — see the note on `pruneStale`); the sources that did not run this
   * time cannot report theirs, so a partial run must never be allowed to reach the pruner.
   * Today's 7-day grace would usually absorb it, but "usually" is not a guarantee to build
   * a delete on.
   */
  onlySources?: string[];
  /**
   * Scrape every discovered source tonight regardless of its back-off cadence (see
   * `sourceSchedule`). Off by default, which is the whole point of the back-off.
   *
   * It exists because a cadence you cannot escape is the same class of defect as a cap you
   * cannot see: after fixing an adapter or a parser you need the quiet sources re-probed NOW,
   * not in three weeks. `onlySources` is the surgical version of the same need; this is the
   * sweep.
   */
  ignoreBackoff?: boolean;
}

/**
 * Why the gate stage threw a row away.
 *
 * Four buckets, because those are the four questions a "this source returned 0 events" report
 * cannot answer today and each implies a different fix:
 *
 *   `city`                    — off-city (stage 5c). The source works; it is national.
 *   `date-window`             — outside the plausible window (stage 5b): an evergreen advert
 *                               dated 2015→2030, or a listing 600 days out.
 *   `missing-required-field`  — no title, no URL, or an unparseable start instant. A PARSER bug,
 *                               and the one bucket that means "go read the adapter".
 *   `duplicate`              — collapsed against another copy in the same run (stage 6). Normal
 *                               and expected; Luma's city feed and a host calendar overlap by
 *                               design.
 */
export type GateReason = 'city' | 'date-window' | 'missing-required-field' | 'duplicate';

export const GATE_REASONS: readonly GateReason[] = [
  'city',
  'date-window',
  'missing-required-field',
  'duplicate',
];

/** Counts plus a few titles. Deliberately not a full log — see `GATE_EXAMPLES_PER_REASON`. */
export interface GateTally {
  count: number;
  examples: string[];
}

export type GateBreakdown = Partial<Record<GateReason, GateTally>>;

/**
 * How many example titles to keep per source per reason.
 *
 * Three. A count alone cannot be argued with ("12 rejected on city" — which city? whose bug?),
 * and a full log of every rejected row on every source is how a report gets ignored — the exact
 * failure mode the off-city stage's own 12-line cap already guards against.
 */
const GATE_EXAMPLES_PER_REASON = 3;

export interface SourceReport {
  sourceId: string;
  label: string;
  events: number;
  errors: number;
  durationMs: number;
  firstError?: string;
  /**
   * What the gate stage removed from THIS source's contribution, by reason. Absent when the
   * source lost nothing.
   */
  rejected?: GateBreakdown;
}

/** One source the back-off schedule chose not to fetch tonight. */
export interface SkippedSource {
  kind: string;
  handle: string;
  cadence: ScrapeCadence;
  consecutiveEmptyScrapes: number;
  ageDays: number | null;
}

export interface PipelineResult {
  totalScraped: number;
  uniqueRaw: number;
  totalNormalized: number;
  ingestion: IngestionResult;
  sources: SourceReport[];
  discovered: { lumaCalendars: number; meetupGroups: number };
  enrichment: { lumaDescriptions: number; meetupEvents: number };
  /** Rows the gate stage removed, summed across every source. */
  gates: GateBreakdown;
  /** What the Meetup ICS ceiling cost this run, and what the second pass recovered. */
  meetupTruncation: MeetupTruncationReport;
  /**
   * The company-microsite pass. `micrositeCandidates` now gates only the RENDER + LLM half, which
   * is still off by default; the JSON-LD and platform-detection halves run whenever the stage is
   * selected, because they cost one HTTP request per page and deliver GIDS and Bengaluru Tech
   * Summit. `structuredEvents` is therefore non-zero on an ordinary run and `created` is not.
   *
   * Reported as a first-class section rather than folded into `sources`, because it is the only
   * stage that produces rows a reader cannot see — a count of pending candidates belongs beside
   * the review queue that has to absorb them, not inside a list of feeds.
   */
  microsite: MicrositeReport;
  /** Sources not fetched tonight because they are on a weekly/monthly cadence. */
  backoff: { skipped: number; weekly: number; monthly: number; sources: SkippedSource[] };
  pruned: number;
  errors: string[];
  durationMs: number;
  timestamp: Date;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Back-off scheduling
//
// Discovery compounds and never shrinks, so the set of sources that produce NOTHING compounds
// too. Measured 2026-09-10 against live Atlas: 430 enabled Source rows, 200 with 5 or more
// CONSECUTIVE empty scrapes and 148 with 15 or more — 97 Meetup groups and 51 Luma calendars at
// the 5 mark. Every one of them was fetched every single night for zero events. That is ~148
// wasted upstream requests a night, on a run that makes ~700, and it is not a rate-limit
// problem: it is budget spent proving something already proved 25 times.
//
// The field this reads (`consecutiveEmptyScrapes`) was already stored and already maintained by
// `updateSource`; nothing here adds bookkeeping. What was missing was anybody consulting it.
//
// WHY A CADENCE AND NOT A CULL. A quiet Luma calendar is not a dead one — a company community
// posts in bursts, and `loadDiscovered`'s own docblock records what happened the last time
// sources were dropped rather than deprioritised: `microsoft-reactor-bengaluru` and
// `lfdt-bengaluru` looked like a supply gap for weeks. Weekly and monthly still find the burst,
// one cycle late, at 1/7th and 1/30th of the cost. Deleting a source is `cleanup-sources.ts`'s
// job and requires a human.
//
// DAILY IS UNCONDITIONALLY DUE, and that is deliberate rather than sloppy. A cadence expressed
// as "at least N days since the last fetch" would make a same-day re-run a no-op — so a run
// started to verify a fix would silently scrape nothing and look like the fix failed. Only the
// backed-off cadences consult the clock.
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type ScrapeCadence = 'daily' | 'weekly' | 'monthly';

/** Consecutive empty scrapes at which a source drops to weekly, then to monthly. */
export const BACKOFF_WEEKLY_AFTER = 5;
export const BACKOFF_MONTHLY_AFTER = 15;

const CADENCE_DAYS: Record<ScrapeCadence, number> = { daily: 0, weekly: 7, monthly: 30 };

export interface SourceScheduleInput {
  consecutiveEmptyScrapes?: number | null;
  lastScrapedAt?: Date | string | null;
}

export interface SourceScheduleVerdict {
  cadence: ScrapeCadence;
  /** Should this source be fetched in the run happening at `now`? */
  due: boolean;
  /** Whole days since the last fetch; null when never fetched. */
  ageDays: number | null;
  /** Log-ready explanation, so a skip is never silent. */
  reason: string;
}

/**
 * Decide whether a source is due tonight. PURE: no I/O, no database, no ambient clock — `now`
 * is a parameter so the truth table can be asserted (see `scripts/diag-gate-reasons.ts`).
 */
export function sourceSchedule(
  row: SourceScheduleInput,
  now: Date = new Date()
): SourceScheduleVerdict {
  // A missing, negative or NaN count is treated as zero. `consecutiveEmptyScrapes` has a schema
  // default of 0, but rows written before it existed have no key at all, and reading `undefined`
  // as "many" would back off the whole corpus at once.
  const rawEmpty = Number(row.consecutiveEmptyScrapes ?? 0);
  const empty = Number.isFinite(rawEmpty) && rawEmpty > 0 ? Math.floor(rawEmpty) : 0;

  const cadence: ScrapeCadence =
    empty >= BACKOFF_MONTHLY_AFTER ? 'monthly' : empty >= BACKOFF_WEEKLY_AFTER ? 'weekly' : 'daily';

  const lastMs = row.lastScrapedAt ? new Date(row.lastScrapedAt).getTime() : NaN;
  const ageDays = Number.isFinite(lastMs)
    ? // Clamp at 0: a lastScrapedAt in the future is clock skew, and letting it go negative
      // would block a weekly source forever rather than for one cycle.
      Math.max(0, Math.floor((now.getTime() - lastMs) / (24 * 3600 * 1000)))
    : null;

  // Never scraped wins over everything. A source that has not had its first look cannot have
  // earned a back-off, and `loadDiscovered` already orders these first for the same reason.
  if (ageDays === null) {
    return { cadence: 'daily', due: true, ageDays: null, reason: 'never scraped' };
  }
  if (cadence === 'daily') {
    return { cadence, due: true, ageDays, reason: `producing (${empty} empty in a row)` };
  }

  const needed = CADENCE_DAYS[cadence];
  const due = ageDays >= needed;
  return {
    cadence,
    due,
    ageDays,
    reason: due
      ? `${cadence} and ${ageDays}d since last fetch — due`
      : `${cadence} after ${empty} empty scrapes, last fetched ${ageDays}d ago (needs ${needed}d)`,
  };
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
  meetupSecondPass: true,
  // 74 groups were on the cap when this was measured, out of 261 known. 160 leaves room for the
  // truncated share to grow with discovery without the cap silently biting — and if it does bite,
  // `scrapeMeetupGroupsSweep` logs it and the report counts it.
  maxMeetupSecondPass: 160,
  renderCappedGroups: false,
  includeEventbrite: true,
  includeCompanyPages: true,
  // OFF. Needs a browser, spends a frontier model, and creates a review queue somebody has to
  // work through. See the option's own docblock for why each of those alone is disqualifying as a
  // default.
  micrositeCandidates: false,
  prune: true,
  onlySources: [],
  ignoreBackoff: false,
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
 *
 * It also applies the BACK-OFF SCHEDULE (`sourceSchedule`), which is a different lever from the
 * ordering above and they are easy to confuse. Ordering decides who loses a fight for a capped
 * number of slots. Back-off decides whether a source is worth a slot tonight at all. Both were
 * needed: ordering alone still fetched 148 permanently-empty sources every night, and back-off
 * alone would still let a cap drop the alphabetically unlucky.
 *
 * Skips are RETURNED, not swallowed, so the caller can log and report them. A limit you cannot
 * see in the logs is a coverage bug that presents as a supply problem — the same rule `applyCap`
 * exists to encode.
 */
interface DiscoveredLoad {
  due: DiscoveredSource[];
  skipped: SkippedSource[];
}

async function loadDiscovered(
  kind: string,
  options: { ignoreBackoff?: boolean; now?: Date } = {}
): Promise<DiscoveredLoad> {
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

    const now = options.now ?? new Date();
    const ordered = (rows as Row[])
      .filter(row => row.handle)
      .sort((a, b) => {
        const byRank = rank(a) - rank(b);
        if (byRank !== 0) return byRank;
        // Within "productive", more events first. Within "empty", fewer dead runs first.
        const byYield = (b.lastEventCount ?? 0) - (a.lastEventCount ?? 0);
        if (byYield !== 0) return byYield;
        return (a.consecutiveEmptyScrapes ?? 0) - (b.consecutiveEmptyScrapes ?? 0);
      });

    const due: DiscoveredSource[] = [];
    const skipped: SkippedSource[] = [];
    for (const row of ordered) {
      const verdict = sourceSchedule(row, now);
      if (!options.ignoreBackoff && !verdict.due) {
        skipped.push({
          kind,
          handle: row.handle!,
          cadence: verdict.cadence,
          consecutiveEmptyScrapes: row.consecutiveEmptyScrapes ?? 0,
          ageDays: verdict.ageDays,
        });
        continue;
      }
      due.push({ kind, handle: row.handle!, label: row.name || row.handle! });
    }
    return { due, skipped };
  } catch {
    return { due: [], skipped: [] };
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

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Meetup ICS truncation — the detection guard
//
// The finding this exists for: `/<group>/events/ical/` caps at ten events, 74 of 261 groups were
// sitting on that ceiling, and NOTHING SAID SO. A group silently truncated at ten is
// indistinguishable in the report, in the feed and in its Source health from a group with ten
// events. That is the same class of defect as the source cap and the enrichment budget — the
// third time this pipeline has been bitten by a limit it could not see — so the rule from
// `applyCap` applies here too: a limit you cannot see in the logs is a coverage bug that presents
// as a supply problem.
//
// WHY THIS IS NOT WRITTEN TO THE `Source` ROW. It is tempting, and `updateSource`'s `error` field
// is right there — but `flushHealth` deliberately records an error ONLY when a source contributed
// nothing, because flagging a healthy source is how a health report gets trained away. A group
// with 17 events is healthy. And a second `updateSource` call for the same row would
// double-increment `consecutiveEmptyScrapes` (see `claim`). What DOES land in the Source row is
// the fix itself: `lastEventCount` now exceeds ten, so the wall that made this finding visible in
// the first place becomes self-diagnosing — re-run `scripts/diag-meetup-cap.ts` and a group stuck
// at exactly ten is now genuinely at ten.
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface MeetupTruncationReport {
  /** Groups whose ICS came back at or above the cap. */
  suspected: number;
  /** Second passes performed. */
  secondPassRan: number;
  /** Suspected groups skipped because `maxMeetupSecondPass` bit. */
  capped: number;
  /** Events recovered that the ICS feed could not report. */
  gained: number;
  /** Rows dropped by the adapter's venue-country guard. */
  offCountry: number;
  /** Groups with more events than even the page's 30-row ceiling shows. */
  stillTruncated: number;
  /** Second passes that returned nothing — the signal the upstream shape changed. */
  empty: number;
  /** Whether the second pass ran at all this run. */
  enabled: boolean;
}

const EMPTY_TRUNCATION: MeetupTruncationReport = {
  suspected: 0,
  secondPassRan: 0,
  capped: 0,
  gained: 0,
  offCountry: 0,
  stillTruncated: 0,
  empty: 0,
  enabled: false,
};

/** What the optional headless-browser fallback offers the run, or a no-op if it is switched off. */
interface RendererHandle {
  /** Undefined when rendering is off — the adapter then simply never has a fallback. */
  render?: PageRenderer;
  /** Safe concurrency for the page pass. A browser page costs ~100 MB; an HTTP request does not. */
  pageConcurrency: number;
  close: () => Promise<void>;
  describe: () => string | undefined;
}

const NO_RENDERER: RendererHandle = {
  pageConcurrency: 5,
  close: async () => {},
  describe: () => undefined,
};

/**
 * Load `core/render.ts` — and Playwright with it — ONLY when the run asked for it.
 *
 * A DYNAMIC import, guarded on the flag, because `app/api/scrape/route.ts` imports this module
 * and is bundled for a Vercel function. A static import here would put a browser dependency into
 * a serverless build that can never use one. `core/render.ts` additionally hides its own
 * Playwright specifier from the bundler; both halves are needed, since a bundler traces dynamic
 * imports too.
 *
 * Failing to load is NOT an error: rendering is a fallback for a path that currently answers
 * without it, so the run continues with no renderer rather than dying over an optional
 * dependency.
 */
async function loadRenderer(enabled: boolean): Promise<RendererHandle> {
  if (!enabled) return NO_RENDERER;
  try {
    const mod = await import('./core/render');
    console.log('Meetup second pass: headless-browser fallback ENABLED');
    return {
      render: (url: string) => mod.renderHtml(url),
      // Drops from 5 to 2 for the whole page pass. Deliberately pessimistic: rendering is a
      // per-group fallback, so in the worst case every in-flight group renders at once, and
      // sizing for the average would OOM a small runner exactly when the upstream broke.
      pageConcurrency: mod.RENDER_CONCURRENCY,
      close: () => mod.closeRenderer(),
      describe: () => {
        const stats = mod.renderStats();
        if (stats.launchError) return `browser unavailable: ${stats.launchError}`;
        if (stats.requested === 0) return 'browser fallback not needed';
        return `browser rendered ${stats.rendered}/${stats.requested} page(s) in ${(
          stats.totalMs / 1000
        ).toFixed(1)}s`;
      },
    };
  } catch (error) {
    console.warn(
      `  ! renderCappedGroups was set but core/render.ts could not load — continuing without a browser: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return NO_RENDERER;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// COMPANY MICROSITES — the pending-candidate landing path.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THIS IS THE ONLY WRITER OF MICROSITE ROWS, AND IT HARD-CODES `visibility: 'pending'`.
//
// An LLM reading a marketing page is allowed to produce an event here for exactly one reason: it
// cannot reach a reader without a human approving it. So the stamp is not a parameter, not a
// default, and not derived from anything — it is a literal, in one function, and everything below
// is about making sure nothing else can undo it.
//
// ── AND IT WRITES ITS OWN EVIDENCE (`Event.extraction`) ──────────────────────────────────────
//
// Review is only a real safeguard if the reviewer can check the claim. A fabricated event and a
// correct one arrive with the SAME status and the same fields, so the row carries the page text the
// model read, the verbatim reply, the fingerprint and the model name — enough to judge the parse by
// eye (`scripts/diag-microsite-audit.ts`) or re-run it against a better model with no second fetch.
// The field is `select: false`, so it cannot follow an approved row into a public response; see its
// docblock in `lib/models/Event.ts`.
//
// ── WHY THE DEDUP KEYS ARE NAMESPACED, WHICH IS THE PART THAT LOOKS LIKE OVER-ENGINEERING ────
//
// `clusterKey` is normalised title + IST day with no source in it, and `ingestEvents`' three
// lookups are all scoped by `SCRAPED_ONLY = { createdByUserId: { $exists: false } }`. A microsite
// candidate has NO owner — no user typed it in — so it satisfies that scope, and `mergeInto`'s
// guard (`if (existing.createdByUserId) return false`) does not fire for it either.
//
// So an un-namespaced pending row is not a duplicate-card risk, it is SILENT LOSS of a public
// event: the scraper later finds the same conference on Luma, the cluster lookup finds the pending
// row FIRST, `mergeInto` fills it, `Event.create` is never reached, and the run counts a
// successful merge. The real event then exists only as a row nobody but an admin can see, and
// nothing reports an error. That is precisely the failure `Event.generateClusterKey`'s own docblock
// describes for hand-entered events, arriving from the one direction its `createdByUserId` guards
// cannot see.
//
// The fix is the same one that file chose, for the same stated reason — a namespaced key makes the
// row STRUCTURALLY incapable of entering a scraped cluster, so a fourth lookup written next year
// inherits the protection instead of having to remember a rule. `generateDedupHash`'s fifth
// parameter is documented as an owner id; it is a hash input, and the namespace is what an owner id
// IS here.
//
// THE COST, STATED PLAINLY, AND IT IS THE SAME TRADE: an APPROVED microsite event keeps its
// namespaced key, so if the scraper later finds the same event the city gets two cards. A visible
// duplicate rather than invisible loss — the right way round, and review is exactly where somebody
// notices the event is already in the corpus and rejects it.
//
// ── WHAT HAPPENS ON A SECOND NIGHT ───────────────────────────────────────────────────────────
//
// The namespaced `dedupHash` is stable across runs for the same page + title + start, so a page
// whose text changed but whose event did not resolves to the SAME row. Three outcomes, and the
// third is the one that matters:
//
//   · no row        → create it, pending.
//   · pending row   → refresh the fingerprint and `lastSeenAt`. The reviewer sees one item, not
//                     one per night.
//   · DECIDED row   → leave it completely alone. Approved (`visibility` absent) or rejected
//                     (`'private'`), a decision has been made, and re-creating a rejected
//                     candidate every night is how a review queue becomes something nobody opens.
//                     This is also why the lookup cannot be `{ dedupHash, visibility: 'pending' }`:
//                     it has to be able to SEE a decided row in order to respect it.
// ═════════════════════════════════════════════════════════════════════════════════════════════

export interface MicrositeReport {
  /** Pages in the watchlist that were attempted. */
  pages: number;
  /** How each page resolved, keyed by `MicrositeVia`. */
  via: Record<string, number>;
  /** Upcoming events the free JSON-LD path produced. These joined the PUBLIC path. */
  structuredEvents: number;
  /** Model rows accepted by the strict validator. */
  candidates: number;
  /** Model rows refused, by reason. The number that says whether to trust this stage. */
  rejections: Record<string, number>;
  /** Accepted rows dropped as not-Bengaluru. */
  offCity: number;
  /** Pending rows created, refreshed, and left alone because they were already decided. */
  created: number;
  refreshed: number;
  alreadyDecided: number;
  /** Platform handles found, worth registering as exact sources. */
  platformsFound: number;
  errors: string[];
}

export const EMPTY_MICROSITE_REPORT: MicrositeReport = {
  pages: 0,
  via: {},
  structuredEvents: 0,
  candidates: 0,
  rejections: {},
  offCity: 0,
  created: 0,
  refreshed: 0,
  alreadyDecided: 0,
  platformsFound: 0,
  errors: [],
};

/**
 * The namespace folded into both dedup keys. One per watchlist URL.
 *
 * Per-URL rather than one flat `'microsite'`, so two pages announcing the same conference produce
 * two reviewable rows rather than one silently overwriting the other — the reviewer can then see
 * both and reject the weaker extraction.
 */
function micrositeNamespace(pageUrl: string): string {
  return `microsite:${pageUrl}`;
}

/**
 * What this page yielded last time, so the model only reads pages that changed.
 *
 * Reads the fingerprint back off `sourceEventId`, which is where the landing path put it. That is
 * the whole state store: no new collection, no new field, and the version that produced a row
 * sits on the row itself, so a bad extraction can be re-run against the same input.
 *
 * `{ deletedAt: null }` and NOT `$exists` — the predicate has to match a null field and an absent
 * one, and getting it backwards here would make every page look unchanged and the stage do nothing.
 */
async function loadMicrositeFingerprints(urls: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (urls.length === 0) return map;
  try {
    await connectDB();
    const rows = await Event.find({
      source: 'company',
      sourceEventId: { $regex: `^${FINGERPRINT_PREFIX}` },
      clusterKey: { $in: urls.map(url => new RegExp(`^${escapeRegex(micrositeNamespace(url))}\\|`)) },
      deletedAt: null,
    })
      .select('clusterKey sourceEventId')
      .lean<Array<{ clusterKey: string; sourceEventId?: string }>>();

    for (const url of urls) {
      const prefix = `${micrositeNamespace(url)}|`;
      // Most recent wins is not expressible without a sort, and it does not need to be: any row
      // from this page carries a fingerprint of a version we already extracted, and a MISMATCH is
      // what triggers a re-read. Being conservative in the wrong direction here costs one model
      // call, not a wrong event.
      const row = rows.find(r => r.clusterKey?.startsWith(prefix));
      const fingerprint = fingerprintFromSourceEventId(row?.sourceEventId);
      if (fingerprint) map.set(url, fingerprint);
    }
  } catch (error) {
    // Fails OPEN: with no history every page looks changed, so the stage does more work rather
    // than less. The opposite failure — treating a database error as "nothing changed" — would
    // make the stage silently stop producing candidates while reporting success.
    console.warn(
      `  ! could not read microsite fingerprints, treating every page as changed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  return map;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Land extracted candidates as pending submissions.
 *
 * `normalizeEvents` is reused rather than hand-assembling a document, because it is what derives
 * `area`, `companies`, `connectionScore`, `audience`/`perks`/`tier`, the slug and the base dedup
 * keys — and a copy of that would be a second definition of every one. It maps input index to
 * output index, which is how each normalised row is paired back to the candidate it came from.
 *
 * Never throws. Each row is written inside its own try/catch: one validation failure must not cost
 * the others, and none of it may cost the scrape.
 */
async function landMicrositeCandidates(
  candidates: MicrositeCandidate[],
  report: MicrositeReport
): Promise<void> {
  if (candidates.length === 0) return;
  await connectDB();

  const normalized = await normalizeEvents(candidates.map(candidateToRawEvent));

  for (const [index, doc] of normalized.entries()) {
    const candidate = candidates[index];
    if (!candidate) continue;
    try {
      const namespace = micrositeNamespace(candidate.url);
      const dedupHash = Event.generateDedupHash(
        doc.title,
        doc.startDateTime,
        doc.venue,
        doc.source,
        namespace
      );
      // Namespaced by PREFIX rather than through `generateClusterKey`'s owner slot, which would
      // stamp a literal `user:` on a row no user owns. Same structural guarantee, honest label.
      const clusterKey = `${namespace}|${doc.clusterKey}`;

      const existing = await Event.findOne({ dedupHash });
      if (existing) {
        if (existing.visibility !== 'pending') {
          // Approved or rejected. A decision stands.
          report.alreadyDecided++;
          continue;
        }
        /*
         * ── A REFRESH MAY FILL GAPS. IT MAY NOT OVERWRITE WHAT A REVIEWER CORRECTED ─────────────
         *
         * This block used to assign `description`, `startDateTime`, `endDateTime`, `venue` and
         * `address` outright. The row it is assigning to is `visibility: 'pending'` — which means a
         * human may have opened it in the submissions queue and fixed exactly those fields, because
         * correcting them before approving is the entire purpose of that editor. The next scrape
         * then read the same page, produced the same claim, and **silently reverted the correction.**
         * A reviewer's edit lasted until the following night and nothing anywhere reported it.
         *
         * The fix is the discipline §2 already states for `mergeInto`: a later sighting may only
         * FILL GAPS or improve values, never blank or replace them. That rule exists for
         * cross-source merging and applies with more force here, because the value being replaced
         * was put there by a person rather than by another scraper.
         *
         * Cost, stated plainly: if the ORGANISER corrects a wrong date on their own page, a pending
         * row that already holds a date does not pick it up. That is the right trade — the fresh
         * text and its fingerprint are still written below, so the reviewer is judging against what
         * the page says today, and `diag-microsite-audit.ts`'s drift check is what surfaces the
         * disagreement. Losing a human's correction silently is the worse failure, and it is the one
         * with no signal at all.
         *
         * `description` is included in the gap rule rather than exempted from it. It is the field a
         * reviewer is most likely to trim, and an empty one is the only case where replacing it
         * cannot destroy a judgement.
         */
        existing.sourceEventId = fingerprintSourceEventId(candidate.fingerprint);
        existing.lastSeenAt = new Date();
        if (!existing.description) existing.description = doc.description;
        if (!existing.venue && doc.venue) existing.venue = doc.venue;
        if (!existing.address && doc.address) existing.address = doc.address;
        if (!existing.endDateTime && doc.endDateTime) existing.endDateTime = doc.endDateTime;
        /*
         * `startDateTime` is `required`, so it is never absent and therefore never gap-fillable —
         * it is deliberately not assigned at all. Note the row is addressed by `dedupHash`, which
         * folds the IST day, so a genuinely re-dated event produces a DIFFERENT hash and arrives
         * as a new candidate rather than needing this path to move an existing one.
         */
        /*
         * REPLACED IN THE SAME BREATH AS THE FINGERPRINT, and the pairing is the correctness point.
         * `sourceEventId` above is the fingerprint of the text THIS run read; if the retained text
         * were left at the previous night's version the row would claim a fingerprint whose input it
         * does not hold, and the audit script's drift check exists precisely because that mismatch
         * is otherwise undetectable.
         *
         * `existing` was loaded WITHOUT this path (`select: false`), which is safe: mongoose only
         * `$set`s modified paths, so a document fetched without it cannot blank it — and here it is
         * assigned outright, so the write is explicit either way.
         */
        existing.extraction = candidateToExtraction(candidate);
        await existing.save();
        report.refreshed++;
        continue;
      }

      await Event.create({
        ...doc,
        dedupHash,
        clusterKey,
        sourceEventId: fingerprintSourceEventId(candidate.fingerprint),
        /*
         * THE AUDIT TRAIL. The page text this event was invented from, plus the verbatim reply —
         * see `EventExtraction` in `lib/models/Event.ts`. `select: false` there means no read path
         * returns it without asking, so a row that later gets approved and joins the public corpus
         * does not start carrying 20 KB of somebody's marketing copy into the feed.
         *
         * This is the only writer. A candidate with no retained text would be a row a reviewer
         * cannot check, so it is attached unconditionally rather than behind a flag.
         */
        extraction: candidateToExtraction(candidate),
        // THE LITERAL. Not a variable, not a default, not derived. An extracted event may only
        // ever exist as something awaiting review.
        visibility: 'pending',
        // NO `createdByUserId`. Nobody typed this in, so claiming an owner would be a lie — and it
        // would put the row in `pruneStale`'s permanent-keep set, so an un-reviewed candidate for
        // an event that has already happened would sit in the queue forever. Left unowned, it is
        // cleaned up seven days after the event's own date, which is the correct lifetime for a
        // candidate nobody judged. The submissions route renders `submitter: null` for it, a case
        // it already handles.
      });
      report.created++;
    } catch (error) {
      const err = error as { code?: number; message?: string };
      if (err.code === 11000) {
        // A namespaced key collided, which means a concurrent run already landed this row.
        report.refreshed++;
        continue;
      }
      report.errors.push(
        `microsite candidate "${doc.title.slice(0, 60)}": ${err.message || String(error)}`
      );
    }
  }
}

/** Log the truncation picture, and push ONE aggregate error when the fix is switched off. */
function reportTruncation(
  summary: MeetupSweepSummary,
  outcomes: MeetupGroupOutcome[],
  opts: Required<PipelineOptions>,
  errors: string[]
): MeetupTruncationReport {
  const report: MeetupTruncationReport = {
    suspected: summary.truncated,
    secondPassRan: summary.secondPassRan,
    capped: summary.capped,
    gained: summary.gained,
    offCountry: summary.offCountry,
    stillTruncated: summary.stillTruncated,
    empty: summary.empty,
    enabled: opts.meetupSecondPass,
  };
  if (report.suspected === 0) return report;

  if (!opts.meetupSecondPass) {
    // The one case that goes into `errors`, and therefore into the run report and the digest's
    // unhealthy-sources section. Running with the second pass off is a deliberate choice; running
    // with it off and not knowing what it costs is the bug this whole change exists to close.
    const message =
      `Meetup ICS truncation: ${report.suspected} group(s) returned exactly ${MEETUP_ICS_CAP} events and the ` +
      `second pass is DISABLED (meetupSecondPass=false) — their remaining events were not scraped`;
    console.log(`  ! ${message}`);
    errors.push(message);
    return report;
  }

  console.log(
    `Meetup ICS cap: ${report.suspected} group(s) at ${MEETUP_ICS_CAP}; second pass ran on ` +
      `${report.secondPassRan}, recovered ${report.gained} event(s)` +
      (report.capped > 0 ? `, ${report.capped} left capped` : '') +
      (report.offCountry > 0 ? `, dropped ${report.offCountry} non-India row(s)` : '')
  );
  // Named, not just counted — the same rule the off-city gate follows. The biggest gains first,
  // because "which groups were we missing" is the question this answers.
  const gainers = outcomes.filter(o => o.gained > 0).sort((a, b) => b.gained - a.gained);
  for (const one of gainers.slice(0, 10)) {
    console.log(
      `  · ${one.slug}: ${one.icsCount} → ${one.events.length} (+${one.gained}` +
        (one.upstreamTotal !== undefined ? `, upstream says ${one.upstreamTotal}` : '') +
        `) via ${one.secondPass}`
    );
  }
  if (gainers.length > 10) console.log(`  · … and ${gainers.length - 10} more`);

  if (report.empty > 0) {
    // The interesting failure: still on the cap, and the page told us nothing. Either the group
    // really has ten, or Meetup changed the page. `diag-meetup-cap.ts` is how you tell.
    console.log(
      `  ! ${report.empty} second pass(es) returned nothing — if this is most of them, Meetup's ` +
        `/events/ page shape has changed (run scripts/diag-meetup-cap.ts)`
    );
  }
  if (report.stillTruncated > 0) {
    console.log(
      `  · ${report.stillTruncated} group(s) have more than the page's ${MEETUP_PAGE_CAP}-row ceiling shows`
    );
  }
  return report;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Gate attribution
//
// THE PROBLEM THIS SOLVES. Devfolio, Unstop and the company sweep routinely report 0 events and
// the report cannot distinguish "there are none this week" from "the gates ate them all". Those
// are opposite situations — one is upstream supply, one is our bug — and they render identically
// as `[none]    0 events`. Same for a Meetup group that returns twelve Chennai listings: today it
// looks exactly like a group with nothing scheduled.
//
// WHY A WeakMap AND NOT A FIELD ON RawEvent. `RawEvent` is the adapter contract, and every field
// on it is something an adapter is expected to fill. A bookkeeping field there would be a fifth
// optional property that adapters must ignore, would flow into `normalizeEvents`, and would need
// stripping before storage. Ownership is not a property of the event; it is a property of THIS
// RUN. A WeakMap keyed on the object says exactly that and is dropped with the batch.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Which source produced a row: the report bucket, and the Source-row identity for health. */
interface OwnerRef {
  sourceId: string;
  healthKey: string;
}

/** A Source health write, deferred until after the gates so it can report what survived them. */
interface PendingHealth {
  key: string;
  name: string;
  type: string;
  url: string;
  sourceId: string;
  /** Rows the adapter returned, before any gate. */
  scraped: number;
  firstError?: string;
}

function createGateLedger(owners: WeakMap<RawEvent, OwnerRef>) {
  const byHealthKey = new Map<string, GateBreakdown>();
  const bySourceId = new Map<string, GateBreakdown>();
  const totals: GateBreakdown = {};

  const bump = (into: GateBreakdown, reason: GateReason, title: string) => {
    const tally = (into[reason] ??= { count: 0, examples: [] });
    tally.count++;
    if (tally.examples.length < GATE_EXAMPLES_PER_REASON) tally.examples.push(title.slice(0, 90));
  };

  const bucket = (map: Map<string, GateBreakdown>, key: string): GateBreakdown => {
    let existing = map.get(key);
    if (!existing) map.set(key, (existing = {}));
    return existing;
  };

  return {
    totals,
    byHealthKey,
    bySourceId,
    charge(event: RawEvent, reason: GateReason): void {
      const title = event.title || event.sourceUrl || '(untitled)';
      bump(totals, reason, title);
      const owner = owners.get(event);
      // An unowned row is possible in principle (a future stage that synthesises events), so it
      // is counted in the totals and simply not charged to anybody rather than dropped.
      if (!owner) return;
      bump(bucket(bySourceId, owner.sourceId), reason, title);
      bump(bucket(byHealthKey, owner.healthKey), reason, title);
    },
    /**
     * Rows a source lost that should count AGAINST its health, i.e. everything except
     * duplicates.
     *
     * Duplicates are deliberately excluded. Stage 6 keeps one copy of an overlapping event and
     * charges the loss to whichever source lost the coin toss — but Luma's city feed and a host
     * calendar overlapping is the design working, not a source failing. Counting it would drive
     * a perfectly healthy calendar's `consecutiveEmptyScrapes` up and eventually back it off to
     * monthly, which is the opposite of what the overlap means.
     */
    countableLoss(healthKey: string): number {
      const breakdown = byHealthKey.get(healthKey);
      if (!breakdown) return 0;
      return (
        (breakdown.city?.count ?? 0) +
        (breakdown['date-window']?.count ?? 0) +
        (breakdown['missing-required-field']?.count ?? 0)
      );
    },
  };
}

type GateLedger = ReturnType<typeof createGateLedger>;

/** One-line summary of what the gates removed, for a health row's `lastError` note. */
function gateSummary(breakdown: GateBreakdown | undefined, scraped: number): string | undefined {
  if (!breakdown) return undefined;
  const parts = GATE_REASONS.filter(reason => breakdown[reason]?.count).map(
    reason => `${reason} ${breakdown[reason]!.count}`
  );
  if (parts.length === 0) return undefined;
  const example = GATE_REASONS.map(reason => breakdown[reason]?.examples[0]).find(Boolean);
  return `returned ${scraped} row(s), all removed by the ingest gates: ${parts.join(', ')}${
    example ? ` — e.g. "${example}"` : ''
  }`;
}

interface Collector {
  events: RawEvent[];
  reports: SourceReport[];
  errors: string[];
  discovered: DiscoveredSource[];
  /** Which source each row came from, for gate attribution. */
  owners: WeakMap<RawEvent, OwnerRef>;
  /** Health writes, flushed after the gates. */
  health: PendingHealth[];
}

const healthKeyOf = (name: string, url: string) => `${name}|${url}`;

/**
 * Take ownership of a batch of rows and queue the source's health write.
 *
 * The health write is DEFERRED rather than done here, and that is the point of this function.
 * `updateSource` used to be called the instant a source finished, so `lastEventCount` recorded
 * what the adapter returned and nothing recorded what survived — a Meetup group returning twelve
 * Chennai rows was filed as healthy with 12 events, and the report showed 12 while the corpus
 * gained 0.
 *
 * It cannot simply be called twice, either: `updateSource` computes
 * `consecutiveEmptyScrapes = eventCount > 0 ? 0 : prev + 1`, so a second call with 0 increments
 * it AGAIN. That would double-count against `BACKOFF_WEEKLY_AFTER` and back a source off in half
 * the time the schedule claims. One write, after the gates.
 */
function claim(
  collector: Collector,
  descriptor: { id: string; label: string; type: string; url: string },
  events: RawEvent[],
  firstError?: string
): void {
  const healthKey = healthKeyOf(descriptor.label, descriptor.url);
  for (const event of events) collector.owners.set(event, { sourceId: descriptor.id, healthKey });
  collector.events.push(...events);
  collector.health.push({
    key: healthKey,
    name: descriptor.label,
    type: descriptor.type,
    url: descriptor.url,
    sourceId: descriptor.id,
    scraped: events.length,
    firstError,
  });
}

/** Run one source with isolation + health recording. */
async function runSource(
  descriptor: { id: string; label: string; type: string; url: string },
  run: () => Promise<ScrapeResult>,
  collector: Collector
): Promise<void> {
  try {
    const result = await run();
    if (result.discovered?.length) collector.discovered.push(...result.discovered);
    claim(collector, descriptor, result.events, result.errors[0]);

    collector.reports.push({
      sourceId: result.sourceId,
      label: result.label,
      events: result.events.length,
      errors: result.errors.length,
      durationMs: result.durationMs,
      firstError: result.errors[0],
    });
    collector.errors.push(...result.errors.map(e => `${result.label}: ${e}`));
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
    claim(collector, descriptor, [], message);
  }
}

/**
 * Write every source's health in one pass, AFTER the gates.
 *
 * `eventCount` is what survived to ingest, not what the adapter returned, and when nothing
 * survived the `error` note says which gate ate it. That is the whole fix: "0 events" now
 * distinguishes "upstream had none" (no note) from "12 rows, all Chennai" (a note naming the
 * city gate and one title).
 *
 * Concurrency 8 because `updateSource` is two round trips per row and there are ~400 rows; the
 * serial version added ~20s to every run.
 */
async function flushHealth(collector: Collector, ledger: GateLedger): Promise<void> {
  await mapPool(collector.health, 8, async pending => {
    const kept = Math.max(0, pending.scraped - ledger.countableLoss(pending.key));
    // Only record an error when the source contributed NOTHING. A source that returned 40 events
    // and logged one bad record is healthy, and flagging it would train the reader to ignore the
    // health report. A real fetch/parse error still outranks a gate note.
    const error =
      kept === 0
        ? pending.firstError ?? gateSummary(ledger.byHealthKey.get(pending.key), pending.scraped)
        : undefined;
    await updateSource(pending.name, pending.type, pending.url, { eventCount: kept, error });
    return null;
  });
}

/**
 * Delete events that have gone stale: their start time has passed AND no source
 * has reported them for a week. Past events are kept for a while on purpose —
 * the tracker references them and users look back at what they attended.
 */
/**
 * Delete past events no source has reported for a week.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * `createdByUserId: { $exists: false }` IS WHAT STOPS THIS DELETING EVERY HAND-ENTERED EVENT.
 *
 * The predicate is "old AND not seen recently", and `lastSeenAt` is only ever refreshed by
 * `ingestEvents()`. Nothing re-reports an event somebody typed in themselves — there is no
 * upstream to report it — so its `lastSeenAt` is frozen at the moment of creation. For the normal
 * case, where the event is entered more than a week before it happens, BOTH arms are already true
 * the instant it ends: the row is deleted exactly at the 7-day mark, and no re-scrape can recover
 * it because there is nothing to re-scrape.
 *
 * The user would see no error. `TrackerEntry.eventId` is `required` and `app/tracker/page.tsx`
 * DROPS entries whose populate came back null — so the tracked entry and its status, notes and
 * connections would simply vanish from the kanban with no message at all.
 *
 * Note what this does to the sentence in `PipelineOptions.onlySources`: pruning is no longer "any
 * past event no source has reported for a week", because events now exist that no source ever
 * reports. That docblock is corrected accordingly.
 *
 * User events are kept indefinitely and deliberately. A hand-entered event is a record of
 * something the user chose to remember, more like a `Folder` than a scraped listing, and deleting
 * one is theirs to do.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
async function pruneStale(): Promise<number> {
  await connectDB();
  const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const outcome = await Event.deleteMany({
    startDateTime: { $lt: cutoff },
    lastSeenAt: { $lt: cutoff },
    createdByUserId: { $exists: false },
  });
  return outcome.deletedCount || 0;
}

export async function runPipeline(options: PipelineOptions = {}): Promise<PipelineResult> {
  const opts = { ...DEFAULTS, ...options };
  const startedAt = Date.now();
  const timestamp = new Date();

  console.log('Starting scrape pipeline…');

  const collector: Collector = {
    events: [],
    reports: [],
    errors: [],
    discovered: [],
    owners: new WeakMap<RawEvent, OwnerRef>(),
    health: [],
  };
  const ledger = createGateLedger(collector.owners);
  const backoffSkipped: SkippedSource[] = [];

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
  const backoff = { ignoreBackoff: opts.ignoreBackoff, now: timestamp };

  const lumaLoad = wants('luma-calendars')
    ? await loadDiscovered('luma-calendar', backoff)
    : { due: [], skipped: [] };
  const meetupLoad = wants('meetup-groups')
    ? await loadDiscovered('meetup-group', backoff)
    : { due: [], skipped: [] };
  backoffSkipped.push(...lumaLoad.skipped, ...meetupLoad.skipped);

  const lumaCalendars = applyCap(
    lumaLoad.due,
    opts.maxLumaCalendars,
    'Luma calendars',
    collector.errors
  );

  // Seeds go FIRST: they are hand-verified, so they must never be the ones a cap drops.
  // loadDiscovered has already ordered the rest by expected yield AND removed the ones on a
  // weekly/monthly cadence that are not due tonight.
  //
  // SEEDS ARE EXEMPT FROM BACK-OFF, and that is the same exemption the cap already grants them
  // for the same reason: they are hand-verified, so a quiet one is more likely to be between
  // bursts than dead. They are merged in as raw slugs here rather than as Source rows, so a seed
  // that `loadDiscovered` skipped is re-added by this line. ~45 of the 97 quiet Meetup groups are
  // seeds, so the saving is roughly halved on this source and full on Luma. If that request
  // budget ever matters, look up each seed's row here — do not remove the exemption blind.
  const meetupSlugs = !wants('meetup-groups')
    ? []
    : applyCap(
        [...new Set([...SEED_MEETUP_GROUPS, ...meetupLoad.due.map(d => d.handle)])].filter(slug =>
          isEnabled(slug, `https://www.meetup.com/${slug}/`)
        ),
        opts.maxMeetupGroups,
        'Meetup groups',
        collector.errors
      );

  console.log(
    `Discovery: ${newlyDiscovered} new source(s); scraping ${lumaCalendars.length} Luma calendars + ${meetupSlugs.length} Meetup groups`
  );
  if (backoffSkipped.length > 0) {
    const weekly = backoffSkipped.filter(s => s.cadence === 'weekly').length;
    const monthly = backoffSkipped.length - weekly;
    // Named per kind, not just totalled: "148 skipped" is indistinguishable from a broken query,
    // and a back-off you cannot see in the logs is the coverage bug `applyCap` already warns about.
    const byKind = new Map<string, number>();
    for (const s of backoffSkipped) byKind.set(s.kind, (byKind.get(s.kind) ?? 0) + 1);
    console.log(
      `Back-off: skipped ${backoffSkipped.length} quiet source(s) — ${weekly} weekly ` +
        `(≥${BACKOFF_WEEKLY_AFTER} empty scrapes), ${monthly} monthly (≥${BACKOFF_MONTHLY_AFTER}); ` +
        [...byKind].map(([kind, n]) => `${n} ${kind}`).join(', ')
    );
    for (const s of backoffSkipped.slice(0, 8)) {
      console.log(
        `  · ${s.kind}/${s.handle}: ${s.cadence}, ${s.consecutiveEmptyScrapes} empty in a row, last fetched ${s.ageDays}d ago`
      );
    }
    if (backoffSkipped.length > 8) console.log(`  · … and ${backoffSkipped.length - 8} more`);
  } else if (opts.ignoreBackoff) {
    console.log('Back-off: disabled for this run (ignoreBackoff)');
  }

  // ── 2. Per-host feeds, concurrently ───────────────────────────────────────
  // Health is recorded PER CALENDAR, not only as an aggregate. Without this, every
  // discovered source showed "Not scraped yet" in Settings — 147 of 198 rows — which
  // made a healthy scraper look broken and hid which specific calendar had died.
  const calendarResults = await mapPool(lumaCalendars, 6, async cal => {
    const one = await scrapeLumaCalendar(cal.handle, cal.label);
    claim(
      collector,
      {
        id: 'luma-calendars',
        label: cal.label,
        type: 'api',
        url: `https://luma.com/calendar/${cal.handle}`,
      },
      one.events,
      one.errors[0]
    );
    return one;
  });
  let calendarEvents = 0;
  let calendarErrors = 0;
  for (const result of calendarResults) {
    if (!result) continue;
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

  let meetupTruncation: MeetupTruncationReport = { ...EMPTY_TRUNCATION };
  if (meetupSlugs.length > 0) {
    /*
     * ONE `claim` PER GROUP, AFTER the second pass has had its say. Not one per feed.
     *
     * `claim` queues a `PendingHealth`, and `flushHealth` calls `updateSource` once per queued
     * entry. Two entries for the same Source row would run `consecutiveEmptyScrapes = count > 0
     * ? 0 : prev + 1` twice and back a quiet group off in half the documented time — the trap
     * `claim`'s own docblock records. So the ICS feed and the page feed are merged inside the
     * adapter and arrive here as one set of events per group.
     */
    const renderer = await loadRenderer(opts.renderCappedGroups);
    /*
     * Isolated like every other source (design note 2): the sweep is not supposed to be able to
     * throw — every group runs inside `scrapeMeetupGroup`'s own try/catch and `mapPool` nulls a
     * throwing slot rather than rejecting — but "not supposed to" is not the same as "cannot", and
     * this stage is 75% of the feed. An empty sweep costs the run one source; an escaped throw
     * costs the run everything after it, including the pruner's grace and every other adapter.
     */
    let sweep: Awaited<ReturnType<typeof scrapeMeetupGroupsSweep>> = {
      outcomes: [],
      summary: {
        groups: meetupSlugs.length,
        truncated: 0,
        secondPassRan: 0,
        capped: 0,
        gained: 0,
        offCountry: 0,
        stillTruncated: 0,
        empty: 0,
        durationMs: 0,
      },
    };
    try {
      sweep = await scrapeMeetupGroupsSweep(meetupSlugs, {
        secondPass: opts.meetupSecondPass,
        maxSecondPass: opts.maxMeetupSecondPass,
        render: renderer.render,
        pageConcurrency: renderer.pageConcurrency,
        now: timestamp,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      collector.errors.push(`Meetup groups: ${message}`);
      console.warn(`  ! Meetup group sweep failed entirely: ${message}`);
    } finally {
      // MUST run. An open Chromium holds the Node event loop, so a script that forgets this
      // exits only when the GitHub runner's 45-minute timeout kills it — a green scrape that
      // reports as a failure.
      await renderer.close();
      const note = renderer.describe();
      if (note) console.log(`Meetup second pass: ${note}`);
    }

    for (const outcome of sweep.outcomes) {
      claim(
        collector,
        {
          id: 'meetup-groups',
          label: outcome.slug.replace(/-/g, ' '),
          type: 'ical',
          url: `https://www.meetup.com/${outcome.slug}/`,
        },
        outcome.events,
        outcome.errors[0]
      );
      collector.errors.push(
        ...outcome.errors.map(e => `meetup-group:${outcome.slug}: ${e}`)
      );
    }

    const groupEvents = sweep.outcomes.reduce((sum, o) => sum + o.events.length, 0);
    const groupErrors = sweep.outcomes.reduce((sum, o) => sum + o.errors.length, 0);
    collector.reports.push({
      sourceId: 'meetup-groups',
      label: `Meetup — ${meetupSlugs.length} groups`,
      events: groupEvents,
      errors: groupErrors,
      durationMs: sweep.summary.durationMs,
    });

    meetupTruncation = reportTruncation(sweep.summary, sweep.outcomes, opts, collector.errors);
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
      }).then(result => {
        claim(
          collector,
          {
            id: 'company-pages',
            label: `Company — ${page.organizer}`,
            type: 'scrape',
            url: page.url,
          },
          result.events,
          result.errors[0]
        );
        return result;
      })
    );

    let companyEvents = 0;
    let workingPages = 0;
    for (const result of results) {
      if (!result) continue;
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

  // ── 4b. Company MICROSITES ────────────────────────────────────────────────
  //
  // The one stage that can write a row a reader cannot see. Its own renderer, opened and closed
  // here, because the Meetup renderer above is already closed by the time this runs and reopening
  // is ~470 ms against a stage that spends tens of seconds per page anyway.
  //
  // ISOLATED HARDER THAN THE REST. Every other source is wrapped because it fetches; this one
  // fetches, launches a browser, calls a model AND writes to Mongo, so the whole stage sits inside
  // one try/catch and the renderer closes in a `finally`. An open Chromium holds the Node event
  // loop, which turns a working scrape into a run that only ends when the runner's 45-minute
  // timeout kills it.
  /*
   * ── THE CHEAP HALF RUNS BY DEFAULT; ONLY THE MODEL HALF OPTS IN ──────────────────────────
   *
   * This stage used to be gated whole, behind `micrositeCandidates: false`, on the premise that a
   * company page yields nothing without a browser and a model. **That premise was measured on
   * company marketing INDEX pages and is false for bespoke event MICROSITES**, which publish
   * schema.org `Event` JSON-LD over plain HTTP because their organisers want Google's event rich
   * results. Measured 2026-09-11: `developersummit.com` (GIDS 2027) and `bengalurutechsummit.com`
   * (BTS 2026, BIEC) both resolve on step 1 — **one HTTP request each, no browser, no model.** Two
   * of the city's largest flagships were being skipped because a flag protecting the expensive path
   * also switched off the free one.
   *
   * So the gate is split. Step 1 (JSON-LD) and step 2 (platform detection, which feeds `Source` and
   * is permanent supply) always run; step 3 (render + LLM) runs only when `micrositeCandidates` is
   * set. The adapter needs no new flag for that — step 3 requires `opts.render` and reports
   * `no-render` without it, so withholding the renderer IS the switch.
   *
   * The asymmetry in where the output lands is unchanged and is the safety argument: JSON-LD joins
   * the PUBLIC path because the site published it and no model touched it, while every extracted
   * row is quarantined as `pending` for a human.
   */
  const microsite: MicrositeReport = { ...EMPTY_MICROSITE_REPORT };
  if (wants('microsites')) {
    const llmExtraction = Boolean(opts.micrositeCandidates);
    // Only launched when the model half is on. `loadRenderer(false)` returns the no-op handle, so
    // `close()` and `describe()` stay safe to call unconditionally in the `finally`.
    const renderer = await loadRenderer(llmExtraction);
    try {
      const entries = MICROSITE_WATCHLIST.filter(entry => isEnabled(entry.url));
      microsite.pages = entries.length;
      console.log(
        `Microsites: ${entries.length} page(s) — JSON-LD joins the public feed; ` +
          (llmExtraction
            ? 'LLM extraction lands as PENDING review'
            : 'LLM extraction OFF (pass --microsites-llm to arm it)')
      );

      const known = await loadMicrositeFingerprints(entries.map(entry => entry.url));
      const outcome = await scrapeMicrosites({
        entries,
        // Withheld when the model half is off — this is the switch for step 3.
        render: llmExtraction ? renderer.render : undefined,
        knownFingerprints: known,
        maxExtractions: llmExtraction ? DEFAULT_MAX_EXTRACTIONS : 0,
        now: timestamp,
      });

      for (const pageReport of outcome.reports) {
        microsite.via[pageReport.via] = (microsite.via[pageReport.via] ?? 0) + 1;
        microsite.offCity += pageReport.offCity;
        if (pageReport.platform) microsite.platformsFound++;
        for (const [reason, count] of Object.entries(pageReport.rejections)) {
          microsite.rejections[reason] = (microsite.rejections[reason] ?? 0) + count;
        }
      }
      microsite.candidates = outcome.candidates.length;
      microsite.errors.push(...outcome.errors);

      /*
       * The JSON-LD half joins the PUBLIC path, and that asymmetry is the whole design.
       *
       * These are schema.org `Event` nodes the site published itself — the same class of data
       * `universal.ts` reads from `postman.com/events` — so there is no model in the chain and no
       * reason to make a human approve them. Only the extracted rows are quarantined.
       *
       * `claim` charges them to a source id so the gate ledger can report what stage 5b and 5c did
       * to them, exactly like every other source.
       */
      if (outcome.structuredEvents.length > 0) {
        claim(
          collector,
          {
            id: 'microsites',
            label: 'Microsites — JSON-LD',
            type: 'scrape',
            url: 'https://pulseblr.local/microsites',
          },
          outcome.structuredEvents,
          outcome.errors[0]
        );
        microsite.structuredEvents = outcome.structuredEvents.length;
      }

      if (outcome.discovered.length > 0) {
        // A platform handle is permanent supply for one request a night, which is worth far more
        // than any extraction — see the cascade note in the adapter.
        collector.discovered.push(...outcome.discovered);
      }

      await landMicrositeCandidates(outcome.candidates, microsite);

      collector.reports.push({
        sourceId: 'microsites',
        label:
          `Microsites — ${microsite.structuredEvents} public, ` +
          `${microsite.created} new pending, ${microsite.refreshed} refreshed`,
        events: microsite.structuredEvents,
        errors: microsite.errors.length,
        durationMs: 0,
      });
      collector.errors.push(...microsite.errors.map(e => `microsites: ${e}`));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      collector.errors.push(`microsites: ${message}`);
      console.warn(`  ! microsite pass failed entirely: ${message}`);
    } finally {
      await renderer.close();
      const note = renderer.describe();
      if (note) console.log(`Microsites: ${note}`);
    }
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
    // A missing title or URL, or an unparseable start, is a PARSER defect rather than a listing
    // that failed a policy — so it is charged to a different bucket. That distinction is the
    // point of the taxonomy: `missing-required-field` on a source means go read the adapter,
    // `date-window` means the upstream published an advert.
    if (!event.title?.trim() || !event.sourceUrl?.trim()) {
      ledger.charge(event, 'missing-required-field');
      return false;
    }
    const start = event.startDateTime?.getTime?.() ?? NaN;
    if (!Number.isFinite(start)) {
      ledger.charge(event, 'missing-required-field');
      return false;
    }

    // Started too long ago to still be "on", regardless of what its end says.
    if (start < nowMs - MAX_PAST_START_DAYS * 24 * 3600 * 1000) {
      ledger.charge(event, 'date-window');
      return false;
    }
    // Implausibly far out — almost always a placeholder or a parsing error.
    if (start > nowMs + MAX_FUTURE_START_DAYS * 24 * 3600 * 1000) {
      ledger.charge(event, 'date-window');
      return false;
    }

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
    ledger.charge(event, 'city');
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
    if (score(event) > score(existing)) {
      byKey.set(key, event);
      ledger.charge(existing, 'duplicate');
    } else {
      ledger.charge(event, 'duplicate');
    }
  }
  const uniqueRaw = [...byKey.values()];
  console.log(`${totalScraped} scraped → ${uniqueRaw.length} unique before tagging`);

  // ── 6b. Record source health, now that every gate has had its say ─────────
  // AFTER the gates and BEFORE tagging. After, so `lastEventCount` is what survived rather than
  // what the adapter returned. Before, so a failure in the LLM or ingest stages cannot leave the
  // run with no health recorded at all — which is what deferring the write past stage 8 would
  // risk, and it would be strictly worse than the immediate write this replaced.
  await flushHealth(collector, ledger);

  const gateLoss = GATE_REASONS.reduce((sum, r) => sum + (ledger.totals[r]?.count ?? 0), 0);
  if (gateLoss > 0) {
    console.log(
      `Gates removed ${gateLoss} row(s): ` +
        GATE_REASONS.filter(r => ledger.totals[r]?.count)
          .map(r => `${r} ${ledger.totals[r]!.count}`)
          .join(', ')
    );
  }

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
    sources: collector.reports
      .map(report => {
        const rejected = ledger.bySourceId.get(report.sourceId);
        return rejected ? { ...report, rejected } : report;
      })
      .sort((a, b) => b.events - a.events),
    discovered: {
      lumaCalendars: lumaCalendars.length,
      meetupGroups: meetupSlugs.length,
    },
    enrichment: { lumaDescriptions, meetupEvents: meetupEnriched },
    gates: ledger.totals,
    meetupTruncation,
    microsite,
    backoff: {
      skipped: backoffSkipped.length,
      weekly: backoffSkipped.filter(s => s.cadence === 'weekly').length,
      monthly: backoffSkipped.filter(s => s.cadence === 'monthly').length,
      sources: backoffSkipped,
    },
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
    // The line this whole ledger exists for. `[none] 0 events  Devfolio` used to be the end of
    // the story; it is now followed by whether the gates are the reason.
    if (source.rejected) {
      for (const reason of GATE_REASONS) {
        const tally = source.rejected[reason];
        if (!tally) continue;
        console.log(
          `           ↳ ${reason} rejected ${tally.count}` +
            (tally.examples.length ? `  e.g. ${tally.examples.map(t => `"${t}"`).join(', ')}` : '')
        );
      }
    }
  }
  const { ingestion } = result;
  console.log('  ' + '─'.repeat(46));
  console.log(`  scraped        ${result.totalScraped}`);
  for (const reason of GATE_REASONS) {
    const tally = result.gates[reason];
    if (tally) console.log(`  gate: ${reason.padEnd(9)}${String(tally.count).padStart(5)} rejected`);
  }
  if (result.backoff.skipped > 0) {
    console.log(
      `  back-off       ${result.backoff.skipped} source(s) skipped (${result.backoff.weekly} weekly, ${result.backoff.monthly} monthly)`
    );
  }
  // Printed whenever any group is on the ICS ceiling, INCLUDING when the second pass recovered
  // nothing. A zero here is the number that matters: it means either every capped group really
  // has ten events, or the recovery path has quietly stopped working.
  const truncation = result.meetupTruncation;
  if (truncation.suspected > 0) {
    console.log(
      `  meetup cap     ${truncation.suspected} group(s) at ${MEETUP_ICS_CAP}` +
        (truncation.enabled
          ? ` → +${truncation.gained} recovered from ${truncation.secondPassRan} page pass(es)` +
            (truncation.capped > 0 ? `, ${truncation.capped} capped` : '') +
            (truncation.empty > 0 ? `, ${truncation.empty} empty` : '')
          : ' (SECOND PASS DISABLED — those events were not scraped)')
    );
  }
  /*
   * Printed whenever the microsite pass ran at all, INCLUDING when it produced nothing — the same
   * rule as the Meetup cap line above and for the same reason. A stage that spends a browser and a
   * frontier model and reports nothing is either a page with no events on it or an extraction path
   * that has quietly stopped working, and those must not print identically.
   *
   * REJECTIONS ARE PRINTED SEPARATELY FROM CANDIDATES, because they are the only signal that says
   * whether to trust this stage. `candidates 3, refused 0` and `candidates 3, refused 11` are
   * completely different situations and a combined count hides both.
   */
  const micro = result.microsite;
  if (micro.pages > 0) {
    const via = Object.entries(micro.via)
      .map(([key, count]) => `${key}=${count}`)
      .join(' ');
    console.log(`  microsites     ${micro.pages} page(s)  ${via}`);
    console.log(
      `                 ${micro.structuredEvents} public (JSON-LD), ${micro.candidates} extracted` +
        ` → ${micro.created} new pending, ${micro.refreshed} refreshed, ${micro.alreadyDecided} already decided`
    );
    const refused = Object.entries(micro.rejections);
    const refusedTotal = refused.reduce((sum, [, count]) => sum + count, 0);
    console.log(
      `                 model rows REFUSED ${refusedTotal}` +
        (refused.length ? `  (${refused.map(([r, c]) => `${r}×${c}`).join(' ')})` : '') +
        (micro.offCity ? `, ${micro.offCity} off-city` : '')
    );
    if (micro.platformsFound > 0) {
      console.log(
        `                 ${micro.platformsFound} page(s) front a known platform — register the handle, do not extract`
      );
    }
    if (micro.created > 0) {
      console.log(`                 → REVIEW THESE at /admin → Submissions before they can be seen`);
    }
  }
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
