// LLM extraction of a single event from the RENDERED TEXT of a company microsite.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHY THIS EXISTS, AND WHY IT IS NOT THE THING `universal.ts` REFUSES TO DO.
//
// `adapters/universal.ts` states, as a deliberate non-goal, that there is no LLM-on-HTML
// fallback: "blind extraction on such pages produces confident garbage (wrong dates, marketing
// copy as titles) that is worse than absence." That was correct, and the reason was never
// "an LLM cannot read a page" — it was that a hallucinated event reaching the PUBLIC FEED
// unchallenged is worse than a missing one.
//
// Two things have changed, and only together do they make this buildable:
//
//  1. THE PIPELINE IS NO LONGER FULLY AUTOMATIC. `visibility: 'pending'` plus the submissions
//     queue (`GET/PATCH /api/admin/submissions`, `app/admin/SubmissionsPanel.tsx`) means an
//     extracted event lands in front of a human before it can reach a reader. Nothing here is
//     allowed to produce a public row — see `landMicrositeCandidates` in `pipeline.ts`.
//  2. STRUCTURED EXTRACTION IS MEASURED DEAD, so there is no cheaper alternative left. Tested
//     twice: 19 of 20 pages in `COMPANY_EVENT_PAGES` yield nothing on raw HTTP, and 0 of 5
//     (Databricks, MongoDB, Razorpay, Microsoft Reactor, Confluent) emit `Event` schema even
//     fully rendered with headless Chromium. The rendered TEXT is all there (4.5k-15k chars
//     naming "register", "agenda", "speakers", "Bengaluru"), and it is the only thing left.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE CONTRACT: VALIDATE STRICTLY, REJECT ON A MISS, NEVER COERCE.
//
// This is the whole safety argument, and every rule below exists because the OPPOSITE choice is
// the one that feels helpful in the moment:
//
//   · A date is accepted only in an explicit ISO shape. `new Date("Sept 20")` succeeds, silently
//     picks the current year, and is how a page about last year's summit becomes an upcoming
//     event. So the pattern is matched before anything is constructed.
//   · A physical event with no venue, address or city is REJECTED, not filed with a guessed
//     location. "Bengaluru" appearing somewhere on a global company's events page is not
//     evidence that THIS event is in Bengaluru.
//   · Every field that claims to be quoted from the page is GROUNDED against the page: a title
//     or venue that does not appear in the source text is a hallucination by construction, and
//     this check costs nothing. It is the single most effective rule here.
//   · A start instant outside the plausible window is rejected using the same bounds the pipeline
//     already applies at stage 5b, so a hallucinated year cannot be stored and then cleaned up
//     later by `cleanup-implausible.ts`.
//
// THERE IS NO FLOOR HERE, UNLIKE TAGGING. `keywordTagging()` exists so an event is never dropped
// for want of a classification; extraction has no such analogue and must not acquire one. A
// throttled, failed or half-parsed extraction yields ZERO events. A partial event is a fabricated
// event with some true fields in it.
// ═════════════════════════════════════════════════════════════════════════════════════════════

import { isRateLimited, retryAfterMs, BATCH_BACKOFF_CAP_MS } from './throttle';

/**
 * One event as the model returned it, after validation.
 *
 * Deliberately NOT `RawEvent`: that type is the adapter contract and carries fields no page text
 * can support (coordinates, platform ids, guest counts). Keeping the extraction shape separate
 * means a field added to `RawEvent` cannot silently become something a model is trusted to invent.
 */
export interface ExtractedEvent {
  title: string;
  description: string;
  /** Absolute instant. Built only from a strictly-matched ISO string — see `parseIsoInstant`. */
  startsAt: Date;
  endsAt?: Date;
  /** True when the naked local time in the response was read as IST. */
  assumedIst: boolean;
  /**
   * True when the page gave a DATE and no time, so `startsAt` is midnight IST.
   *
   * MEASURED, NOT ANTICIPATED. The first live run against `opensourceindia.in` — a page whose only
   * temporal claim is "7-8 OCT 2026 | BENGALURU" — came back `2026-10-07T00:00`, because the format
   * demanded a time and the model had none to give. Forcing a field the page does not contain is
   * the coercion this module exists to refuse, so the date-only shape is now expressible and the
   * assumption is recorded instead of being indistinguishable from a stated midnight.
   */
  timeAssumed: boolean;
  venue?: string;
  address?: string;
  city?: string;
  isOnline: boolean;
  organizer?: string;
  registrationUrl?: string;
  priceInr?: number;
  isFree?: boolean;
  speakers?: Array<{ name: string; title?: string; company?: string }>;
}

