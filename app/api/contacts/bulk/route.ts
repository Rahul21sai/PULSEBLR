import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongodb';
import Contact from '@/lib/models/Contact';
import Person from '@/lib/models/Person';
import { requireUser } from '@/lib/api-auth';
import { addContactTags, canonicaliseTags, findOwnedFolder } from '@/lib/contacts/service';
import { derivePersonTags, deriveNextActionAt } from '@/lib/people/service';
import { validateContactBulk } from '@/lib/scan/follow-up';

/**
 * POST /api/contacts/bulk — tag, re-date or move MANY captures in one request.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY A ROUTE AND NOT A LOOP IN THE COMPONENT. The folder table is where a forty-scan batch actually
 * lands, and until now the only editor was one sheet per person. Doing the batch client-side means
 * forty PATCHes, any of which can fail halfway leaving the user unable to tell which half landed —
 * and forty separate person recomputes behind them. `/api/people/tags` already made this argument
 * for the people page; this is the same argument one layer down, on `Contact` rather than `Person`.
 *
 * THE WRITES ARE DOCUMENT SAVES, NOT A `bulkWrite`, AND THAT IS NOT AN OVERSIGHT. `Contact`'s
 * `contactKey` hook is `pre('validate')`, which Mongoose does not run for `updateOne` /
 * `findOneAndUpdate` / `bulkWrite` — `runValidators` invokes the separate update-validator helper,
 * not document middleware. The model's own comment states the consequence as a rule: "every Contact
 * write must go through `findOne` + assign + `.save()`". None of the fields written here feeds
 * `contactKey`, so a bulk update would appear to work; what it would quietly stop doing is
 * SELF-HEALING a document written before that field existed, which is the case the hook exists for.
 * A capped batch of small saves is the cheap side of that trade.
 *
 * THE PERSON SIDE IS RECOMPUTED IN MEMORY — three extra queries regardless of batch size. `Person.tags`
 * is `canonicaliseTags(captureTags ∪ ownTags)` and `Person.nextActionAt` is the soonest OUTSTANDING
 * follow-up across every encounter, so neither can be appended to: removing a tag one capture still
 * carries must leave it in place, and clearing one reminder must fall back to the next. Calling
 * `recomputePerson()` per row would be correct and would also be ~5 queries × 200 people in one
 * request, so the pure derivations are reused directly instead — the same shape `/api/people/tags`
 * settled on, for the same reason.
 *
 * `companies` AND `isTargetCompany` ARE DELIBERATELY UNTOUCHED. They come from company / role /
 * headline, none of which this route writes, and `deriveContactMeta()` refuses to resolve companies
 * from tags at all — a tag match scores 60 with no `strength` gate, above the title branch's gated
 * 50, which is what once filed a hardware engineer tagged `embedded, arm` under the company Arm. A
 * tag cannot change who somebody works for, so a tag write has no business recomputing it.
 *
 * NO BULK DELETE. Deliberately out of scope rather than forgotten: it is the one irreversible action
 * here, its `Person` cleanup is per-row (`onContactDeleted` recomputes or removes the person), and a
 * partial failure would be unrecoverable in a way a partial tag is not. `DELETE /api/contacts/[id]`
 * already handles one person properly.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 */
