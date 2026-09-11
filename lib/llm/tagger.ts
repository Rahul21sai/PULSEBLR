import { EVENT_CATEGORIES } from '../models/Event';
import {
  TECH_FLAG_CATEGORIES,
  AUDIENCE_NAMES,
  PERK_NAMES,
  EVENT_TIERS,
  hasFoodFromPerks,
  type EventAudience,
  type EventPerk,
  type EventTier,
} from '../event-types';
import { isRateLimited, retryAfterMs, BATCH_BACKOFF_CAP_MS } from './throttle';

export interface TaggingResult {
  categories: string[];
  format: 'online' | 'offline' | 'hybrid';
  hasFood: 'yes' | 'no' | 'unknown';
  /** True for a software/data/hardware/product-engineering event. */
  isTechEvent: boolean;
  confidence: number;
  /** Who the event is for. Controlled vocabulary; see `AUDIENCE_NAMES`. Empty = unknown. */
  audience: string[];
  /** What you get in the room. Controlled vocabulary; see `PERK_NAMES`. Empty = unknown. */
  perks: string[];
  /**
   * Browse label; see `EVENT_TIERS`. **`undefined` MEANS "NO EVIDENCE", NOT "ORDINARY".**
   *
   * `EVENT_TIERS` has no `unknown` member, so absence is the only way to say
   * "nothing here tells me". Defaulting the silent case to `community` would put
   * ~90% of the corpus in one bucket and make the label a synonym for "a row
   * exists" — and it would assert, of a comedy show scraped from District, that it
   * is a community engineering gathering. A facet that cannot be wrong cannot be
   * useful either.
   */
  tier?: EventTier;
}

export interface TaggingInput {
  title: string;
  description: string;
  venue?: string;
  onlineLink?: string;
  /** Adapter-supplied hints (Devfolio themes, Bevy event types, Meetup keywords). */
  hints?: string[];
  /*
   * ── FIELDS BELOW ARE FOR `tier` AND ARE ALL OPTIONAL ────────────────────────────
   *
   * `tier` is specified (spec §2.3) as coming from venue class, host company,
   * attendee count, the `Conference` category and price — and only the first of
   * those was already on this input. They are optional rather than required
   * because `lib/scrapers/normalizer.ts#toTaggingInput` does not pass them today,
   * so at INGEST `tier` is derived from title/description/venue alone while
   * `scripts/backfill-card-metadata.ts`, which reads whole stored documents, has
   * the full set. `deriveCardMetadata()` therefore has to work with any subset,
   * and a run of the backfill is what sharpens an ingest-time verdict.
   */
  organizer?: string;
  attendeeCount?: number;
  isFree?: boolean;
  price?: number;
  /**
   * Categories, when already known. Only `deriveCardMetadata()` reads this — the
   * keyword floor computes its own first and feeds them in, and the backfill
   * passes the stored ones. `Conference` is the single category `tier` consults.
   */
  categories?: string[];
}

const VALID_CATEGORIES = new Set<string>(EVENT_CATEGORIES);
const VALID_FORMATS: TaggingResult['format'][] = ['online', 'offline', 'hybrid'];
const VALID_FOOD: TaggingResult['hasFood'][] = ['yes', 'no', 'unknown'];
const VALID_AUDIENCE = new Set<string>(AUDIENCE_NAMES);
const VALID_PERKS = new Set<string>(PERK_NAMES);
const VALID_TIERS = new Set<string>(EVENT_TIERS);

/** Caps on the two arrays, so one over-eager response cannot fill a card with chips. */
const MAX_AUDIENCE = 3;
const MAX_PERKS = 4;

// ─────────────────────────────────────────────────────────────────────────────
// BATCHING
//
// The scraper now surfaces 300–900 events per run instead of a handful. One LLM
// call per event would dominate runtime and cost, so we classify in batches: the
// model receives a numbered list and returns one object per item.
//
// Sizing came from measurement, not taste. At batch size 8 with full 600-character
// descriptions, llama-3.1-8b returned an array the wrong length often enough that
// only 8 of 840 events got LLM tags — everything else silently fell back to
// keywords. The same model handled 8 short items perfectly, which pointed at
// output length rather than capability. So: smaller batches, more output headroom,
// shorter per-event excerpts, and lenient parsing that keeps however many items
// DID come back instead of throwing the whole batch away.
// ─────────────────────────────────────────────────────────────────────────────
const BATCH_SIZE = 5;

/**
 * Batch size per provider.
 *
 * 5 was sized for llama-3.1-8b, whose failure mode is returning the wrong number of
 * objects once the prompt grows. A frontier model does not have that problem, and
 * with ~975 events per run the round-trip count dominates wall clock: at 5 items
 * that is 195 sequential calls. Larger batches for the stronger models cut that
 * roughly threefold. Lenient parsing still covers a short response either way.
 */
const PROVIDER_BATCH_SIZE: Record<string, number> = {
  'IBM ICA': 15,
  Anthropic: 15,
  'NVIDIA NIM': 5,
};

function batchSizeFor(providerName: string | undefined): number {
  return (providerName && PROVIDER_BATCH_SIZE[providerName]) || BATCH_SIZE;
}

/** Characters of description sent per event. Enough to classify, short enough to batch. */
const DESCRIPTION_BUDGET = 400;

const SYSTEM_PROMPT = `You classify events happening in Bengaluru (Bangalore), India.

For EACH numbered event you receive, return one JSON object with these fields:

"categories": 1-3 values chosen ONLY from this exact list:
${EVENT_CATEGORIES.map(c => `  - ${c}`).join('\n')}

Two of those categories are read as tech topics and are easy to reach for wrongly:
  - "Gaming/XR" means games ENGINEERING — Unity/Unreal/Godot, game design, engines,
    shaders, VR/XR development, esports infrastructure. A board-game night, a quiz, a
    DJ night or a "screen-free Sunday" is "Community/Social", NEVER Gaming/XR.
  - "Hardware/Robotics" means physical engineering — embedded, firmware, VLSI, RISC-V,
    PCBs, robots, sensors. Not a talk that merely happens near a machine.
  Prefer "Other" over a tech category you are unsure about. A wrong tech category puts a
  non-tech event in front of an engineer; "Other" simply omits it.

"format": "online" | "offline" | "hybrid"
  online = purely virtual. offline = physical venue. hybrid = both.

"hasFood": "yes" | "no" | "unknown"
  yes only when food/snacks/refreshments/dinner/lunch are actually mentioned.

"isTechEvent": true | false
  TRUE only for SOFTWARE or HARDWARE engineering events: programming languages,
  AI/ML, data engineering, cloud, devops, security, web/mobile, embedded,
  robotics, chips, open source, developer tooling, hackathons, and technical
  product/engineering talks. Practitioner meetups and conferences count.
  FALSE for: concerts, comedy, sports, food, spiritual and wellness sessions,
  book clubs, dating and social mixers, generic business/sales/marketing
  networking, real-estate and investing pitches, and certification or
  course-selling sessions that merely mention a technology.
  COURSE SELLING IS FALSE EVEN WHEN THE SESSION IS FREE. A free demo class, a
  trial lecture, a "training with placement assistance", a batch-starting
  announcement or a coaching-institute enquiry session is lead generation for a
  paid course. Judge it by what happens in the room: a sales pitch to an audience
  is FALSE no matter how technical the syllabus sounds. Real practitioner talks,
  meetups, conferences, hackathons and workshops run by communities are TRUE.

"confidence": 0.0-1.0

The next three keys are OPTIONAL. OMITTING A KEY IS THE CORRECT ANSWER whenever the
event copy does not say. An omitted key is filled in from keywords afterwards and
costs nothing; a guessed one is a filter chip that hides the event from the very
people it is for. Never invent one to look complete.

"audience": up to 3 values chosen ONLY from:
  students, juniors, senior-engineers, founders, leaders, product, data, security,
  sre, researchers
  Who the event is FOR, not what it is about. A Kubernetes talk is not automatically
  "sre" — it is "sre" when it addresses operators, on-call or reliability work.

"perks": up to 4 values chosen ONLY from:
  breakfast, lunch, snacks, swag, certificate, recording, drinks
  ONLY what the copy actually promises attendees. "No recording will be shared" is
  not the recording perk, and "AWS Certification Prep" is not the certificate perk —
  that is the subject, not something you are given.

"tier": "flagship" | "community" | "advert" | "unknown"
  flagship = a large named event: a real conference or corporate summit, a hotel or
    convention-centre venue, hundreds of attendees.
  community = an ordinary practitioner gathering: a meetup, a user group, a hack
    night, a chapter event.
  advert = not really an event. A coaching-institute demo class, a "new batch
    starting" announcement, a certification course being sold, a placement-guarantee
    or job-guarantee pitch, an enrolment enquiry session. BEING FREE DOES NOT MAKE IT
    AN EVENT — a free demo class is still a sales session.
  unknown = you cannot tell. Use it freely; it is not a failure.
  This is a BROWSE LABEL, never a quality ranking.

"event": the number from the "Event N:" heading this object classifies.
  REQUIRED. Copy it exactly. It is how each classification is matched back to its
  event, so an object without it, or with the wrong number, is discarded.

Respond with ONLY a JSON array, one object per input event, in the SAME ORDER.
No prose, no markdown fences.`;

/**
 * Strip characters that break the provider's JSON parser.
 *
 * Observed live: NVIDIA rejected a batch with
 *   "Failed to deserialize the JSON body … unexpected end of hex escape".
 * The cause is a LONE SURROGATE in scraped copy — an emoji whose pair got split
 * by an upstream truncation. `JSON.stringify` happily emits `\ud83d` on its own,
 * which is valid JS but not valid JSON for a strict deserializer. Scraped text is
 * full of emoji, so this has to be handled rather than hoped away.
 */
function sanitizeForJson(text: string): string {
  return text
    // Unpaired high surrogate (not followed by a low one) and vice versa.
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    // Control characters that add nothing to a classification prompt.
    .replace(/\p{Cc}/gu, ' ');
}

