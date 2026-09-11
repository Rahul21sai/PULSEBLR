// Company event MICROSITES — the one supply class every other adapter structurally cannot reach.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT THIS IS FOR. A large company announcing a flagship Bengaluru event stands up a bespoke
// site for it: its own domain or path, a registration funnel, an agenda, a speaker list. None of
// it is on Luma, Meetup or Bevy, so no adapter here has ever seen one. That is the gap.
//
// WHY IT IS NOT `universal.ts`. That adapter tries JSON-LD → ICS → RSS → embedded JSON and then
// stops, on measured evidence: 19 of its 20 registered pages yield nothing, and a second, stronger
// test with headless Chromium found 0 of 5 emit `Event` schema even fully rendered. So this
// adapter's cheap path is the same as `universal.ts`'s first step — and its expensive path is the
// one `universal.ts` refuses, guarded by the review queue rather than by hope. See
// `lib/llm/extract-event.ts` for that argument in full.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE CASCADE, CHEAPEST AND MOST EXACT FIRST. Each step that answers stops the next from running.
//
//   1. JSON-LD on the plain HTML.        Free, exact, zero hallucination surface. Rare, but it
//                                        costs one request to find out and the day a site adds
//                                        markup this path starts working with no code change.
//   2. UNDERLYING PLATFORM DETECTION.    A bespoke domain usually FRONTS somebody's product —
//                                        Zoho Backstage, Airmeet, Hubilo, Cvent, Konfhub,
//                                        Eventbrite, Luma, Devfolio, Townscript. When the page
//                                        reveals one, the answer is not to read the page with a
//                                        model: it is to register the platform handle, where the
//                                        data is structured, exact, and already supported by an
//                                        adapter in this directory. This step therefore reports
//                                        a DISCOVERY and deliberately spends no LLM call.
//   3. RENDER → TEXT → LLM.              Last resort. Needs a browser, needs a frontier model,
//                                        lands as `visibility: 'pending'`, never in the feed.
//
// Step 2 is the step most likely to be dropped as an optimisation and it is the one that pays.
// A platform handle is permanent supply for one request a night; an LLM extraction is a paid
// guess that a human then has to check.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THREE PROPERTIES TO KEEP.
//
//  1. NO PLAYWRIGHT REFERENCE, STATIC OR DYNAMIC. The renderer arrives as a function parameter
//     (`PageRenderer`), exactly as `adapters/meetup.ts` takes it, because `app/api/scrape/route.ts`
//     imports the pipeline and therefore this file into a Vercel bundle that cannot run a browser.
//     See `core/render.ts` property 1.
//  2. NO DATABASE. Change detection needs state from the last run, and it is INJECTED
//     (`knownFingerprints`) rather than queried here. An adapter in this codebase has never read
//     Mongo and this one must not be the first — it is also what lets the whole cascade be
//     reasoned about without a database in the way.
//  3. NO EVENT REACHES `collector.events`. This adapter returns `MicrositeOutcome`, not
//     `ScrapeResult`, and that is a deliberate type-level fence: a `RawEvent[]` would be one
//     careless spread away from the public ingest path, and a hallucinated event in the public
//     feed is the exact harm the review queue exists to prevent.
// ═════════════════════════════════════════════════════════════════════════════════════════════

import * as crypto from 'crypto';
import { fetchText, mapPool } from '../core/http';
import { rawEventsFromHtml } from '../core/jsonld';
import { stripHtml, absoluteUrl } from '../core/text';
import { isBengaluru, offCityReason } from '../core/geo';
import type { RawEvent, DiscoveredSource } from '../core/types';
import type { PageRenderer } from './meetup';
import {
  extractEventsFromText,
  extractionProvider,
  type ExtractedEvent,
  type ExtractionResult,
  type ExtractionProvider,
} from '../../llm/extract-event';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE WATCHLIST
//
// HAND-CURATED AND SMALL, ON PURPOSE. This is the one adapter here that does not compound through
// auto-discovery, and that is not an oversight: discovery is what makes Luma and Meetup coverage
// grow for free, but the cost per page here is a browser render plus a frontier-model call plus a
// human review, so an automatically-grown list would spend all three on pages nobody vetted.
// Growth belongs on the OTHER side of step 2 — a platform handle found here goes into `Source` and
// is scraped by an exact adapter from then on.
//
// `bengaluruOnly` says the page is already city-scoped, so an event with no city text on it is
// still plausibly local. On a global company's events index (the default) a physical event must
// name Bengaluru, or the review queue fills with Las Vegas.
// ─────────────────────────────────────────────────────────────────────────────────────────────
export interface MicrositeEntry {
  url: string;
  organizer: string;
  /** The page is scoped to Bengaluru, so an unplaced physical event is not automatically foreign. */
  bengaluruOnly?: boolean;
}