export async function POST(request: NextRequest) {
  /**
   * GUARD FIRST, VALIDATE SECOND — in that order, and the order is the contract
   * `scripts/diag-api-auth.ts` asserts. Reversed, an anonymous caller sending a bad body gets 400
   * instead of 401, which tells a stranger their payload parsed and validated far enough to be
   * judged. Adding validation to a route is an improvement and the natural place to put it is at the
   * top of the handler — which is above the guard. That is exactly how this gets broken.
   */
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  try {
    const parsed = validateContactBulk(await request.json().catch(() => null));
    if (!parsed.ok) {
      // 400 naming the field, and never a Mongoose message — those carry the model name and the
      // schema path, which is the reconnaissance the tracker write paths had to stop handing out.
      return NextResponse.json(
        parsed.field ? { error: parsed.error, field: parsed.field } : { error: parsed.error },
        { status: 400 }
      );
    }
    const command = parsed.value;

    await connectDB();

    /**
     * A MOVE MUST VERIFY THE DESTINATION, or a batch of contacts could be pushed into a folder
     * somebody else owns. `findOwnedFolder` never reveals that a foreign folder exists — the same
     * check `PATCH /api/contacts/[id]` makes for a single row, and the reason a 404 rather than a
     * 403 is the right answer.
     */
    let destinationId: unknown = null;
    if (command.action === 'move') {
      const destination = await findOwnedFolder(gate.userId, command.folderId);
      if (!destination) return NextResponse.json({ error: 'Folder not found' }, { status: 404 });
      destinationId = destination._id;
    }

    /**
     * OWNERSHIP IS THE QUERY, not a check. `{ _id: { $in: ids }, userId }` means a foreign id cannot
     * widen the write — it fails to match and contributes nothing. A fetch-then-compare would have
     * to get the comparison right for every id in a list of 200.
     *
     * Documents, not `.lean()`: they are about to be saved. See the header.
     */
    const contacts = await Contact.find({ _id: { $in: command.contactIds }, userId: gate.userId });

    if (!contacts.length) {
      return NextResponse.json({
        action: command.action,
        requested: command.contactIds.length,
        matched: 0,
        changed: 0,
        failed: 0,
      });
    }

    const adding = command.action === 'tag' ? canonicaliseTags(command.add) : [];
    const removing =
      command.action === 'tag' ? new Set(canonicaliseTags(command.remove)) : new Set<string>();

    for (const contact of contacts) {
      if (command.action === 'tag') {
        /**
         * Remove first, then add, so a request naming the same tag in both lists ADDS it — the less
         * surprising of the two readings: the user's last instruction wins.
         *
         * Canonicalised through the SAME `canonicaliseTags()` every other contact write path uses. A
         * tag is a FACET KEY, so a second lowercaser here is precisely how `"AI/ML"` and `"ai/ml"`
         * become two chips for one idea, splitting a cohort in half with nothing on screen to say so.
         */
        contact.tags = canonicaliseTags([
          ...(contact.tags ?? []).filter(tag => !removing.has(tag)),
          ...adding,
        ]);
      } else if (command.action === 'followUp') {
        /**
         * `.set(path, null)` rather than an assignment, and that is a typing detail with a real
         * reason behind it. `IContact.followUpAt` is `Date | undefined`, so assigning `null` does not
         * compile — but `null` is what CLEARING has to store, because it is what
         * `pickWritable`/`updateOwnedContact` store on the single-contact path (they assign through a
         * `Record<string, unknown>` cast, which hides the same mismatch). Writing `undefined` here
         * would `$unset` the field instead, so a cleared reminder would be stored one way in bulk and
         * another way one at a time.
         */
        contact.set('followUpAt', command.followUpAt ? new Date(command.followUpAt) : null);
        /**
         * SETTING A DATE ALSO CLEARS `followedUp`. `deriveNextActionAt()` skips any capture already
         * marked done, so a new reminder on somebody previously ticked off would be stored and then
         * never surface anywhere — the worst kind of write, one that succeeds and does nothing.
         * Clearing the reminder leaves the flag alone: "I already replied" stays true.
         */
        if (command.followUpAt) contact.followedUp = false;
      } else {
        contact.folderId = destinationId as typeof contact.folderId;
      }
    }

    /**
     * Saved individually — see the header — and settled rather than `Promise.all`, because a partial
     * failure is a real outcome worth reporting. Answering 500 when thirty-nine of forty people were
     * tagged would tell the user nothing happened, which is worse than an honest count.
     */
    const results = await Promise.allSettled(contacts.map(contact => contact.save()));
    const changed = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.length - changed;

    if (!changed) {
      // Every save failed, so this is a genuine server fault rather than a partial result.
      const [first] = results;
      console.error(
        'Bulk contact edit failed for every row:',
        first && first.status === 'rejected' ? first.reason : 'unknown'
      );
      return NextResponse.json({ error: 'Failed to apply that change' }, { status: 500 });
    }

    /**
     * The tag vocabulary gets the new tags, so a chip exists for them immediately. `/api/contacts/
     * facets` unions `User.contactTags` with the tags actually in use, and only the stored
     * vocabulary can represent a tag that ends up applied to nobody — without this the rail shows
     * nothing new and the bulk bar looks like it failed.
     */
    if (adding.length) await addContactTags(gate.userId, adding);

    const personsUpdated = await refreshPeople(gate.userId, contacts, command.action);

    return NextResponse.json({
      action: command.action,
      requested: command.contactIds.length,
      matched: contacts.length,
      changed,
      failed,
      personsUpdated,
      ...(command.action === 'tag' ? { added: adding, removed: [...removing] } : {}),
      ...(command.action === 'followUp' ? { followUpAt: command.followUpAt } : {}),
    });
  } catch (error) {
    /*
     * NO `details` ON THE 500. The only thing it ever holds is a Mongoose message naming the model
     * and the schema path — the reconnaissance `lib/tracker/validate.ts` exists to stop handing out,
     * and CLAUDE.md counts roughly ten routes still leaking it. This is not the eleventh. The real
     * wording is in the server log, which is where it is useful.
     */
    console.error('Error applying a bulk contact edit:', error);
    return NextResponse.json({ error: 'Failed to apply that change' }, { status: 500 });
  }
}