function buildBatchPrompt(inputs: TaggingInput[]): string {
  return inputs
    .map((input, index) => {
      const parts = [`Event ${index + 1}:`, `Title: ${sanitizeForJson(input.title)}`];
      // Descriptions can be thousands of characters; the opening lines carry the
      // classifying signal and keep the batch inside a sane token budget.
      if (input.description && input.description !== input.title) {
        parts.push(`Description: ${sanitizeForJson(input.description.slice(0, DESCRIPTION_BUDGET))}`);
      }
      if (input.venue) parts.push(`Venue: ${sanitizeForJson(input.venue)}`);
      if (input.onlineLink) parts.push('Has online link: yes');
      // Evidence for `tier`, and only sent when an adapter actually observed it —
      // an absent line is honest, a "Host: unknown" line is a token spent on nothing.
      if (input.organizer) parts.push(`Host: ${sanitizeForJson(input.organizer)}`);
      if (typeof input.attendeeCount === 'number' && input.attendeeCount > 0) {
        parts.push(`Attendees so far: ${input.attendeeCount}`);
      }
      if (input.isFree === false && typeof input.price === 'number' && input.price > 0) {
        parts.push(`Ticket price: INR ${Math.round(input.price)}`);
      }
      if (input.hints?.length) parts.push(`Hints: ${sanitizeForJson(input.hints.slice(0, 8).join(', '))}`);
      return parts.join('\n');
    })
    .join('\n\n');
}

// Some gateway/model combos reject temperature != 1 (ICA/litellm returns HTTP 400
// "Only temperature=1 is supported" for claude-opus-4-8). We prefer 0.2 for
// deterministic classification, but remember any model that refuses so the rest
// of the run skips straight to 1 instead of burning a failed call per batch.
const MODELS_REQUIRING_TEMP_1 = new Set<string>();

interface ProviderConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  provider: string;
  timeoutMs?: number;
  /**
   * Model to retry with when `model` times out or 404s.
   *
   * Why this exists: a valid NVIDIA key configured with `z-ai/glm-5.2` produced a
   * hard timeout on every request (measured: >25 s, repeatedly), while
   * `meta/llama-3.1-8b-instruct` answered in 376 ms on the SAME key. The failure
   * was a model choice, not a credentials problem, so failing over to another
   * model on the same provider recovers tagging instead of dropping to keywords.
   */
  fallbackModel?: string;
  /**
   * Name of the env var holding this provider's key, for the 401/403 log line
   * only. A breaker message that names the variable to fix is actionable; one
   * that says "credentials rejected" sends you reading source.
   */
  credentialEnv?: string;
}

/**
 * Models proven unusable this run — skipped immediately afterwards.
 *
 * A model lands here only when it is DEFINITIVELY unusable (HTTP 404, i.e. not
 * available to this account) or after repeated timeouts. See MODEL_TIMEOUTS.
 */
const DEAD_MODELS = new Set<string>();

/**
 * Timeout counter per model, and the threshold before we give up on it.
 *
 * Measured failure this caused: ICA's claude-sonnet-5 timed out ONCE mid-run. The
 * original code marked it dead on that first timeout; because ICA has no fallback
 * model configured, its chain became empty and every later batch threw
 * "no usable model", which tripped the circuit breaker for ICA and then NVIDIA.
 * A single transient blip therefore dropped 750 events to keyword tagging — a worse
 * outcome than the slow-but-working path. Genuinely dead models (glm-5.2) time out
 * every single time and still get retired quickly; transient ones now recover.
 */
const MODEL_TIMEOUTS = new Map<string, number>();
const TIMEOUTS_BEFORE_DEAD = 3;

function recordTimeout(model: string, provider: string): void {
  const count = (MODEL_TIMEOUTS.get(model) ?? 0) + 1;
  MODEL_TIMEOUTS.set(model, count);
  if (count >= TIMEOUTS_BEFORE_DEAD) {
    DEAD_MODELS.add(model);
    console.warn(`[${provider}] model "${model}" retired after ${count} timeouts`);
  } else {
    console.warn(
      `[${provider}] model "${model}" timed out (${count}/${TIMEOUTS_BEFORE_DEAD}) — will retry on the next batch`
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PROVIDER CIRCUIT BREAKER
//
// Why there is a breaker at all (the original measurement): with an expired ICA
// key returning an instant 401 and a NVIDIA endpoint timing out at 45 s, EVERY
// batch paid ~46 s before falling back to keywords. Across 105 batches that is 80
// minutes of waiting to produce exactly the keyword tagging we'd have got for
// free. So a provider that fails TRIP_AFTER times consecutively is dropped.
//
// Scoped to the PROCESS, like DEAD_MODELS and MODEL_TIMEOUTS above and for the
// same reason: a fact learned by paying for a failed round-trip should only be
// paid for once.
//
// It used to live inside tagEvents() while the log line claimed the provider was
// "disabled for this run". For `npm run scrape` those coincide by accident —
// pipeline.ts calls tagEvents() exactly once with the whole corpus. Nowhere else
// do they: scripts/retag-events.ts chunks by 40, so `--all` over ~1000 events is
// 25 calls and a dead provider was re-probed TRIP_AFTER times in every one (75
// doomed requests to relearn one fact), and the Next.js server tags one event per
// call on the manual add-event path.
//
// That server is also the reason a bare hoist is not enough: a breaker that never
// reopens would take a provider out until the next deploy. So the disable is
// scoped to the kind of evidence that caused it:
//
//   - Transient (timeouts, unparseable output) → cooldown, then re-probe.
//   - Auth rejection (401/403) → the rest of the process. Credentials are read
//     from process.env, which cannot change without a restart, so a retry can
//     never succeed. This is the provider-level analogue of DEAD_MODELS on 404.
// ─────────────────────────────────────────────────────────────────────────────
const TRIP_AFTER = 3;

/**
 * How long a provider tripped on transient failures stays out.
 *
 * Longer than a full scrape (5–10 min) so a run that trips a provider early does
 * not pay the strikes again near the end, but short enough that a long-lived
 * server heals on its own instead of needing a restart.
 */
const BREAKER_COOLDOWN_MS = 10 * 60 * 1000;

const PROVIDER_STRIKES = new Map<string, number>();
/** Provider name → why it is out, and until when (`Infinity` = rest of the process). */
const PROVIDER_DISABLED = new Map<string, { reason: string; until: number }>();

function disableProvider(name: string, reason: string, until: number): void {
  // Never downgrade a permanent disable back into a temporary one.
  if (PROVIDER_DISABLED.get(name)?.until === Infinity) return;
  PROVIDER_DISABLED.set(name, { reason, until });
  const scope =
    until === Infinity
      ? 'for this process'
      : `for ${Math.round(BREAKER_COOLDOWN_MS / 60000)} min`;
  console.warn(`[${name}] disabled ${scope} — ${reason}`);
}

/** An auth rejection is never worth a retry, on any model, at any temperature. */
function disableProviderForAuth(name: string, status: number, credentialEnv?: string): void {
  PROVIDER_STRIKES.delete(name);
  const fix = credentialEnv ? ` — check ${credentialEnv} in .env.local` : '';
  disableProvider(name, `credentials rejected (HTTP ${status})${fix}`, Infinity);
}

function isProviderDisabled(name: string): boolean {
  const entry = PROVIDER_DISABLED.get(name);
  if (!entry) return false;
  if (Date.now() < entry.until) return true;
  // Cooldown elapsed — let it prove itself again from a clean slate.
  PROVIDER_DISABLED.delete(name);
  PROVIDER_STRIKES.delete(name);
  console.warn(`[${name}] breaker cooldown elapsed — re-enabling`);
  return false;
}

function recordProviderStrike(name: string): void {
  // Already retired for good (bad credential) — the strike count is moot, and the
  // caller records one on the same error that retired it.
  if (PROVIDER_DISABLED.get(name)?.until === Infinity) return;
  const next = (PROVIDER_STRIKES.get(name) ?? 0) + 1;
  PROVIDER_STRIKES.set(name, next);
  if (next >= TRIP_AFTER) {
    disableProvider(name, `${next} consecutive failures`, Date.now() + BREAKER_COOLDOWN_MS);
  }
}

/** A success means the provider is alive; the strike record no longer describes it. */
function clearProviderStrikes(name: string): void {
  PROVIDER_STRIKES.delete(name);
}

/** Providers currently out, for the summary line. Prunes expired entries. */
function disabledProviders(): string[] {
  return [...PROVIDER_DISABLED.keys()].filter(isProviderDisabled);
}

/** NVIDIA NIM model measured as fast and reliable for this classification task. */
const NVIDIA_FAST_MODEL = 'meta/llama-3.1-8b-instruct';

/*
 * THROTTLE HANDLING LIVES IN `lib/llm/throttle.ts`, NOT HERE.
 *
 * It was written here first, then written a second time in `draft-followup.ts` because this file
 * did not export it — so it is now shared. The module header carries the full evidence: ICA fronts
 * Bedrock through litellm and loses the 429, delivering a throttle as an HTTP 400 with the cause
 * only in the body, and before that predicate existed the first throttled batch tripped the strike
 * counter and every later batch in the run fell to the keyword floor.
 *
 * The CAP is a parameter rather than a constant in that module, because this caller and the
 * interactive one legitimately differ: `BATCH_BACKOFF_CAP_MS` is 20s, which is right here (a
 * runner with hundreds of batches queued behind it) and wrong for a user watching a spinner.
 */

/** Attempts per model for a throttle specifically, over and above the model chain. */
const RATE_LIMIT_ATTEMPTS = 4;

async function callOpenAICompatible(userPrompt: string, opts: ProviderConfig): Promise<string> {
  const { apiKey, baseUrl, provider, timeoutMs = 45000, fallbackModel, credentialEnv } = opts;
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

  // Try the configured model, then the provider's known-good fallback.
  const chain = [opts.model, fallbackModel]
    .filter((m): m is string => Boolean(m))
    .filter(m => !DEAD_MODELS.has(m));

  if (chain.length === 0) {
    throw new Error(
      `${provider}: every configured model has been retired this run ` +
        `(${[opts.model, fallbackModel].filter(Boolean).join(', ')})`
    );
  }

  let lastError: Error | undefined;

  for (const model of chain) {
    const call = (temperature: number) =>
      fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
          ],
          // Generous headroom: a truncated response (finish_reason "length") is
          // indistinguishable from a malformed one at the parse layer, and was the
          // suspected cause of near-total fallback to keyword tagging.
          // Scaled for the largest batch a provider may receive (~200 tokens/event).
          //
          // RE-CHECKED when audience/perks/tier were added to the response shape,
          // because that is exactly the "more output competes for the same budget"
          // failure this number exists to absorb. The object went from roughly
          //   {"categories":[..],"format":..,"hasFood":..,"isTechEvent":..,
          //    "confidence":..,"event":1}                       ~110 chars, ~35 tok
          // to that plus
          //   "audience":["senior-engineers","data"],"perks":["snacks","swag"],
          //   "tier":"community"                                 ~80 chars, ~25 tok
          // — call it 60 tokens per event. At the largest batch (15, for ICA and
          // Anthropic) that is ~900, so 4000 is still ~4x headroom and the 200/event
          // figure above is still the conservative one. Left UNCHANGED deliberately:
          // 4000 is a value these gateways are known to accept, and raising a
          // max_tokens past a model's own completion cap is itself a 400. If a
          // provider ever batches larger than ~60 events, recompute here first.
          max_tokens: 4000,
          temperature,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });

    try {
      let response = await call(MODELS_REQUIRING_TEMP_1.has(model) ? 1 : 0.2);

      if (response.status === 400 && !MODELS_REQUIRING_TEMP_1.has(model)) {
        const errText = await response.text();
        if (/temperature/i.test(errText)) {
          MODELS_REQUIRING_TEMP_1.add(model);
          console.warn(`[${provider}] ${model} rejected temperature=0.2 — retrying at 1`);
          response = await call(1);
        } else if (isRateLimited(400, errText)) {
          // Fall through to the throttle loop below rather than throwing. Re-issue the
          // request first so that loop has a live response to inspect.
          response = await call(MODELS_REQUIRING_TEMP_1.has(model) ? 1 : 0.2);
        } else {
          throw new Error(`${provider} error 400: ${errText.slice(0, 300)}`);
        }
      }

      /*
       * THE THROTTLE LOOP. A rate limit is transient, so it retries the SAME model — the model is
       * not what is wrong, and moving to the fallback would spend a second request proving that.
       *
       * It reads the body to decide, which means the body is consumed; on the last attempt that
       * text is carried into the error so the log still names the real cause instead of a bare
       * status. Bounded by RATE_LIMIT_ATTEMPTS so a persistently throttled account degrades to the
       * keyword floor — which is intact and documented — rather than stalling a scrape that has
       * hundreds of batches left to run.
       */
      for (let attempt = 0; attempt < RATE_LIMIT_ATTEMPTS; attempt++) {
        if (response.ok) break;
        const body = await response.text();
        if (!isRateLimited(response.status, body)) {
          // Not a throttle: hand it to the status handling below with the body intact.
          response = new Response(body, { status: response.status, headers: response.headers });
          break;
        }
        if (attempt === RATE_LIMIT_ATTEMPTS - 1) {
          throw new Error(
            `${provider} rate-limited after ${RATE_LIMIT_ATTEMPTS} attempts: ${body.slice(0, 200)}`
          );
        }
        const wait = retryAfterMs(response.headers.get('retry-after'), attempt, BATCH_BACKOFF_CAP_MS);
        console.warn(
          `[${provider}] ${model} rate-limited (HTTP ${response.status}) — waiting ${wait}ms, ` +
            `attempt ${attempt + 2}/${RATE_LIMIT_ATTEMPTS}`
        );
        await new Promise(resolve => setTimeout(resolve, wait));
        response = await call(MODELS_REQUIRING_TEMP_1.has(model) ? 1 : 0.2);
      }

      if (response.status === 404) {
        // The model isn't available to this account — it will never be, so stop
        // paying for it and move to the fallback.
        DEAD_MODELS.add(model);
        lastError = new Error(`${provider}: model "${model}" not available (404)`);
        console.warn(`[${provider}] model "${model}" unavailable — trying next model`);
        continue;
      }

      if (response.status === 401 || response.status === 403) {
        // Neither transient nor model-specific: no fallback model on this provider
        // can succeed with a rejected credential, and no retry will change it.
        // Retire the whole provider rather than pay TRIP_AFTER round-trips per
        // tagEvents() call to relearn it. Throwing (not `continue`) is deliberate —
        // trying the fallback model would waste one more request on the same key.
        const body = (await response.text()).slice(0, 200);
        disableProviderForAuth(provider, response.status, credentialEnv);
        throw new Error(`${provider} error ${response.status}: ${body}`);
      }

      if (!response.ok) {
        throw new Error(
          `${provider} error ${response.status}: ${(await response.text()).slice(0, 300)}`
        );
      }

      const data = await response.json();
      return data.choices?.[0]?.message?.content ?? '';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastError = error instanceof Error ? error : new Error(message);
      // A timeout is only provisional evidence: count it, and retire the model
      // only after it happens repeatedly (see recordTimeout).
      if (/abort|timeout/i.test(message)) {
        recordTimeout(model, provider);
        continue;
      }
      // Auth/other errors are provider-level; no other model will help.
      throw lastError;
    }
  }

  throw lastError ?? new Error(`${provider}: all models failed`);
}

