import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongodb';
import Person from '@/lib/models/Person';
import Interaction from '@/lib/models/Interaction';
import Contact from '@/lib/models/Contact';
// Registers the `Event` model this process needs for the title join below. A model that has never
// been imported is not registered, which surfaces as `MissingSchemaError` far from the cause.
import Event from '@/lib/models/Event';
import { requireUser } from '@/lib/api-auth';
import {
  attachFolderNames,
  canonicaliseTags,
  contactToDTO,
} from '@/lib/contacts/service';
import {
  mergeSuggestionsFor,
  recomputePerson,
  recordInteraction,
} from '@/lib/people/service';
import {
  isObjectIdLike,
  personToDTO,
  validatePersonPatch,
  type InteractionDTO,
  type LeanPerson,
} from '@/lib/person-types';
import type { ContactDTO } from '@/lib/contacts/types';

/**
 * GET   /api/people/[id] — one human: their fields, their encounters, their timeline, and any
 *                          duplicate we suspect.
 * PATCH /api/people/[id] — correct a name, tag the human, APPEND a note, or move a follow-up.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THERE IS NO DELETE, AND THERE IS NO PATCH FOR AN INTERACTION. Both omissions are load-bearing.
 *
 * A person is deleted by deleting their last encounter — `onContactDeleted()` and `onFolderDeleted()`
 * own that, and they remove the timeline and the ghost row together. A DELETE here would leave the
 * captures pointing at a person id that no longer exists, which no query in the app can reach.
 *
 * And the timeline is APPEND-ONLY: a timeline you can edit is not evidence. `Interaction`'s schema
 * carries no `updatedAt` and refuses every modification except a merge repointing `personId`, so a
 * route offering to rewrite a note would fail at the model — correctly. Editing a note means
 * appending another one, which is what `patch.note` does. That is the defect being fixed here: today
 * a person carries ONE `note` string that every edit overwrites, so the thing you wrote down at the
 * event is gone the first time you add anything.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * `params` is a Promise in this Next version and must be awaited. The inline type is used rather than
 * the generated `RouteContext<'/api/people/[id]'>` helper, because that helper indexes a union in
 * `.next/types/routes.d.ts` listing only routes present at the last build — so a brand-new route does
 * not typecheck until typegen re-runs.
 */

/** A timeline long enough to be a history, short enough to be one response. */
const TIMELINE_LIMIT = 200;

