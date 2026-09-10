import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongodb';
import Person from '@/lib/models/Person';
import Contact from '@/lib/models/Contact';
import { requireUser } from '@/lib/api-auth';
import { addContactTags, canonicaliseTags } from '@/lib/contacts/service';
import { derivePersonTags } from '@/lib/people/service';
import { validateTagBulk } from '@/lib/person-types';

/**
 * POST /api/people/tags — add or remove one set of tags across many people at once.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY A ROUTE AND NOT A LOOP IN THE COMPONENT. Coming back from a conference with forty scans and
 * tagging them one edit sheet at a time is forty sheets — that is the difference between a feature and
 * a demo. Doing it client-side means forty PATCHes, each of which runs a full `recomputePerson()`
 * (several queries), any of which can fail halfway leaving the user unable to tell which half landed.
 *
 * THIS TOUCHES THE DATABASE THREE TIMES REGARDLESS OF BATCH SIZE, and that shape is the reason the
 * route exists. `Person.tags` is DERIVED — `canonicaliseTags(captureTags ∪ ownTags)` — so it cannot
 * simply be appended to: removing an own-tag that a capture ALSO carries must leave it in place, and
 * only the captures know that. So: load the people, load their captures' tags, recompute both fields
 * in memory through `derivePersonTags()`, and write with one `bulkWrite`. Calling `recomputePerson()`
 * per row would be correct and would also be ~5 queries × 200 people in one request.
 *
 * It recomputes ONLY `tags` and `ownTags`. `companies` and `isTargetCompany` are untouched on purpose:
 * contact tags must never reach `resolveCompanies()`, which scores a tag match at 60 with no `strength`
 * gate — above the title branch's gated 50 — so forwarding a user's private label filed a hardware
 * engineer tagged `embedded, arm` under the company **Arm**. A tag cannot change who somebody works
 * for, so a tag write has no business recomputing it.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * The response reports `matched` alongside `requested`, because they legitimately differ: an id the
 * caller does not own, or one that has since become a merge tombstone, simply does not match the
 * scoped filter. Reporting the gap beats silently tagging fewer people than were named.
 */
export async function POST(request: NextRequest) {
  /**
   * GUARD FIRST, VALIDATE SECOND — in that order, and the ordering is the contract
   * `scripts/diag-api-auth.ts` asserts. Reversed, an anonymous caller sending a bad body gets 400
   * instead of 401, which tells a stranger their payload parsed and validated far enough to be judged.
   * Adding validation to a route is an improvement, and the natural place to put it is at the top of
   * the handler — which is ABOVE the guard. That is exactly how this gets broken.
   */
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  try {
    const parsed = validateTagBulk(await request.json().catch(() => null));
    if (!parsed.ok) {
      // 400 naming the field, and never a Mongoose message — those carry the model name and the
      // schema path, which is the leak the tracker write paths had to stop.
      return NextResponse.json(
        parsed.field ? { error: parsed.error, field: parsed.field } : { error: parsed.error },
        { status: 400 }
      );
    }
    const { personIds, add, remove } = parsed.value;

    // Canonicalised through the SAME function every contact write path uses. A tag is a facet KEY, so
    // a second canonicaliser here is how `"AI/ML"` and `"ai/ml"` become two chips for one idea.
    const adding = canonicaliseTags(add);
    const removing = new Set(canonicaliseTags(remove));

    await connectDB();

    /**
     * OWNERSHIP IS THE QUERY, not a check. `{ _id: { $in: ids }, userId }` means a foreign id cannot
     * widen the write — it fails to match and contributes nothing. A fetch-then-compare would need to
     * get the comparison right for every id in a list of 200, and `mergedInto: null` is in here for a
     * second reason: a tombstone is not listed anywhere, so tagging one writes to a row the user can
     * never see again.
     */
    const people = await Person.find({
      _id: { $in: personIds },
      userId: gate.userId,
      mergedInto: null,
    }).select('_id ownTags');

    if (!people.length) {
      return NextResponse.json({ tagged: 0, requested: personIds.length, matched: 0 });
    }

    const matchedIds = people.map(p => p._id);

    // Their captures' tags — the half of the derivation that only the captures know. `scannedAt` is
    // selected because `PersonContactFacts` requires it, not because the tag rule reads it.
    const captures = await Contact.find({
      userId: gate.userId,
      personId: { $in: matchedIds },
    })
      .select('personId tags scannedAt')
      .lean();

    const captureTags = new Map<string, Array<{ scannedAt: Date; tags: string[] }>>();
    for (const capture of captures) {
      const key = String(capture.personId);
      const facts = { scannedAt: capture.scannedAt as Date, tags: capture.tags ?? [] };
      const list = captureTags.get(key);
      if (list) list.push(facts);
      else captureTags.set(key, [facts]);
    }

    const writes = people.map(person => {
      const key = String(person._id);
      const current = person.ownTags ?? [];
      // Remove first, then add, so a request carrying the same tag in both lists ADDS it. That is the
      // less surprising of the two readings: the user's last instruction wins.
      const nextOwn = canonicaliseTags([
        ...current.filter(tag => !removing.has(tag)),
        ...adding,
      ]);

      return {
        updateOne: {
          // Scoped by `userId` on the write as well as on the read above. The ids came from an owned
          // query, so this is belt and braces — and it is the cheap kind: a bulk write that could ever
          // be pointed at a foreign row by a later refactor is not worth the saved clause.
          filter: { _id: person._id, userId: gate.userId },
          update: {
            $set: {
              ownTags: nextOwn,
              /**
               * `tags` RECOMPUTED, never appended. CLAUDE.md's rule for `Event.companies` applies
               * verbatim: "True at the moment of writing; union is forever." Unioned here, a tag
               * removed from a capture would stay on the person permanently with nothing in the UI
               * able to clear it — the same shape as a bad category that re-scraping can never remove.
               */
              tags: derivePersonTags(captureTags.get(key) ?? [], nextOwn),
            },
          },
        },
      };
    });

    const result = await Person.bulkWrite(writes);

    /**
     * The tag vocabulary gets the new tags too, so a chip exists for them immediately.
     *
     * `/api/people/facets` unions `User.contactTags` with `Person.distinct('tags')`, and each half
     * covers the other's gap — but only the stored vocabulary can represent a tag that ends up applied
     * to nobody (every named person already had it, say). Without this the rail would show nothing new
     * and the bulk bar would look like it had failed.
     */
    if (adding.length) await addContactTags(gate.userId, adding);

    return NextResponse.json({
      tagged: result.modifiedCount ?? 0,
      requested: personIds.length,
      matched: people.length,
      added: adding,
      removed: [...removing],
    });
  } catch (error) {
    console.error('Error bulk-tagging people:', error);
    return NextResponse.json({ error: 'Failed to apply tags' }, { status: 500 });
  }
}