/**
 * Bring the affected `Person` rows back in step with the captures that just changed.
 *
 * NON-FATAL BY DESIGN, the same judgement `attachToPerson()` and the contact delete path make: the
 * write the user asked for has already committed, so a failure in the identity layer is a
 * consistency problem to log and repair with `recomputePerson`, not a reason to report a successful
 * edit as broken.
 *
 * A MOVE CHANGES NOTHING HERE. `Interaction.eventId` is taken from the folder at CAPTURE time and
 * `PATCH /api/contacts/[id]` does not re-point it on a single move either; giving the bulk path
 * different semantics would make two moves mean two things.
 */
async function refreshPeople(
  userId: string,
  contacts: Array<{ personId?: unknown }>,
  action: 'tag' | 'followUp' | 'move'
): Promise<number> {
  if (action === 'move') return 0;

  try {
    const personIds = [
      ...new Set(
        contacts
          .map(c => (c.personId ? String(c.personId) : ''))
          // A capture with no `personId` predates the spine or had its attach fail; the backfill
          // owns those, and there is nothing here to recompute for it.
          .filter(Boolean)
      ),
    ];
    if (!personIds.length) return 0;

    const [people, captures] = await Promise.all([
      Person.find({ _id: { $in: personIds }, userId, mergedInto: null }).select('_id ownTags'),
      /**
       * EVERY capture of those people, not just the ones edited. Both derived fields are functions of
       * the whole set: a tag removed from one encounter must stay if another still carries it, and a
       * cleared reminder must fall back to the next outstanding one rather than to null.
       */
      Contact.find({ userId, personId: { $in: personIds } })
        .select('personId tags followUpAt followedUp scannedAt')
        .lean(),
    ]);
    if (!people.length) return 0;

    const byPerson = new Map<
      string,
      Array<{ scannedAt: Date; tags?: string[]; followUpAt?: Date | null; followedUp?: boolean }>
    >();
    for (const capture of captures) {
      const key = String(capture.personId);
      const facts = {
        scannedAt: capture.scannedAt as Date,
        tags: capture.tags ?? [],
        followUpAt: capture.followUpAt ?? null,
        followedUp: capture.followedUp,
      };
      const list = byPerson.get(key);
      if (list) list.push(facts);
      else byPerson.set(key, [facts]);
    }

    const writes = people.map(person => {
      const facts = byPerson.get(String(person._id)) ?? [];
      return {
        updateOne: {
          // Scoped by `userId` on the write as well as the read. The ids came from an owned query, so
          // this is belt and braces — and it is the cheap kind.
          filter: { _id: person._id, userId },
          update: {
            $set:
              action === 'tag'
                ? // RECOMPUTED, never unioned. Union is forever: a tag removed from every capture
                  // would otherwise stay on the person with no UI able to clear it.
                  { tags: derivePersonTags(facts, person.ownTags ?? []) }
                : { nextActionAt: deriveNextActionAt(facts) },
          },
        },
      };
    });

    const result = await Person.bulkWrite(writes);
    return result.modifiedCount ?? 0;
  } catch (error) {
    console.error('Bulk contact edit landed but the person spine was not updated:', error);
    return 0;
  }
}
