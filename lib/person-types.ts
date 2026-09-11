/**
 * The CLIENT-side shapes for the people spine, plus the PURE request validators for `/api/people/*`.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE IS HERE AND NOT IN `lib/people/`.
 *
 * Two independent constraints put it here, and either one alone would be sufficient:
 *
 *   1. IT MUST BE MONGOOSE-FREE. `lib/people/service.ts` imports mongoose and every model, so a
 *      client component importing a type from it drags the whole data layer into the browser
 *      bundle — the same reason `FOLDER_ON_TRACKER_STATUS` lives in `lib/tracker/validate.ts`
 *      rather than in `lib/contacts/service.ts`. Dates also arrive over JSON as ISO **strings**,
 *      not `Date`, so the Mongoose interfaces are the wrong types for a component regardless:
 *      typing them `Date` compiles fine and then every `.getTime()` throws at runtime. That is
 *      the rationale `lib/event-types.ts` and `lib/contacts/types.ts` already record.
 *
 *   2. THE VALIDATORS MUST BE TESTABLE WITHOUT A SERVER, and they must be shared by every route
 *      that accepts the same body. `tests/people-api-shape.test.ts` pins them with no database and
 *      no `auth()`. Putting them in a route file instead would mean the test imports a route
 *      module — and a route module imported from anywhere it should not be is how every `/api/*`
 *      path in this app once ended up a 404.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * GUARD FIRST, VALIDATE SECOND. Nothing in this file may be called before `requireUser()` in a
 * handler. Reversed, an anonymous caller sending a bad body gets 400 instead of 401 — which tells a
 * stranger their payload parsed and validated far enough to be judged, and breaks the contract
 * `scripts/diag-api-auth.ts` asserts. The validators are pure precisely so that ordering is a free
 * choice rather than a performance trade.
 */

// TYPE-ONLY import, so nothing from `lib/models/**` survives into a client bundle. It is erased at
// compile time under `isolatedModules`. Importing the *type* rather than re-declaring the union is
// what stops a seventh interaction kind existing in the schema and not here.
import type { InteractionKind } from './models/Interaction';

export type { InteractionKind };

/* ══════════════════════════════════════════════════════════════════════════════════════════════
   CLIENT SHAPES
   ══════════════════════════════════════════════════════════════════════════════════════════════ */

/** One human, as `/api/people` and `/api/people/[id]` serve them. Mirrors `lib/models/Person.ts`. */
export interface PersonDTO {
  _id: string;
  /** EFFECTIVE name — `derivePersonFields` has already applied any override. */
  displayName: string;
  company?: string | null;
  role?: string | null;
  headline?: string | null;
  /** What the USER pinned by hand. Rendered in the edit sheet so a correction is visible as one. */
  overrides: { displayName?: string | null; company?: string | null; role?: string | null };
  contactKeys: string[];
  tags: string[];
  ownTags: string[];
  companies: string[];
  isTargetCompany: boolean;
  lastInteractionAt?: string | null;
  nextActionAt?: string | null;
  /** DISTINCT events, not `met` rows and not folders. This is what `met N x` renders. */
  eventCount: number;
  interactionCount: number;
  /** Set only on the LOSER of a merge. A tombstone must never be listed — only opened by URL. */
  mergedInto?: string | null;
  createdAt: string;
  updatedAt: string;

  /**
   * The most recent encounters, for the history collapsed INSIDE the card.
   *
   * Server-computed and capped (see `RECENT_INTERACTIONS`), because the alternative is either three
   * cards for one human — which is the defect this whole spine removes — or a fetch per row.
   */
  recent?: InteractionDTO[];
  /** Derived from a `li:` contact key. Person has no LinkedIn field; see `linkedinUrlFromKeys`. */
  linkedin?: string | null;
}

export interface InteractionDTO {
  _id: string;
  kind: InteractionKind;
  /** WHEN IT HAPPENED, not when the row was written. */
  at: string;
  eventId?: string | null;
  /**
   * Joined at read time, and NULLABLE for a real reason: `pruneStale()` deletes events 7 days past
   * without touching anything that references them, so a dangling `eventId` is normal rather than
   * corruption. The UI says "an event we no longer have" instead of rendering a blank heading.
   */
  eventTitle?: string | null;
  eventStartAt?: string | null;
  contactId?: string | null;
  note?: string | null;
}

