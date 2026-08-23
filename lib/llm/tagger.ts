import { EVENT_CATEGORIES, TECH_CATEGORY_NAMES } from '../models/Event';

export interface TaggingResult {
  categories: string[];
  format: 'online' | 'offline' | 'hybrid';
  hasFood: 'yes' | 'no' | 'unknown';
  /** True for a software/data/hardware/product-engineering event. */
  isTechEvent: boolean;
  confidence: number;
}

export interface TaggingInput {
  title: string;
  description: string;
  venue?: string;
  onlineLink?: string;
  /** Adapter-supplied hints (Devfolio themes, Bevy event types, Meetup keywords). */
  hints?: string[];
}

const VALID_CATEGORIES = new Set<string>(EVENT_CATEGORIES);
const VALID_FORMATS: TaggingResult['format'][] = ['online', 'offline', 'hybrid'];
const VALID_FOOD: TaggingResult['hasFood'][] = ['yes', 'no', 'unknown'];

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
  networking, real-estate and investing pitches, and paid certification or
  course-selling sessions that merely mention a technology.

"confidence": 0.0-1.0

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

/** NVIDIA NIM model measured as fast and reliable for this classification task. */
const NVIDIA_FAST_MODEL = 'meta/llama-3.1-8b-instruct';

async function callOpenAICompatible(userPrompt: string, opts: ProviderConfig): Promise<string> {
  const { apiKey, baseUrl, provider, timeoutMs = 45000, fallbackModel } = opts;
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
        } else {
          throw new Error(`${provider} error 400: ${errText.slice(0, 300)}`);
        }
      }

      if (response.status === 404) {
        // The model isn't available to this account — it will never be, so stop
        // paying for it and move to the fallback.
        DEAD_MODELS.add(model);
        lastError = new Error(`${provider}: model "${model}" not available (404)`);
        console.warn(`[${provider}] model "${model}" unavailable — trying next model`);
        continue;
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
  const message = await anthropic.messages.create({
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 2000,
    temperature: 0.2,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });
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

/** Coerce one model object into a schema-valid TaggingResult. */
function coerce(raw: unknown, fallback: TaggingResult): TaggingResult {
  if (!raw || typeof raw !== 'object') return fallback;
  const obj = raw as Record<string, unknown>;

  const categories = Array.isArray(obj.categories)
    ? obj.categories.filter((c): c is string => typeof c === 'string' && VALID_CATEGORIES.has(c))
    : [];

  const format = VALID_FORMATS.includes(obj.format as TaggingResult['format'])
    ? (obj.format as TaggingResult['format'])
    : fallback.format;

  const hasFood = VALID_FOOD.includes(obj.hasFood as TaggingResult['hasFood'])
    ? (obj.hasFood as TaggingResult['hasFood'])
    : fallback.hasFood;

  return {
    categories: categories.length > 0 ? [...new Set(categories)].slice(0, 3) : fallback.categories,
    format,
    hasFood,
    isTechEvent: typeof obj.isTechEvent === 'boolean' ? obj.isTechEvent : fallback.isTechEvent,
    confidence: typeof obj.confidence === 'number' ? obj.confidence : 0.8,
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

  // Sized from the provider we expect to serve most batches. If it trips the
  // breaker mid-run the next provider simply receives larger batches than its
  // ideal — which lenient parsing already tolerates.
  const batchSize = batchSizeFor(providers[0]?.name);

  // ── Circuit breaker ───────────────────────────────────────────────────────
  // Measured failure mode: with an expired ICA key (instant 401) and a NVIDIA
  // endpoint that timed out at 45 s, EVERY batch paid ~46 s before falling back
  // to keywords. Across 105 batches that is 80 minutes of waiting to produce
  // exactly the keyword tagging we'd have got for free. So a provider that fails
  // this many times consecutively is dropped for the rest of the run.
  const TRIP_AFTER = 3;
  const strikes = new Map<string, number>();
  const tripped = new Set<string>();
  let loggedSample = false;
  let partialBatches = 0;

  for (let offset = 0; offset < inputs.length; offset += batchSize) {
    const batch = inputs.slice(offset, offset + batchSize);
    const available = providers.filter(p => !tripped.has(p.name));

    if (available.length === 0) {
      // All providers are out. Keyword fallbacks are already in `results`, so
      // stop calling out entirely rather than re-failing for every remaining batch.
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
          strikes.set(provider.name, 0); // a success clears the record
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
        recordStrike(provider.name);
      } catch (error) {
        console.warn(
          `[${provider.name}] batch failed: ${error instanceof Error ? error.message : String(error)}`
        );
        recordStrike(provider.name);
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

  function recordStrike(name: string): void {
    const next = (strikes.get(name) ?? 0) + 1;
    strikes.set(name, next);
    if (next >= TRIP_AFTER && !tripped.has(name)) {
      tripped.add(name);
      console.warn(
        `[${name}] disabled for this run after ${next} consecutive failures — using the next provider`
      );
    }
  }

  const summary =
    `Tagging: ${llmTagged}/${inputs.length} via LLM, ${inputs.length - llmTagged} via keywords` +
    (batchFailures > 0 ? ` (${batchFailures} batch(es) fell back` : '') +
    (partialBatches > 0 ? `${batchFailures > 0 ? ', ' : ' ('}${partialBatches} partial` : '') +
    (batchFailures > 0 || partialBatches > 0 ? ')' : '');
  if (tripped.size > 0) {
    console.warn(`${summary} — providers disabled: ${[...tripped].join(', ')}`);
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
const CATEGORY_KEYWORDS: Array<[string, RegExp]> = [
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
  ['Hardware/Robotics', /\b(hardware|embedded|robotics|iot|drone|semiconductor|chip design|soc design|analog design|silicon|fpga|vlsi|verilog|systemverilog|vhdl|asic|risc-?v|tape-?outs?|photonics?|mems|arduino|raspberry pi|esp32|stm32|microcontrollers?|mechatronics|firmware|rtos|pcb|soldering|electronics|electron devices?|signal processing|3d print(?:ing|ers?)?|makerspaces?|maker faire|sensors?)\b/i],
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
const TECH_CATEGORIES = new Set<string>([...TECH_CATEGORY_NAMES, 'Hackathon']);

const FOOD_RE =
  /\b(food|snacks?|refreshments?|lunch|dinner|breakfast|pizza|beverages?|drinks?|meal|catering|high tea|buffet)\b/i;

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

  return {
    categories: chosen,
    format,
    hasFood: FOOD_RE.test(text) ? 'yes' : 'unknown',
    isTechEvent: chosen.some(c => TECH_CATEGORIES.has(c)),
    confidence: 0.6,
  };
}

/** Back-compat alias for the previous export name. */
export const tagEventsWithLLM = tagEvents;