/** Why one candidate object was thrown away. One reason per row, so a probe can tabulate them. */
export type RejectionReason =
  | 'not-an-object'
  | 'title-missing'
  | 'title-not-on-page'
  | 'description-missing'
  | 'start-not-iso'
  | 'start-out-of-window'
  | 'end-before-start'
  | 'no-location-evidence'
  | 'venue-not-on-page'
  | 'bad-registration-url';

export interface Rejection {
  reason: RejectionReason;
  /** What the model said, truncated. Enough to argue with the rejection. */
  sample: string;
}

export interface ExtractionParse {
  events: ExtractedEvent[];
  rejected: Rejection[];
  /** Set when the response could not be read as a JSON array at all. */
  transportError?: string;
}

export interface ExtractionResult extends ExtractionParse {
  /** Which provider answered, or undefined when none could. */
  provider?: string;
  model?: string;
  /** Why no call was made or why it failed. A failure yields no events, never a partial one. */
  error?: string;
  latencyMs: number;
  /** Verbatim response, for the audit trail. Kept even when parsing rejected everything. */
  rawResponse?: string;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// PROMPT
//
// Two instructions carry most of the precision, and both are phrased as REFUSALS because a
// model asked to "extract the event" from a page listing eight of them will invent a ninth that
// summarises the others:
//
//   · Quote, never paraphrase, the title and venue. This is what makes the grounding check in
//     `parseExtraction` a real filter rather than a formality.
//   · Return `[]` rather than a guess. A model that has been told an empty array is a correct
//     answer stops manufacturing one.
//
// The date instruction is explicit about the two failure modes seen in the wild: a year the page
// does not state, and a range ("Sept 18-20") flattened to one day.
// ─────────────────────────────────────────────────────────────────────────────────────────────
export const EXTRACTION_SYSTEM_PROMPT = `You read the visible text of ONE web page and report the events it announces.

Return ONLY a JSON array. No prose, no code fence, no explanation.

Each element:
{
  "title": string,            // QUOTED from the page. Never paraphrased, never a summary.
  "description": string,      // 1-3 sentences, drawn only from the page's own words.
  "startsAt": string,         // "YYYY-MM-DDTHH:MM", with an offset "…+05:30", or "YYYY-MM-DD"
                              // if the page gives a date and NO time. Never invent a time.
  "endsAt": string|null,      // same format, or null
  "venue": string|null,       // QUOTED from the page. The building or campus name.
  "address": string|null,
  "city": string|null,        // Only if the page states it for THIS event.
  "isOnline": boolean,
  "organizer": string|null,
  "registrationUrl": string|null,
  "priceInr": number|null,    // Rupees. null if not stated.
  "isFree": boolean|null,
  "speakers": [{"name": string, "title": string|null, "company": string|null}] | null
}

RULES — a wrong answer is much worse than no answer:
- If the page announces no dated event, return [].
- NEVER infer a year, a month or a day the page does not state. If the DATE is incomplete, omit that event entirely. If only the TIME is missing, give the date alone.
- A date RANGE is one event with startsAt and endsAt, not several.
- Times with no timezone are Indian Standard Time.
- If the page does not say where a physical event is, set venue, address and city to null — do not guess from the company's headquarters or from other events on the page.
- Do not include past events, "on demand" recordings, webinar archives, or always-available content.
- Report at most 10 events, the soonest first.`;

/** Characters of page text sent to the model. */
export const TEXT_BUDGET = 12000;

/**
 * The prompt body.
 *
 * The URL is included because it is frequently the only place a year appears (`/summit-2026/`),
 * and because the model needs it to resolve a relative registration link into something absolute.
 * It is labelled as page metadata rather than instruction, so a URL containing words like
 * "ignore-previous" is data.
 */
export function buildExtractionPrompt(input: {
  url: string;
  pageTitle?: string;
  text: string;
}): string {
  const text = input.text.slice(0, TEXT_BUDGET);
  return [
    'PAGE URL: ' + input.url,
    input.pageTitle ? 'PAGE TITLE: ' + input.pageTitle : '',
    '',
    'VISIBLE TEXT:',
    text,
  ]
    .filter(Boolean)
    .join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// VALIDATION
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * ISO instants only, and the offset handling is the interesting half.
 *
 * A bare `new Date(value)` is what this function exists to avoid: it accepts "Sept 20", "next
 * Tuesday" and "2026-13-45", inventing a year or an epoch date for each. So the shape is matched
 * first and only then constructed.
 *
 * A naked local time is read as IST and the caller is told (`assumedIst`), because this product is
 * Bengaluru-only and every other adapter resolves its own timezone the same way — but a silent
 * assumption about an instant is exactly the kind of thing that shows up as an event on the wrong
 * day, so it is recorded rather than absorbed.
 */
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})?)?$/;