/** How many encounters ride along on each list row. Three, matching the card's three lines. */
export const RECENT_INTERACTIONS = 3;

export interface PersonBucket {
  value: string;
  count: number;
  /** Company buckets only: is this employer on the user's target list? */
  isTarget?: boolean;
  label?: string;
}

export interface PersonFacets {
  total: number;
  companies: PersonBucket[];
  tags: PersonBucket[];
  tagVocabulary: string[];
  targetCount: number;
  followUpCount: number;
  repeatCount: number;
}

/** One end of a possible duplicate, flattened for a side-by-side compare. */
export interface MergeCandidate {
  _id: string;
  displayName: string;
  company?: string | null;
  role?: string | null;
  headline?: string | null;
  eventCount: number;
  interactionCount: number;
  lastInteractionAt?: string | null;
  contactKeys: string[];
}

export interface MergePair {
  a: MergeCandidate;
  b: MergeCandidate;
  /** The key both hold — the evidence for the suggestion, shown so it can be argued with. */
  contactKey: string;
}

/**
 * Human labels for the timeline.
 *
 * `Record<InteractionKind, string>` on purpose: a kind added to the schema without a label here
 * fails the build rather than rendering a raw enum value at somebody.
 */
export const INTERACTION_LABEL: Record<InteractionKind, string> = {
  met: 'Met',
  note: 'Note',
  'follow-up-set': 'Follow-up set',
  'follow-up-done': 'Followed up',
  'message-sent': 'Message sent',
  intake: 'Added themselves',
  merged: 'Merged',
};

export const INTERACTION_ICON: Record<InteractionKind, string> = {
  met: 'handshake',
  note: 'sticky_note_2',
  'follow-up-set': 'alarm',
  'follow-up-done': 'task_alt',
  'message-sent': 'send',
  intake: 'person_add',
  merged: 'merge',
};

/**
 * The LinkedIn URL for a person, from their contact keys.
 *
 * `Person` has no LinkedIn field, and adding one would be a fourth place the same fact lives.
 * `contactKey` already encodes it: `li:<public-vanity-slug>` is the top identity tier precisely
 * because a LinkedIn QR carries the slug and nothing else (19 decoded samples, Jun 2018 → Mar 2026,
 * zero structural variation). So the profile URL is a pure function of the keys.
 *
 * WE NEVER FETCH linkedin.com — this only ever becomes an `href` for the user to click. LinkedIn's
 * User Agreement forbids scraping, robots.txt ends in `Disallow: /`, and a server-side fetch is
 * answered with HTTP 999 anyway.
 */
export function linkedinUrlFromKeys(keys: readonly string[] | undefined | null): string | null {
  if (!keys) return null;
  for (const key of keys) {
    if (typeof key !== 'string' || !key.startsWith('li:')) continue;
    const slug = key.slice(3).trim();
    // A slug is a URL path segment. Anything with a slash or a space in it is not one, and putting
    // it in an href unchecked is how a stored value becomes a link to somewhere else.
    if (slug && /^[A-Za-z0-9\-_%.]+$/.test(slug)) return `https://www.linkedin.com/in/${slug}`;
  }
  return null;
}

/* ────────────────────────────── lean document → DTO ────────────────────────────── */

type MaybeDate = Date | string | null | undefined;

/**
 * The shape a `.lean()` Person arrives in, stated loosely on purpose.
 *
 * Every field is optional because a document written before a field existed genuinely lacks it, and
 * because this module may not import the Mongoose interface (see the header). The mapper below
 * supplies the same defaults the schema does, so a pre-spine row renders rather than throwing.
 */
export interface LeanPerson {
  _id: unknown;
  displayName?: string | null;
  company?: string | null;
  role?: string | null;
  headline?: string | null;
  overrides?: { displayName?: string | null; company?: string | null; role?: string | null } | null;
  contactKeys?: string[] | null;
  tags?: string[] | null;
  ownTags?: string[] | null;
  companies?: string[] | null;
  isTargetCompany?: boolean | null;
  lastInteractionAt?: MaybeDate;
  nextActionAt?: MaybeDate;
  eventCount?: number | null;
  interactionCount?: number | null;
  mergedInto?: unknown;
  createdAt?: MaybeDate;
  updatedAt?: MaybeDate;
}

