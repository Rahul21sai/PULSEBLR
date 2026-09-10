/**
 * The impure half of the speaker↔people join: three bounded queries, then hand the result to the
 * pure matcher and get out of the way.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THE SPLIT. `lib/events/speaker-match.ts` decides who counts as a match and it holds no model,
 * so it is structurally incapable of writing anything — which is the one guarantee this feature
 * needs, because auto-creating a `Person` from a speaker would fill `/people` with strangers and
 * corrupt every `eventCount`. All this file may do is LOAD, and every query below is a read.
 *
 * PER-USER DATA, SCOPED TO THE CALLER. Every query carries `userId: viewerId`, and an anonymous
 * visitor short-circuits before the first one. An event page is public, so rendering one user's
 * contacts on it would be the digest leak again — `generateDailyDigest` ran both its `TrackerEntry`
 * queries unfiltered and served the result anonymously — on a far more public surface.
 *
 * IT COSTS NOTHING ON ALMOST EVERY EVENT. `speakers` is sparse by nature (richer Luma copy,
 * organiser submissions, the company-microsite path — no platform API supplies it), so the common
 * case returns at the first guard with zero queries. It also returns early for a bill of mononyms,
 * because the matcher would refuse those anyway.
 *
 * WHY A PREFILTER RATHER THAN LOADING THE VIEWER'S PEOPLE. Cost has to scale with the length of the
 * bill, not with how many people the reader has met. The `$or` below is one clause per speaker, each
 * an AND of word-boundary regexes over `displayName`, so `Dr. Asha Rao` is still found for a speaker
 * billed as `Asha Rao`. The KNOWN GAP: the tokens are folded to ASCII, so a stored name spelled with
 * a diacritic is not reached by the regex even though the matcher would accept it. That is a recall
 * gap in the prefilter and not a loosening of the rule, which is the right direction for it to fail.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 */

import mongoose from 'mongoose';

import Event from '@/lib/models/Event';
import Interaction from '@/lib/models/Interaction';
import Person from '@/lib/models/Person';
import { publicEventScope } from '@/lib/events/query';
import { RECENT_INTERACTIONS } from '@/lib/person-types';
import type { EventSpeaker } from '@/lib/event-types';
import {
  matchSpeakers,
  speakerNameTokens,
  type MatchableInteraction,
  type MatchablePerson,
  type SpeakerMatch,
} from '@/lib/events/speaker-match';

/** A bill longer than this is a listings error, not a conference. Bounds the `$or` either way. */
const MAX_SPEAKERS_QUERIED = 24;
/** Candidates are people who share a name with somebody on the bill. Dozens would be remarkable. */
const MAX_CANDIDATES = 60;

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * People the viewer has met who could answer to one of these names.
 *
 * `mergedInto: null` rather than `{ $exists: false }`, matching `buildPersonFilter`: the loser of a
 * merge is a soft tombstone kept so an old `/people/<id>` URL still resolves, and listing it would
 * show one human twice — which looks exactly like the merge having failed.
 */
async function candidatePeople(
  viewerId: string,
  billTokens: string[][]
): Promise<MatchablePerson[]> {
  const clauses = billTokens.slice(0, MAX_SPEAKERS_QUERIED).map(tokens => ({
    $and: tokens.map(token => ({
      // Word-boundary-ish rather than anchored, so an honorific or a middle name on the stored
      // record does not hide it. The matcher, not this query, decides whether it is the same person.
      displayName: new RegExp(`(?<![A-Za-z0-9])${escapeRegex(token)}(?![A-Za-z0-9])`, 'i'),
    })),
  }));

  const rows = await Person.find({ userId: viewerId, mergedInto: null, $or: clauses })
    .select('displayName company companies eventCount lastInteractionAt')
    .limit(MAX_CANDIDATES)
    .lean();

  return rows.map(row => ({
    _id: String(row._id),
    displayName: String(row.displayName ?? ''),
    company: (row.company as string | undefined) ?? null,
    companies: (row.companies as string[] | undefined) ?? [],
    eventCount: (row.eventCount as number | undefined) ?? 0,
    lastInteractionAt: row.lastInteractionAt ? new Date(row.lastInteractionAt).toISOString() : null,
  }));
}

