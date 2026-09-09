/**
 * The people spine: resolve a capture onto a human, append to that human's timeline, keep the
 * denormalised counters honest, and merge two humans without destroying either.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * MODULE BOUNDARY, AND WHY THE IMPORT ARROW POINTS THE WAY IT DOES.
 *
 * The design rule is "`lib/contacts/service.ts` calls into `lib/people/service.ts`, one direction
 * only", and the module graph must be ACYCLIC. Those two requirements pull against each other,
 * because the derivation rules mandate reusing `matchesTargetCompany()` / `deriveContactMeta()` /
 * `canonicaliseTags()` from the contacts service — "must not be recomputed independently, or the
 * person page and the contact row can disagree".
 *
 * Resolved by making the STATIC edge point people → contacts (pure helpers only) and the RUNTIME
 * call point contacts → people through a lazy `await import()` inside `upsertContact`. So:
 *
 *   · the static graph has exactly one edge and no cycle;
 *   · this module is importable on its own, which is what the backfill and diag scripts need;
 *   · the write-path call still reads contacts → people, as the spec draws it.
 *
 * Do NOT "tidy" that lazy import into a top-level one. It closes the cycle.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * The first half of this file is PURE — plain data in, plain data out, no Mongoose — because that is
 * where every derivation rule that must not drift lives, and each of those rules has a
 * wrong-but-plausible reading that fails silently. `tests/person-derivation.test.ts` pins them
 * without a database, the same arrangement `canonicaliseTags` has in `tests/contact-tags.test.ts`.
 */
import mongoose from 'mongoose';
import connectDB from '../mongodb';
import Person, { IPerson, PersonOverrides } from '../models/Person';
import Interaction, { IInteraction, InteractionKind } from '../models/Interaction';
import Contact from '../models/Contact';
import {
  canonicaliseTags,
  deriveContactMeta,
  getTargetCompanies,
} from '../contacts/service';

export { connectDB };

type IdLike = mongoose.Types.ObjectId | string;

/* ══════════════════════════════════════════════════════════════════════════════════════════════
   PURE — the derivation rules
   ══════════════════════════════════════════════════════════════════════════════════════════════ */

/** Everything a `Contact` contributes to its `Person`. A plain shape, so tests need no database. */
export interface PersonContactFacts {
  scannedAt: Date;
  name?: string | null;
  company?: string | null;
  role?: string | null;
  headline?: string | null;
  followUpAt?: Date | null;
  followedUp?: boolean | null;
  tags?: string[] | null;
}

/** Everything an `Interaction` contributes. `eventId` is deliberately loose — see `sameEvent`. */
export interface PersonInteractionFacts {
  at: Date;
  eventId?: IdLike | null;
}

export interface DerivedPersonFields {
  displayName?: string;
  company?: string;
  role?: string;
  headline?: string;
}

/** Trimmed value, or undefined when there is nothing usable. Blank is ABSENT, never an answer. */
function value(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined;
  const trimmed = input.trim();
  return trimmed ? trimmed : undefined;
}