/** ISO string, or null. Never `Invalid Date` and never a `Date` — the DTO is JSON. */
function iso(value: MaybeDate): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function personToDTO(person: LeanPerson): PersonDTO {
  const contactKeys = person.contactKeys ?? [];
  return {
    _id: String(person._id),
    // `displayName` is `required` in the schema, so a blank here means a document from before the
    // spine. Naming it honestly beats an empty heading with no explanation.
    displayName: person.displayName || 'Unnamed',
    company: person.company ?? null,
    role: person.role ?? null,
    headline: person.headline ?? null,
    overrides: {
      displayName: person.overrides?.displayName ?? null,
      company: person.overrides?.company ?? null,
      role: person.overrides?.role ?? null,
    },
    contactKeys,
    tags: person.tags ?? [],
    ownTags: person.ownTags ?? [],
    companies: person.companies ?? [],
    isTargetCompany: Boolean(person.isTargetCompany),
    lastInteractionAt: iso(person.lastInteractionAt),
    nextActionAt: iso(person.nextActionAt),
    eventCount: person.eventCount ?? 0,
    interactionCount: person.interactionCount ?? 0,
    mergedInto: person.mergedInto ? String(person.mergedInto) : null,
    createdAt: iso(person.createdAt) ?? '',
    updatedAt: iso(person.updatedAt) ?? '',
    linkedin: linkedinUrlFromKeys(contactKeys),
  };
}

/** The subset the merge compare sheet needs. Same source, so the two sides cannot disagree. */
export function personToMergeCandidate(person: LeanPerson): MergeCandidate {
  const dto = personToDTO(person);
  return {
    _id: dto._id,
    displayName: dto.displayName,
    company: dto.company,
    role: dto.role,
    headline: dto.headline,
    eventCount: dto.eventCount,
    interactionCount: dto.interactionCount,
    lastInteractionAt: dto.lastInteractionAt,
    contactKeys: dto.contactKeys,
  };
}

/** "Staff Engineer · Razorpay", or an honest blank. */
export function personSubtitle(person: {
  role?: string | null;
  headline?: string | null;
  company?: string | null;
}): string {
  return [person.role || person.headline, person.company].filter(Boolean).join(' · ');
}

/**
 * The identity line for a person CARD, where a registry company chip is rendered right below it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT JUST `personSubtitle`. The card shows "Staff Engineer · Razorpay" and then, two
 * lines down, a chip reading "Razorpay". That is the same word twice in one card — and the chip is not
 * removable, because it is the filter affordance and the only thing that says the REGISTRY recognised
 * that employer. So the duplicate has to come out of the prose instead.
 *
 * IT DROPS THE COMPANY ONLY ON AN EXACT (case- and space-insensitive) MATCH. `Person.company` is
 * whatever the newest capture recorded — "Razorpay Software Private Limited" — while `companies[]`
 * holds canonical registry names, so the two frequently differ and BOTH are then worth showing. A
 * fuzzy match here would be the wrong kind of clever: it would delete a real employer string on the
 * strength of a prefix, and the failure is silent, which is why this is pinned in
 * `tests/people-api-shape.test.ts` rather than left inline in the component.
 *
 * A COMMA, NOT A MIDDLE DOT. `docs/design-direction.md` names middle-dot meta strings as a pattern to
 * ration, and the rule it gives is "keep at most one per surface, where the sequence genuinely is a
 * list of equals". A role and an employer are not equals — one modifies the other — so this is prose
 * and takes prose punctuation. The card spends its one dot string on the encounter line, where place
 * and date really are two facts of the same rank.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 */