/** Resolve `eventId`s to titles in one query. A missing event is normal — see `InteractionDTO`. */
async function withEventTitles(
  rows: Array<{
    _id: unknown;
    kind: string;
    at: Date;
    eventId?: unknown;
    contactId?: unknown;
    note?: string | null;
  }>
): Promise<InteractionDTO[]> {
  const ids = [...new Set(rows.filter(r => r.eventId).map(r => String(r.eventId)))];
  const events = ids.length
    ? await Event.find({ _id: { $in: ids } })
        .select('title startDateTime')
        .lean()
    : [];
  const titles = new Map(
    events.map(e => [
      String(e._id),
      { title: e.title as string, startAt: e.startDateTime as Date | undefined },
    ])
  );

  return rows.map(row => {
    const event = row.eventId ? titles.get(String(row.eventId)) : undefined;
    return {
      _id: String(row._id),
      kind: row.kind as InteractionDTO['kind'],
      at: new Date(row.at).toISOString(),
      eventId: row.eventId ? String(row.eventId) : null,
      eventTitle: event?.title ?? null,
      eventStartAt: event?.startAt ? new Date(event.startAt).toISOString() : null,
      contactId: row.contactId ? String(row.contactId) : null,
      note: row.note ?? null,
    };
  });
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // GUARD FIRST — before the id is even read off the params, so an anonymous request cannot learn
  // whether its id was well-formed.
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  try {
    await connectDB();
    const { id } = await params;
    if (!isObjectIdLike(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    /**
     * OWNERSHIP IS A QUERY FILTER, not a fetch-then-compare, and the refusal is 404 rather than 403.
     *
     * A 403 confirms the row exists, and a Mongo ObjectId is not a secret — it is a timestamp plus a
     * counter, so neighbouring ids are enumerable. `mergedInto` is deliberately NOT excluded: the
     * tombstone exists so an old `/people/<id>` URL still resolves after a merge, and the client is
     * told where the human went.
     */
    const person = await Person.findOne({ _id: id, userId: gate.userId }).lean();
    if (!person) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const [contactRows, interactionRows, suggestions] = await Promise.all([
      Contact.find({ userId: gate.userId, personId: person._id }).sort({ scannedAt: -1 }).lean(),
      Interaction.find({ userId: gate.userId, personId: person._id })
        .sort({ at: -1 })
        .limit(TIMELINE_LIMIT)
        .lean(),
      mergeSuggestionsFor(gate.userId, String(person._id)),
    ]);

    // Folder names, so a `met` with no `eventId` still says WHERE. Every folder made by hand carries
    // `eventId: null`, so without this the commonest encounter in the database has no context at all.
    const contacts: ContactDTO[] = await attachFolderNames(contactRows.map(contactToDTO));

    return NextResponse.json({
      person: personToDTO(person as unknown as LeanPerson),
      contacts,
      interactions: await withEventTitles(
        interactionRows as unknown as Parameters<typeof withEventTitles>[0]
      ),
      timelineTruncated: interactionRows.length === TIMELINE_LIMIT,
      suggestions,
    });
  } catch (error) {
    console.error('Error fetching person:', error);
    return NextResponse.json({ error: 'Failed to fetch person' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  try {
    await connectDB();
    const { id } = await params;
    if (!isObjectIdLike(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    // Ownership as a filter, and BEFORE the body is judged: an unowned id must not be able to learn
    // whether its payload was valid.
    const person = await Person.findOne({ _id: id, userId: gate.userId });
    if (!person) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    /**
     * A TOMBSTONE IS READ-ONLY. It exists so an old URL resolves; edits belong on the survivor, or
     * a note lands on a row nothing lists and the user watches their own writing disappear. 409 with
     * the survivor's id, so the client can follow it rather than guess.
     */
    if (person.mergedInto) {
      return NextResponse.json(
        {
          error: 'This person was merged into another. Edit the surviving person instead.',
          mergedInto: String(person.mergedInto),
        },
        { status: 409 }
      );
    }

    // One string form of the id, used for every write below. `person._id` is typed `unknown` on a
    // custom Document interface, and a string is an `IdLike` everywhere it is passed.
    const personId = String(person._id);

    const parsed = validatePersonPatch(await request.json().catch(() => null));
    if (!parsed.ok) {
      // 400 NAMING the field, and never a Mongoose message. Handing the raw body to Mongoose is what
      // made the tracker write paths answer 500 with the model name and schema path attached.
      return NextResponse.json(
        parsed.field ? { error: parsed.error, field: parsed.field } : { error: parsed.error },
        { status: 400 }
      );
    }
    const patch = parsed.value;

    /**
     * FOLLOW-UPS ARE STORED PER ENCOUNTER AND SHOWN PER PERSON, so this route has to collapse them.
     *
     * `nextActionAt` is `min(followUpAt)` across the person's outstanding encounters, so somebody met
     * three times can carry three dates while the card shows one. The design decision is that the
     * person page writes through the MOST RECENT contact — one obvious landing place. Two asymmetric
     * consequences, both deliberate:
     *
     *   · "Done" closes EVERY outstanding reminder. Closing only the newest would leave an older date
     *     outstanding, `nextActionAt` would not move, and the button would look broken while having
     *     worked exactly as written.
     *   · "Set" clears the others' dates first (`followUpAt: null`, NOT `followedUp: true` — nothing
     *     was followed up, the reminder was simply replaced) and then writes one. Otherwise
     *     `nextActionAt` stays pinned to an older date and the new one never surfaces.
     *
     * Either way the person ends with at most ONE outstanding reminder, which is what the card claims.
     */
    if (patch.followUp) {
      const outstanding = {
        userId: gate.userId,
        personId,
        followUpAt: { $ne: null },
        followedUp: { $ne: true },
      };

      if (patch.followUp.action === 'done') {
        // `updateMany` rather than the document path: `followedUp` and `followUpAt` take no part in
        // `contactKey`, so the `pre('validate')` hook that recomputes it has nothing to do here.
        await Contact.updateMany(outstanding, { $set: { followedUp: true } });
        await recordInteraction(
          gate.userId,
          { personId, kind: 'follow-up-done' },
          { recompute: false }
        );
      } else {
        const target = await Contact.findOne({ userId: gate.userId, personId }).sort({
          scannedAt: -1,
        });
        if (!target) {
          // A person with no encounters is a ghost row that `recomputeOrDelete()` removes, so this
          // should be unreachable — but a reminder attached to nothing would be invisible forever.
          return NextResponse.json(
            { error: 'There is no encounter to attach a reminder to.' },
            { status: 409 }
          );
        }
        await Contact.updateMany(
          { ...outstanding, _id: { $ne: target._id } },
          { $set: { followUpAt: null } }
        );
        target.followUpAt = new Date(patch.followUp.at);
        target.followedUp = false;
        // Document path here, because this contact is being loaded and saved anyway and `.save()` is
        // the documented rule for a `Contact` write — `pre('validate')` self-heals a legacy row's
        // missing `contactKey`, and `findOneAndUpdate` would skip it.
        await target.save();
        await recordInteraction(
          gate.userId,
          { personId, kind: 'follow-up-set' },
          { recompute: false }
        );
      }
    }

    // APPEND. There is no path here that edits an existing note — see the header.
    if (patch.note) {
      await recordInteraction(
        gate.userId,
        { personId, kind: 'note', note: patch.note },
        { recompute: false }
      );
    }

    if (patch.messageSent) {
      await recordInteraction(
        gate.userId,
        { personId, kind: 'message-sent' },
        { recompute: false }
      );
    }

    if (patch.overrides) {
      /**
       * Read the three fields by name rather than spreading. `person.overrides` is a single-nested
       * subdocument at runtime, so spreading it copies Mongoose's internals (`$__`, `_doc`) into what
       * is then written back as the value.
       *
       * A BLANK override CLEARS it — it does not pin an empty string. `derivePersonFields` reads a
       * blank override as "no override" for exactly that reason, so storing `''` would produce a
       * field no later capture could ever fill and the user could not tell it from broken.
       */
      const current = person.overrides ?? {};
      const next: Record<string, string | undefined> = {
        displayName: current.displayName,
        company: current.company,
        role: current.role,
      };
      for (const [key, value] of Object.entries(patch.overrides)) {
        next[key] = value ? value : undefined;
      }
      person.set('overrides', next);
    }

    if (patch.ownTags) {
      // The SAME canonicaliser the capture sheet and the offline drain use, so a tag typed here and
      // one typed offline land in the same facet bucket. A tag is a facet KEY, not a label.
      person.ownTags = canonicaliseTags(patch.ownTags);
    }

    if (patch.overrides || patch.ownTags) await person.save();

    /**
     * ONE recompute, at the end, after the overrides are SAVED.
     *
     * Order matters: `recomputePerson()` re-reads `person.overrides` from the database and re-applies
     * it over the derived values, so recomputing before the save would derive from the old override
     * and the correction would appear not to have taken. The interactions above pass
     * `recompute: false` so the counters are computed once from the final state instead of three
     * times from intermediate ones.
     */
    const updated = await recomputePerson(gate.userId, personId);

    return NextResponse.json({
      person: personToDTO(
        (updated ? updated.toObject() : person.toObject()) as unknown as LeanPerson
      ),
    });
  } catch (error) {
    console.error('Error updating person:', error);
    return NextResponse.json({ error: 'Failed to update person' }, { status: 500 });
  }
}
