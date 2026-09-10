import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongodb';
import Person from '@/lib/models/Person';
import { requireUser } from '@/lib/api-auth';
import {
  dismissMergeSuggestion,
  mergePersons,
  mergeSuggestionsFor,
  recomputePerson,
  unmergePersons,
} from '@/lib/people/service';
import {
  personToDTO,
  personToMergeCandidate,
  validateMergeRequest,
  type LeanPerson,
  type MergeCandidate,
  type MergePair,
} from '@/lib/person-types';

/**
 * GET  /api/people/merge — the duplicates we suspect, as pairs ready for a side-by-side compare.
 * POST /api/people/merge — merge two people, dismiss the suggestion, or undo a merge.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * A KEY COLLISION NEVER AUTO-MERGES, and this route is the whole reason that decision is affordable.
 *
 * `contactKey` is a POINTER that gets recomputed — `nm:asha rao` becomes `li:asha-rao-123` the day her
 * LinkedIn arrives — so two rows sharing a key are two humans who MAY be one. The asymmetry decides
 * it: a wrong merge destroys the distinction between two real people and is very hard to unwind once
 * notes and follow-ups interleave, whereas an un-merged duplicate is merely untidy. So `resolvePerson`
 * records a suggestion and changes nothing, and a human decides here.
 *
 * Which only works if the suggestion is REACHABLE. Before this route the entire product surface for a
 * detected duplicate was a `met 3 x` badge: no route, no UI, no service call. The detection existed
 * and the decision had nowhere to happen.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * THREE ACTIONS ON ONE ROUTE, deliberately. They are one decision, reversed and re-decided: merge
 * these two, no they are different people, undo that merge. Three routes would be three guards and
 * three validators for one user-facing choice — and `unmerge` in particular has to be as easy to
 * reach as `merge`, or "reversible" is a claim rather than a feature.
 */

/** Keys examined per request. A user with more ambiguity than this has a data problem, not a UI one. */
const MAX_SHARED_KEYS = 40;
/** Pairs returned. The banner shows one at a time; the sheet pages through the rest. */
const MAX_PAIRS = 20;