export function personIdentityLine(
  person: { role?: string | null; headline?: string | null; company?: string | null },
  chippedCompanies: readonly string[] = []
): string {
  const fold = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');
  const company = (person.company ?? '').trim();
  const alreadyChipped =
    Boolean(company) && chippedCompanies.some(name => fold(name) === fold(company));
  return [person.role || person.headline, alreadyChipped ? '' : company]
    .map(part => (part ?? '').trim())
    .filter(Boolean)
    .join(', ');
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
   REQUEST VALIDATION — pure, so `tests/` pins it with no database and no server
   ══════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * The result shape every validator here returns.
 *
 * `field` exists so the 400 can NAME what was wrong. The tracker write paths are the cautionary
 * tale: they handed the raw body to Mongoose, so a bad `status` came back as a **500** carrying
 * `TrackerEntry validation failed: status: ...` — a 5xx telling a client to retry something that can
 * never work, with the model name and schema path attached as free reconnaissance.
 */
export type Validated<T> = { ok: true; value: T } | { ok: false; error: string; field?: string };

function bad<T>(error: string, field?: string): Validated<T> {
  return field ? { ok: false, error, field } : { ok: false, error };
}

/**
 * A Mongo ObjectId as it appears in a URL or a body: exactly 24 hex characters.
 *
 * STRICTER THAN `mongoose.Types.ObjectId.isValid`, deliberately. That accepts any 12-character
 * string, so `'not-an-id!!!'` passes it and then becomes a *different* id via byte coercion — a
 * lookup that silently searches for something the caller never named. Every id this app hands out
 * is a 24-hex string, so nothing legitimate is refused.
 */
export function isObjectIdLike(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-fA-F]{24}$/.test(value);
}

/** Field caps, matching the schema so the API never refuses what the database would accept. */
export const MAX_OVERRIDE_LENGTH = 200;
export const MAX_NOTE_LENGTH = 4000;
export const MAX_OWN_TAGS = 20;
export const MAX_TAG_LENGTH = 40;

export interface PersonOverridesInput {
  displayName?: string;
  company?: string;
  role?: string;
}

/**
 * Everything one `PATCH /api/people/[id]` may do. All members optional; an empty patch is refused.
 *
 * Several members rather than one discriminated action, because the edit sheet legitimately saves a
 * name correction and a tag in one request, and splitting that into two round trips would let the
 * second fail after the first landed.
 */
export interface PersonPatch {
  /**
   * USER-SET values that beat the derived ones. An EMPTY STRING clears the override — it does not
   * pin an empty value. `derivePersonFields` reads a blank override as "no override" for exactly
   * this reason: pinning `''` would make a field no later capture could ever fill, which reads as
   * broken rather than cleared.
   */
  overrides?: PersonOverridesInput;
  /** Tags belonging to the HUMAN rather than to one encounter. Canonicalised server-side. */
  ownTags?: string[];
  /** APPENDS a `note` interaction. Never overwrites — see `PATCH`'s header. */
  note?: string;
  /**
   * `done` closes every outstanding reminder for this person; `set` schedules one.
   * The route explains why the asymmetry is right.
   */
  followUp?: { action: 'done' } | { action: 'set'; at: string };
  /** Records that the user actually reached out, which is what makes last-contacted honest. */
  messageSent?: true;
}

function optionalString(
  body: Record<string, unknown>,
  key: string,
  max: number
): Validated<string | undefined> {
  if (!(key in body) || body[key] === undefined || body[key] === null) {
    return { ok: true, value: undefined };
  }
  const raw = body[key];
  if (typeof raw !== 'string') return bad(`${key} must be text`, key);
  const trimmed = raw.trim();
  if (trimmed.length > max) return bad(`${key} must be ${max} characters or fewer`, key);
  return { ok: true, value: trimmed };
}

/**
 * The three user-settable fields, validated on their own.
 *
 * SHARED BY `PATCH /api/people/[id]` AND THE MERGE COMPARE, because "which name survives" must be
 * bounded by exactly the same rules as a name typed on the person page — two validators for one
 * concept is how a 200-character cap becomes a 400 on one path and a 500 on the other.
 *
 * It deliberately does NOT enforce "at least one field", and that is the seam. An EMPTY result is
 * legitimate on the merge path (nothing was contested, so nothing gets pinned) and illegitimate on the
 * patch path (a PATCH that changes nothing looks to the client exactly like one that worked). Folding
 * the emptiness rule in here refused `overrides: {}` on a merge — caught by
 * `tests/people-api-shape.test.ts`, which is why the rule lives with the caller that owns it.
 */