async function callAnthropic(userPrompt: string): Promise<string> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
  let message;
  try {
    message = await anthropic.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 2000,
      temperature: 0.2,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    });
  } catch (error) {
    // This path uses the SDK rather than callOpenAICompatible, so it needs its own
    // hook into the breaker — otherwise a bad ANTHROPIC_API_KEY is the one
    // credential failure still retried TRIP_AFTER times per call.
    const status = (error as { status?: number })?.status;
    if (status === 401 || status === 403) {
      disableProviderForAuth('Anthropic', status, 'ANTHROPIC_API_KEY');
    }
    throw error;
  }
  const content = message.content[0];
  if (content.type !== 'text') throw new Error('Unexpected Anthropic response type');
  return content.text;
}

/**
 * Extract the classification objects from a model response.
 *
 * Lenient on purpose. Requiring `length === expected` threw away batches where the
 * model returned 4 good objects out of 5, which is how a run ended up with 832 of
 * 840 events on keyword tags. Now we take whatever valid objects came back and let
 * the caller fill any gap from keywords, so partial output still helps.
 *
 * Handles: a bare array, a `{ "results": [...] }` / `{ "events": [...] }` wrapper,
 * markdown fences, trailing prose, and a truncated final object.
 */
function parseBatchResponse(text: string, expected: number): unknown[] | null {
  const cleaned = text.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();

  const attempts: string[] = [];
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start !== -1 && end > start) attempts.push(cleaned.slice(start, end + 1));

  // Wrapper object form.
  const objStart = cleaned.indexOf('{');
  const objEnd = cleaned.lastIndexOf('}');
  if (objStart !== -1 && objEnd > objStart) attempts.push(cleaned.slice(objStart, objEnd + 1));

  for (const candidate of attempts) {
    try {
      const parsed = JSON.parse(candidate);
      const array = Array.isArray(parsed)
        ? parsed
        : (parsed?.results ?? parsed?.events ?? parsed?.classifications);
      if (Array.isArray(array) && array.length > 0) return array.slice(0, expected);
    } catch {
      /* try the next shape */
    }
  }

  // Truncated output: salvage every complete top-level object in the stream. A
  // response cut off mid-object still contains usable earlier ones.
  const salvaged: unknown[] = [];
  for (const match of cleaned.matchAll(/\{[^{}]*"categories"[\s\S]*?\}\s*(?=,|\]|$)/g)) {
    try {
      salvaged.push(JSON.parse(match[0]));
    } catch {
      /* incomplete tail — ignore */
    }
    if (salvaged.length >= expected) break;
  }
  return salvaged.length > 0 ? salvaged : null;
}

/**
 * Pull a controlled-vocabulary array out of a model object.
 *
 * Returns `null` — not `[]` — when the key is absent or contained nothing valid, so
 * the caller can tell "the model said nothing" from "the model said none". Only the
 * first may fall back to the keyword floor; the second is an answer.
 */
function coerceVocabulary(
  value: unknown,
  valid: ReadonlySet<string>,
  cap: number
): string[] | null {
  if (!Array.isArray(value)) return null;
  const kept = value.filter(
    (v): v is string => typeof v === 'string' && valid.has(v.trim().toLowerCase())
  );
  if (kept.length === 0) return null;
  return [...new Set(kept.map(v => v.trim().toLowerCase()))].slice(0, cap);
}

/**
 * Coerce one model object into a schema-valid TaggingResult.
 *
 * ── THE NEW FIELDS MAY NOT INVALIDATE THE OLD ONES ─────────────────────────────
 * `audience`, `perks` and `tier` are read INDEPENDENTLY and each falls back on its
 * own. A model that ignores all three, or emits garbage in them, still has its
 * categories, format, food flag and tech flag applied exactly as before — the
 * object is never rejected for the sake of the additions. That property is the only
 * structural defence available against the documented risk that extra output
 * degrades the fields that already work (CLAUDE.md §3: batch-of-8 produced 8 LLM
 * tags out of 840). It does NOT defend against the other half of that risk — a
 * model returning FEWER OBJECTS because each is longer — which nothing in the code
 * can prevent and only a live measurement can detect. See the header of
 * `scripts/diag-card-metadata.ts` for why that measurement is currently impossible.
 */