export const MICROSITE_WATCHLIST: MicrositeEntry[] = [
  // ── Bengaluru flagships with their own site ────────────────────────────────────────────────
  // The reason this adapter exists: none is on Luma or Meetup, and `devevents.ts` carries GIDS
  // only when its curators happen to add it. Two of the three answer on step 1 today, which is
  // the finding the probe produced — see the note under the cascade above.
  { url: 'https://developersummit.com/', organizer: 'GIDS', bengaluruOnly: true },
  { url: 'https://www.bengalurutechsummit.com/', organizer: 'Bengaluru Tech Summit', bengaluruOnly: true },
  { url: 'https://opensourceindia.in/', organizer: 'Open Source India', bengaluruOnly: true },
  // ── Company event indexes ──────────────────────────────────────────────────────────────────
  // Measured structurally dead to every cheaper path, kept because they are where a Bengaluru
  // summit gets announced and because step 2 may yet find a platform behind one. Listed with no
  // illusions: see the table in CLAUDE.md §15.
  { url: 'https://www.databricks.com/events', organizer: 'Databricks' },
  { url: 'https://razorpay.com/events/', organizer: 'Razorpay' },
  //
  // NOT ON THIS LIST, AND MEASURED RATHER THAN GUESSED (2026-09-11):
  //
  //   · `indiafoss.net` IS NO LONGER FOSS UNITED'S SITE. Rendered and read on 2026-09-11: 16,943
  //     characters of Indonesian togel gambling SEO ("COLOKSGP Agen Resmi Betting Situs Togel"),
  //     ©2026, with a Cloudflare `Content-Signal: ai-train=no` on top. The domain has lapsed and
  //     been repurposed. IndiaFOSS itself is already covered by `fossunited.org` through
  //     `fossunited.ts`. **A watchlist entry can rot into a different website, and a URL that was
  //     right when it was added is not evidence about what is served today** — which is also the
  //     one live case that proved the model refuses to invent: given all 17 KB of it, it returned
  //     `[]`.
  //   · `reactindia.io` publishes clean JSON-LD and the event is at "Planet Hollywood Beach
  //     Resort" — GOA. A well-marked-up conference is not a Bengaluru conference, and it is the
  //     row that found the missing geo gate on step 1.
  //   · `techsparks.yourstory.com` and `events.mongodb.com` answer a plain fetch with **403**.
  //     Not added, and NOT worked around with the browser: this codebase's own standard is that a
  //     page needing a browser to be readable at all is not a source (`core/render.ts` header),
  //     and a 403 is the site declining, not a parsing problem to route past.
  //   · `cypherconf.com` fronts Eventbrite — kept out because the only evidence is a 2017 ticket
  //     link in its footer, which is what taught step 2 not to short-circuit on a platform that
  //     has no adapter behind it.
  //   · `rootconf.in` yields 20 JSON-LD events, all 2018-2022 archives, and is HasGeek-hosted —
  //     so `hasgeek.ts` already covers its live supply and this would be duplicate requests for
  //     duplicate rows.
  //   · `kcdbengaluru.in`, `cloudnativebengaluru.com`, `droidcon.in`, `pycon.org.in` do not
  //     resolve at all from here, and `devopsdays.org/events/2026-bangalore/` is a 404. A URL
  //     that fails DNS is not a source waiting to work; it is a guess.
];

// ─────────────────────────────────────────────────────────────────────────────────────────────
// PLATFORM DETECTION
//
// Markers are chosen to be things a page CANNOT carry by accident — a script host, an embed
// origin, an API domain — never a brand name in prose. "Powered by Airmeet" in a footer is a
// weaker claim than a request to `airmeet.com`, and a page ABOUT Eventbrite is not a page ON
// Eventbrite. Each pattern also yields the handle URL where one is recoverable, because the
// handle is the whole value of this step.
// ─────────────────────────────────────────────────────────────────────────────────────────────
export type MicrositePlatform =
  | 'luma'
  | 'eventbrite'
  | 'konfhub'
  | 'zoho-backstage'
  | 'airmeet'
  | 'hubilo'
  | 'cvent'
  | 'townscript'
  | 'devfolio'
  | 'meetup'
  | 'bevy'
  | 'hasgeek'
  | 'explara';