export function validateOverrides(input: unknown): Validated<PersonOverridesInput> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return bad('overrides must be an object', 'overrides');
  }
  const raw = input as Record<string, unknown>;
  const overrides: PersonOverridesInput = {};

  for (const key of ['displayName', 'company', 'role'] as const) {
    if (!(key in raw) || raw[key] === undefined) continue;
    // `null` is a synonym for "clear this override": a form field that has never held a value sends
    // null just as readily as ''. Both mean "go back to what the captures say".
    if (raw[key] === null) {
      overrides[key] = '';
      continue;
    }
    if (typeof raw[key] !== 'string') return bad(`overrides.${key} must be text`, `overrides.${key}`);
    const trimmed = (raw[key] as string).trim();
    if (trimmed.length > MAX_OVERRIDE_LENGTH) {
      return bad(
        `overrides.${key} must be ${MAX_OVERRIDE_LENGTH} characters or fewer`,
        `overrides.${key}`
      );
    }
    overrides[key] = trimmed;
  }

  return { ok: true, value: overrides };
}

export function validatePersonPatch(input: unknown): Validated<PersonPatch> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    // A non-JSON body reaches the route as `{}` because `request.json()` throws and is caught, so
    // this is also the "malformed JSON" answer. Either way it is the caller's mistake: a 400.
    return bad('Expected a JSON object');
  }
  const body = input as Record<string, unknown>;
  const patch: PersonPatch = {};

  if ('overrides' in body && body.overrides !== undefined && body.overrides !== null) {
    const overrides = validateOverrides(body.overrides);
    if (!overrides.ok) return bad(overrides.error, overrides.field);
    // An overrides object with no RECOGNISED keys leaves the patch empty, and the empty-patch refusal
    // at the bottom then answers for it — a body of `{ overrides: { nickname: 'Ash' } }` is a caller
    // mistake, not a no-op.
    if (Object.keys(overrides.value).length) patch.overrides = overrides.value;
  }

  if ('ownTags' in body && body.ownTags !== undefined && body.ownTags !== null) {
    if (!Array.isArray(body.ownTags)) return bad('ownTags must be an array', 'ownTags');
    if (body.ownTags.length > MAX_OWN_TAGS) {
      return bad(`ownTags must have ${MAX_OWN_TAGS} entries or fewer`, 'ownTags');
    }
    const tags: string[] = [];
    for (const entry of body.ownTags) {
      if (typeof entry !== 'string') return bad('ownTags entries must be text', 'ownTags');
      const trimmed = entry.trim();
      if (trimmed.length > MAX_TAG_LENGTH) {
        return bad(`a tag must be ${MAX_TAG_LENGTH} characters or fewer`, 'ownTags');
      }
      // Blanks are dropped rather than refused: an empty chip in the editor is a user mid-typing,
      // not an error worth failing a save over. Canonicalisation server-side does the rest.
      if (trimmed) tags.push(trimmed);
    }
    // An empty array is a MEANINGFUL value here — it clears every own-tag — so it is kept rather
    // than treated as "field absent". That is why this assignment is unconditional.
    patch.ownTags = tags;
  }

  if ('note' in body && body.note !== undefined && body.note !== null) {
    const note = optionalString(body, 'note', MAX_NOTE_LENGTH);
    if (!note.ok) return note;
    // A blank note is refused rather than ignored: the timeline is append-only evidence, and an
    // empty row is a permanent entry that says nothing and cannot be deleted.
    if (!note.value) return bad('A note cannot be empty', 'note');
    patch.note = note.value;
  }

  if ('followUp' in body && body.followUp !== undefined && body.followUp !== null) {
    const raw = body.followUp;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return bad('followUp must be an object', 'followUp');
    }
    const followUp = raw as Record<string, unknown>;
    if (followUp.action === 'done') {
      patch.followUp = { action: 'done' };
    } else if (followUp.action === 'set') {
      if (typeof followUp.at !== 'string' || !followUp.at.trim()) {
        return bad('followUp.at is required when setting a follow-up', 'followUp.at');
      }
      const ms = Date.parse(followUp.at);
      if (Number.isNaN(ms)) return bad('followUp.at is not a date', 'followUp.at');
      // Normalised to an ISO string so the route never re-parses, and so a client sending
      // "2026-09-20T12:00:00+05:30" and one sending the same instant in Z are indistinguishable.
      patch.followUp = { action: 'set', at: new Date(ms).toISOString() };
    } else {
      return bad('followUp.action must be "done" or "set"', 'followUp.action');
    }
  }

  if ('messageSent' in body && body.messageSent !== undefined && body.messageSent !== null) {
    if (body.messageSent !== true) return bad('messageSent must be true', 'messageSent');
    patch.messageSent = true;
  }

  if (!Object.keys(patch).length) {
    // Not a no-op success. A PATCH the server silently ignored looks to the client exactly like one
    // it applied, which is how a typo'd field name becomes "the app is not saving my edits".
    return bad('Nothing to change');
  }

  return { ok: true, value: patch };
}

