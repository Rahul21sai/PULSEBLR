/**
 * The day-after follow-up draft: prose written from the note you took, always editable, never sent.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * THIS IS THE MOST PRIVACY-SENSITIVE LLM CALL IN THE APP, AND THAT SHAPES THE WHOLE MODULE.
 *
 * Everything it sends is one user's private notes about a named third party who never agreed to be
 * described. Three structural defences, in the order they matter:
 *
 *   1. AN ALLOWLIST, NOT A DOCUMENT. `DRAFT_FIELDS` is the complete set of things that may reach a
 *      prompt, and `selectDraftFields()` is the only way material is built. Handing `person.toObject()`
 *      to a template would work today and would silently start leaking the first time somebody adds
 *      a field to `Person` — which is exactly how `POST /api/events` became three escalations when it
 *      spread `{ ...body }`. An email address, a phone number and a `contactKey` are all one field
 *      addition away from a prompt, and none of them helps write a sentence.
 *
 *   2. THE VIEWER'S ID IS REQUIRED AND FIRST. Nothing here reads the database — the route does — but
 *      the same rule applies to the material it hands over: it must have been selected by
 *      `{ _id, userId }`. `getNewEventsSince(viewerId, since)` is the precedent, and the reason it is
 *      positional and required is that an optional scope fails OPEN.
 *
 *   3. THE NOTE IS EVIDENCE, NOT COPY. A note often records a judgement — "seemed unhappy at his
 *      job", "vague about funding" — and a draft that paraphrases that back to its subject is worse
 *      than no draft at all. `SYSTEM_PROMPT` forbids it explicitly and the rule is stated as the
 *      reason, not just the instruction, because a model that understands why complies better.
 *
 * The UI's job is the fourth defence, and it cannot live here: the sheet says that the note is sent
 * to a model BEFORE the request goes out. Somebody who wrote "seemed unhappy at his job" deserves to
 * know that before it leaves the machine.
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── WHY THERE IS NO FLOOR, AND WHY THAT IS THE HONEST ANSWER ─────────────────────────────────────
 *
 * `keywordTagging()` is the floor under classification: with every provider down an event still gets
 * categories, coarser ones. THERE IS NO EQUIVALENT FOR PROSE. A template — "Hi <name>, great meeting
 * you at <event>!" — is not a degraded draft, it is a different and worse product wearing the same
 * label, and the user cannot tell which one they got. So `generateFollowupDraft()` returns an
 * explicit failure and the UI says the drafting service is unavailable and offers the note verbatim
 * to copy. Nothing here ever synthesises a sentence without a model.
 *
 * ── THE SPLIT ────────────────────────────────────────────────────────────────────────────────────
 *
 * Everything above the PROVIDER banner is pure: no network, no clock of its own, no mongoose, no
 * `process.env`. `tests/draft-followup.test.ts` exercises it with none of those. That is the split
 * `lib/notifications/reminder-policy.ts` uses against `reminders.ts`, and the reason is the same —
 * the rules worth pinning must be pinnable without a running MongoDB.
 */
import { shortDateIST } from '../format';

/* ══════════════════════════════════════════════════════════════════════════════════════════════
   1. THE FIELD ALLOWLIST
   ══════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * THE COMPLETE SET OF FIELDS THAT MAY REACH THE MODEL. Nothing else does, ever.
 *
 * Enumerated as a value rather than left implicit in a template literal so that the boundary is a
 * thing a test can read and assert against, and so that adding a field is a visible edit here rather
 * than an invisible consequence of editing `Person`.
 *
 * WHAT IS DELIBERATELY ABSENT, and why each omission is a decision rather than an oversight:
 *
 *   · `email`, `phone`, `linkedin`, `github`, `x`, `website` — contact routes. The user already has
 *     them and the model has no use for them; a draft does not need to know how it will be sent.
 *   · `contactKey`, `contactKeys`, `clientId`, `_id`, `personId`, `userId` — identifiers. They
 *     identify a row, never a sentence.
 *   · `tags`, `ownTags`, `companies`, `isTargetCompany` — the user's private filing of this person.
 *     "target company" in particular is a statement about the USER's job hunt, and a draft that
 *     leaked its flavour ("I'd love to hear about openings") would be transparently transactional.
 *   · `nextActionAt`, `followUpAt`, `followedUp` — reminder plumbing.
 *   · The SENDER's own name. Not third-party data at all, but the channel already carries who is
 *     writing: LinkedIn and email both show the sender. So the model is told to write NO sign-off,
 *     which removes the single most likely place for a `[Your Name]` placeholder to appear.
 */
