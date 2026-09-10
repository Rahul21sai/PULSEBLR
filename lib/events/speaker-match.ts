/**
 * "You met her at IndiaFOSS, Jul" — a speaker on this event's bill, matched to somebody already in
 * the viewer's own people list. The events↔people join paying off on the EVENTS side.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * NEVER CREATE A `Person` FROM A SPEAKER. This is the whole reason the matcher is a pure function
 * over data somebody else loaded: it has no model, no connection and no write path, so it is
 * STRUCTURALLY INCAPABLE of the thing that would break `/people`. A speaker is a name printed on an
 * event page; a Person is somebody you actually met. Manufacturing rows from the first would fill
 * the people list with strangers and corrupt every `eventCount`, which is the number `met N×`
 * renders — a badge that has already carried one counting bug (`detectRepeatConnections` keyed on
 * the folder, so two folders for one event counted as two events).
 *
 * PER-USER DATA, DISPLAY ONLY. The caller passes the SIGNED-IN VIEWER's own Persons and nobody
 * else's. An anonymous visitor gets an empty list in and an empty list out. Leaking one user's
 * contacts onto a public event page is the same class of bug as the digest leak
 * (`generateDailyDigest` ran both its `TrackerEntry` queries unfiltered and served the result
 * anonymously), and an event page is a far more public surface than an inbox.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE MATCHING RULE, AND WHAT IT REFUSES.
 *
 * A false "you met her" is worse than a missing one. It is not a wrong label on an event, it is a
 * confident claim about the reader's own memory — and the reader cannot check it, because the whole
 * point is that they may not remember. So the rule below is built to decline:
 *
 *   1. AT LEAST TWO NAME TOKENS on both sides. "Asha" matching "Asha" is not evidence; Bengaluru has
 *      a great many Ashas and the reader has met at most a few.
 *   2. THE TOKEN SETS MUST BE EQUAL. No fuzzy distance, no nickname table, no initial expansion, no
 *      first-name-plus-company shortcut. `Asha Rao` does not match `Asha R Rao` or `A Rao`.
 *      Order is ignored, because surname-first is ordinary in South India and the same tokens in a
 *      different order is overwhelmingly the same human — the only widening allowed here.
 *   3. A STATED COMPANY THAT DISAGREES IS A VETO. If the bill says `Asha Rao · Google` and the
 *      viewer's Asha Rao is at Razorpay, that is two people, and no match is offered. Agreement
 *      upgrades the match to `name+company`; silence on either side leaves it at `name`.
 *   4. AMBIGUITY DECLINES. Two Persons answering to one name is exactly the case where a guess
 *      damages trust, so a tie produces nothing. A company-corroborated candidate beats a
 *      name-only one, and only an outright tie within the stronger class refuses.
 *
 * WHAT IT WILL STILL GET WRONG, stated rather than implied:
 *
 *   · TWO REAL PEOPLE, ONE NAME, ONE EMPLOYER — the viewer knows one "Rahul Sharma" at Infosys and
 *     the speaker is a different one. Rule 3 corroborates and cannot separate them. This is the
 *     residual false positive and there is no signal in either record that closes it.
 *   · A COMMON TWO-TOKEN NAME WITH NO COMPANY ANYWHERE falls to `name` alone. Rendering the basis
 *     is how the reader gets to judge it — see `SpeakerMatch.basis`.
 *   · SPELLING. `Krishnan` against `Krishnaan` is a miss, by design. Recall is the safe failure.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * PURE. No React, no I/O, no dates beyond comparing two ISO strings. `tests/speaker-match.test.ts`
 * pins it, including every refusal above — the refusals are the half worth testing.
 */

import type { EventSpeaker } from '../event-types';

/**
 * The narrow slice of a `Person` this decision reads.
 *
 * Deliberately not `PersonDTO`: the caller projects only these fields out of Mongo, and a matcher
 * typed against the full DTO would invite a `.select()` that quietly widens what the event page
 * loads about the viewer's contacts.
 */
export interface MatchablePerson {
  _id: string;
  /** Already EFFECTIVE — `derivePersonFields` has applied any override the user pinned. */
  displayName: string;
  company?: string | null;
  /** Registry-resolved canonical employers, from `lib/companies/resolve.ts`. */
  companies?: readonly string[] | null;
  /** Distinct events, not `met` rows. Rendered only when it is worth mentioning. */
  eventCount?: number | null;
  lastInteractionAt?: string | null;
  /**
   * Recent encounters, newest first or otherwise — this sorts them itself. `eventTitle` is nullable
   * for a real reason: `pruneStale()` deletes events a week past without touching what references
   * them, so a dangling `eventId` is normal rather than corruption.
   */
  recent?: readonly MatchableInteraction[] | null;
}