export async function GET() {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  try {
    await connectDB();

    /**
     * FIND THE CANDIDATES IN ONE AGGREGATE, then let the service decide.
     *
     * `mergeSuggestionsFor(userId, personId)` is per-person, so a banner over the whole list would be
     * one call per row — and it is the only thing that knows about `notSamePersonAs`. So the aggregate
     * narrows to the handful of keys held by two or more LIVE people, and the service is asked only
     * about those. Reimplementing the dismissal check here instead is how a dismissed pair comes back,
     * which is worse than never having suggested it: the user re-decides something they already
     * decided and cannot tell whether their answer was recorded.
     *
     * `mergedInto: null` matters — a merged loser keeps its keys, so including tombstones would
     * suggest merging a person with their own already-merged twin, forever.
     */
    const shared = await Person.aggregate<{ _id: string; ids: unknown[] }>([
      { $match: { userId: gate.userId, mergedInto: null } },
      { $unwind: '$contactKeys' },
      { $group: { _id: '$contactKeys', ids: { $addToSet: '$_id' } } },
      // "at least two documents in the array" — an index probe, not a `$size` comparison, so it can
      // use the grouped output without counting every group.
      { $match: { 'ids.1': { $exists: true } } },
      { $limit: MAX_SHARED_KEYS },
    ]);

    const pairKeys = new Set<string>();
    const pairs: Array<{ aId: string; bId: string; contactKey: string }> = [];

    for (const group of shared) {
      if (pairs.length >= MAX_PAIRS) break;
      const anchor = String(group.ids[0]);
      const suggestions = await mergeSuggestionsFor(gate.userId, anchor);
      for (const suggestion of suggestions) {
        // Unordered pair identity, so A-vs-B and B-vs-A are one suggestion. Without this the same
        // duplicate is offered twice and dismissing one leaves the other on screen.
        const key = [anchor, suggestion.personId].sort().join(':');
        if (pairKeys.has(key)) continue;
        pairKeys.add(key);
        pairs.push({ aId: anchor, bId: suggestion.personId, contactKey: suggestion.contactKey });
        if (pairs.length >= MAX_PAIRS) break;
      }
    }

    const ids = [...new Set(pairs.flatMap(p => [p.aId, p.bId]))];
    const people = ids.length
      ? await Person.find({ userId: gate.userId, _id: { $in: ids } }).lean()
      : [];
    const byId = new Map<string, MergeCandidate>(
      people.map(p => [String(p._id), personToMergeCandidate(p as unknown as LeanPerson)])
    );

    const result: MergePair[] = pairs
      .map(pair => {
        const a = byId.get(pair.aId);
        const b = byId.get(pair.bId);
        // A row deleted between the aggregate and this read is not an error; it is just no longer a
        // duplicate. Dropping it silently is correct — surfacing half a pair is not.
        return a && b ? { a, b, contactKey: pair.contactKey } : null;
      })
      .filter((p): p is MergePair => p !== null);

    return NextResponse.json({ pairs: result });
  } catch (error) {
    console.error('Error listing merge suggestions:', error);
    return NextResponse.json({ error: 'Failed to load duplicate suggestions' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  // GUARD FIRST. This route mutates two rows at once, so an anonymous caller must be refused before
  // its body is parsed — a 400 here would tell a stranger their ids were well-formed.
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  try {
    await connectDB();

    const parsed = validateMergeRequest(await request.json().catch(() => null));
    if (!parsed.ok) {
      return NextResponse.json(
        parsed.field ? { error: parsed.error, field: parsed.field } : { error: parsed.error },
        { status: 400 }
      );
    }
    const body = parsed.value;

    if (body.action === 'dismiss') {
      /**
       * OWNERSHIP CHECKED BEFORE THE WRITE, even though `dismissMergeSuggestion` scopes both of its
       * updates by `userId` and so cannot touch a stranger's row. Without this the route would answer
       * 200 for two ids the caller does not own — a probe that says "those exist and are now marked
       * not-duplicates", which is a lie AND a disclosure. 404, never 403.
       */
      const owned = await Person.countDocuments({
        userId: gate.userId,
        _id: { $in: [body.personId, body.otherId] },
      });
      if (owned !== 2) return NextResponse.json({ error: 'Not found' }, { status: 404 });

      await dismissMergeSuggestion(gate.userId, body.personId, body.otherId);
      return NextResponse.json({ dismissed: true });
    }

    if (body.action === 'unmerge') {
      const loser = await Person.findOne({ _id: body.loserId, userId: gate.userId }).select(
        'mergedInto'
      );
      if (!loser) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      if (!loser.mergedInto) {
        // 409 rather than 404: the row exists and is the caller's, it simply is not a merge to undo.
        // A 404 here would read as "the person is gone", which is alarming and wrong.
        return NextResponse.json({ error: 'That person was not merged.' }, { status: 409 });
      }

      const restored = await unmergePersons(gate.userId, body.loserId);
      if (!restored) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      return NextResponse.json({
        person: personToDTO(restored.toObject() as unknown as LeanPerson),
      });
    }

    /**
     * MERGE. `mergePersons` returns null for every refusal it can make — either row missing or not
     * owned, and a loser that is ALREADY a tombstone (merging it again would chain tombstones, and a
     * chain is what makes `resolvePerson`'s follow loop unbounded). All of those are 404 here, so
     * ownership stays unobservable.
     */
    const result = await mergePersons(gate.userId, body.loserId, body.winnerId);
    if (!result) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    let winner = result.winner;

    /**
     * THE PER-FIELD CHOICES LAND AS `overrides`, NOT ON THE DERIVED FIELDS.
     *
     * The compare sheet asks which name, company and role should survive. Writing those onto
     * `Person.displayName` directly would be undone by the very next `recomputePerson()` — which runs
     * on every note, every follow-up and every new scan, because derivation re-reads the contacts. An
     * override is the only place a human decision survives a recompute, which is exactly what
     * `derivePersonFields` re-applies it for.
     *
     * Applied AFTER the merge, so it is chosen from the union of both histories rather than from one.
     */
    if (body.overrides) {
      const current = winner.overrides ?? {};
      const next: Record<string, string | undefined> = {
        displayName: current.displayName,
        company: current.company,
        role: current.role,
      };
      for (const [key, value] of Object.entries(body.overrides)) {
        // Blank clears rather than pins — a pinned empty string is a field no later capture can fill.
        next[key] = value ? value : undefined;
      }
      winner.set('overrides', next);
      await winner.save();
      // Save first, then recompute: `recomputePerson` re-reads the stored overrides, so recomputing
      // before the save would derive from the previous ones and the choice would appear not to take.
      winner = (await recomputePerson(gate.userId, String(winner._id))) ?? winner;
    }

    return NextResponse.json({
      person: personToDTO(winner.toObject() as unknown as LeanPerson),
      mergedFrom: String(result.loser._id),
      contactsMoved: result.contactsMoved,
      interactionsMoved: result.interactionsMoved,
    });
  } catch (error) {
    console.error('Error merging people:', error);
    return NextResponse.json({ error: 'Failed to merge' }, { status: 500 });
  }
}