function coerce(raw: unknown, fallback: TaggingResult): TaggingResult {
  if (!raw || typeof raw !== 'object') return fallback;
  const obj = raw as Record<string, unknown>;

  const categories = Array.isArray(obj.categories)
    ? obj.categories.filter((c): c is string => typeof c === 'string' && VALID_CATEGORIES.has(c))
    : [];

  const format = VALID_FORMATS.includes(obj.format as TaggingResult['format'])
    ? (obj.format as TaggingResult['format'])
    : fallback.format;

  const perks = coerceVocabulary(obj.perks, VALID_PERKS, MAX_PERKS) ?? fallback.perks;
  const audience = coerceVocabulary(obj.audience, VALID_AUDIENCE, MAX_AUDIENCE) ?? fallback.audience;

  const rawTier = typeof obj.tier === 'string' ? obj.tier.trim().toLowerCase() : '';
  // "unknown" is a value the prompt explicitly invites, and it is not in EVENT_TIERS.
  // It lands here as an invalid string and correctly leaves the keyword verdict alone.
  const tier = VALID_TIERS.has(rawTier) ? (rawTier as EventTier) : fallback.tier;

  const statedFood = VALID_FOOD.includes(obj.hasFood as TaggingResult['hasFood'])
    ? (obj.hasFood as TaggingResult['hasFood'])
    : fallback.hasFood;
  /*
   * `hasFood` is UPGRADE-ONLY from perks, and `hasFoodFromPerks()` is the only
   * definition of which perks count. It returns 'yes' or null, and null means the
   * perks are SILENT rather than negative — so it may fill an 'unknown' and must
   * never overwrite a stated 'yes' or 'no'. A model that lists lunch while saying
   * hasFood 'no' has contradicted itself; the explicit field wins, because the one
   * thing worse than a missing perk chip is a food filter that disagrees with the
   * copy on the card.
   */
  const hasFood = statedFood === 'unknown' ? (hasFoodFromPerks(perks) ?? 'unknown') : statedFood;

  return {
    categories: categories.length > 0 ? [...new Set(categories)].slice(0, 3) : fallback.categories,
    format,
    hasFood,
    isTechEvent: typeof obj.isTechEvent === 'boolean' ? obj.isTechEvent : fallback.isTechEvent,
    confidence: typeof obj.confidence === 'number' ? obj.confidence : 0.8,
    audience,
    perks,
    tier,
  };
}

/** Providers configured in this environment, in priority order. */
function activeProviders(): Array<{ name: string; run: (prompt: string) => Promise<string> }> {
  const providers: Array<{ name: string; run: (prompt: string) => Promise<string> }> = [];

  // The pipeline's --no-llm flag sets this so local runs finish in seconds on
  // keyword tagging alone, without anyone having to unset real API keys.
  if (process.env.PULSEBLR_SKIP_LLM === '1') return providers;

  if (process.env.ICA_API_KEY && process.env.ICA_BASE_URL && process.env.ICA_MODEL) {
    providers.push({
      name: 'IBM ICA',
      run: prompt =>
        callOpenAICompatible(prompt, {
          apiKey: process.env.ICA_API_KEY!,
          baseUrl: process.env.ICA_BASE_URL!,
          model: process.env.ICA_MODEL!,
          provider: 'IBM ICA',
          credentialEnv: 'ICA_API_KEY',
        }),
    });
  }
  if (process.env.NVIDIA_API_KEY) {
    providers.push({
      name: 'NVIDIA NIM',
      run: prompt =>
        callOpenAICompatible(prompt, {
          apiKey: process.env.NVIDIA_API_KEY!,
          baseUrl: process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1',
          model: process.env.NVIDIA_MODEL || NVIDIA_FAST_MODEL,
          // Verified 376 ms on this endpoint while the larger listed models
          // (z-ai/glm-5.2, llama-3.3-70b) never returned. Classification is a
          // small, well-specified task, so the 8B model is the right tool anyway.
          fallbackModel: NVIDIA_FAST_MODEL,
          provider: 'NVIDIA NIM',
          credentialEnv: 'NVIDIA_API_KEY',
          // Deliberately tight: a batch that takes longer than this is slower than
          // just using keyword tagging for it.
          timeoutMs: 25000,
        }),
    });
  }
  if (process.env.ANTHROPIC_API_KEY) {
    providers.push({ name: 'Anthropic', run: callAnthropic });
  }

  return providers;
}

/**
 * Tag many events. Batched, with a provider cascade per batch and keyword
 * fallback as the floor — an event is never dropped for want of a classification.
 */
export async function tagEvents(inputs: TaggingInput[]): Promise<TaggingResult[]> {
  const fallbacks = inputs.map(keywordTagging);
  const providers = activeProviders();

  if (providers.length === 0) {
    console.warn('No LLM provider configured (ICA / NVIDIA / Anthropic) — using keyword tagging');
    return fallbacks;
  }

  const results: TaggingResult[] = [...fallbacks];
  let llmTagged = 0;
  let batchFailures = 0;

  // Sized from the first provider that will ACTUALLY serve a batch, not simply
  // providers[0]. Sizing from a provider the breaker has already retired sent
  // NVIDIA batches of 15 whenever ICA was out — triple the size it was measured
  // to handle, and the exact condition that produced 8 LLM tags out of 840. If a
  // provider trips *mid-call* the next one still inherits the larger batches,
  // which lenient parsing tolerates; that part is unavoidable without re-batching.
  const batchSize = batchSizeFor(providers.find(p => !isProviderDisabled(p.name))?.name);

  let loggedSample = false;
  let partialBatches = 0;

  for (let offset = 0; offset < inputs.length; offset += batchSize) {
    const batch = inputs.slice(offset, offset + batchSize);
    const available = providers.filter(p => !isProviderDisabled(p.name));

    if (available.length === 0) {
      // Every provider is out — possibly tripped by an earlier tagEvents() call,
      // which is the whole point of the breaker living at module scope. Keyword
      // fallbacks are already in `results`, so stop calling out entirely rather
      // than re-failing for every remaining batch.
      batchFailures += Math.ceil((inputs.length - offset) / batchSize);
      break;
    }

    const prompt = buildBatchPrompt(batch);
    let parsed: unknown[] | null = null;

    for (const provider of available) {
      try {
        const text = await provider.run(prompt);
        parsed = parseBatchResponse(text, batch.length);
        if (parsed) {
          clearProviderStrikes(provider.name); // a success clears the record
          break;
        }
        // Show what actually came back the first time this happens. A bare
        // "unusable" line gave no way to tell truncation from malformed JSON.
        if (!loggedSample) {
          loggedSample = true;
          console.warn(
            `[${provider.name}] unparseable batch response (first 240 chars): ${text.slice(0, 240).replace(/\s+/g, ' ')}`
          );
        }
        recordProviderStrike(provider.name);
      } catch (error) {
        console.warn(
          `[${provider.name}] batch failed: ${error instanceof Error ? error.message : String(error)}`
        );
        recordProviderStrike(provider.name);
      }
    }

    if (parsed) {
      /**
       * Match each classification to its event by the ECHOED EVENT NUMBER, not by array
       * position.
       *
       * Position was wrong, and wrong in a way that produced confident nonsense. The old
       * comment claimed a short array "leaves the tail on keyword tags rather than
       * mis-assigning another event's classification to it" — true only if the omission is
       * at the END. The salvage path collects every complete object it can find, so when a
       * model skips or malforms one in the MIDDLE, everything after the gap shifts left by
       * one and each event inherits its neighbour's tags.
       *
       * Measured in the live corpus: "Sunday book club meet" tagged [Cybersecurity, AI/ML],
       * "ComicCast Society: Live Stand-Up Comedy Evening" tagged [AI/ML, Web/Mobile], and
       * "Dr. Joe Dispenza's Meditation Challenge" tagged [Product/Design, AI/ML,
       * Cloud/DevOps]. Those are not judgement errors — they are other events' answers,
       * landing one row off. 17 of 333 tech-flagged events came from this.
       *
       * The events are already numbered "Event N:" in the prompt, so the model just echoes
       * that number back and a gap becomes harmless instead of corrupting the remainder.
       */
      let applied = 0;
      let mappedByIndex = 0;

      for (const item of parsed) {
        const raw = (item as { event?: unknown })?.event;
        const eventNumber = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
        if (!Number.isInteger(eventNumber) || eventNumber < 1 || eventNumber > batch.length) continue;
        const target = offset + eventNumber - 1;
        results[target] = coerce(item, fallbacks[target]);
        applied++;
        mappedByIndex++;
      }

      // Fall back to positional ONLY when the count matches exactly, which is the one case
      // where position cannot be ambiguous. A short array with no usable numbers is left on
      // keyword tags for the whole batch — fewer LLM tags is strictly better than
      // authoritative-looking tags belonging to a different event.
      if (mappedByIndex === 0 && parsed.length === batch.length) {
        parsed.forEach((item, index) => {
          results[offset + index] = coerce(item, fallbacks[offset + index]);
        });
        applied = parsed.length;
      }

      llmTagged += applied;
      if (applied < batch.length) partialBatches++;
      if (applied === 0) batchFailures++;
    } else {
      batchFailures++;
    }
  }

  const summary =
    `Tagging: ${llmTagged}/${inputs.length} via LLM, ${inputs.length - llmTagged} via keywords` +
    (batchFailures > 0 ? ` (${batchFailures} batch(es) fell back` : '') +
    (partialBatches > 0 ? `${batchFailures > 0 ? ', ' : ' ('}${partialBatches} partial` : '') +
    (batchFailures > 0 || partialBatches > 0 ? ')' : '');
  const disabled = disabledProviders();
  if (disabled.length > 0) {
    console.warn(`${summary} — providers disabled: ${disabled.join(', ')}`);
  } else {
    console.log(summary);
  }
  return results;
}