export interface PlatformHit {
  platform: MicrositePlatform;
  /** The exact substring that identified it, for a report a human can check. */
  evidence: string;
  /** Absolute URL on the platform, when the marker carried one. */
  handleUrl?: string;
  /**
   * The `Source.kind` this platform maps to, when an adapter here already scrapes it.
   * `undefined` means "recognised, not yet supported" — which is still worth reporting, because
   * it says the page is machine-readable by someone and the work is an adapter, not a model.
   */
  sourceKind?: string;
}

interface PlatformRule {
  platform: MicrositePlatform;
  /** Capture group 1, when present, is the handle URL (absolute or relative). */
  pattern: RegExp;
  sourceKind?: string;
}

/**
 * Ordered most-specific first. `lu.ma` before a generic embed check, because an embedded Luma
 * checkout on a bespoke page means the event IS a Luma event and `luma.ts` already reads it
 * perfectly.
 */
const PLATFORM_RULES: PlatformRule[] = [
  {
    platform: 'luma',
    pattern: /https?:\/\/(?:www\.)?(?:lu\.ma|luma\.com)\/([A-Za-z0-9_-]+)/i,
    sourceKind: 'luma-calendar',
  },
  {
    platform: 'eventbrite',
    pattern: /https?:\/\/(?:www\.)?eventbrite\.[a-z.]+\/(e\/[A-Za-z0-9_-]+)/i,
  },
  { platform: 'konfhub', pattern: /https?:\/\/(?:www\.)?konfhub\.com\/([A-Za-z0-9_-]+)/i },
  {
    platform: 'zoho-backstage',
    pattern: /https?:\/\/(?:www\.)?(?:zohobackstage\.com|backstage\.zoho\.[a-z.]+)\/([A-Za-z0-9_-]+)/i,
  },
  { platform: 'airmeet', pattern: /https?:\/\/(?:www\.)?airmeet\.com\/(?:e\/)?([A-Za-z0-9_-]+)/i },
  { platform: 'hubilo', pattern: /https?:\/\/[A-Za-z0-9-]+\.hubilo\.com\/?([A-Za-z0-9_-]*)/i },
  { platform: 'cvent', pattern: /https?:\/\/(?:web|events)\.cvent\.com\/event\/([A-Za-z0-9_-]+)/i },
  { platform: 'townscript', pattern: /https?:\/\/(?:www\.)?townscript\.com\/e\/([A-Za-z0-9_-]+)/i },
  {
    platform: 'devfolio',
    pattern: /https?:\/\/([A-Za-z0-9-]+)\.devfolio\.co/i,
    sourceKind: 'devfolio',
  },
  {
    platform: 'meetup',
    pattern: /https?:\/\/(?:www\.)?meetup\.com\/([A-Za-z0-9_-]+)\//i,
    sourceKind: 'meetup-group',
  },
  { platform: 'bevy', pattern: /https?:\/\/([A-Za-z0-9-]+\.community\.dev)/i, sourceKind: 'bevy' },
  { platform: 'hasgeek', pattern: /https?:\/\/(?:www\.)?hasgeek\.com\/([A-Za-z0-9_-]+)/i },
  { platform: 'explara', pattern: /https?:\/\/(?:www\.)?explara\.com\/e\/([A-Za-z0-9_-]+)/i },
];

/**
 * Which platform, if any, is behind this page.
 *
 * Reads the HTML rather than the stripped text: the markers live in `src`, `href` and `iframe`
 * attributes, which `stripHtml` deletes. That ordering — detect on HTML, extract from text — is
 * why this function takes the raw document.
 */
export function detectPlatform(html: string, pageUrl: string): PlatformHit | undefined {
  for (const rule of PLATFORM_RULES) {
    const match = rule.pattern.exec(html);
    if (!match) continue;
    // A page that merely links to its own domain through one of these patterns is not fronting it.
    const evidence = match[0].slice(0, 160);
    if (sameHost(evidence, pageUrl)) continue;
    return {
      platform: rule.platform,
      evidence,
      handleUrl: absoluteUrl(match[0], pageUrl),
      ...(rule.sourceKind ? { sourceKind: rule.sourceKind } : {}),
    };
  }
  return undefined;
}