export const DRAFT_FIELDS = [
  'personName',
  'company',
  'role',
  'headline',
  'eventTitle',
  'metAt',
  'notes',
] as const;

export type DraftField = (typeof DRAFT_FIELDS)[number];

/**
 * The material a draft is written from. One key per `DRAFT_FIELDS` entry, and no others.
 *
 * A `type` AND NOT AN `interface`, ON PURPOSE — do not "tidy" it back. TypeScript gives an object
 * type alias an implicit index signature and an interface none, so only this form is assignable to
 * the `Record<string, unknown>` that `selectDraftFields` and `generateFollowupDraft` accept. That
 * matters because it lets already-selected material be passed straight back in: the route builds
 * material through the allowlist and the generator re-selects it, which is idempotent by
 * construction and means the boundary is enforced on both sides of the call rather than trusted on
 * one. As an interface it needs a cast or a spread at every hand-off, and a cast at a redaction
 * boundary is precisely the thing that stops being checked.
 */
export type DraftMaterial = {
  /** Who the message is TO. The effective display name, overrides already applied. */
  personName: string;
  company: string | null;
  role: string | null;
  /** A LinkedIn-style one-liner, when a capture carried one. */
  headline: string | null;
  /** Where you met. Null is normal — `pruneStale()` deletes events a week past. */
  eventTitle: string | null;
  /** When you met, ISO. Used for "yesterday" vs "last month" phrasing, nothing else. */
  metAt: string | null;
  /** What you wrote down. NEWEST FIRST. This is the whole substance of the draft. */
  notes: string[];
};

/**
 * How many notes ride along, and how long each may be.
 *
 * Three, newest first: a follow-up is about the last conversation, and a fourth note is far more
 * likely to be about a different one. 600 chars each matches the description budget the tagger
 * settled on for the same reason — a longer excerpt buys nothing a model can use and every extra
 * character is a character that left the machine.
 */
export const MAX_NOTES = 3;
export const MAX_NOTE_CHARS = 600;

/** Field values longer than this are truncated. A role is a role, not an essay. */
const MAX_SHORT_FIELD_CHARS = 200;

function cleanShort(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_SHORT_FIELD_CHARS);
}

/**
 * Build the material from a wider object, keeping ONLY the allowlisted keys.
 *
 * THE PARAMETER IS DELIBERATELY LOOSE (`Record<string, unknown>`) AND THAT IS THE POINT. A narrow
 * parameter type would push callers into constructing the exact shape by hand at the call site,
 * which is where a stray `email:` gets added by someone doing the obvious thing. Taking anything and
 * picking seven keys means the redaction boundary is enforced by this function rather than remembered
 * by its callers — and `tests/draft-followup.test.ts` asserts it by feeding in a document stuffed
 * with secrets and reading the built prompt back.
 *
 * A blank string is normalised to `null`, not kept: an empty `role` in a prompt reads as "role:" with
 * nothing after it, which invites a model to fill the gap.
 */
export function selectDraftFields(source: Record<string, unknown>): DraftMaterial {
  const rawNotes = Array.isArray(source.notes) ? source.notes : [];
  const notes: string[] = [];
  for (const entry of rawNotes) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    notes.push(trimmed.slice(0, MAX_NOTE_CHARS));
    if (notes.length >= MAX_NOTES) break;
  }

  return {
    personName: cleanShort(source.personName) ?? '',
    company: cleanShort(source.company),
    role: cleanShort(source.role),
    headline: cleanShort(source.headline),
    eventTitle: cleanShort(source.eventTitle),
    metAt: typeof source.metAt === 'string' && source.metAt.trim() ? source.metAt.trim() : null,
    notes,
  };
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
   2. WHETHER THERE IS ANYTHING TO DRAFT FROM
   ══════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Notes shorter than this carry no conversation. `"yes"`, `"nice"`, `"dev"` are real notes people
 * type; none of them is a thing a follow-up can be about.
 */
export const MIN_NOTE_CHARS = 12;

export type MaterialProblem = 'no-name' | 'no-note';