function time(input: Date | string | null | undefined): number {
  if (!input) return 0;
  const ms = input instanceof Date ? input.getTime() : new Date(input).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * The person's displayed fields: NEWEST ENCOUNTER WINS, PER FIELD — then user overrides on top.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * PER FIELD, NOT PER ROW. This is the rule with the plausible wrong reading, and the wrong reading
 * loses data. "Newest wins" read as "take the newest row" makes the company go EMPTY the moment
 * somebody is scanned from a LinkedIn QR — which carries a vanity slug and no employer — so a
 * capture that told you nothing new would erase an employer you already knew. Falling back per field
 * to the newest encounter that HAD a value for that field costs nothing and cannot lose anything.
 *
 * OVERRIDES ARE RE-APPLIED HERE, INSIDE THE DERIVATION, not once at the moment the user types them.
 * A recompute runs on every new encounter, every note and every follow-up; applying the override
 * anywhere else means the next scan silently reverts the user's correction, with nothing on screen
 * to say which of the two values is being shown. A BLANK override is "no override", not "force this
 * field empty" — otherwise clearing the input would pin an empty string that no later capture could
 * ever fill, which reads as the field being broken rather than cleared.
 *
 * The returned object is the EFFECTIVE value and is what gets stored on `Person`, so sorting by name,
 * filtering by company and free-text search all agree with what is rendered. Storing the raw derived
 * value instead would make a corrected name unfindable by the corrected spelling.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * Order-independent: the caller may hand these over in any order. Ties on `scannedAt` keep input
 * order, which is arbitrary but stable, and a tie means two captures at the same instant — there is
 * no better answer available.
 */
export function derivePersonFields(
  contacts: readonly PersonContactFacts[],
  overrides: PersonOverrides = {}
): DerivedPersonFields {
  const newestFirst = [...contacts].sort((a, b) => time(b.scannedAt) - time(a.scannedAt));

  const newest = (pick: (contact: PersonContactFacts) => unknown): string | undefined => {
    for (const contact of newestFirst) {
      const found = value(pick(contact));
      if (found) return found;
    }
    return undefined;
  };

  const out: DerivedPersonFields = {};

  // `overrides` first at each field, so the user's answer wins without the derivation having to know
  // it was overridden.
  const displayName = value(overrides.displayName) ?? newest(c => c.name);
  const company = value(overrides.company) ?? newest(c => c.company);
  const role = value(overrides.role) ?? newest(c => c.role);
  // No override for `headline` — it is a self-description, not a field a third party corrects.
  const headline = newest(c => c.headline);

  if (displayName) out.displayName = displayName;
  if (company) out.company = company;
  if (role) out.role = role;
  if (headline) out.headline = headline;

  return out;
}

export interface DerivedPersonCounters {
  eventCount: number;
  interactionCount: number;
  lastInteractionAt: Date | null;
}

/**
 * The two counters and the last-contacted date.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * `eventCount` IS THE NUMBER OF DISTINCT `eventId`s. Not the number of `met` rows, and not the number
 * of folders. `detectRepeatConnections` already carries this bug's scar — it identified the encounter
 * by the FOLDER, so two folders for one event read as two events — and `met N x` has to mean N
 * distinct events or the badge is a lie, and a flattering one: it inflates every number on the page.
 *
 * Nulls are IGNORED rather than counted. A note, a sent message and an off-event capture all carry no
 * `eventId`; they are real interactions and must raise `interactionCount`, but counting a null as an
 * event would make somebody you have only emailed read as somebody you met.
 *
 * `lastInteractionAt` IS `max(at)` ACROSS EVERY KIND — never `Contact.scannedAt`. That substitution
 * is today's defect stated exactly: capture time is not last-contact time, and a note written in
 * September about somebody scanned in January means the last contact was September. This is the
 * whole reason the timeline exists, and the reason `completeContactFollowUp()` flipping a boolean
 * with no timestamp was not good enough.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 */
export function derivePersonCounters(
  interactions: readonly PersonInteractionFacts[]
): DerivedPersonCounters {
  const events = new Set<string>();
  let latest = 0;

  for (const row of interactions) {
    // Compared by STRING form, so an ObjectId from a `.find()` and the same id as a string from a
    // lean read or a script argument agree. Comparing the raw values would count one event twice.
    if (row.eventId !== null && row.eventId !== undefined) {
      const id = String(row.eventId);
      if (id) events.add(id);
    }
    const at = time(row.at);
    if (at > latest) latest = at;
  }

  return {
    eventCount: events.size,
    interactionCount: interactions.length,
    lastInteractionAt: latest ? new Date(latest) : null,
  };
}

/**
 * The SOONEST OUTSTANDING follow-up across the person's encounters, or null.
 *
 * Follow-ups are per-ENCOUNTER, so somebody met three times can carry three dates while the person
 * card shows one. The soonest outstanding one is the actionable one; the others are not lost, they
 * are simply not what to do next. (The person page writes follow-ups through the MOST RECENT contact
 * so there is one obvious place they land. Moving `followUpAt` onto `Person` is a later, easy change
 * and premature now.)
 *
 * A missing `followedUp` counts as NOT done, matching the schema default — the alternative would make
 * every row written before that field existed look permanently complete.
 */
export function deriveNextActionAt(contacts: readonly PersonContactFacts[]): Date | null {
  let soonest = 0;

  for (const contact of contacts) {
    if (contact.followedUp === true) continue;
    const at = time(contact.followUpAt);
    if (!at) continue;
    if (!soonest || at < soonest) soonest = at;
  }

  return soonest ? new Date(soonest) : null;
}

/**
 * The person's tags: RECOMPUTED FROM SCRATCH, never unioned with the previous value.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * UNION IS FOREVER, and this repo has already made and reversed exactly this mistake: "`Event.companies`
 * is RECOMPUTED at ingest, not unioned — and that had to change… True at the moment of writing; union
 * is forever." Unioned here, removing a tag from a contact would leave it on the person permanently
 * with no UI able to clear it — the same shape as a bad category that re-scraping can never remove.
 *
 * `ownTags` are the tags added directly on the PERSON and are stored in their own field precisely so
 * that a contact-driven recompute cannot erase them. A tag that belongs to the human rather than to
 * one encounter has nowhere else to live, and folding it into `tags` would make it collateral damage
 * of the next recompute.
 *
 * Canonicalised through the SAME `canonicaliseTags()` every contact write path uses, because a tag is
 * a FACET KEY: `"AI/ML"` and `"ai/ml"` are not untidiness, they are two chips for one idea that split
 * a person's cohort in half with nothing on screen to suggest it.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 */
export function derivePersonTags(
  contacts: readonly PersonContactFacts[],
  ownTags: readonly string[] = []
): string[] {
  const all: string[] = [];
  for (const contact of contacts) {
    if (Array.isArray(contact.tags)) all.push(...contact.tags);
  }
  all.push(...ownTags);
  return canonicaliseTags(all);
}

/** The seed values a brand-new `Person` is created with. Everything else is recomputed immediately. */
export interface PersonSeed {
  displayName?: string;
  company?: string;
  role?: string;
  headline?: string;
}

/**
 * The name a person gets when the seed supplies none.
 *
 * Only reachable from a hand-built call: `Contact.name` is `required`, so the capture path always
 * has one. It exists because `Person.displayName` is `required` too, and an insert that fails
 * validation on the identity plumbing would take a real capture down with it.
 */
export const UNNAMED_PERSON = 'Unnamed';

export interface PersonUpsertSpec {
  filter: Record<string, unknown>;
  update: Record<string, unknown>;
  options: Record<string, unknown>;
}

/**
 * The atomic create, built as data so it can be asserted without a database.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE RACE: two devices draining the outbox at once both resolve the same new `contactKey`, both find
 * no person, and both insert. `contactKeys` is an ARRAY, so it cannot carry a unique index — an upsert
 * is the only atomic answer available.
 *
 * THE TRAP, and the reason this is a pure function with a test rather than an inline call: an equality
 * filter on an array field (`{ contactKeys: 'li:asha' }`) makes Mongo synthesise that field on insert
 * as a SCALAR — `contactKeys: 'li:asha'` — not a one-element array. Every later `$addToSet` then
 * behaves differently and the document shape is quietly corrupt. Naming the field explicitly in
 * `$setOnInsert` is what prevents it, and `tests/person-derivation.test.ts` asserts the built document
 * so a refactor cannot drop it.
 *
 * `$setOnInsert` ONLY, never `$set`. If it also `$set` a value, the loser of a race would overwrite
 * the winner's row with its own single-encounter view. Losing the race must be harmless.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 */
export function personUpsertSpec(
  userId: string,
  contactKey: string,
  seed: PersonSeed = {}
): PersonUpsertSpec {
  const insert: Record<string, unknown> = {
    userId,
    // AN ARRAY. See above — this single line is the whole guard.
    contactKeys: [contactKey],
    displayName: value(seed.displayName) ?? UNNAMED_PERSON,
  };
  const company = value(seed.company);
  const role = value(seed.role);
  const headline = value(seed.headline);
  if (company) insert.company = company;
  if (role) insert.role = role;
  if (headline) insert.headline = headline;

  return {
    filter: { userId, contactKeys: contactKey },
    update: { $setOnInsert: insert },
    options: { upsert: true, new: true, setDefaultsOnInsert: true },
  };
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
   MONGOOSE — resolve, record, recompute, merge, lifecycle
   ══════════════════════════════════════════════════════════════════════════════════════════════ */

/** Chain depth cap. A tombstone chain longer than this is corruption, not a deep merge history. */
const MAX_TOMBSTONE_HOPS = 10;

/**
 * Follow `mergedInto` to the surviving person.
 *
 * A merge leaves the loser in place as a soft tombstone so old URLs still resolve, which means a
 * stored `Contact.personId` or a stored `contactKey` can legitimately point at a merged-away row.
 * Following the chain rather than treating that as a miss is what stops a later capture re-creating
 * the person that was just merged.
 */
async function followTombstone(person: IPerson): Promise<IPerson> {
  let current = person;
  for (let hop = 0; hop < MAX_TOMBSTONE_HOPS; hop++) {
    if (!current.mergedInto) return current;
    const next = await Person.findOne({ _id: current.mergedInto, userId: current.userId });
    if (!next) return current; // Dangling tombstone — the tombstone itself is the best answer left.
    current = next;
  }
  return current;
}

/** A merge SUGGESTION. Never acted on automatically — see `resolvePerson`. */
export interface MergeSuggestion {
  /** The person the incoming key already belongs to. */
  personId: string;
  displayName: string;
  contactKey: string;
}

export interface ResolvePersonResult {
  person: IPerson;
  created: boolean;
  /** Non-null when a DIFFERENT person already holds the incoming key. Nothing was merged. */
  suggestion: MergeSuggestion | null;
}

/** Just the fields the resolver reads. Accepts a hydrated doc or a lean object. */
export interface ResolvableContact {
  _id?: IdLike;
  contactKey?: string | null;
  personId?: IdLike | null;
  name?: string | null;
  company?: string | null;
  role?: string | null;
  headline?: string | null;
}

/**
 * Attach a capture to the human it is about, creating that human when nobody holds its key.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * A KEY COLLISION NEVER AUTO-MERGES, and that is the most important line in this function.
 *
 * `contactKey` is a POINTER that gets recomputed, so the interesting case is an UPGRADE: a contact
 * stored as `nm:asha rao` gains a LinkedIn slug and becomes `li:asha-rao-123`. If nobody holds the
 * new key, it is appended to the person the contact is already attached to — the person keeps their
 * notes, timeline and follow-ups, which is exactly what keying `Person` on the string would have
 * destroyed.
 *
 * If a DIFFERENT person already holds it, that is two humans who may or may not be one, and the
 * asymmetry decides it: a wrong merge destroys the distinction between two real people and is very
 * hard to unwind once notes and follow-ups interleave, while an un-merged duplicate is merely untidy.
 * So a collision returns a SUGGESTION and changes nothing — and a pair already in `notSamePersonAs`
 * returns no suggestion at all, because a dismissal that comes back is worse than no suggestion.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * `personId` is assigned by THIS function and never by a client. It is deliberately absent from
 * `pickWritable`'s allowlist: that function is the trust boundary for every contact write path, and a
 * client able to set `personId` could attach its capture to any person id it guessed.
 */
export async function resolvePerson(
  userId: string,
  contact: ResolvableContact
): Promise<ResolvePersonResult> {
  const key = value(contact.contactKey) ?? '';

  const seed: PersonSeed = {
    displayName: contact.name ?? undefined,
    company: contact.company ?? undefined,
    role: contact.role ?? undefined,
    headline: contact.headline ?? undefined,
  };

  // 1. Whoever this capture is already attached to, following any merge that happened since.
  let current: IPerson | null = contact.personId
    ? await Person.findOne({ _id: contact.personId, userId })
    : null;
  if (current) current = await followTombstone(current);

  // 2. Whoever holds the incoming key. Tombstones are INCLUDED here on purpose: a merged loser's
  //    keys stay on the loser, so ignoring tombstones would route the next capture to a brand-new
  //    person and silently undo the merge.
  let byKey: IPerson | null = key
    ? await Person.findOne({ userId, contactKeys: key })
    : null;
  if (byKey) byKey = await followTombstone(byKey);

  if (current) {
    if (byKey && !sameId(byKey._id, current._id)) {
      return { person: current, created: false, suggestion: suggestionFor(current, byKey, key) };
    }
    if (key && !current.contactKeys.includes(key)) {
      current.contactKeys.push(key);
      await current.save();
    }
    return { person: current, created: false, suggestion: null };
  }

  if (byKey) return { person: byKey, created: false, suggestion: null };

  /**
   * 3. Nobody holds it. Create — atomically, because step 2 and this are not one operation and two
   *    drains can be between them at the same instant.
   *
   *    A keyless contact cannot be looked up again, so it gets its own person. That is the
   *    pre-spine state rather than a regression: `Contact.contactKey` is `required`, so this is only
   *    reachable for a document written before that field existed. Failing the capture over it would
   *    be strictly worse.
   */
  if (!key) {
    const person = await Person.create({
      userId,
      contactKeys: [],
      displayName: value(seed.displayName) ?? UNNAMED_PERSON,
      ...(value(seed.company) ? { company: value(seed.company) } : {}),
      ...(value(seed.role) ? { role: value(seed.role) } : {}),
      ...(value(seed.headline) ? { headline: value(seed.headline) } : {}),
    });
    return { person, created: true, suggestion: null };
  }

  const spec = personUpsertSpec(userId, key, seed);
  const result = await Person.findOneAndUpdate(spec.filter, spec.update, {
    ...spec.options,
    // Mongoose 9: this is how you learn whether the upsert INSERTED or matched an existing row.
    // Without it the two are indistinguishable and `created` becomes a guess.
    includeResultMetadata: true,
  });

  const person = result?.value as IPerson | null;
  if (!person) {
    // Cannot happen with `upsert: true` and `new: true`, but a silent null here would surface far
    // away as "contact saved with no person", so it fails loudly at the cause.
    throw new Error(`resolvePerson: upsert returned no document for key ${key}`);
  }

  return {
    person,
    created: Boolean(result?.lastErrorObject?.upserted),
    suggestion: null,
  };
}

function sameId(a: IdLike | null | undefined, b: IdLike | null | undefined): boolean {
  return Boolean(a && b && String(a) === String(b));
}

/** A suggestion, unless this exact pair has already been dismissed — in either direction. */
function suggestionFor(
  current: IPerson,
  other: IPerson,
  contactKey: string
): MergeSuggestion | null {
  const dismissed =
    current.notSamePersonAs?.some(id => sameId(id, other._id as IdLike)) ||
    other.notSamePersonAs?.some(id => sameId(id, current._id as IdLike));
  if (dismissed) return null;

  return {
    personId: String(other._id),
    displayName: other.displayName,
    contactKey,
  };
}

/** Every live person who shares a `contactKey` with this one, minus the dismissed pairs. */
export async function mergeSuggestionsFor(
  userId: string,
  personId: IdLike
): Promise<MergeSuggestion[]> {
  const person = await Person.findOne({ _id: personId, userId });
  if (!person || !person.contactKeys.length) return [];

  const others = await Person.find({
    userId,
    _id: { $ne: person._id },
    mergedInto: null,
    contactKeys: { $in: person.contactKeys },
  });

  return others
    .map(other => {
      const shared = other.contactKeys.find(key => person.contactKeys.includes(key)) ?? '';
      return suggestionFor(person, other, shared);
    })
    .filter((s): s is MergeSuggestion => s !== null);
}

/**
 * Remember that these two are NOT the same human.
 *
 * Recorded on BOTH rows so the suggestion cannot come back from the other direction — a dismissal
 * that reappears is worse than never having suggested it, because the user has to re-decide something
 * they already decided and cannot tell whether their answer was recorded.
 */
export async function dismissMergeSuggestion(
  userId: string,
  personId: IdLike,
  otherId: IdLike
): Promise<void> {
  if (sameId(personId, otherId)) return;
  await Person.updateOne(
    { _id: personId, userId },
    { $addToSet: { notSamePersonAs: new mongoose.Types.ObjectId(String(otherId)) } }
  );
  await Person.updateOne(
    { _id: otherId, userId },
    { $addToSet: { notSamePersonAs: new mongoose.Types.ObjectId(String(personId)) } }
  );
}

export interface RecordInteractionInput {
  personId: IdLike;
  kind: InteractionKind;
  /** WHEN IT HAPPENED, not when the row was written. A backfilled `met` carries the scan time. */
  at?: Date;
  eventId?: IdLike | null;
  contactId?: IdLike | null;
  note?: string;
}

/**
 * Append to a person's timeline, and keep their counters in step.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * IDEMPOTENT FOR `met`, AND THE DATABASE IS WHAT MAKES IT SO. `POST /api/contacts` answers a replayed
 * `clientId` with 200 and the existing document — the contract that stops a retried scan on bad
 * conference wifi duplicating anybody. A naive create on that path appends a SECOND `met` row and a
 * person met once reads "met 2 x". The partial unique index on `{ userId, contactId }` filtered to
 * `kind: 'met'` refuses it, and this catches the resulting duplicate-key error and returns the row
 * that already exists — so the replay is a no-op rather than an error the caller has to interpret.
 *
 * Enforcing it in the index rather than by checking first matters because there are already four
 * write paths (scan, sync drain, intake, backfill) and each new one would otherwise have to remember.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * `recompute: false` is for BULK callers only — the backfill, and `mergePersons`, both of which
 * recompute once at the end instead of once per row. Everything on a request path should let it
 * recompute, or `lastInteractionAt` is stale exactly when the user is looking at it.
 */
export async function recordInteraction(
  userId: string,
  input: RecordInteractionInput,
  options: { recompute?: boolean } = {}
): Promise<IInteraction> {
  const doc = {
    userId,
    personId: new mongoose.Types.ObjectId(String(input.personId)),
    kind: input.kind,
    at: input.at ?? new Date(),
    eventId: input.eventId ? new mongoose.Types.ObjectId(String(input.eventId)) : null,
    contactId: input.contactId ? new mongoose.Types.ObjectId(String(input.contactId)) : null,
    ...(input.note ? { note: input.note } : {}),
  };

  let interaction: IInteraction;
  try {
    interaction = await Interaction.create(doc);
  } catch (err) {
    const duplicate = (err as { code?: number }).code === 11000;
    if (!duplicate) throw err;

    // The replay case. The index guarantees there is exactly one, and it is the older truth — the
    // same reasoning that stops `upsertContact` overwriting a replayed contact.
    const existing = await Interaction.findOne({
      userId,
      contactId: doc.contactId,
      kind: 'met',
    });
    if (!existing) throw err; // A duplicate on some other index — do not swallow it.
    return existing;
  }

  if (options.recompute !== false) await recomputePerson(userId, input.personId);
  return interaction;
}

/**
 * Recompute every derived and denormalised field on a person, from the encounters and the timeline.
 *
 * DENORMALISED COUNTERS DRIFT — hence a recompute function plus a backfill script plus a diagnostic,
 * following the `connectionScore` precedent rather than trusting increments. An incremented counter
 * is wrong forever after one lost write; a recomputed one is wrong until the next recompute.
 *
 * Assigning `undefined` to `company` / `role` / `headline` is deliberate: Mongoose unsets the path, so
 * a value whose last remaining source was just deleted actually disappears. `displayName` is
 * `required`, so it is only ever REPLACED — never blanked — because a person whose last contact was
 * deleted is about to be deleted too and must stay valid until then.
 */
export async function recomputePerson(
  userId: string,
  personId: IdLike
): Promise<IPerson | null> {
  const person = await Person.findOne({ _id: personId, userId });
  if (!person) return null;

  const [contacts, interactions] = await Promise.all([
    Contact.find({ userId, personId: person._id })
      .select('name company role headline followUpAt followedUp tags scannedAt')
      .lean(),
    Interaction.find({ userId, personId: person._id }).select('at eventId').lean(),
  ]);

  const facts: PersonContactFacts[] = contacts.map(c => ({
    scannedAt: c.scannedAt as Date,
    name: c.name,
    company: c.company,
    role: c.role,
    headline: c.headline,
    followUpAt: c.followUpAt,
    followedUp: c.followedUp,
    tags: c.tags,
  }));

  const derived = derivePersonFields(facts, person.overrides ?? {});
  const counters = derivePersonCounters(
    interactions.map(i => ({ at: i.at as Date, eventId: i.eventId }))
  );

  if (derived.displayName) person.displayName = derived.displayName;
  person.company = derived.company;
  person.role = derived.role;
  person.headline = derived.headline;

  person.tags = derivePersonTags(facts, person.ownTags ?? []);
  person.lastInteractionAt = counters.lastInteractionAt;
  person.nextActionAt = deriveNextActionAt(facts);
  person.eventCount = counters.eventCount;
  person.interactionCount = counters.interactionCount;

  /**
   * `companies` and `isTargetCompany` come from `deriveContactMeta()` — the SAME function the contact
   * write path and `backfill-contact-companies.ts` use. Recomputing them independently here is
   * exactly how the person page and the contact row end up disagreeing about who somebody works for.
   *
   * `tags` is passed as null, following that function's own warning: a tag match scores 60 with no
   * `strength` gate, above the title branch's gated 50, so forwarding a user's private label would
   * file a hardware engineer tagged `embedded, arm` under the company Arm.
   */
  const targets = await getTargetCompanies(userId);
  const meta = deriveContactMeta(
    {
      company: person.company ?? null,
      role: person.role ?? null,
      headline: person.headline ?? null,
      tags: null,
    },
    targets
  );
  person.companies = meta.companies;
  person.isTargetCompany = meta.isTargetCompany;

  await person.save();
  return person;
}

export interface MergeResult {
  winner: IPerson;
  loser: IPerson;
  contactsMoved: number;
  interactionsMoved: number;
}

/**
 * Fold `loserId` into `winnerId`. Nothing is deleted, so this is reversible.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * IT RECOMPUTES; IT DOES NOT CONCATENATE. Adding the two sets of counters together would double-count
 * any event BOTH persons attended — which is precisely the distinct-events trap `eventCount` exists
 * to avoid, arriving through the one path where it looks like arithmetic rather than a query.
 *
 * The loser keeps its `contactKeys` and gains a `mergedInto` tombstone, which does three jobs: an old
 * `/people/<id>` URL still resolves; `resolvePerson` follows the chain so a later capture carrying an
 * old key routes to the survivor instead of re-creating the person; and `unmergePersons` has something
 * to reverse from.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 */
export async function mergePersons(
  userId: string,
  loserId: IdLike,
  winnerId: IdLike
): Promise<MergeResult | null> {
  if (sameId(loserId, winnerId)) return null;

  const [loser, winner] = await Promise.all([
    Person.findOne({ _id: loserId, userId }),
    Person.findOne({ _id: winnerId, userId }),
  ]);
  if (!loser || !winner) return null;
  if (loser.mergedInto) return null; // Already merged away; merging it again would chain tombstones.

  // Union the keys BEFORE repointing, so a concurrent capture carrying a loser key finds the winner.
  for (const key of loser.contactKeys) {
    if (!winner.contactKeys.includes(key)) winner.contactKeys.push(key);
  }
  for (const tag of loser.ownTags ?? []) {
    if (!winner.ownTags.includes(tag)) winner.ownTags.push(tag);
  }
  // Dismissals follow the survivor: "not the same as X" is a fact about the human, not about the row.
  for (const id of loser.notSamePersonAs ?? []) {
    if (!winner.notSamePersonAs.some(existing => sameId(existing, id))) {
      winner.notSamePersonAs.push(id);
    }
  }
  await winner.save();

  const [contactsMoved, interactionsMoved] = await Promise.all([
    Contact.updateMany({ userId, personId: loser._id }, { $set: { personId: winner._id } }),
    // The ONE legitimate update to an append-only collection. `Interaction`'s middleware allows
    // `personId` and refuses every other path, so this is the only shape that can get through.
    Interaction.updateMany({ userId, personId: loser._id }, { $set: { personId: winner._id } }),
  ]);

  loser.mergedInto = winner._id as mongoose.Types.ObjectId;
  await loser.save();

  // So the timeline explains its own history. `recompute: false` because the recompute below covers
  // it, and doing it twice would read the same rows for nothing.
  await recordInteraction(
    userId,
    {
      personId: winner._id as mongoose.Types.ObjectId,
      kind: 'merged',
      note: `Merged "${loser.displayName}" (${String(loser._id)}) into this person`,
    },
    { recompute: false }
  );

  const recomputed = await recomputePerson(userId, winner._id as mongoose.Types.ObjectId);

  return {
    winner: recomputed ?? winner,
    loser,
    contactsMoved: contactsMoved.modifiedCount ?? 0,
    interactionsMoved: interactionsMoved.modifiedCount ?? 0,
  };
}

/**
 * Reverse a merge.
 *
 * WHAT THIS CAN AND CANNOT RESTORE, stated plainly rather than implied. It moves back the contacts
 * whose `contactKey` is one the LOSER brought to the merge, and the interactions belonging to those
 * contacts. That is exact for the ordinary case and approximate in two:
 *
 *   · A contact whose key CHANGED after the merge (a `nm:` upgraded to `li:`) no longer matches a
 *     loser key, so it stays with the winner.
 *   · An interaction with no `contactId` — a note, a sent message — cannot be attributed to either
 *     side, so it stays with the winner. Attributing it by guess would put a private note on the
 *     wrong human, which is worse than leaving it where the user last saw it.
 *
 * Both are recorded on the timeline by the `merged` interaction, which is not removed: the history of
 * the merge survives the reversal, which is the point of an append-only timeline.
 */
export async function unmergePersons(userId: string, loserId: IdLike): Promise<IPerson | null> {
  const loser = await Person.findOne({ _id: loserId, userId });
  if (!loser?.mergedInto) return null;

  const winnerId = loser.mergedInto;

  const returning = loser.contactKeys.length
    ? await Contact.find({ userId, personId: winnerId, contactKey: { $in: loser.contactKeys } })
        .select('_id')
        .lean()
    : [];
  const returningIds = returning.map(c => c._id);

  if (returningIds.length) {
    await Contact.updateMany(
      { userId, _id: { $in: returningIds } },
      { $set: { personId: loser._id } }
    );
    await Interaction.updateMany(
      { userId, personId: winnerId, contactId: { $in: returningIds } },
      { $set: { personId: loser._id } }
    );
  }

  // Keys the loser brought are taken back off the winner, so the next capture resolves to the right
  // person again. A key BOTH sides genuinely held is lost from the winner here — acceptable, because
  // the winner's own contacts will restore it on their next recompute-triggering write.
  await Person.updateOne(
    { _id: winnerId, userId },
    { $pull: { contactKeys: { $in: loser.contactKeys } } }
  );

  // Explicit null, not `$unset`: `buildPersonFilter` matches `mergedInto: null`, which covers both,
  // but a visible null makes "this was unmerged" readable from the row.
  loser.mergedInto = null;
  await loser.save();

  await recomputePerson(userId, winnerId);
  return recomputePerson(userId, loser._id as mongoose.Types.ObjectId);
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
   LIFECYCLE — the delete paths, which the first draft of the design silently assumed away
   ══════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * A person with no encounters left is a GHOST ROW: it appears in `/people` with no history, no
 * company and nothing to open. Deleting it is the right answer, and it takes its timeline with it —
 * an interaction pointing at a person who no longer exists is unreachable by every query in the app.
 *
 * Tombstones pointing AT the deleted person go too. They hold no contacts by construction (a merge
 * repoints all of them onto the winner), so they are pure redirect rows and a dangling redirect
 * resolves to nothing.
 */
async function deletePersonAndTimeline(userId: string, personId: IdLike): Promise<void> {
  await Interaction.deleteMany({ userId, personId });
  await Person.deleteMany({ userId, mergedInto: personId });
  await Person.deleteOne({ _id: personId, userId });
}

async function recomputeOrDelete(userId: string, personId: IdLike): Promise<void> {
  const remaining = await Contact.countDocuments({ userId, personId });
  if (remaining === 0) {
    await deletePersonAndTimeline(userId, personId);
    return;
  }
  await recomputePerson(userId, personId);
}

/**
 * Call AFTER deleting one contact. `app/api/contacts/[id]/route.ts` is a bare `findOneAndDelete` with
 * no cascade, so without this the spine is left holding a `met` interaction that points at a capture
 * which no longer exists, and a person whose counters describe a history they no longer have.
 *
 * `findOneAndDelete` returns the deleted document, so the route has both ids to hand — pass the
 * contact id as well as the person id, or the orphaned interaction stays and keeps inflating
 * `interactionCount`.
 *
 * Ordering: remove the interactions for that capture, THEN recompute — recomputing first would read
 * the rows that are about to go and write counters that are wrong the moment they land.
 */
export async function onContactDeleted(
  userId: string,
  personId: IdLike | null | undefined,
  contactId?: IdLike | null
): Promise<void> {
  if (!personId) return; // A contact written before the spine existed. Nothing to clean.
  if (contactId) await Interaction.deleteMany({ userId, contactId });
  await recomputeOrDelete(userId, personId);
}

/**
 * The person ids a folder's contacts belong to — call this BEFORE the delete.
 *
 * `app/api/folders/[id]/route.ts` does `Contact.deleteMany({ userId, folderId })`, and once those
 * rows are gone there is no way to find out who was affected. Collect first is not a style
 * preference here; it is the only order that works.
 */
export async function personIdsInFolder(userId: string, folderId: IdLike): Promise<string[]> {
  const ids = (await Contact.find({ userId, folderId })
    .distinct('personId')) as Array<IdLike | null>;
  return ids.filter(Boolean).map(String);
}

/**
 * Call AFTER a folder delete has removed its contacts, with the ids collected beforehand by
 * `personIdsInFolder()`.
 *
 * The interactions to remove are the ones whose `contactId` points at a capture that is now gone. A
 * blanket delete by `personId` would be wrong: somebody met at two events has interactions from the
 * OTHER event that must survive, and those are the ones that make the person still worth having.
 */
export async function onFolderDeleted(
  userId: string,
  personIds: Array<IdLike | null | undefined>
): Promise<void> {
  const unique = [...new Set(personIds.filter(Boolean).map(String))];

  for (const personId of unique) {
    const live = (await Contact.find({ userId, personId }).distinct('_id')) as IdLike[];
    // "Has a contactId, and it is not one of the surviving contacts." `null` is included in the
    // `$nin` list so a note or a sent message — which legitimately has no contactId — is not swept up.
    await Interaction.deleteMany({
      userId,
      personId,
      contactId: { $nin: [...live, null] },
    });
    await recomputeOrDelete(userId, personId);
  }
}