function sameHost(candidate: string, pageUrl: string): boolean {
  try {
    return new URL(candidate).host === new URL(pageUrl).host;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CHANGE DETECTION
//
// WHY A CONTENT HASH AND NOT `ETag` / `Last-Modified`. Three reasons, in order of how much they
// decide it:
//
//  1. The wrong thing changes. A marketing site redeploys nightly, so its `ETag` and
//     `Last-Modified` move whether or not a single event changed — which would make the LLM run
//     every night and the whole mechanism decorative. It also fails the other way: a CDN serving
//     a long-cached shell can hold both steady while the client-rendered event list underneath
//     changes completely, and the event list is the only part that exists after rendering.
//  2. The validators are not reachable from the fetch path this codebase uses. `core/http.ts`
//     `fetchText` returns a string, not a `Response`, and widening it for one adapter would touch
//     every source in the directory.
//  3. A hash is computed on the artefact the model actually sees. That makes it the audit key as
//     well as the cache key: the fingerprint stored on a candidate row identifies the exact text
//     version that produced it, so a wrong parse can be re-run against the same input.
//
// The hash is taken over the STRIPPED, NORMALISED TEXT, not the HTML, so a changed build id,
// rotated CSRF token or reshuffled analytics script does not read as a changed page.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Length of the stored fingerprint. 16 hex chars — 64 bits, ample for a per-URL comparison. */
const FINGERPRINT_CHARS = 16;

export function contentFingerprint(text: string): string {
  return crypto
    .createHash('sha256')
    .update(normaliseForFingerprint(text))
    .digest('hex')
    .slice(0, FINGERPRINT_CHARS);
}

/**
 * Collapse the parts of a page that change without the page changing.
 *
 * Whitespace, and digits that look like a countdown ("3 days left", "Ends in 14:22:07"). Left
 * alone deliberately: dates, prices and everything else numeric — those changing IS the page
 * changing, and over-normalising here would make the stage skip a page on the day its date moved.
 */
function normaliseForFingerprint(text: string): string {
  return text
    .toLowerCase()
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:left|remaining|to go)\b/g, ' ')
    .replace(/\b\d+\s*(?:days?|hours?|minutes?|seconds?)\s*(?:left|remaining|to go)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** `sourceEventId` prefix. Namespaced so it can never collide with a platform's own id. */
export const FINGERPRINT_PREFIX = 'microsite:';

export function fingerprintSourceEventId(fingerprint: string): string {
  return `${FINGERPRINT_PREFIX}${fingerprint}`;
}

/** Recover the fingerprint a stored candidate was extracted from. */
export function fingerprintFromSourceEventId(value: string | undefined): string | undefined {
  if (!value || !value.startsWith(FINGERPRINT_PREFIX)) return undefined;
  return value.slice(FINGERPRINT_PREFIX.length) || undefined;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// SITE POLICY
//
// Cloudflare "Content Signals" in `robots.txt` are the one term that speaks DIRECTLY to what this
// adapter does, and honouring them is not optional politeness. Measured 2026-09-11:
// `indiafoss.net` publishes `Content-Signal: search=yes,ai-train=no,use=reference` and
// `Disallow: /` for ClaudeBot, GPTBot, CCBot, Google-Extended and
// CloudflareBrowserRenderingCrawler — a site on the watchlist above, whose whole purpose is
// Bengaluru open-source events.
//
// The two signals are read differently and the difference is the point:
//
//   · `ai-input=no` describes THIS. The spec's own words: "inputting content into one or more AI
//     models (e.g., retrieval augmented generation, grounding, or other real-time taking of
//     content)". So it BLOCKS the LLM step outright.
//   · `ai-train=no` refuses training and fine-tuning, which is not what happens here. Reported,
//     not enforced, because silently treating it as a block would make the stage skip a site that
//     has not actually refused, and inventing a restriction is as wrong as ignoring one.
//
// Steps 1 and 2 — JSON-LD and platform detection — are unaffected either way: they read the page
// the way a search engine does, which `search=yes` grants explicitly.
//
// FAILS OPEN ON A FETCH ERROR, and that is the standard's own rule (c): where a signal is absent
// the operator "neither grants nor restricts". A missing `robots.txt` is an absent signal, not a
// refusal. Safe here for a second reason too — the watchlist is hand-curated and the stage is off
// by default, so no site reaches this without an operator having put it there.
// ─────────────────────────────────────────────────────────────────────────────────────────────
export interface SitePolicy {
  /** May the rendered text be sent to a model? */
  llmAllowed: boolean;
  /** The signal line, verbatim, when one was published. */
  contentSignal?: string;
  /** Set when `ai-train=no` is published. Reported only — see the block comment. */
  refusesTraining: boolean;
  note?: string;
}

const OPEN_POLICY: SitePolicy = { llmAllowed: true, refusesTraining: false };

export function parseContentSignal(robotsTxt: string): SitePolicy {
  // Comment lines carry the spec's own explanatory preamble, which names every signal value and
  // would otherwise match. Stripped before anything is read.
  const directives = robotsTxt
    .split('\n')
    .filter(line => !line.trim().startsWith('#'))
    .join('\n');
  const match = /^\s*content-signal\s*:\s*(.+)$/im.exec(directives);
  if (!match) return OPEN_POLICY;
  const signal = match[1].trim();
  const aiInputNo = /ai-input\s*=\s*no/i.test(signal);
  const aiTrainNo = /ai-train\s*=\s*no/i.test(signal);
  return {
    llmAllowed: !aiInputNo,
    contentSignal: signal.slice(0, 200),
    refusesTraining: aiTrainNo,
    ...(aiInputNo ? { note: 'ai-input=no — extraction refused by the site' } : {}),
  };
}

/** One `robots.txt` read per host per process. */
const policyCache = new Map<string, Promise<SitePolicy>>();

export function sitePolicy(pageUrl: string): Promise<SitePolicy> {
  let host: string;
  try {
    host = new URL(pageUrl).origin;
  } catch {
    return Promise.resolve(OPEN_POLICY);
  }
  const cached = policyCache.get(host);
  if (cached) return cached;
  const fetching = fetchText(`${host}/robots.txt`, { timeoutMs: 10000, retries: 1 })
    .then(parseContentSignal)
    .catch(() => OPEN_POLICY);
  policyCache.set(host, fetching);
  return fetching;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE PASS
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** How each page was resolved. `platform` and `unchanged` both mean NO model call was made. */
export type MicrositeVia =
  | 'jsonld'
  | 'platform'
  | 'unchanged'
  | 'llm'
  | 'no-text'
  | 'no-render'
  | 'policy-refused'
  | 'error';

export interface MicrositeCandidate {
  /** Watchlist entry that produced it. */
  url: string;
  organizer: string;
  event: ExtractedEvent;
  /** Fingerprint of the text the model read. Becomes `Event.sourceEventId`. */
  fingerprint: string;
  /** The text itself, for the audit trail. Not stored on the Event — see the pipeline note. */
  sourceText: string;
  /** Verbatim model response. */
  rawResponse?: string;
  model?: string;
}

export interface MicrositePageReport {
  url: string;
  organizer: string;
  via: MicrositeVia;
  /** Length of the extracted plain text, 0 when nothing was rendered. */
  textLength: number;
  fingerprint?: string;
  platform?: PlatformHit;
  policy?: SitePolicy;
  /** UPCOMING events the cheap JSON-LD path found, when that is how the page answered. */
  jsonLdEvents?: number;
  /** JSON-LD events dropped as already finished — usually a site's own archive. */
  pastEvents?: number;
  candidates: number;
  /** Rejected rows, by reason, so precision is measurable rather than asserted. */
  rejections: Record<string, number>;
  /** Rows dropped after extraction because they are not in Bengaluru. */
  offCity: number;
  latencyMs: number;
  /** Which model answered, when one did. */
  model?: string;
  error?: string;
  /**
   * The text the model read and its verbatim reply — populated ONLY when `keepAudit` is set.
   *
   * The probe sets it; the pipeline must not. THE ZERO-CANDIDATE CASE IS THE ONE THAT NEEDS THIS:
   * a page that produced no events is either a correct refusal or a silent miss, and those are
   * indistinguishable without the input. The first version of this attached the text to accepted
   * CANDIDATES only, which meant the four pages worth investigating were the four with nothing to
   * inspect. Off by default because a report row carrying 17 KB of page text is not something to
   * log on every scrape.
   */
  auditText?: string;
  auditResponse?: string;
}

export interface MicrositeOutcome {
  candidates: MicrositeCandidate[];
  /** JSON-LD events from step 1. These are ordinary scraped events and DO join the public path. */
  structuredEvents: RawEvent[];
  /** Platform handles worth registering as real sources. */
  discovered: DiscoveredSource[];
  reports: MicrositePageReport[];
  errors: string[];
}

export interface MicrositeOptions {
  entries?: MicrositeEntry[];
  /** `core/render.ts#renderHtml`, passed in. Absent ⇒ no page reaches the LLM step. */
  render?: PageRenderer;
  /** URL → fingerprint from the last run. A match skips the model entirely. */
  knownFingerprints?: Map<string, string>;
  /** Hard cap on model calls this run, so a watchlist edit cannot become a bill. */
  maxExtractions?: number;
  /** Pages fetched/rendered at once. Kept low: a render is ~100 MB and these are small sites. */
  concurrency?: number;
  now?: Date;
  provider?: ExtractionProvider;
  /** Attach the page text and the raw model reply to every LLM report row. Probe only. */
  keepAudit?: boolean;
  /** Injected in the probe so it can report without a live model. */
  extract?: (input: {
    url: string;
    pageTitle?: string;
    text: string;
    now?: Date;
    provider?: ExtractionProvider;
  }) => Promise<ExtractionResult>;
}

/** Default LLM budget per run. Five pages is the watchlist; the cap is the guard, not the plan. */
export const DEFAULT_MAX_EXTRACTIONS = 6;

function pageTitleOf(html: string): string | undefined {
  const match = /<title[^>]*>([\s\S]{1,300}?)<\/title>/i.exec(html);
  return match ? stripHtml(match[1]).trim() || undefined : undefined;
}

/**
 * Is this extracted event in Bengaluru?
 *
 * The gate is applied HERE rather than left to the pipeline's stage 5c because these rows do not
 * travel through it — they are landed separately as pending submissions. Two tiers, matching what
 * the rest of the codebase does with the same two functions:
 *
 *   · `offCityReason` is the hard reject, and it is the same predicate
 *     `cleanup-non-bengaluru.ts` selects on. It never reads a description, so "our Chennai
 *     rollout" in body copy cannot condemn a Bengaluru event.
 *   · `isBengaluru` must then be positively TRUE for a physical event, unless the watchlist entry
 *     is city-scoped. On a global company's events index that is the difference between a review
 *     queue about Bengaluru and one about Las Vegas — and unlike the feed, a queue nobody can
 *     work through is a queue that gets abandoned.
 *
 * Online events pass on both counts: an online event with no city text is attendable from here,
 * which is the same judgement `universal.ts` makes.
 */
export function isBengaluruCandidate(event: ExtractedEvent, entry: MicrositeEntry): boolean {
  return isBengaluruLocation(
    { title: event.title, venue: event.venue, address: event.address, city: event.city },
    entry,
    event.isOnline
  );
}

/**
 * The same two-tier gate, applied to the CHEAP path's output as well.
 *
 * This was missing on the first run of `probe-microsite-llm.ts` and it found a real leak in one
 * measurement: `reactindia.io` publishes clean JSON-LD, so step 1 answered — and the event is at
 * "Planet Hollywood Beach Resort", which is in GOA. `offCityReason` alone does not catch it (no
 * field contains the word "Goa", and with no Bengaluru evidence either it returns "keep"), so a
 * Goa conference would have gone into the public feed as a company event.
 *
 * `universal.ts` has always had this guard — its `geoPolicy: 'require'` drops an event whose
 * `isBengaluru` verdict is `null` unless it is online — and the JSON-LD path here is the same
 * path, so it needs the same rule. The lesson is the one CLAUDE.md keeps recording: the cheap path
 * being exact about the DATA says nothing about whether the data is about this city.
 */
export function isBengaluruLocation(
  input: { title?: string; venue?: string; address?: string; city?: string; text?: string },
  entry: MicrositeEntry,
  isOnline: boolean
): boolean {
  if (offCityReason({ title: input.title, venue: input.venue, address: input.address, city: input.city })) {
    return false;
  }
  if (isOnline) return true;
  const verdict = isBengaluru({
    venue: input.venue,
    address: input.address,
    city: input.city,
    text: input.text,
  });
  if (verdict === false) return false;
  if (verdict === true) return true;
  // Unknown. Accepted only on a page that is itself Bengaluru-scoped.
  return entry.bengaluruOnly === true;
}

/**
 * Run the microsite pass.
 *
 * Never throws: a page that fails is one report row with `via: 'error'`, which is the same
 * isolation every source in this directory has.
 */
export async function scrapeMicrosites(opts: MicrositeOptions = {}): Promise<MicrositeOutcome> {
  const entries = opts.entries ?? MICROSITE_WATCHLIST;
  const known = opts.knownFingerprints ?? new Map<string, string>();
  const extract = opts.extract ?? extractEventsFromText;
  const provider = opts.provider ?? extractionProvider();
  const concurrency = opts.concurrency ?? 2;
  let budget = opts.maxExtractions ?? DEFAULT_MAX_EXTRACTIONS;

  const outcome: MicrositeOutcome = {
    candidates: [],
    structuredEvents: [],
    discovered: [],
    reports: [],
    errors: [],
  };

  const results = await mapPool(entries, concurrency, async entry => {
    const startedAt = Date.now();
    const report: MicrositePageReport = {
      url: entry.url,
      organizer: entry.organizer,
      via: 'error',
      textLength: 0,
      candidates: 0,
      rejections: {},
      offCity: 0,
      latencyMs: 0,
    };
    const local: {
      report: MicrositePageReport;
      candidates: MicrositeCandidate[];
      structured: RawEvent[];
      discovered: DiscoveredSource[];
    } = { report, candidates: [], structured: [], discovered: [] };

    let html: string;
    try {
      html = await fetchText(entry.url, { timeoutMs: 25000, retries: 2 });
    } catch (error) {
      report.error = `fetch failed: ${error instanceof Error ? error.message : String(error)}`;
      report.latencyMs = Date.now() - startedAt;
      return local;
    }

    // ── 1. JSON-LD, free and exact ──────────────────────────────────────────
    //
    // "Answered" means it produced events IN BENGALURU. A page that emits perfect `Event` schema
    // about a conference in Goa has not answered this pipeline's question, and letting it stop the
    // cascade would also hide whichever local event the page announces further down.
    const allStructured = rawEventsFromHtml(html, { baseUrl: entry.url, source: 'company' });
    /*
     * PAST EVENTS DROPPED HERE, not left to the pipeline's date gate — same as `universal.ts`.
     *
     * Measured 2026-09-11: `rootconf.in` publishes 20 clean JSON-LD `Event` nodes and every one is
     * an ARCHIVE, dated 2018-2022, and `opensourceindia.in` publishes exactly one, dated 2022.
     * Stage 5b would reject them all, so nothing wrong reaches the corpus either way — but the
     * source-health row would read "20 events" for a page contributing zero, which is the reporting
     * failure the pipeline's gate ledger exists to stop. A conference site keeping its back
     * catalogue in schema.org markup is the normal case, not an oddity.
     */
    const now = (opts.now ?? new Date()).getTime();
    const structured = allStructured.filter(
      event => (event.endDateTime ?? event.startDateTime).getTime() >= now
    );
    report.pastEvents = allStructured.length - structured.length;
    if (structured.length > 0) {
      report.jsonLdEvents = structured.length;
      for (const event of structured) {
        if (!event.organizer) event.organizer = entry.organizer;
      }
      const local2 = structured.filter(event =>
        isBengaluruLocation(
          {
            title: event.title,
            venue: event.venue,
            address: event.address,
            city: event.city,
            text: event.description,
          },
          entry,
          event.rawFormat === 'online'
        )
      );
      report.offCity = structured.length - local2.length;
      if (local2.length > 0) {
        local.structured = local2;
        report.via = 'jsonld';
        report.latencyMs = Date.now() - startedAt;
        return local;
      }
    }

    // ── 2. Underlying platform — prefer it, and spend no model call ──────────
    //
    // IT SHORT-CIRCUITS ONLY WHEN AN ADAPTER CAN ACTUALLY TAKE OVER, and that condition was added
    // because measurement showed the obvious version failing. `cypherconf.com` was detected as
    // Eventbrite on the strength of a link to a **2017** ticket page still sitting in the site's
    // footer. Eventbrite has no per-event adapter here (`eventbrite.ts` reads city browse pages),
    // so stopping there would have handed back "platform: eventbrite" and zero events — a page
    // routed away from the only path that could read it, by a nine-year-old hyperlink.
    //
    // So a platform WITH an adapter still stops the cascade: the handle is permanent, exact supply
    // and an extraction would be a paid guess at data we can fetch properly. A platform WITHOUT one
    // is RECORDED and the cascade continues — the report still says the page is machine-readable by
    // somebody, which is the signal that the work is an adapter rather than a model.
    const platform = detectPlatform(html, entry.url);
    if (platform) {
      report.platform = platform;
      if (platform.sourceKind && platform.handleUrl) {
        local.discovered.push({
          kind: platform.sourceKind,
          handle: platform.handleUrl,
          label: `${entry.organizer} — via ${platform.platform}`,
        });
        report.via = 'platform';
        report.latencyMs = Date.now() - startedAt;
        return local;
      }
    }

    // ── 3. Render → text → LLM ──────────────────────────────────────────────
    const policy = await sitePolicy(entry.url);
    report.policy = policy;
    if (!policy.llmAllowed) {
      report.via = 'policy-refused';
      report.error = policy.note;
      report.latencyMs = Date.now() - startedAt;
      return local;
    }

    if (!opts.render) {
      report.via = 'no-render';
      report.latencyMs = Date.now() - startedAt;
      return local;
    }

    const rendered = await opts.render(entry.url);
    // `renderHtml` returns null on every failure and never throws, so null here means "no
    // browser" or "the page did not load" — both of which are "no events", not an error.
    const text = stripHtml(rendered ?? html);
    report.textLength = text.length;
    if (text.length < 400) {
      report.via = 'no-text';
      report.latencyMs = Date.now() - startedAt;
      return local;
    }

    const fingerprint = contentFingerprint(text);
    report.fingerprint = fingerprint;
    if (known.get(entry.url) === fingerprint) {
      report.via = 'unchanged';
      report.latencyMs = Date.now() - startedAt;
      return local;
    }

    if (budget <= 0) {
      report.via = 'error';
      report.error = 'extraction budget exhausted for this run';
      report.latencyMs = Date.now() - startedAt;
      return local;
    }
    budget--;

    const extraction = await extract({
      url: entry.url,
      pageTitle: pageTitleOf(html),
      text,
      now: opts.now,
      provider,
    });
    report.via = 'llm';
    report.model = extraction.model;
    if (opts.keepAudit) {
      report.auditText = text;
      report.auditResponse = extraction.rawResponse;
    }
    if (extraction.error) report.error = extraction.error;
    if (extraction.transportError) {
      report.error = [report.error, extraction.transportError].filter(Boolean).join('; ');
    }
    for (const rejection of extraction.rejected) {
      report.rejections[rejection.reason] = (report.rejections[rejection.reason] ?? 0) + 1;
    }

    for (const event of extraction.events) {
      if (!isBengaluruCandidate(event, entry)) {
        report.offCity++;
        continue;
      }
      local.candidates.push({
        url: entry.url,
        organizer: entry.organizer,
        event,
        fingerprint,
        sourceText: text,
        rawResponse: extraction.rawResponse,
        model: extraction.model,
      });
    }
    report.candidates = local.candidates.length;
    report.latencyMs = Date.now() - startedAt;
    return local;
  });

  for (const result of results) {
    if (!result) continue;
    outcome.reports.push(result.report);
    outcome.candidates.push(...result.candidates);
    outcome.structuredEvents.push(...result.structured);
    outcome.discovered.push(...result.discovered);
    if (result.report.error) {
      outcome.errors.push(`${result.report.organizer}: ${result.report.error}`);
    }
  }

  return outcome;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CANDIDATE → RawEvent
//
// Converting here rather than in the pipeline is what lets the landing path reuse
// `normalizeEvents()` — the audited normalizer — instead of hand-assembling a document. That
// matters more than it looks: `assemble()` derives `area`, `companies`, `connectionScore`,
// `audience`/`perks`/`tier`, the slug and both dedup keys, and a hand-rolled copy would be a second
// definition of every one of them.
//
// `source: 'company'` because `EVENT_SOURCES` has no `microsite` member and this is not the file
// that gets to add one. The distinguishing marker is `sourceEventId`, which the landing path sets
// to `microsite:<fingerprint>` — see `fingerprintSourceEventId`.
//
// THE FINGERPRINT IS NOT SET HERE. `assemble()` copies `raw.sourceEventId` straight through and it
// feeds ingestion's second lookup, so putting it on the RawEvent would make the value visible to a
// path these rows must never enter. The landing path stamps it after normalisation instead.
// ─────────────────────────────────────────────────────────────────────────────────────────────
export function candidateToRawEvent(candidate: MicrositeCandidate): RawEvent {
  const { event } = candidate;
  return {
    title: event.title,
    description: event.description,
    sourceUrl: event.registrationUrl ?? candidate.url,
    source: 'company',
    organizer: event.organizer ?? candidate.organizer,
    venue: event.venue,
    address: event.address,
    // Only what the page said. `assemble()` fills 'Bengaluru' itself when an area resolves, which
    // is a derivation from the venue rather than an assumption about the event.
    city: event.city,
    startDateTime: event.startsAt,
    endDateTime: event.endsAt,
    timezone: 'Asia/Kolkata',
    isFree: event.isFree,
    price: event.priceInr,
    currency: event.priceInr !== undefined ? 'INR' : undefined,
    applyLink: event.registrationUrl ?? candidate.url,
    rawFormat: event.isOnline ? 'online' : 'offline',
    /*
     * NO `tags`, DELIBERATELY, AND IT IS NOT AN OMISSION.
     *
     * A marker tag naming the watchlist URL was the obvious way to carry provenance through
     * normalisation — and `assemble()` passes `raw.tags` to `resolveCompanies()`, which scores a
     * TAG match at 60 with no `strength` gate. So `__microsite:https://razorpay.com/events/` would
     * attribute the company Razorpay to every event extracted from that page, justified by nothing
     * but the URL it was fetched from. That is the same class as the documented `Docker` →
     * "SriVidya Tradition" leak, from the one direction `strength` cannot defend against.
     *
     * Provenance travels by POSITION instead: `normalizeEvents` maps input to output index for
     * index, so the landing path zips its candidates against the normalised rows.
     */
  };
}