export interface MatchableInteraction {
  /** ISO string. When it HAPPENED, not when the row was written. */
  at?: string | null;
  eventTitle?: string | null;
}

export interface SpeakerMatch {
  personId: string;
  /** The viewer's own name for them, override included. */
  displayName: string;
  /**
   * The evidence, so the page can show how much to trust the claim rather than asserting all
   * matches equally. `name+company` had both sides state an employer and agree.
   */
  basis: 'name+company' | 'name';
  /** The event you met at, when one is still in the corpus. */
  metAtTitle: string | null;
  /** ISO string for the encounter behind `metAtTitle`, else the last interaction of any kind. */
  metAt: string | null;
  /** Distinct events you have met them at. 0 when the caller did not project it. */
  eventCount: number;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
   NORMALISATION
   ══════════════════════════════════════════════════════════════════════════════════════════════ */

/** Dropped from the FRONT of a name. A speaker bill says "Dr."; a contact record almost never does. */
const HONORIFICS = new Set([
  'mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'prof', 'professor',
  'shri', 'sri', 'smt', 'er', 'ca',
]);

/** Dropped from the END. Credentials are decoration on a conference programme. */
const NAME_SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'phd', 'msc', 'mba', 'mtech', 'btech']);

/**
 * A name as comparable tokens: diacritics folded, punctuation to spaces, honorifics and credentials
 * removed. Returns `[]` for anything with nothing left to compare.
 *
 * Punctuation becomes a SPACE rather than nothing, so `Jean-Luc` is two tokens and cannot silently
 * fuse into `jeanluc` while the other side stays split.
 */
export function nameTokens(raw: string | null | undefined): string[] {
  if (!raw) return [];

  /*
   * The diacritic strip is a CODE-POINT COMPARISON, not a regex over a character range.
   *
   * A character class spanning the combining-marks block (U+0300 to U+036F) is the idiomatic
   * spelling and it is a liability in a source file: the range renders as invisible characters, so
   * a diff cannot show it, and any tool that rewrites one byte of it breaks folding with no error
   * at all. This function was written twice for exactly that reason. `lib/llm/tagger.ts` carries
   * the same scar at production scale: a heredoc turned 70 word boundaries into 0x08 bytes, so the
   * keyword floor became dead code while every provider was up and nothing looked wrong. Numeric
   * bounds cannot be corrupted invisibly.
   *
   * It must also run BEFORE the punctuation pass below. A combining mark is not `[a-z0-9]`, so
   * leaving it in place turns it into a SPACE and splits one name token into two.
   */
  const COMBINING_FIRST = 0x300;
  const COMBINING_LAST = 0x36f;
  let folded = '';
  for (const ch of raw.normalize('NFD')) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= COMBINING_FIRST && code <= COMBINING_LAST) continue;
    folded += ch;
  }

  const tokens = folded
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean);

  while (tokens.length && HONORIFICS.has(tokens[0])) tokens.shift();
  while (tokens.length && NAME_SUFFIXES.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens;
}

/** Order-insensitive identity for a name. See rule 2 in the header for why order is ignored. */
function nameKey(raw: string | null | undefined): string | null {
  const tokens = nameTokens(raw);
  // ONE TOKEN IS NOT A NAME MATCH. Rule 1, and it is the cheapest false positive to prevent.
  if (tokens.length < 2) return null;
  return [...tokens].sort().join(' ');
}

/**
 * Words that say nothing about WHICH company this is, so `Zoho Technologies` and `Zoho` corroborate
 * rather than conflict, as do `Google India` and `Google`.
 *
 * This only ever makes corroboration MORE permissive; it can never create a match on its own,
 * because the full name must already be equal before company is consulted at all. The known cost is
 * a genuine pair like `Tata` and `Tata Technologies` reading as agreement.
 */
const COMPANY_NOISE = new Set([
  'inc', 'llc', 'ltd', 'limited', 'pvt', 'private', 'plc', 'gmbh', 'sa', 'bv',
  'co', 'corp', 'corporation', 'company', 'group', 'holdings',
  'technologies', 'technology', 'tech', 'labs', 'lab', 'systems', 'software',
  'solutions', 'services', 'consulting', 'india', 'bengaluru', 'bangalore', 'blr',
  'the',
]);

/** A company as a comparable key, or `null` when nothing distinguishing survives. */
export function companyKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const tokens = nameTokens(raw).filter(t => !COMPANY_NOISE.has(t));
  return tokens.length ? tokens.sort().join(' ') : null;
}