export function parseIsoInstant(
  value: unknown
): { at: Date; assumedIst: boolean; timeAssumed: boolean } | undefined {
  if (typeof value !== 'string') return undefined;
  const match = ISO_INSTANT.exec(value.trim());
  if (!match) return undefined;
  const [, year, month, day, hourRaw, minuteRaw, second, offset] = match;
  const timeAssumed = hourRaw === undefined;
  const hour = hourRaw ?? '00';
  const minute = minuteRaw ?? '00';
  // Range-check before constructing: `Date.UTC(2026, 12, 45)` rolls over into a real instant
  // rather than failing, so month 13 would become the following January.
  const m = Number(month);
  const d = Number(day);
  const h = Number(hour);
  const min = Number(minute);
  if (m < 1 || m > 12 || d < 1 || d > 31 || h > 23 || min > 59) return undefined;

  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second ?? '00'}${offset ?? '+05:30'}`;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return undefined;
  // Catches the rollover cases the range check above cannot: 31 February parses and then reports
  // a different day than it was given.
  if (at.getTime() === 0 && year !== '1970') return undefined;
  return { at, assumedIst: !offset, timeAssumed };
}

/**
 * Plausible-window bounds, copied from the values `pipeline.ts` applies at stage 5b.
 *
 * Deliberately duplicated as named constants rather than imported: `pipeline.ts` declares them
 * inside `runPipeline` as locals, so there is nothing to import, and this module must stay free of
 * any scraper import so it can be unit-tested with no I/O graph behind it. If those numbers change,
 * these are the second place to change — which is why they are named after the stage that owns
 * them.
 */
export const MAX_PAST_START_DAYS = 2;
export const MAX_FUTURE_START_DAYS = 550;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Grounding: does this string actually appear in the page text?
 *
 * Compared on letters and digits only, because the rendered text has different whitespace,
 * punctuation and casing from whatever the model echoed back — "AI Summit '26 | Bengaluru" against
 * "AI Summit 26 Bengaluru" is the same claim. Anything shorter than four comparable characters is
 * accepted rather than tested: at that length the check is noise, and the length floor on `title`
 * already rejects the degenerate cases.
 *
 * EXPORTED so `scripts/diag-microsite-audit.ts` re-checks a stored row with THIS predicate rather
 * than a copy of it. The same reason `cleanup-non-bengaluru.ts` imports `offCityReason` instead of
 * mirroring it: an audit that drifts from the gate it audits reports on a rule nothing enforces.
 */
export function isGrounded(value: string, haystack: string): boolean {
  const flatten = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const needle = flatten(value);
  if (needle.length < 4) return true;
  return flatten(haystack).includes(needle);
}

function str(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

/**
 * http(s) only, for the same reason `lib/events/manual-input.ts` insists on it: this URL ends up
 * in an `href` on the event page and in front of the admin reviewing the submission, so a
 * `javascript:` value here is stored XSS with a reviewer as the first target.
 */
function httpUrl(value: unknown): string | undefined {
  const raw = str(value, 2000);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** Strip a code fence if the model wrapped its JSON in one. Transport, not content. */
function unwrapJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : raw).trim();
  // Some models prepend a sentence. Take the outermost array if one is present.
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start >= 0 && end > start) return body.slice(start, end + 1);
  return body;
}

export interface ParseContext {
  /** The page text the model was shown. Grounding is checked against this. */
  sourceText: string;
  /** Injected in tests; defaults to now. */
  now?: Date;
  /** Cap on accepted events, so one runaway response cannot fill the review queue. */
  maxEvents?: number;
}

/**
 * Validate a raw model response into events, plus a reason for everything thrown away.
 *
 * PURE — no I/O, no clock of its own unless `now` is omitted. `tests/extract-event.test.ts` pins
 * every rejection reason here, which is the point: the rejections are the feature.
 */
export function parseExtraction(raw: string, ctx: ParseContext): ExtractionParse {
  const out: ExtractionParse = { events: [], rejected: [] };
  const now = ctx.now ?? new Date();
  const maxEvents = ctx.maxEvents ?? 10;

  let parsed: unknown;
  try {
    parsed = JSON.parse(unwrapJson(raw));
  } catch (error) {
    out.transportError = `response was not JSON: ${
      error instanceof Error ? error.message : String(error)
    }`;
    return out;
  }

  if (!Array.isArray(parsed)) {
    out.transportError = `response was ${
      parsed === null ? 'null' : typeof parsed
    }, expected a JSON array`;
    return out;
  }

  const reject = (reason: RejectionReason, row: unknown) =>
    out.rejected.push({ reason, sample: JSON.stringify(row ?? null).slice(0, 200) });

  for (const row of parsed) {
    if (out.events.length >= maxEvents) break;
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      reject('not-an-object', row);
      continue;
    }
    const obj = row as Record<string, unknown>;

    const title = str(obj.title, 300);
    if (!title || title.length < 4) {
      reject('title-missing', obj);
      continue;
    }
    if (!isGrounded(title, ctx.sourceText)) {
      reject('title-not-on-page', obj);
      continue;
    }

    const description = str(obj.description, 6000);
    if (!description) {
      reject('description-missing', obj);
      continue;
    }

    const start = parseIsoInstant(obj.startsAt);
    if (!start) {
      reject('start-not-iso', obj);
      continue;
    }
    const ageMs = now.getTime() - start.at.getTime();
    if (ageMs > MAX_PAST_START_DAYS * DAY_MS || -ageMs > MAX_FUTURE_START_DAYS * DAY_MS) {
      reject('start-out-of-window', obj);
      continue;
    }

    let endsAt: Date | undefined;
    if (obj.endsAt !== null && obj.endsAt !== undefined && obj.endsAt !== '') {
      const end = parseIsoInstant(obj.endsAt);
      // An unparseable END is not fatal — the event is still fully specified without one, and
      // dropping a real event over an optional field would be the coercion rule applied backwards.
      // An end BEFORE the start is different: it means the model mis-read the range, so the row's
      // dates cannot be trusted at all.
      if (end) {
        if (end.at.getTime() < start.at.getTime()) {
          reject('end-before-start', obj);
          continue;
        }
        endsAt = end.at;
      }
    }

    const isOnline = obj.isOnline === true;
    const venue = str(obj.venue, 300);
    const address = str(obj.address, 500);
    const city = str(obj.city, 100);

    if (!isOnline && !venue && !address && !city) {
      reject('no-location-evidence', obj);
      continue;
    }
    if (venue && !isGrounded(venue, ctx.sourceText)) {
      reject('venue-not-on-page', obj);
      continue;
    }

    let registrationUrl: string | undefined;
    if (obj.registrationUrl !== null && obj.registrationUrl !== undefined && obj.registrationUrl !== '') {
      registrationUrl = httpUrl(obj.registrationUrl);
      if (!registrationUrl) {
        // Refused rather than dropped: a page whose "register" link the model turned into a
        // `javascript:` or relative string is a page it read badly, and the link is the one field
        // a reviewer is most likely to click.
        reject('bad-registration-url', obj);
        continue;
      }
    }

    const priceRaw = obj.priceInr;
    const priceInr =
      typeof priceRaw === 'number' && Number.isFinite(priceRaw) && priceRaw >= 0
        ? priceRaw
        : undefined;

    const speakers = Array.isArray(obj.speakers)
      ? obj.speakers
          .map(s => {
            if (!s || typeof s !== 'object') return undefined;
            const person = s as Record<string, unknown>;
            const name = str(person.name, 120);
            // Grounded like the title. A fabricated speaker is the one extraction error that
            // damages a real person, and `Event.speakers` is read by `speaker-match.ts`.
            if (!name || !isGrounded(name, ctx.sourceText)) return undefined;
            return {
              name,
              ...(str(person.title, 160) ? { title: str(person.title, 160)! } : {}),
              ...(str(person.company, 160) ? { company: str(person.company, 160)! } : {}),
            };
          })
          .filter((s): s is { name: string; title?: string; company?: string } => Boolean(s))
          .slice(0, 12)
      : undefined;

    out.events.push({
      title,
      description,
      startsAt: start.at,
      ...(endsAt ? { endsAt } : {}),
      assumedIst: start.assumedIst,
      timeAssumed: start.timeAssumed,
      ...(venue ? { venue } : {}),
      ...(address ? { address } : {}),
      ...(city ? { city } : {}),
      isOnline,
      ...(str(obj.organizer, 200) ? { organizer: str(obj.organizer, 200)! } : {}),
      ...(registrationUrl ? { registrationUrl } : {}),
      ...(priceInr !== undefined ? { priceInr } : {}),
      ...(typeof obj.isFree === 'boolean' ? { isFree: obj.isFree } : {}),
      ...(speakers && speakers.length ? { speakers } : {}),
    });
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// PROVIDER CALL
//
// ICA ONLY, DELIBERATELY. Measured 2026-09-10: NVIDIA is dead at the account level (404 for
// every model, including ones `GET /models` lists) and `ANTHROPIC_API_KEY` is unset, so the
// cascade that `tagger.ts` runs would only add two rejected round trips per page. More to the
// point, extraction is not classification: the 8B model that answers tagging in 376 ms is not a
// model to trust with "quote the title and do not invent the year". If a second frontier tier
// appears, add it here — not a small model as a floor. There is no floor for extraction.
//
// THROTTLE HANDLING IS IMPORTED, NOT COPIED. `lib/llm/throttle.ts` owns the predicate because it
// describes what ICA does — fronting Bedrock through litellm and LOSING the 429, so a throttle
// arrives as an HTTP 400 with the cause only in the body — rather than what any caller wants. It
// had already been written twice in one day before that module existed, and a copied predicate does
// not stay a copy.
//
// THE CAP AND THE ATTEMPT COUNT ARE THIS CALLER'S TO CHOOSE, and both are deliberate:
//
//   · `BATCH_BACKOFF_CAP_MS` (20s), because this runs on a GitHub runner behind the rest of a
//     nightly scrape, with nobody watching. The interactive cap would fail a page that would have
//     succeeded a second later.
//   · Four attempts, matching the tagger's, for one specific reason: two other agents share this
//     ICA account today and throttling is the expected condition, not the exception. Fewer would
//     make a busy night look like an extraction failure.
//
// AND THE FAILURE MODE IS STRICTER THAN THE TAGGER'S. Tagging has `keywordTagging()` as its floor,
// so a throttled batch degrades to coarser categories and the event survives. There is no floor
// here and there must never be one: every path below returns ZERO events, because a half-parsed
// event landing in the submissions queue is a hallucination wearing a review badge — it arrives
// with the same status as a verified candidate and a reviewer has no way to tell them apart.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Attempts per throttled request.
 *
 * Four. See the note above: concurrent load on this ICA account makes a 400-shaped throttle the
 * normal case rather than an anomaly, and the alternative to waiting is a page that silently
 * contributes nothing.
 */
const RATE_LIMIT_ATTEMPTS = 4;

/**
 * ICA requires `temperature: 1` on `claude-sonnet-5` and answers `{"detail":"Model not found"}`
 * when the field is absent — the most misleading error in this stack, documented under
 * Environment in CLAUDE.md. Sent explicitly for that reason, not as a style choice. Extraction
 * would prefer 0, and cannot have it.
 */
const ICA_TEMPERATURE = 1;

export interface ExtractionProvider {
  name: string;
  model: string;
  apiKey: string;
  baseUrl: string;
}

/**
 * The configured extraction provider, or `undefined`.
 *
 * `undefined` is a normal outcome, not an error: with no key the microsite stage contributes zero
 * candidates, exactly as an adapter with a dead feed contributes zero events.
 */
export function extractionProvider(): ExtractionProvider | undefined {
  if (process.env.PULSEBLR_SKIP_LLM === '1') return undefined;
  const { ICA_API_KEY, ICA_BASE_URL, ICA_MODEL } = process.env;
  if (!ICA_API_KEY || !ICA_BASE_URL || !ICA_MODEL) return undefined;
  return {
    name: 'IBM ICA',
    model: ICA_MODEL,
    apiKey: ICA_API_KEY,
    baseUrl: ICA_BASE_URL,
  };
}

/**
 * Extract events from one page's text.
 *
 * NEVER THROWS AND NEVER RETURNS A PARTIAL EVENT. Every failure path — no provider, throttled
 * past the retry budget, a non-JSON response, a rejected row — returns zero events with the
 * reason attached, because a scrape stage that dies on one page is the failure mode every adapter
 * in this codebase is isolated to prevent.
 */
export async function extractEventsFromText(input: {
  url: string;
  pageTitle?: string;
  text: string;
  now?: Date;
  timeoutMs?: number;
  provider?: ExtractionProvider;
}): Promise<ExtractionResult> {
  const startedAt = Date.now();
  const provider = input.provider ?? extractionProvider();
  if (!provider) {
    return {
      events: [],
      rejected: [],
      error: 'no extraction provider configured (ICA_API_KEY / ICA_BASE_URL / ICA_MODEL)',
      latencyMs: 0,
    };
  }

  const url = `${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const userPrompt = buildExtractionPrompt(input);
  const timeoutMs = input.timeoutMs ?? 90_000;

  const call = () =>
    fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${provider.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: provider.model,
        messages: [
          { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        // One page, up to ten events, each with a description and a speaker list. Roughly
        // 250 tokens per event, so 4000 is comfortable headroom — and 4000 is a value this
        // gateway is known to accept, which is why it matches `tagger.ts` rather than being
        // recomputed upward. A truncated response is indistinguishable from a malformed one at
        // the parse layer.
        max_tokens: 4000,
        temperature: ICA_TEMPERATURE,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

  const fail = (error: string, rawResponse?: string): ExtractionResult => ({
    events: [],
    rejected: [],
    provider: provider.name,
    model: provider.model,
    error,
    latencyMs: Date.now() - startedAt,
    ...(rawResponse ? { rawResponse } : {}),
  });

  try {
    let response = await call();

    for (let attempt = 0; attempt < RATE_LIMIT_ATTEMPTS; attempt++) {
      if (response.ok) break;
      const body = await response.text();
      if (!isRateLimited(response.status, body)) {
        return fail(`${provider.name} error ${response.status}: ${body.slice(0, 300)}`);
      }
      if (attempt === RATE_LIMIT_ATTEMPTS - 1) {
        return fail(
          `${provider.name} rate-limited after ${RATE_LIMIT_ATTEMPTS} attempts: ${body.slice(0, 200)}`
        );
      }
      const wait = retryAfterMs(response.headers.get('retry-after'), attempt, BATCH_BACKOFF_CAP_MS);
      console.warn(
        `  [${provider.name}] rate-limited (HTTP ${response.status}) — waiting ${wait}ms, ` +
          `attempt ${attempt + 2}/${RATE_LIMIT_ATTEMPTS}`
      );
      await new Promise(resolve => setTimeout(resolve, wait));
      response = await call();
    }

    if (!response.ok) {
      return fail(`${provider.name} error ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = data.choices?.[0]?.message?.content ?? '';
    if (!raw.trim()) return fail(`${provider.name} returned an empty response`);

    const parse = parseExtraction(raw, { sourceText: input.text, now: input.now });
    return {
      ...parse,
      provider: provider.name,
      model: provider.model,
      latencyMs: Date.now() - startedAt,
      rawResponse: raw,
    };
  } catch (error) {
    return fail(
      `${provider.name}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`
    );
  }
}