/**
 * How many people one bulk-tag request may touch.
 *
 * A real cap, not a formality: the route loads every matched person and their captures to recompute
 * the derived `tags` field, so an unbounded list is an unbounded read. 200 is comfortably more than a
 * conference's worth of scans, which is the use case — coming back with forty people and tagging them
 * one edit sheet at a time is forty sheets, and that is the difference between a feature and a demo.
 */
export const MAX_BULK_PEOPLE = 200;

/** Tags per bulk request. Matches `MAX_TAGS_PER_CONTACT`, which caps what canonicalisation emits. */
export const MAX_BULK_TAGS = 20;

export interface TagBulkRequest {
  personIds: string[];
  /** Added to each person's `ownTags`. Canonicalised SERVER-SIDE — see the note below. */
  add: string[];
  /** Removed from each person's `ownTags`. A tag a CAPTURE also carries is untouched. */
  remove: string[];
}

/**
 * Validate a bulk-tag request.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * CANONICALISATION IS NOT DONE HERE, AND THAT IS DELIBERATE. `canonicaliseTags()` lives in
 * `lib/contacts/service.ts`, which imports mongoose, so it cannot be reached from this client-safe
 * module — and duplicating it would be worse than the import problem it avoids. A tag is a FACET KEY:
 * a second lowercaser is precisely how `"AI/ML"` and `"ai/ml"` become two chips for one idea, silently
 * splitting a cohort in half with nothing on screen to suggest it. So this validator checks SHAPE and
 * the route canonicalises through the one definition every other write path uses.
 *
 * IDS ARE VALIDATED FOR SHAPE ONLY. Ownership is not this function's job and must not look like it is:
 * the route filters `{ _id: { $in: ids }, userId }`, so a foreign id in the list cannot widen the
 * write — it simply does not match. Checking ownership here would put a database read inside a pure
 * function and, worse, would invite a route to trust the verdict instead of scoping its own query.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 */