function personCompanyKeys(person: MatchablePerson): Set<string> {
  const keys = new Set<string>();
  const own = companyKey(person.company);
  if (own) keys.add(own);
  for (const name of person.companies ?? []) {
    const key = companyKey(name);
    if (key) keys.add(key);
  }
  return keys;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
   MATCHING
   ══════════════════════════════════════════════════════════════════════════════════════════════ */

type CompanyVerdict = 'agrees' | 'conflicts' | 'unknown';

function compareCompany(speaker: EventSpeaker, person: MatchablePerson): CompanyVerdict {
  const stated = companyKey(speaker.company);
  if (!stated) return 'unknown';
  const held = personCompanyKeys(person);
  if (!held.size) return 'unknown';
  return held.has(stated) ? 'agrees' : 'conflicts';
}

/** Newest first, treating a missing date as oldest so it never wins by accident. */
function byRecency(a: MatchableInteraction, b: MatchableInteraction): number {
  const at = a.at ? Date.parse(a.at) : NaN;
  const bt = b.at ? Date.parse(b.at) : NaN;
  return (Number.isNaN(bt) ? -Infinity : bt) - (Number.isNaN(at) ? -Infinity : at);
}

/**
 * The most recent encounter that names an event, plus its date.
 *
 * Falls back to `lastInteractionAt` with no title, which renders as "met in July" rather than
 * "met at «nothing»" — the encounter is real even when the event it happened at has been pruned.
 */
function lastMeeting(person: MatchablePerson): { title: string | null; at: string | null } {
  const withTitle = (person.recent ?? [])
    .filter(i => Boolean(i.eventTitle && i.eventTitle.trim()))
    .sort(byRecency)[0];
  if (withTitle) return { title: withTitle.eventTitle!.trim(), at: withTitle.at ?? null };

  const any = [...(person.recent ?? [])].sort(byRecency)[0];
  return { title: null, at: any?.at ?? person.lastInteractionAt ?? null };
}

function toMatch(person: MatchablePerson, basis: SpeakerMatch['basis']): SpeakerMatch {
  const met = lastMeeting(person);
  return {
    personId: person._id,
    displayName: person.displayName,
    basis,
    metAtTitle: met.title,
    metAt: met.at,
    eventCount: person.eventCount ?? 0,
  };
}

/**
 * One speaker against the viewer's people. `null` means "no claim", which is the answer far more
 * often than not and is always a safe one.
 */
export function matchSpeaker(
  speaker: EventSpeaker,
  people: readonly MatchablePerson[]
): SpeakerMatch | null {
  const key = nameKey(speaker.name);
  if (!key) return null;

  const corroborated: MatchablePerson[] = [];
  const nameOnly: MatchablePerson[] = [];

  for (const person of people) {
    if (nameKey(person.displayName) !== key) continue;
    const verdict = compareCompany(speaker, person);
    // Rule 3: a stated employer that disagrees is two different humans, not a weak match.
    if (verdict === 'conflicts') continue;
    (verdict === 'agrees' ? corroborated : nameOnly).push(person);
  }

  // Rule 4. A corroborated candidate beats any number of name-only ones; a tie inside the winning
  // class declines, because picking one would be a coin toss dressed up as a memory.
  if (corroborated.length === 1) return toMatch(corroborated[0], 'name+company');
  if (corroborated.length > 1) return null;
  if (nameOnly.length === 1) return toMatch(nameOnly[0], 'name');
  return null;
}

/**
 * Every speaker on the bill, index-aligned with the input so a caller can zip the two lists and
 * render the unmatched ones plainly. `null` at a position means no claim for that speaker.
 */
export function matchSpeakers(
  speakers: readonly EventSpeaker[] | null | undefined,
  people: readonly MatchablePerson[] | null | undefined
): (SpeakerMatch | null)[] {
  if (!speakers?.length) return [];
  if (!people?.length) return speakers.map(() => null);
  return speakers.map(speaker => matchSpeaker(speaker, people));
}

/**
 * The name fragments worth querying Mongo for, so the caller can prefilter instead of loading the
 * viewer's whole contact list.
 *
 * Returns token arrays for speakers that COULD match — single-token names are dropped here, so a
 * bill of mononyms costs no query at all. Tokens are pre-normalisation-adjacent (folded and
 * de-punctuated), which is a deliberate limitation worth knowing: a stored name spelled with a
 * diacritic will not be found by a regex built from the folded form, so it is a recall gap in the
 * PREFILTER and not in the rule above. Widening it means loading more people, not matching looser.
 */
export function speakerNameTokens(
  speakers: readonly EventSpeaker[] | null | undefined
): string[][] {
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const speaker of speakers ?? []) {
    const tokens = nameTokens(speaker.name);
    if (tokens.length < 2) continue;
    const key = [...tokens].sort().join(' ');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tokens);
  }
  return out;
}