/**
 * The last few encounters per candidate, with event titles resolved — so "met at IndiaFOSS" has
 * something to name.
 *
 * The ids are cast BY HAND. An aggregation gets no schema casting (Mongoose only casts `find()`
 * filters), and a `$match` on a string against an ObjectId field matches nothing SILENTLY: every
 * speaker would render with no encounter and look like somebody the reader had never met. This uses
 * `find()` for exactly that reason — one sorted read over `{ userId, personId, at: -1 }`, no
 * pipeline, no casting trap.
 */
async function recentByPerson(
  viewerId: string,
  personIds: string[]
): Promise<Map<string, MatchableInteraction[]>> {
  const out = new Map<string, MatchableInteraction[]>();
  if (!personIds.length) return out;

  const rows = await Interaction.find({
    userId: viewerId,
    personId: { $in: personIds.map(id => new mongoose.Types.ObjectId(id)) },
  })
    .select('personId at eventId')
    .sort({ at: -1 })
    .limit(personIds.length * RECENT_INTERACTIONS)
    .lean();

  const eventIds = new Set<string>();
  for (const row of rows) if (row.eventId) eventIds.add(String(row.eventId));

  /*
   * Titles for whatever those encounters point at. `Event` may legitimately be GONE — `pruneStale()`
   * deletes events a week past without touching their references — so a missing title is a normal
   * outcome the matcher carries as null, not an error.
   *
   * `publicEventScope(viewerId)` even though this is the viewer's OWN history and every reachable row
   * should already pass it. The argument that it is redundant depends on an invariant about how
   * `Interaction.eventId` came to be set, spread across the tracker and scan write paths, and
   * "nothing can currently put an unviewable id here" is a claim that a future write path breaks
   * silently. Carrying the scope makes the guarantee local. It can only ever narrow, and its worst
   * outcome is a soft-deleted event losing its title so the line degrades to "Someone you have met"
   * — which is the correct answer for a row an admin removed from the corpus.
   */
  const events = eventIds.size
    ? await Event.find({ _id: { $in: [...eventIds] }, ...publicEventScope(viewerId) })
        .select('title')
        .lean()
    : [];
  const titles = new Map(events.map(e => [String(e._id), String(e.title ?? '')]));

  for (const row of rows) {
    const key = String(row.personId);
    const list = out.get(key) ?? [];
    if (list.length >= RECENT_INTERACTIONS) continue;
    list.push({
      at: row.at ? new Date(row.at).toISOString() : null,
      eventTitle: row.eventId ? titles.get(String(row.eventId)) ?? null : null,
    });
    out.set(key, list);
  }

  return out;
}

/**
 * Speaker matches for this event, index-aligned with `speakers`.
 *
 * Returns `[]` for an anonymous visitor and for an event with no bill, which are the same answer as
 * far as the page is concerned: render the speakers plainly, claim nothing.
 */
export async function loadSpeakerMatches(
  speakers: readonly EventSpeaker[] | null | undefined,
  viewerId: string | null
): Promise<(SpeakerMatch | null)[]> {
  if (!viewerId || !speakers?.length) return [];

  const billTokens = speakerNameTokens(speakers);
  if (!billTokens.length) return speakers.map(() => null);

  const people = await candidatePeople(viewerId, billTokens);
  if (!people.length) return speakers.map(() => null);

  // Matched first, THEN hydrated: the encounter query only has to cover the people who survived the
  // rule, which is usually one or two of the candidates and often none.
  const provisional = matchSpeakers(speakers, people);
  const matchedIds = [...new Set(provisional.filter(Boolean).map(m => m!.personId))];
  if (!matchedIds.length) return provisional;

  const recent = await recentByPerson(viewerId, matchedIds);
  const hydrated = people.map(p => ({ ...p, recent: recent.get(p._id) ?? [] }));
  return matchSpeakers(speakers, hydrated);
}