/**
 * Is there enough here to write from? Returns the problem, or `null` when there is.
 *
 * A MISSING NOTE IS A REFUSAL, NOT A PROMPT. This is the decision that keeps the feature honest.
 * With no note the only message a model can produce is "great to meet you at X" — which needs no
 * model, tells the recipient nothing, and is the template this module's header refuses to ship. So
 * the answer is to say there is nothing to draft from and point at the note field, which is a real
 * next step the user can take in five seconds.
 *
 * It also removes the worst failure mode: a plausible, fluent, entirely invented message about a
 * conversation the user cannot remember, sent to somebody who was there.
 */
export function materialProblem(material: DraftMaterial): MaterialProblem | null {
  if (!material.personName) return 'no-name';
  const substance = material.notes.join(' ').trim();
  if (substance.length < MIN_NOTE_CHARS) return 'no-note';
  return null;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
   3. THE PROMPT
   ══════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * The rules, stated as reasons wherever a reason exists.
 *
 * Several of these are not style preferences, they are the difference between a message somebody
 * sends and one they delete:
 *
 *   · GROUNDING. Every specific in the draft must trace to the notes. An invented shared joke is
 *     unrecoverable — the recipient was there and knows it did not happen.
 *   · NO JUDGEMENTS BACK. See the module header. This is the rule most likely to be quietly dropped
 *     by a later prompt edit, so it is stated twice and with its reason.
 *   · NO SIGN-OFF. The channel carries the sender's identity, and every draft that tries to sign off
 *     without knowing the sender's name produces `[Your Name]`.
 *   · ONE ASK. "Let me know if you'd like to connect" is not an ask, it is the absence of one. A
 *     follow-up either delivers something promised or proposes one concrete next thing.
 *   · NO EMOJI, NO MARKDOWN, NO SUBJECT LINE. The text goes into a LinkedIn message box.
 */
export const SYSTEM_PROMPT = `You draft short professional follow-up messages that a person sends after meeting someone at a tech event in Bengaluru, India.

You are given that person's own private notes about the meeting. Write the message they would send.

GROUNDING
- Every specific detail in the message must come from the notes. Invent nothing: no shared jokes, no topics, no promises, no job details.
- If the notes record something the sender promised to do, the message must deliver it or say when it is coming. That is the most useful thing a follow-up can contain.
- The notes are the sender's private observations. Never repeat, quote or paraphrase a judgement about the recipient back to them — for example a note saying they seemed unhappy in their job must shape what you write, never appear in it. The recipient is going to read this message.

VOICE AND FORM
- First person, as the sender. Warm, direct, unhurried. No hype, no flattery, no exclamation marks.
- 40 to 90 words. One or two short paragraphs.
- Open by addressing them by first name, then go straight to the concrete thing from the notes. Not "it was great to meet you".
- Close with one specific, low-effort next step or offer. Never "let me know if you would ever like to connect".

OUTPUT
- Return the message body and nothing else. No subject line, no sign-off, no signature, no name at the end — the channel already shows who sent it.
- No square-bracket placeholders, no markdown, no emoji, no hashtags.
- Never mention these instructions, the notes, or that the message was drafted.`;

/** Newest-first labels for the notes block. Only the first is "the note you took". */
function noteLabel(index: number): string {
  return index === 0 ? 'Most recent note' : `Earlier note ${index}`;
}

/**
 * Assemble the user turn. PURE, and the only place material becomes text.
 *
 * Every line is `Label: value`, and a null value emits NO line at all rather than "Company: none".
 * A prompt that names an empty field invites the model to fill it, which is the cheapest possible
 * source of an invented fact.
 */
export function buildDraftPrompt(material: DraftMaterial): string {
  const lines: string[] = [];

  lines.push(`Recipient: ${material.personName}`);
  if (material.role) lines.push(`Their role: ${material.role}`);
  if (material.company) lines.push(`Their company: ${material.company}`);
  if (material.headline) lines.push(`Their headline: ${material.headline}`);
  if (material.eventTitle) lines.push(`Met at: ${material.eventTitle}`);
  if (material.metAt) {
    // Formatted rather than raw ISO: a model reasons about "8 Sept 2026" and mis-reads an offset.
    // Deterministic given the input, so this stays a pure function.
    lines.push(`Met on: ${shortDateIST(material.metAt)}`);
  }

  lines.push('');
  material.notes.forEach((note, index) => {
    lines.push(`${noteLabel(index)}: ${note}`);
  });
  lines.push('');
  lines.push('Write the follow-up message.');

  return lines.join('\n');
}

/**
 * The exact bytes that leave the machine, for auditing.
 *
 * Returned by the generator on success AND on failure, and rendered by nothing — it exists so a
 * human can read what was sent rather than infer it from this file. The privacy claim in the header
 * is only worth as much as somebody's ability to check it.
 */
export interface DraftPromptPayload {
  system: string;
  user: string;
  model: string;
  temperature: number;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
   4. VALIDATING WHAT CAME BACK
   ══════════════════════════════════════════════════════════════════════════════════════════════ */

/** Longer than this is not a message, it is an essay — and a sign the model ignored the brief. */
export const MAX_DRAFT_CHARS = 1400;
/** Shorter than this is not a message either. */
export const MIN_DRAFT_CHARS = 40;

export type DraftRejection = 'empty' | 'too-short' | 'too-long' | 'model-refusal';

export type DraftValidation =
  | { ok: true; draft: string }
  | { ok: false; rejection: DraftRejection };

/**
 * A leading apology or refusal from the model, which must never be shown as a draft.
 *
 * DELIBERATELY ANCHORED AT THE START. "I'm sorry I had to leave early" is a perfectly good sentence
 * for a follow-up to contain, so an unanchored match would reject good drafts — the same
 * over-matching failure the `\bpm\b` tagger regex is the standing example of in this repo.
 */
const MODEL_REFUSAL = /^\s*(i'?m sorry|i am sorry|i cannot|i can'?t|i'?m unable|as an ai|sorry,)/i;

/**
 * Clean and judge the model's reply.
 *
 * LENIENT ABOUT WRAPPING, STRICT ABOUT SUBSTANCE — the same posture `parseTagResponse` takes, and
 * for the same reason: a model that returns the right message inside a code fence has done the work,
 * and discarding it would fall through to a failure state that tells the user the service is down
 * when it is not. So fences, a `Subject:` line and a leading "Here is a draft:" label are stripped;
 * length and refusals are refused.
 */
export function validateDraft(raw: string | null | undefined): DraftValidation {
  if (typeof raw !== 'string') return { ok: false, rejection: 'empty' };

  let text = raw.trim();
  if (!text) return { ok: false, rejection: 'empty' };

  // A fenced block, with or without a language tag.
  const fenced = text.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/);
  if (fenced) text = fenced[1].trim();

  // A preamble label on its own line: "Here is a draft:", "Draft:", "Follow-up message:".
  text = text.replace(/^[^\n:]{0,60}(draft|message|follow-?up)[^\n:]{0,20}:\s*\n+/i, '').trim();

  // A subject line the prompt forbade. Dropped rather than treated as a failure.
  text = text.replace(/^subject:.*\n+/i, '').trim();

  // Surrounding quotes, which some models add when asked for "the message".
  if (text.length > 2 && /^["'“](.|\n)*["'”]$/.test(text)) {
    text = text.slice(1, -1).trim();
  }

  if (!text) return { ok: false, rejection: 'empty' };
  if (MODEL_REFUSAL.test(text)) return { ok: false, rejection: 'model-refusal' };
  if (text.length < MIN_DRAFT_CHARS) return { ok: false, rejection: 'too-short' };
  if (text.length > MAX_DRAFT_CHARS) return { ok: false, rejection: 'too-long' };

  return { ok: true, draft: text };
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
   5. THROTTLE ARITHMETIC
   ══════════════════════════════════════════════════════════════════════════════════════════════ */

/*
 * THE THROTTLE LOGIC IS SHARED, AND THIS FILE IS WHY IT IS SHARED.
 *
 * Both functions were written here as a second copy of `tagger.ts`'s, because that file did not
 * export them and reaching into a file this stream did not own would have been worse. The note
 * left behind named the fix and its precedent, and this is that fix: `lib/llm/throttle.ts` now
 * holds one implementation, and `/events/[id]`'s `WorthGoing` panel is the reason to bother — it
 * had COPIED `connection-score.ts`'s funnel regex, the copy fell eight entries behind, and the
 * page went on confidently explaining a heavily-penalised coaching advert without mentioning the
 * penalty.
 *
 * `retryAfterMs` is re-exported through a THIN WRAPPER rather than directly, and the wrapper is
 * the point: it binds this caller's cap. The shared function takes `capMs` as a required argument
 * precisely because there is no correct default — 20s is right for a tagging batch on a GitHub
 * runner with hundreds more queued behind it, and wrong here, where somebody is watching a
 * spinner and a wait past about ten seconds reads as broken. Binding it here keeps that decision
 * beside the code it governs and keeps this module's own call sites and tests unchanged.
 *
 * The `random` parameter survived the merge in the other direction: it was this copy's
 * improvement, not the tagger's, and the shared module took it. Hard-wiring `Math.random` leaves
 * jittered backoff testable only statistically, which is slow, flaky, and asserts the wrong thing.
 */
import {
  isRateLimited,
  retryAfterMs as retryAfterMsCapped,
  INTERACTIVE_BACKOFF_CAP_MS,
} from './throttle';

/*
 * Imported for local use AND re-exported under this module's existing name. A bare
 * `export { x } from './y'` does NOT bind the name locally — it only forwards it — so the
 * throttle loop below could not see it and `tsc` said so immediately. Worth the two lines:
 * renaming the loop's call site instead would have churned a function this module's tests
 * already address by name.
 */
export { isRateLimited as rateLimitedFrom };

export function retryAfterMs(
  header: string | null,
  attempt: number,
  random: () => number = Math.random
): number {
  return retryAfterMsCapped(header, attempt, INTERACTIVE_BACKOFF_CAP_MS, random);
}

/** Attempts for a throttle specifically. Three, against the latency ceiling above. */
export const RATE_LIMIT_ATTEMPTS = 3;

/* ══════════════════════════════════════════════════════════════════════════════════════════════
   6. THE PROVIDER — everything below here touches the network
   ══════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * WHY THE TRANSPORT IS IN THIS FILE AND NOT THE ROUTE.
 *
 * `callOpenAICompatible()` in the tagger hard-codes the tagging `SYSTEM_PROMPT`, so it cannot carry a
 * different one and this path cannot reuse it. The alternative was to put a `fetch` in the route
 * handler, which would mix HTTP-in with HTTP-out and make the provider behaviour unreadable from the
 * one file that documents it. So it lives here, strictly below the pure section, and the route stays
 * thin: guard, throttle, read, call, respond.
 */

export type DraftFailure =
  /** No model configured, credentials rejected, timeout, or a persistent throttle. */
  | 'unavailable'
  /** There is nothing to write from. Not a service failure — see `materialProblem`. */
  | 'no-material'
  /** The model answered and the answer was not a usable message. */
  | 'bad-response';

export type DraftResult =
  | {
      ok: true;
      draft: string;
      /**
       * ALWAYS `false`, AS A TYPE RATHER THAN A VALUE.
       *
       * A draft is never sent by generating it, and the literal type means no code path in this
       * module can claim otherwise — a future `sent: true` here is a compile error, not a review
       * catch. Recording that a message went out is a separate, deliberate act: the person page's
       * existing `PATCH /api/people/[id]` with `{ messageSent: true }`, fired when the user actually
       * opens the channel. `tests/draft-followup.test.ts` pins this.
       */
      sent: false;
      /** Exactly what was sent, for auditing. See `DraftPromptPayload`. */
      payload: DraftPromptPayload;
    }
  | {
      ok: false;
      failure: DraftFailure;
      /** For the server log. NEVER returned to a client — it can quote a provider body. */
      detail: string;
      problem?: MaterialProblem;
      rejection?: DraftRejection;
      payload?: DraftPromptPayload;
    };

/** ICA's own timeout. Prose is a bigger completion than a tag batch, but a user is waiting. */
const TIMEOUT_MS = 30_000;

/**
 * ICA REQUIRES `temperature: 1` AND WILL LIE ABOUT WHY.
 *
 * Measured and recorded in CLAUDE.md: omitting `temperature` returns `400 {"detail":"Model not
 * found"}`, which sends you to check `ICA_MODEL` against `GET /models`, find it present, and conclude
 * the catalogue is wrong. `temperature: 0.2` returns a 400 that is at least honest — "only
 * temperature=1 is supported". So 1 is sent explicitly and from the first request, rather than
 * discovering it through a wasted call the way the tagger's `MODELS_REQUIRING_TEMP_1` has to.
 *
 * It happens to be the right value here anyway: this is the one call in the app that wants prose
 * rather than a deterministic classification.
 */
const TEMPERATURE = 1;

/** Completion headroom. 90 words is ~130 tokens; 800 absorbs a model that over-writes. */
const MAX_TOKENS = 800;

/**
 * Draft a follow-up. The only impure export.
 *
 * `viewerId` IS REQUIRED AND FIRST, matching `getNewEventsSince(viewerId, since)`. It is not used to
 * query anything here — the route has already scoped its reads by `{ _id, userId }` — it is taken so
 * that the signature cannot be satisfied without having decided whose data this is. An optional scope
 * fails open, and this is the call where failing open means one user's private notes about a named
 * person reaching a prompt on behalf of another.
 */
export async function generateFollowupDraft(
  viewerId: string,
  source: Record<string, unknown>
): Promise<DraftResult> {
  if (!viewerId) {
    return { ok: false, failure: 'unavailable', detail: 'No viewer id supplied.' };
  }

  const material = selectDraftFields(source);
  const problem = materialProblem(material);
  if (problem) {
    return { ok: false, failure: 'no-material', detail: `Material problem: ${problem}`, problem };
  }

  const apiKey = process.env.ICA_API_KEY;
  const baseUrl = process.env.ICA_BASE_URL;
  const model = process.env.ICA_MODEL;

  const user = buildDraftPrompt(material);
  const payload: DraftPromptPayload = {
    system: SYSTEM_PROMPT,
    user,
    model: model ?? '(unset)',
    temperature: TEMPERATURE,
  };

  if (!apiKey || !baseUrl || !model) {
    /*
     * NVIDIA and Anthropic are deliberately not attempted. Measured 2026-09-10: every NVIDIA model
     * 404s "not found for account" and `ANTHROPIC_API_KEY` is unset, so a cascade here would spend
     * two doomed round trips before saying what it says immediately. When a second tier is genuinely
     * configured, this is where it goes — and the fallback must be a real prose model, not the 8B
     * that got this feature deferred in the first place.
     */
    return {
      ok: false,
      failure: 'unavailable',
      detail: 'ICA_API_KEY / ICA_BASE_URL / ICA_MODEL are not all set.',
      payload,
    };
  }

  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

  const call = () =>
    fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: user },
        ],
        max_tokens: MAX_TOKENS,
        temperature: TEMPERATURE,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

  try {
    let response = await call();

    /*
     * THE THROTTLE LOOP. Retries the SAME model — a rate limit is not evidence against the model, and
     * there is no second model on this account to move to. Bounded, so a throttled account degrades
     * to an honest "busy" rather than holding a user's request open.
     */
    for (let attempt = 0; attempt < RATE_LIMIT_ATTEMPTS; attempt++) {
      if (response.ok) break;
      // Reading the body consumes it, so it is carried forward either way.
      const body = await response.text();
      if (!isRateLimited(response.status, body)) {
        response = new Response(body, { status: response.status, headers: response.headers });
        break;
      }
      if (attempt === RATE_LIMIT_ATTEMPTS - 1) {
        return {
          ok: false,
          failure: 'unavailable',
          detail: `ICA rate-limited after ${RATE_LIMIT_ATTEMPTS} attempts: ${body.slice(0, 200)}`,
          payload,
        };
      }
      const wait = retryAfterMs(response.headers.get('retry-after'), attempt);
      console.warn(
        `[draft-followup] ICA throttled (HTTP ${response.status}) — waiting ${wait}ms, ` +
          `attempt ${attempt + 2}/${RATE_LIMIT_ATTEMPTS}`
      );
      await new Promise(resolve => setTimeout(resolve, wait));
      response = await call();
    }

    if (!response.ok) {
      /*
       * Every remaining status is `unavailable` and none of them is retried here. 401/403 cannot heal
       * without a new credential, 404 means the model is not on this account, and a 5xx from the
       * gateway is not something to hammer behind a button press. The tagger's circuit breaker is
       * deliberately NOT reached into: it is process state keyed by provider name, and retiring the
       * whole ICA provider — the only working tier — because a draft failed would take tagging down
       * with it. The per-user rate limit on the route is what bounds cost here instead.
       */
      const body = (await response.text()).slice(0, 300);
      return {
        ok: false,
        failure: 'unavailable',
        detail: `ICA error ${response.status}: ${body}`,
        payload,
      };
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const validated = validateDraft(data.choices?.[0]?.message?.content);
    if (!validated.ok) {
      return {
        ok: false,
        failure: 'bad-response',
        detail: `Model reply rejected: ${validated.rejection}`,
        rejection: validated.rejection,
        payload,
      };
    }

    return { ok: true, draft: validated.draft, sent: false, payload };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      failure: 'unavailable',
      detail: /abort|timeout/i.test(message) ? `ICA timed out after ${TIMEOUT_MS}ms` : message,
      payload,
    };
  }
}