/** Single-event convenience wrapper. */
export async function tagEventWithLLM(
  title: string,
  description: string,
  venue?: string,
  onlineLink?: string
): Promise<TaggingResult> {
  const [result] = await tagEvents([{ title, description, venue, onlineLink }]);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Keyword fallback — also the baseline every LLM result is validated against.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Exported so diagnostics can measure against THE pattern rather than a copy of it.
 *
 * A copy is what `diag-scorecard.ts` had, and it drifted within one session: the tagger gained a
 * `silicon(?! valley)` guard and the scorecard's duplicate did not, so the scorecard counted the
 * tagger's CORRECT refusal of "Silicon Valley Business Networking" as a hardware miss and
 * reported a worse number than reality. A metric that keeps its own copy of the thing it
 * measures will eventually measure the copy.
 *
 * Use `categoryPattern(name)` rather than indexing this directly.
 */
export const CATEGORY_KEYWORDS: Array<[string, RegExp]> = [
  // ── Tech topics ──
  ['AI/ML', /\b(ai|a\.i\.|artificial intelligence|machine learning|\bml\b|deep learning|neural|llm|gpt|genai|generative|transformer|nlp|computer vision|agentic|rag|mlops)\b/i],
  ['Data/Analytics', /\b(data|analytics|big data|data science|data engineering|warehouse|spark|iceberg|dbt|kafka|airflow|visualization|\bbi\b|sql|postgres|mysql|clickhouse)\b/i],
  ['Cloud/DevOps', /\b(cloud|devops|aws|azure|gcp|kubernetes|k8s|docker|terraform|ci\/cd|sre|platform engineering|observability|serverless|helm)\b/i],
  ['Web/Mobile', /\b(web|frontend|front-end|backend|react|next\.?js|angular|vue|svelte|flutter|android|ios|react native|wordpress|javascript|typescript|node\.?js|django|rails|laravel|php)\b/i],
  ['Cybersecurity', /\b(security|cyber|infosec|pentest|penetration testing|owasp|ctf|capture the flag|vulnerabilit|appsec|devsecops|threat|malware)\b/i],
  ['Open Source', /\b(open source|open-source|oss\b|foss|linux|apache|cncf|contributor|upstream|maintainer|hacktoberfest|gsoc|copyleft|licen[cs]e)\b/i],
  // Widened for Bengaluru specifically, which is India's chip-design centre.
  //
  // The Meetup discovery fan-out ALREADY searches `vlsi`, `fpga`, `semiconductor` and
  // `embedded` — but this floor could not recognise `VLSI`, `Verilog`, `VHDL` or `RISC-V`, the
  // four words that community actually writes. Discovery and classification have to share a
  // vocabulary: with every LLM provider down, a chip-design meetup was reaching ingest with
  // zero categories and isTechEvent=false, i.e. found and then discarded.
  //
  // Deliberately EXCLUDED as too ambiguous, remembering what a bare `\bpm\b` did to
  // Product/Design: `soc` (Security Operations Center), `rf`, `foundry` (Microsoft Foundry is
  // an AI product), `maker` (decision-maker, policy-maker), `bare metal` (cloud servers),
  // `wafer` (a biscuit), `asics` (the shoe brand sponsors running events — so only the
  // singular `asic` is listed).
  //
  // `asic` is safe inside `\b(…)\b` because "basic" has no word boundary before its `a`.
  // Plural/gerund forms are spelled out where the base word is a prefix of a longer one:
  // `\b` after "3d print" fails on "3D printing", so the suffix must be in the pattern.
  // `silicon` is guarded against "Silicon Valley", which is a PLACE and turns up constantly in
  // Bengaluru startup-networking titles ("Silicon Valley Business Networking", "FounderX Silicon
  // Valley"). It was in this pattern before the widening and would have keyword-tagged those as
  // hardware whenever the LLM tier was unavailable. Found by reading the events the scorecard
  // listed rather than trusting its percentage — the metric had counted the tagger's CORRECT
  // refusal as a miss.
  ['Hardware/Robotics', /\b(hardware|embedded|robotics|iot|drone|semiconductor|chip design|soc design|analog design|silicon(?! valley)|fpga|vlsi|verilog|systemverilog|vhdl|asic|risc-?v|tape-?outs?|photonics?|mems|arduino|raspberry pi|esp32|stm32|microcontrollers?|mechatronics|firmware|rtos|pcb|soldering|electronics|electron devices?|signal processing|3d print(?:ing|ers?)?|makerspaces?|maker faire|sensors?)\b/i],
  ['Blockchain/Web3', /\b(blockchain|web3|crypto|ethereum|solana|bitcoin|nft|defi|smart contract|zk\b|zero.?knowledge)\b/i],
  // A bare `gaming` matched "BoardGaming Sunday" and put a board-game night in the tech feed.
  //
  // This category means games ENGINEERING. Playing games is Community/Social, and the
  // distinction matters because Gaming/XR is in TECH_CATEGORY_NAMES, so anything tagged with it
  // is a candidate for the default `techOnly` view. Measured (diag-gamingxr-leak.ts): of 7
  // upcoming events tagged Gaming/XR, ZERO were games engineering — the category had become the
  // bin the classifier reached for when unsure, catching a DJ night, a design-thinking workshop
  // and a board-game meetup.
  //
  // Bare `unity` is deliberately NOT here: "Unity in Diversity" and "National Unity Day" are
  // ordinary Indian event titles. A real Unity meetup is caught by `game dev`/`game development`,
  // which is how such events actually title themselves.
  ['Gaming/XR', /\b(game dev|gamedev|game development|game design|game engine|game jam|unity3d|unreal engine|godot|shader|webgl|\bvr\b|\bxr\b|metaverse|esports)\b/i],
  // NB: no bare `\bpm\b` or `\bui\b` — `pm` matched the time in "6 PM" and tagged a
  // fifth of the corpus Product/Design.
  ['Product/Design', /\b(product manage|product management|product manager|\bux\b|ui\/ux|design system|figma|user research|design thinking|producttank|product design)\b/i],

  // ── Kind of gathering ──
  ['Hackathon', /\b(hackathon|hack day|hack night|buildathon|code sprint|datathon|devsprint|game jam)\b/i],
  ['Conference', /\b(conference|summit|convention|expo|symposium|congress|devfest|kubecon|\bcon\s?20\d\d\b)\b/i],
  ['Meetup', /\b(meetup|meet ?up|user group|community meet|lightning talks?|unconference|mixer|roundtable)\b/i],
  ['Workshop', /\b(workshop|bootcamp|training|masterclass|certification|hands-on|tutorial|course|lab session)\b/i],
  ['Career/Hiring', /\b(job fair|career fair|hiring|recruit|resume|interview prep|placement|open roles)\b/i],
  ['Startup/Founders', /\b(startup|founder|entrepreneur|venture|\bvc\b|pitch|demo day|incubat|accelerat|fundrais|seed round|angel invest)\b/i],

  // ── Non-tech tail ──
  ['Business/Finance', /\b(business|finance|fintech|payments?|banking|investing|equity|consult|\bb2b\b|sales|marketing|growth|\bseo\b|leadership|mba|insurtech)\b/i],
  ['Science/Research', /\b(science|research|physics|space|astronomy|paper reading|academia|lecture|climate|sustainab|renewable|biotech|pharma)\b/i],
  ['Arts/Culture', /\b(art|gallery|exhibition|film|screening|photograph|dance|craft|museum|poetry|music|concert|\bdj\b|\bedm\b|comedy|stand-?up|theatre|theater|open mic|book club|reading|author|literature)\b/i],
  ['Health/Fitness', /\b(health|medical|wellness|mental health|yoga|meditation|fitness|run(ning)?|marathon|cricket|football|badminton|cycling|hik(e|ing)|trek|sport)\b/i],
  ['Community/Social', /\b(social|community|volunteer|board games|mafia|quiz|potluck|food|dining|brunch|networking)\b/i],
];

/**
 * Categories that make an event "tech" for the keyword fallback.
 *
 * Deliberately narrower than it looks: SOFTWARE and HARDWARE engineering only.
 * `Fintech` and `Product/Design` were removed — a fintech sales mixer and a
 * design-thinking workshop are not software/hardware events, and including them
 * let business networking in through the fallback path. The LLM can still mark a
 * genuinely technical fintech talk as tech; this floor just stops the keyword
 * tagger from over-claiming when the LLM is unavailable.
 */
// Imported, not redeclared: `isTechEvent` is derived from categories in two places now (here
// and the manual-add route), and a second copy of this set is how the two definitions of
// "tech" drift apart. See the note on TECH_FLAG_CATEGORIES.
const TECH_CATEGORIES = TECH_FLAG_CATEGORIES;

const FOOD_RE =
  /\b(food|snacks?|refreshments?|lunch|dinner|breakfast|pizza|beverages?|drinks?|meal|catering|high tea|buffet)\b/i;

// ─────────────────────────────────────────────────────────────────────────────
// CARD METADATA — audience, perks, tier (keyword floor)
//
// These have a keyword floor for the same reason categories do: an event is never
// dropped for want of a classification. A field only the LLM can set does not
// degrade when providers are down, it DISAPPEARS — and it disappears silently,
// because an empty facet looks like an honest absence of data.
//
// That is not hypothetical here. Measured 2026-09-10 in this checkout: IBM ICA
// returns 401 (expired developer key), NVIDIA's configured
// meta/llama-3.1-8b-instruct returns 410 (end of life 2026-08-26) and all 80 models
// its /models endpoint lists return 404 "not found for account", and
// ANTHROPIC_API_KEY is unset. Every tier of the cascade is down, so THIS FLOOR IS
// CURRENTLY THE WHOLE TAGGER, including for the daily cron.
//
// ── HOW THESE PATTERNS WERE BUILT, WHICH IS THE PART TO PRESERVE ──────────────
// A widened regex fails by SILENTLY OVER-MATCHING, and no aggregate count reveals
// it — the corpus lesson is a bare `\bpm\b` matching the "PM" in "6 PM" and tagging
// a fifth of the corpus Product/Design. So the rule applied throughout below is:
// a word that has a common non-technical sense in Bengaluru event copy is only
// matched INSIDE A PHRASE that fixes its sense, or not at all. The words deliberately
// left out are named at each entry, because the next person's instinct will be to
// add exactly those.
//
// `tests/card-metadata.test.ts` pins the refusals alongside the matches, and its
// negative half is the important half.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Which text a pattern is allowed to read.
 *
 * ── THIS IS `resolve.ts`'s `strength` IDEA, APPLIED TO AUDIENCE ────────────────────
 * `lib/companies/resolve.ts` matches a `distinctive` company name anywhere including
 * descriptions, but an `ambiguous` one ONLY against the organiser field, because a
 * bare mention of "Intel" in a description means nothing while "Intel" as the host
 * means Intel is hosting. Narrowing the FIELD is how that file defuses an ambiguous
 * token without deleting it.
 *
 * The same tool is needed here, and measurement is what showed it. `founders` was the
 * most common audience in the corpus at 178 of 1149 upcoming rows (15.5%) — more than
 * students and senior engineers combined — because a description saying "our founder
 * will open the evening" is not an event for founders. The rows it produced included
 * `Roots & Shoots: A morning of Stories by Grandparents`, `The Friends Who Shaped You`
 * and `The Space Between: Women in Midlife`, all from a mental-health festival whose
 * blurb names its founder. That is the same class of leak as `Docker` being attributed
 * to a SriVidya meditation meetup, from the same direction.
 *
 * So a bare `founder` is read from the TITLE only, where naming the audience is what
 * a title is for; the phrase forms ("for founders", "first-time founders") stay
 * readable anywhere because the phrase itself fixes the sense.
 */
type PatternScope = 'text' | 'title';

/**
 * Who the event is for. Exported so a diagnostic measures THE pattern rather than a
 * copy of it — `diag-scorecard.ts` kept a copy of the category patterns and it
 * drifted within one session, reporting the tagger's correct refusal as a miss.
 *
 * A name may appear MORE THAN ONCE, with different scopes; the derivation dedupes.
 */
export const AUDIENCE_KEYWORDS: Array<[EventAudience, RegExp, PatternScope?]> = [
  // `campus`, `college`, `fresher` are the India-specific forms that actually appear.
  ['students', /\b(students?|studentsonly|college|campus|university|undergrad(?:uate)?s?|freshers?|final[- ]?year|sophomores?|school kids?)\b/i],
  /*
   * `fundamentals` and `basics` are deliberately OUT: "Fundamentals of Yoga",
   * "Basics of Vedic Astrology". They describe depth, not an audience, and they are
   * everywhere in the non-tech 74% of this corpus.
   *
   * `101` is matched only after a word of THREE OR MORE LETTERS that is not a currency
   * token — `\b(?!inr\b|usd\b|eur\b|rupees?\b)[a-z]{3,}\s+101\b` — which is how the
   * real title form reads: "Kubernetes 101", "Docker 101".
   *
   * Both halves of that guard were put there by a failing test, not by foresight. A
   * bare `\b101\b` matches a ticket price of `₹101`, an auspicious amount that is
   * common in Indian pricing: `₹` is a non-word character, so `\b` holds in front of
   * the digits and the price reads as a beginner event. And the first attempt,
   * `[a-z]\s+101\b`, still matched `Rs 101` and `at 101` — a two-letter word is enough
   * to satisfy `[a-z]`, so the guard let through exactly the case it was written for.
   *
   * The ORDINAL words are excluded for the same reason, and measurement is what found
   * them: 4 upcoming rows rely on the `101` branch alone, and one of them is
   * `LIT-MIC: Bengaluru Open Mic | Poetry, Stories, Comedy — Edition 101`, where 101
   * is a count of editions, not a difficulty. `edition|episode|volume|part|chapter|
   * room|batch|session|week|day|no` are therefore refused in front of it. The other 3
   * are genuine ("Brand Marketing 101", "Founder 101").
   *
   * If the branch ever costs more than it earns, delete it; the phrase forms beside it
   * carry this audience on their own. `scripts/diag-card-metadata.ts` prints every row
   * that depends on it, precisely so that stays a decision rather than a hope.
   */
  ['juniors', /(?:\b(beginners?|beginner[- ]friendly|newcomers?|no prior experience|no experience (?:needed|required)|entry[- ]level|getting started|first[- ]time contributors?|intro to|introduction to)\b|\b(?!inr\b|usd\b|eur\b|rupees?\b|edition|episode|volume|part|chapter|room|batch|session|week|day|no\b)[a-z]{3,}\s+101\b)/i],
  /*
   * NEVER a bare `senior` — "senior citizen" yoga, walks and health camps are a real
   * category of Bengaluru event, and they are not for senior engineers.
   * NEVER a bare `architect` either: building architects hold expos here, and
   * `Arts/Culture` is full of "architecture walks". Both words are matched only when
   * a qualifier fixes the sense.
   * `advanced` is OUT entirely for the same reason ("advanced yoga", "advanced Garba")
   * and no phrase form of it was frequent enough in the corpus to be worth the risk.
   */
  ['senior-engineers', /\b(senior\s+(?:engineers?|developers?|devs?|software|backend|back[- ]end|frontend|front[- ]end|full[- ]?stack|data|platform|sres?|architects?|technical)|staff engineers?|principal engineers?|tech(?:nical)? leads?|(?:software|solutions?|cloud|data|systems?|security|enterprise)\s+architects?|deep dives?|internals|under the hood)\b/i],
  // Phrase forms — the phrase fixes the sense, so these may read the description.
  ['founders', /\b(co[- ]?founders?|solopreneurs?|bootstrapp(?:ed|ing)|first[- ]time founders?|early[- ]stage founders?|startup founders?|for founders|founders? only|founder[- ]led|indie hackers?)\b/i],
  // Bare forms — TITLE ONLY. See the `PatternScope` note above for the 178-row
  // measurement that forced this, and the grandparents' storytelling event it produced.
  ['founders', /\b(founders?|entrepreneurs?)\b/i, 'title'],
  /*
   * `director` is matched only in an engineering/product form: "creative director",
   * "film director" and "managing director" are Arts and Business copy.
   *
   * BARE `leadership` AND `executives` WERE REMOVED AFTER MEASURING THEM. An earlier
   * version kept them on the reasoning that "an HR Leadership Summit really is for
   * leaders", which is true and was still the wrong call: of 69 rows carrying
   * `leaders`, the single largest block was one recurring Toastmasters event —
   * `In Person - PUBLIC SPEAKING/LEADERSHIP WORKSHOP` — and CLAUDE.md already names
   * Toastmasters as the bulk of what the `Meetup` category catches wrongly. A public-
   * speaking practice club is not an audience of engineering leaders. The qualified
   * forms are kept, so "Engineering Leadership Meetup" still lands.
   */
  ['leaders', /\b(cto|ciso|cio|cxo|cpo|c[- ]suite|vps? of engineering|vp eng(?:ineering)?|engineering managers?|eng(?:ineering)? leaders?|heads? of (?:engineering|product|data|platform|design)|(?:engineering|technology|technical|product) directors?|directors? of (?:engineering|product|technology)|(?:engineering|tech(?:nical)?|product|data) leadership|leadership team)\b/i],
  /*
   * NO BARE `\bpm\b` AND NO BARE `\bui\b`. This is the exact pattern the corpus's
   * most expensive regex mistake was made in: `pm` matched the time in "6 PM".
   * `roadmap` is also out — "roadmap to becoming a data scientist" is a course advert.
   */
  ['product', /\b(product managers?|product management|product owners?|producttank|\bux\b|ui\/ux|user research|design systems?|product design(?:ers?)?|discovery workshops?)\b/i],
  /*
   * NEVER a bare `data`. The `Data/Analytics` CATEGORY pattern above does match it,
   * and that is defensible for a topic tag; as an AUDIENCE it would fire on "data
   * centre", "your data is safe" and "data privacy policy". Job titles only.
   */
  ['data', /\b(data engineers?|data scientists?|data analysts?|analytics engineers?|\bdbas?\b|data platform|business intelligence|\bbi\s+(?:analysts?|developers?|engineers?)|ml engineers?|machine learning engineers?)\b/i],
  /*
   * NEVER a bare `security`: "security guard", "job security", "social security",
   * "food security". Role and practice forms only.
   */
  ['security', /\b(security engineers?|security researchers?|security analysts?|appsec|infosec|pentesters?|penetration testers?|red team|blue team|purple team|soc analysts?|threat hunt(?:er|ers|ing)|bug bount(?:y|ies)|ethical hack(?:er|ers|ing)|\bciso\b)\b/i],
  ['sre', /\b(sres?|site reliability|devops engineers?|platform engineers?|on[- ]call|incident (?:response|management)|observability|reliability engineers?|infrastructure engineers?|chaos engineering)\b/i],
  /*
   * `researchers?` rather than `research`: "user research" is a PRODUCT signal and
   * "market research" is Business. The `-er` requirement separates them at no cost.
   */
  ['researchers', /\b(researchers?|research scientists?|\bphd\b|post[- ]?docs?|paper reading|arxiv|academia|academics?|dissertations?|research labs?)\b/i],
];

/**
 * What you actually get in the room.
 *
 * ── `dinner` HAS NO BUCKET, AND THAT IS A GAP IN `PERK_NAMES`, NOT AN OMISSION HERE ──
 * `PERK_NAMES` is breakfast/lunch/snacks/swag/certificate/recording/drinks, and
 * `FOOD_PERKS` — the only definition of which perks constitute food — is
 * breakfast/lunch/snacks. An evening meetup that promises dinner, which is the most
 * common catering shape in this corpus, can therefore express nothing here. Mapping
 * it onto `snacks` was considered and rejected: a perk list is a factual claim about
 * what is served, and calling dinner a snack makes the chip on the card wrong in
 * order to make a facet look full.
 *
 * Consequence to expect, and it is visible on a card: such an event gets
 * `perks: []` while `hasFood` is still 'yes', because `FOOD_RE` above does match
 * `dinner`. The two are not in conflict — `hasFood` is the older, broader field and
 * `hasFoodFromPerks()` may only ever UPGRADE it — but the food facet under-reports
 * until `dinner` is added to `PERK_NAMES`. `scripts/diag-card-metadata.ts` counts the
 * affected rows so the decision can be made on a number.
 */
export const PERK_KEYWORDS: Array<[EventPerk, RegExp, PatternScope?]> = [
  ['breakfast', /\b(breakfast)\b/i],
  ['lunch', /\b(lunch(?:es)?|lunch break)\b/i],
  /*
   * `dinner` WAS THE MISSING BUCKET, and an evening meetup with dinner is the ordinary
   * Bengaluru shape -- 34 upcoming rows named a dinner, meal, buffet or thali and could be
   * given no food perk at all. It was added to `PERK_NAMES` and this table had no way to
   * produce it, which `tests/card-metadata.test.ts` caught as an unreachable chip: a
   * vocabulary value no keyword can derive is the "facet that can only render empty"
   * problem moved inside the vocabulary.
   *
   * ONLY THE WORDS THAT NAME THE EVENING MEAL ARE HERE. `meal`, `buffet` and `catering`
   * stay out even though `FOOD_RE` matches them for `hasFood`, and the distinction is the
   * point: those say food WITHOUT saying which meal, so filing them under `dinner` would
   * make the chip a false factual claim about a lunchtime buffet. `hasFood` is a yes/no
   * about food and is allowed to be broader; `perks` is an itemised claim and is not.
   *
   * `dinner` is safe bare -- unlike the `coffee`/`tea` over-match that put "Flow State Work
   * - Beat procrastination" under `drinks` -- because the word has no non-food sense in this
   * corpus, and "Founders Dinner" is a real dinner.
   */
  ['dinner', /\b(dinners?|supper|thali)\b/i],
  // `pizza` and `samosa` are the two foods this corpus names by name.
  ['snacks', /\b(snacks?|refreshments?|high tea|finger foods?|light bites|pizzas?|samosas?|munchies|evening tea|tea and biscuits)\b/i],
  // `tees` is OUT: "committees" contains it. `merch` is safe inside \b…\b because
  // "merchant" has no boundary after "merch".
  ['swag', /\b(swags?|goodie bags?|goodies|t[- ]?shirts?|stickers?|merch|merchandise|freebies)\b/i],
  /*
   * A CERTIFICATE IS SOMETHING YOU ARE GIVEN, NOT A SUBJECT. Bare `certification`
   * and `certified` are deliberately absent: "AWS Certification Prep", "Get Google
   * AI Certified … Cohort" and "Azure Certification Bootcamp" name the exam as the
   * topic, and this corpus is full of them — matching those would make `certificate`
   * the most common perk in the database while describing almost nothing given away.
   * Worse, it is the coaching-advert vocabulary, so the perk would correlate with the
   * rows `tier: 'advert'` exists to isolate. A giving-context is required.
   */
  ['certificate', /\b(certificates? of (?:participation|completion|attendance)|participation certificates?|certificates? (?:will be |are )?(?:provided|awarded|issued|given|included)|(?:provided|awarded|issued) certificates?)\b/i],
  /*
   * Likewise a POSITIVE context. "Recording is not permitted", "no recording of this
   * session" and "photography and recording prohibited" all contain the word, and a
   * bare match would promise a replay the event forbids.
   */
  ['recording', /\b(recordings? (?:will be |are |is |be )?(?:shared|provided|available|sent|posted)|(?:sessions?|talks?|it) will be recorded|recorded and (?:shared|posted|uploaded)|\breplays?\b|on[- ]demand (?:access|replay|recordings?))\b/i],
  /*
   * Beverages generally, not alcohol specifically.
   *
   * BARE `coffee`, `tea` AND `chai` WERE HERE AND WERE REMOVED AFTER MEASURING. With
   * them, `drinks` was the commonest perk in the corpus at 96 of 1149 rows, and the
   * matched-substring column showed why: `Flow State Work - Beat procrastination` (four
   * copies) matched on `coffee` appearing in the body copy as a subject, not a promise.
   * Those three words name the topic of an event as often as its catering here, and
   * "coffee chat" is an event FORMAT rather than something you are given.
   *
   * `drinks` itself stays bare, because "drinks after" and "drinks at 7" is exactly how
   * this perk is written. The coffee forms are kept where a provision context makes the
   * promise explicit. `high tea` is food and is claimed by `snacks` above.
   */
  ['drinks', /\b(drinks?|beers?|beverages?|cocktails?|mocktails?|happy hour|free (?:coffee|tea|chai)|(?:coffee|chai|tea) (?:and|&) (?:snacks|refreshments|biscuits|cookies)|(?:coffee|chai|tea) will be (?:provided|served|available)|unlimited (?:coffee|chai|tea))\b/i],
];

/**
 * Not really an event: the coaching-institute funnel.
 *
 * EVERY ENTRY IS A PHRASE, never a bare word, and that is not stylistic. `course`,
 * `training` and `demo` all appear innocently in real event copy — "a crash course in
 * Rust internals", "Demo Night" — and a bare-word list is how you mislabel a fifth of
 * the corpus. `demo` is only matched as `demo class` / `demo session` / `demo lecture`
 * / `demo at <somewhere>`, because "Demo Night", "Demos" and "Demo Day" are among the
 * BEST events for connections, which is the same distinction
 * `lib/events/connection-score.ts` makes with a lookahead.
 *
 * ── WHY THIS IS NOT `FUNNEL_PATTERN` FROM `connection-score.ts` ─────────────────
 * They answer different questions and must be allowed to disagree. `FUNNEL_PATTERN`
 * asks "will I leave with contacts", so it penalises `webinar` and `bootcamp` — a
 * legitimate community webinar scores low and deserves to, but it is an event and is
 * NOT an advert. `tier` is a browse label the operator uses to isolate junk, so
 * calling a real webinar 'advert' would be a false accusation about the organiser,
 * not merely a low rank. This pattern is therefore strictly narrower.
 *
 * `scripts/diag-coaching-leak.ts` holds a third, independent list for the same
 * quarry. The overlap between it and this pattern is reported by
 * `scripts/diag-card-metadata.ts` rather than assumed, so a divergence shows up as a
 * number instead of as a silent gap.
 */
/*
 * ── THE `demo at <institute>` BRANCH SITS OUTSIDE THE SHARED TRAILING `\b` ─────────
 * Everything else here ends on a word character, so one `\b(?:…)\b` wrapper serves
 * them all. `demo at eMexo` does not: the branch has to consume the first letter of
 * the institute's name to be worth anything, and a trailing `\b` after that letter
 * then fails against the SECOND letter. Written inside the wrapper it silently matched
 * nothing, and the row it exists for — `Free Gen AI & Agentic AI Demo at eMexo
 * Technologies`, one of the two adverts CLAUDE.md records at the top of the feed —
 * came back with no tier at all. Caught by a test, not by reading.
 *
 * `(?!the\b|our\b|\d)` keeps the innocent forms out: "live demo at the office",
 * "demo at our campus", "demo at 5pm". What is left is the shape a coaching centre
 * actually writes, which is "Demo at <its own name>".
 */
export const ADVERT_PATTERN =
  /(?:\b(?:(?:free|paid)\s+(?:demo|trial)\s+(?:class|session|lecture|lesson)|demo\s+(?:class|lecture|lesson)|(?:training|coaching)\s+(?:institute|cent(?:re|er)|academy|classes)|placement\s+(?:assistance|guarantee|support|training)|100%\s+(?:placement|job)|job\s+guarantee|(?:certification|certificate)\s+(?:course|program|programme|training|classes)|batch\s+(?:starting|starts|start|commenc)|new\s+batch|enroll?\s+now|admissions?\s+open|limited\s+seats?\s+(?:available|left)|live\s+project\s+training|(?:get|become)\s+\w+\s+certified|crash\s+course|(?:online|offline)\s+training\s+(?:institute|cent(?:re|er))|interview\s+questions?\s+(?:and|&)\s+answers?)\b|\bdemos?\s+at\s+(?!the\b|our\b|\d)[a-z])/i;

/**
 * A large, named, once-a-year event — by NAME, not by the word "summit".
 *
 * `summit` IS DELIBERATELY ABSENT, and it is the single most instructive omission in
 * this file. `lib/event-types.ts` records the measurement: the `Conference` category
 * pattern lists `summit`, and the rows it caught were `Kudremukh New Year Trek`,
 * `Kudremukha Trek` and `Tadiandamol Coorg Trek` — a trek goes to a summit. Alongside
 * them, `Property Expo`, `Dubai Real Estate Expo`, `Garment Technology Expo`,
 * `World Healthcare Expo & Summit` and `Bangalore HR Summit`. 17 of 20 such rows were
 * not tech events at all. So `summit`, `expo`, `convention` and `congress` are all out
 * of this pattern; a flagship is recognised by a brand name, a venue class, an
 * attendee count, or a Conference category plus one of those — never by a noun that
 * mountains also have.
 */
export const FLAGSHIP_TITLE_PATTERN =
  /\b(devfest|kubecon|droidcon|pycon|pyconf|jsconf|rubyconf|gophercon|rootconf|indiafoss|fossasia|fosdem|nullcon|defcon|def con|re:invent|google i\/o|io connect|great indian developer summit|\bgids\b|open source india|the fifth elephant|techsparks|grace hopper|cypher \d{4}|nvidia gtc|\bgtc\b|microsoft ignite|red hat summit|kubernetes community days|\bkcd\b)\b/i;

/**
 * Venue classes that mean money was spent on the room.
 *
 * ── LUXURY HOTELS WERE IN THIS LIST AND WERE REMOVED AFTER MEASURING IT ────────────
 * The first version named properties: JW Marriott, Sheraton Grand, Taj, The Leela,
 * Lalit Ashok, Chancery Pavilion, Le Meridien, Conrad, Grand Hyatt. A test in
 * `tests/card-metadata.test.ts` even asserted that a generic "Hotel Sai Palace" is not
 * a flagship venue — which passed, and missed the point completely, because the
 * problem was the NAMED hotels rather than the word "hotel". Run against the corpus,
 * two of the 18 flagship rows were:
 *
 *     Bangalore's Big Business, Tech & Entrepreneur Professional Networking Event
 *                                                        venue: JW Marriott Hotel
 *     Apparel Sourcing Week 2026                         venue: Sheraton Grand
 *
 * The first is a row `lib/event-types.ts` lists by name among the 17 false positives a
 * blanket `Conference` rule would admit. A business mixer books a five-star ballroom
 * precisely because that is what such mixers do; the hotel is evidence of a budget,
 * not of a flagship engineering event.
 *
 * What is left is PURPOSE-BUILT convention and exhibition space, which is booked for a
 * different reason and at a different scale. That kept LASER WORLD OF PHOTONICS (BIEC),
 * Open Source India (NIMHANS Convention Centre) and Grace Hopper Celebration India
 * (Karnataka Trade Promotion Organisation) and dropped both mixers.
 */
export const FLAGSHIP_VENUE_PATTERN =
  /\b(convention cent(?:re|er)|exhibition cent(?:re|er)|convention hall|\bbiec\b|bangalore international exhibition|palace grounds|tripura vasini|\bktpo\b|karnataka trade promotion|nimhans convention|jio world|bangalore international cent(?:re|er)|world trade cent(?:re|er)|exhibition grounds?)\b/i;

/**
 * Positive evidence of a peer gathering — required before `community` is asserted.
 *
 * `community` is not the default for "no evidence"; see `TaggingResult.tier`.
 */
const COMMUNITY_TITLE_PATTERN =
  /\b(meetups?|meet ?ups?|user groups?|community (?:meet|day|event|call|night)|chapter (?:meet|event|launch)|hack ?nights?|hackathons?|hack days?|show ?and ?tell|lightning talks?|unconference|open house|study (?:group|jam)|book club|coffee chat|tech talks?|dev ?fest|birds of a feather)\b/i;

/** Categories whose presence alone makes "an ordinary practitioner gathering" fair. */
const COMMUNITY_CATEGORIES = new Set(['Meetup', 'Hackathon', 'Open Source']);

/**
 * The attendee count that counts as ONE piece of flagship evidence.
 *
 * ── MEASURED, AND AN EARLIER "MEASURED" COMMENT HERE WAS WRONG ─────────────────────
 * This comment previously cited 1246 upcoming events, 84 with a count, median 26, p90
 * 178, max 1101. Those figures were written before the query was run and none of them
 * is right. The real distribution, `scripts/diag-card-metadata.ts` on 2026-09-10 over
 * 1149 upcoming events:
 *
 *     rows carrying an attendeeCount at all   45 of 1149   (3.9%)
 *     median 50 · p75 123 · p90 216 · p99 394 · max 445
 *
 * 120 therefore still sits at roughly the top quartile of the rows that have a count
 * at all, which is what it is for.
 *
 * ── THERE IS NO "BIG ENOUGH ON ITS OWN" THRESHOLD ANY MORE ─────────────────────────
 * There was one, at 400, on the reasoning that a genuinely huge event needs no second
 * signal. Against the corpus it selected exactly one row — `UNFOLD Walk: Agara
 * Edition`, 445 attendees — which is a walk round a lake. A 100% false-positive rate on
 * a sample of one is not evidence of anything, but the rule cost more than the single
 * true positive it might one day catch, and the ceiling of this corpus (445) sits below
 * where such a rule would need to be to be safe. So a marquee NAME is now the only
 * single-signal route to flagship, and everything else takes two.
 *
 * Re-measure before restoring it. A threshold picked against a different corpus is a
 * guess wearing a constant's clothes.
 */
const FLAGSHIP_ATTENDEES_MODERATE = 120;

/** A ticket this expensive is a corporate conference, not a community evening. */
const FLAGSHIP_PRICE = 5000;

export interface CardMetadata {
  audience: string[];
  perks: string[];
  tier?: EventTier;
}

/**
 * Derive `audience`, `perks` and `tier` from a document's own fields.
 *
 * ONE DEFINITION, used by the keyword floor below, by `scripts/backfill-card-metadata.ts`
 * and by `scripts/diag-card-metadata.ts`. The backfill passes richer input (organiser,
 * attendee count, price, stored categories) than the ingest path currently can, so the
 * same function gives a sharper verdict there — see the note on `TaggingInput`.
 */
export function deriveCardMetadata(input: TaggingInput): CardMetadata {
  const title = input.title || '';
  const text = `${title} ${input.description || ''} ${(input.hints || []).join(' ')}`;
  const categories = input.categories || [];

  const audience = new Set<string>();
  for (const [name, pattern, scope] of AUDIENCE_KEYWORDS) {
    // A `title` scope is the narrowed-field defence, not an optimisation. See PatternScope.
    if (pattern.test(scope === 'title' ? title : text)) audience.add(name);
  }

  const perks = new Set<string>();
  for (const [name, pattern, scope] of PERK_KEYWORDS) {
    if (pattern.test(scope === 'title' ? title : text)) perks.add(name);
  }

  return {
    // Ordered most-specific-first in the tables above, so a slice keeps the best signals.
    audience: [...audience].slice(0, MAX_AUDIENCE),
    perks: [...perks].slice(0, MAX_PERKS),
    tier: deriveTier({ ...input, categories }),
  };
}

/**
 * `flagship` | `community` | `advert`, or `undefined` when nothing says.
 *
 * Precedence is `advert` → `flagship` → `community`, and `advert` FIRST is the load-
 * bearing order. A coaching centre's "Certification Course at our Whitefield academy"
 * can easily also carry a Conference category and a hotel venue; deciding flagship
 * first would promote exactly the rows this label exists to isolate.
 *
 * The advert test reads the TITLE AND DESCRIPTION, unlike `offCityReason()` which
 * deliberately never reads a description — the asymmetry is about consequence.
 * Mis-reading a description there DELETES a row; here it mislabels a browse chip that
 * an operator can see and correct in `/admin`.
 */
function deriveTier(input: TaggingInput): EventTier | undefined {
  const title = input.title || '';
  const text = `${title} ${input.description || ''}`;
  const categories = input.categories || [];
  const going = input.attendeeCount ?? 0;

  if (ADVERT_PATTERN.test(text)) return 'advert';

  const marqueeName = FLAGSHIP_TITLE_PATTERN.test(title);
  const bigVenue = FLAGSHIP_VENUE_PATTERN.test(`${input.venue || ''} ${input.organizer || ''}`);
  const isConference = categories.includes('Conference');
  const pricey = input.isFree === false && (input.price ?? 0) >= FLAGSHIP_PRICE;

  // A marquee name is the ONLY single-signal route: IndiaFOSS is IndiaFOSS at any RSVP
  // count, and the name is checked against a hand list rather than a noun a mountain
  // also has. See FLAGSHIP_ATTENDEES_MODERATE for the count-alone rule that was removed.
  if (marqueeName) return 'flagship';
  // Everything else takes two signals, so that neither a top-quartile RSVP count nor a
  // Conference tag alone — the tag a trek earns from the word "summit" — is enough.
  const supporting = [isConference, bigVenue, pricey, going >= FLAGSHIP_ATTENDEES_MODERATE].filter(
    Boolean
  ).length;
  if (supporting >= 2) return 'flagship';

  if (COMMUNITY_TITLE_PATTERN.test(title) || categories.some(c => COMMUNITY_CATEGORIES.has(c))) {
    return 'community';
  }

  return undefined;
}

/**
 * The keyword pattern for one category, or undefined if it has none.
 *
 * `Meetup` and a few others are assigned by the LLM only and have no regex, so the caller must
 * handle undefined rather than assume every category is keyword-detectable.
 */
export function categoryPattern(category: string): RegExp | undefined {
  return CATEGORY_KEYWORDS.find(([name]) => name === category)?.[1];
}

export function keywordTagging(input: TaggingInput): TaggingResult {
  const text = `${input.title} ${input.description} ${(input.hints || []).join(' ')}`;

  const categories: string[] = [];
  for (const [category, pattern] of CATEGORY_KEYWORDS) {
    if (pattern.test(text)) categories.push(category);
  }

  // Keep the three strongest signals; the list is ordered most-specific first.
  const chosen = categories.slice(0, 3);
  if (chosen.length === 0) chosen.push('Meetup');

  const hasVenue = Boolean(input.venue?.trim());
  const hasOnlineLink = Boolean(input.onlineLink?.trim());
  let format: TaggingResult['format'] = 'offline';
  if (hasVenue && hasOnlineLink) format = 'hybrid';
  else if (hasOnlineLink || /\b(zoom|google meet|ms teams|virtual|webinar|online only)\b/i.test(text)) {
    format = 'online';
  }

  // Categories are computed above, so `tier` sees them here even though the caller
  // did not supply any — which is how a keyword-only run still gets the Conference
  // and Meetup signals `deriveTier` reads.
  const card = deriveCardMetadata({ ...input, categories: chosen });

  /*
   * `hasFood` upgrade-only, through `hasFoodFromPerks()` — the ONE definition of
   * which perks count as food. `FOOD_RE` is broader than `FOOD_PERKS` (it matches
   * `dinner`, `meal`, `buffet`, `catering`, none of which has a perk bucket), so it
   * is asked first and the perk derivation can only ever fill an 'unknown' it left.
   * Never the other way round: a perk list that is silent about food is not evidence
   * that there is none.
   */
  const foodFromText: TaggingResult['hasFood'] = FOOD_RE.test(text) ? 'yes' : 'unknown';
  const hasFood =
    foodFromText === 'unknown' ? (hasFoodFromPerks(card.perks) ?? 'unknown') : foodFromText;

  return {
    categories: chosen,
    format,
    hasFood,
    isTechEvent: chosen.some(c => TECH_CATEGORIES.has(c)),
    confidence: 0.6,
    audience: card.audience,
    perks: card.perks,
    tier: card.tier,
  };
}

/** Back-compat alias for the previous export name. */
export const tagEventsWithLLM = tagEvents;