export function validateTagBulk(input: unknown): Validated<TagBulkRequest> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return bad('Expected a JSON object');
  }
  const body = input as Record<string, unknown>;

  if (!Array.isArray(body.personIds)) return bad('personIds must be an array', 'personIds');
  if (!body.personIds.length) return bad('Select at least one person', 'personIds');
  if (body.personIds.length > MAX_BULK_PEOPLE) {
    return bad(`Tag at most ${MAX_BULK_PEOPLE} people at a time`, 'personIds');
  }

  const personIds: string[] = [];
  const seen = new Set<string>();
  for (const raw of body.personIds) {
    // A malformed id is REFUSED, not skipped. Skipping would answer 200 for a request that tagged
    // fewer people than it named, and the caller would have no way to tell which.
    if (!isObjectIdLike(raw)) return bad('personIds must all be ids', 'personIds');
    if (seen.has(raw)) continue;
    seen.add(raw);
    personIds.push(raw);
  }

  const tagList = (key: 'add' | 'remove'): Validated<string[]> => {
    const raw = body[key];
    if (raw === undefined || raw === null) return { ok: true, value: [] };
    if (!Array.isArray(raw)) return bad(`${key} must be an array`, key);
    if (raw.length > MAX_BULK_TAGS) {
      return bad(`${key} must have ${MAX_BULK_TAGS} entries or fewer`, key);
    }
    const out: string[] = [];
    for (const entry of raw) {
      if (typeof entry !== 'string') return bad(`${key} entries must be text`, key);
      const trimmed = entry.trim();
      if (trimmed.length > MAX_TAG_LENGTH) {
        return bad(`a tag must be ${MAX_TAG_LENGTH} characters or fewer`, key);
      }
      // Blanks dropped rather than refused: an empty chip is somebody mid-typing, not an error worth
      // failing a batch of forty people over.
      if (trimmed) out.push(trimmed);
    }
    return { ok: true, value: out };
  };

  const add = tagList('add');
  if (!add.ok) return add;
  const remove = tagList('remove');
  if (!remove.ok) return remove;

  if (!add.value.length && !remove.value.length) {
    // Not a no-op success. A request that changes nothing but answers 200 is indistinguishable from
    // one that worked, which is how a typo'd field becomes "bulk tagging is broken".
    return bad('Nothing to add or remove', 'add');
  }

  return { ok: true, value: { personIds, add: add.value, remove: remove.value } };
}

/**
 * `POST /api/people/merge` does three things, so the body is a discriminated union.
 *
 * They belong on one route because they are one decision reversed and re-decided: merge these two,
 * no they are different people, undo that merge. Three routes would mean three guards and three
 * validators for one user-facing choice.
 */
export type MergeRequest =
  | { action: 'merge'; loserId: string; winnerId: string; overrides?: PersonOverridesInput }
  | { action: 'dismiss'; personId: string; otherId: string }
  | { action: 'unmerge'; loserId: string };

export function validateMergeRequest(input: unknown): Validated<MergeRequest> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return bad('Expected a JSON object');
  }
  const body = input as Record<string, unknown>;
  const action = body.action;

  if (action === 'merge') {
    if (!isObjectIdLike(body.winnerId)) return bad('winnerId must be an id', 'winnerId');
    if (!isObjectIdLike(body.loserId)) return bad('loserId must be an id', 'loserId');
    // `mergePersons` returns null for this, which the route would have to translate into something.
    // Refusing it here means the 400 names the problem instead of a 404 implying one of them is gone.
    if (body.winnerId === body.loserId) return bad('Cannot merge a person into themselves', 'loserId');

    const request: MergeRequest = {
      action: 'merge',
      loserId: body.loserId,
      winnerId: body.winnerId,
    };

    /**
     * PER-FIELD WINNING VALUES ARE STORED AS `overrides`, NOT WRITTEN OVER THE DERIVED FIELDS.
     *
     * The compare sheet asks the user to pick a name, a company and a role. Writing those straight
     * onto `Person.displayName` would be undone by the very next `recomputePerson()` — which runs on
     * every note, every follow-up and every new scan — because derivation re-reads the contacts.
     * An override is the only place a human decision survives a recompute.
     */
    if (body.overrides !== undefined && body.overrides !== null) {
      const overrides = validateOverrides(body.overrides);
      if (!overrides.ok) return bad(overrides.error, overrides.field);
      // Absent rather than an empty object when nothing was contested, so the route can skip the
      // override write entirely and leave derivation free to keep improving the record.
      if (Object.keys(overrides.value).length) request.overrides = overrides.value;
    }

    return { ok: true, value: request };
  }

  if (action === 'dismiss') {
    if (!isObjectIdLike(body.personId)) return bad('personId must be an id', 'personId');
    if (!isObjectIdLike(body.otherId)) return bad('otherId must be an id', 'otherId');
    if (body.personId === body.otherId) return bad('A person is not their own duplicate', 'otherId');
    return { ok: true, value: { action: 'dismiss', personId: body.personId, otherId: body.otherId } };
  }

  if (action === 'unmerge') {
    if (!isObjectIdLike(body.loserId)) return bad('loserId must be an id', 'loserId');
    return { ok: true, value: { action: 'unmerge', loserId: body.loserId } };
  }

  return bad('action must be "merge", "dismiss" or "unmerge"', 'action');
}
