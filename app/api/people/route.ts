import { NextRequest, NextResponse } from 'next/server';
import mongoose from 'mongoose';
import connectDB from '@/lib/mongodb';
import Person from '@/lib/models/Person';
import Interaction from '@/lib/models/Interaction';
// Imported for its SIDE EFFECT as much as for the query: `Interaction.eventId` is `ref: 'Event'`,
// and a model that has never been imported in this process is not registered — which is how
// `migrate-connections-to-contacts.ts` hid a `MissingSchemaError` behind a dry run over 0 rows.
import Event from '@/lib/models/Event';
import { requireUser } from '@/lib/api-auth';
import { buildPersonFilter, buildPersonSort, type PersonSort, parsePersonQuery } from '@/lib/people/query';
import {
  personToDTO,
  RECENT_INTERACTIONS,
  type InteractionDTO,
  type LeanPerson,
  type PersonDTO,
} from '@/lib/person-types';

/**
 * GET /api/people — one row per HUMAN, with their recent encounters attached.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THE ENCOUNTERS COME BACK WITH THE LIST rather than being fetched when a card is expanded.
 *
 * The card shows its history INSIDE itself — the owner's instruction was "than making 3 card we can
 * add them like history or met before in the card section that make it clean". Three cards for one
 * human is the defect the whole spine removes; a fetch per expanded card would instead put a
 * request between the user and information they can already see the shape of. So the three most
 * recent interactions ride along, in ONE aggregate for the whole page — not one query per row,
 * which at 40 rows is 40 round trips for the same answer.
 *
 * Event titles are then joined in a SECOND query rather than a `$lookup`, because the `$slice`
 * happens before the join: looking up first would join every interaction on the page and throw most
 * of it away.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * There is deliberately NO POST. A person is created by capturing a contact — `resolvePerson()` on
 * the contact write path owns that, and it is the only writer that can see enough to decide whether
 * this human already exists. A hand-created person would arrive with no encounter, which is exactly
 * the ghost row `recomputeOrDelete()` exists to remove.
 */

/** One page. Large enough to scroll into, small enough that the encounter aggregate stays cheap. */
const PAGE_SIZE = 40;
const MAX_PAGE_SIZE = 200;

/** Interaction rows are unbounded per person; the group stage must not push a whole history. */
const MAX_GROUPED_PER_PERSON = 25;

interface RecentRow {
  _id: unknown;
  items: Array<{
    _id: unknown;
    kind: string;
    at: Date;
    eventId?: unknown;
    contactId?: unknown;
    note?: string | null;
  }>;
}

/**
 * The last few interactions for each person on this page, with event titles resolved.
 *
 * Returns a map keyed by person id string. A person with no interactions is simply absent, which is
 * a real state: a Contact written before the spine has no `met` row until the backfill runs.
 */
async function recentByPerson(
  userId: string,
  personIds: string[]
): Promise<Map<string, InteractionDTO[]>> {
  const out = new Map<string, InteractionDTO[]>();
  if (!personIds.length) return out;

  const rows = await Interaction.aggregate<RecentRow>([
    /**
     * The ids MUST be cast by hand. An aggregation pipeline gets no schema casting — Mongoose only
     * casts `find()` filters — so a `$match` on a string against an ObjectId field matches NOTHING
     * and the failure is silent: every card renders with an empty history and looks like a person
     * with no encounters.
     */
    {
      $match: {
        userId,
        personId: { $in: personIds.map(id => new mongoose.Types.ObjectId(id)) },
      },
    },
    // Served by `{ userId, personId, at: -1 }`, which is the same index the person timeline uses.
    { $sort: { at: -1 } },
    {
      $group: {
        _id: '$personId',
        items: {
          // Plain `$push`, trimmed by the `$project` below rather than by the accumulator — there is
          // no `$slice` accumulator, and `$topN`/`$firstN` would pin this to MongoDB 5.2+. The group
          // therefore does materialise a person's interactions before being cut to
          // `MAX_GROUPED_PER_PERSON`, which is what that constant is for: it bounds the PAYLOAD, and
          // the work is bounded in practice because interactions per person are a handful, not
          // thousands. If that ever stops being true, `$topN` is the fix, not a bigger `$limit`.
          $push: {
            _id: '$_id',
            kind: '$kind',
            at: '$at',
            eventId: '$eventId',
            contactId: '$contactId',
            note: '$note',
          },
        },
      },
    },
    { $project: { items: { $slice: ['$items', MAX_GROUPED_PER_PERSON] } } },
  ]);

  // Event titles for whatever survived the slice, in one query. `Event` may legitimately be gone —
  // `pruneStale()` deletes events 7 days past without touching their references — so a missing title
  // is a normal outcome the DTO carries as null rather than an error.
  const eventIds = new Set<string>();
  for (const row of rows) {
    for (const item of row.items.slice(0, RECENT_INTERACTIONS)) {
      if (item.eventId) eventIds.add(String(item.eventId));
    }
  }

  const events = eventIds.size
    ? await Event.find({ _id: { $in: [...eventIds] } })
        .select('title startDateTime')
        .lean()
    : [];
  const titles = new Map(
    events.map(e => [
      String(e._id),
      { title: e.title as string, startAt: e.startDateTime as Date | undefined },
    ])
  );

  for (const row of rows) {
    out.set(
      String(row._id),
      row.items.slice(0, RECENT_INTERACTIONS).map(item => {
        const event = item.eventId ? titles.get(String(item.eventId)) : undefined;
        return {
          _id: String(item._id),
          kind: item.kind as InteractionDTO['kind'],
          at: new Date(item.at).toISOString(),
          eventId: item.eventId ? String(item.eventId) : null,
          eventTitle: event?.title ?? null,
          eventStartAt: event?.startAt ? new Date(event.startAt).toISOString() : null,
          contactId: item.contactId ? String(item.contactId) : null,
          note: item.note ?? null,
        };
      })
    );
  }

  return out;
}

export async function GET(request: NextRequest) {
  // GUARD FIRST. Nothing above this line reads the query string, so an anonymous caller with a
  // malformed one gets 401 rather than 400 — a 400 would confirm their input parsed.
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  try {
    await connectDB();
    const search = request.nextUrl.searchParams;

    // `parsePersonQuery` rather than reading params here, so this route, the facet route and the
    // export route cannot parse the same URL differently. `includeMerged` is deliberately not
    // parseable — a tombstone in a list renders one human twice, which is what merging fixed.
    const params = parsePersonQuery(search);
    const filter = buildPersonFilter(gate.userId, params);
    const sort = buildPersonSort((search.get('sort') as PersonSort) ?? 'recent');

    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(search.get('limit')) || PAGE_SIZE));
    const skip = Math.max(0, Number(search.get('skip')) || 0);

    // `countDocuments` against the SAME filter object — the property `lib/people/query.ts` exists to
    // guarantee. The Contact version of this page shipped a heading reading "6 people" over a list
    // of 2 because the count ran against a filter the list did not use.
    const [rows, total] = await Promise.all([
      Person.find(filter).sort(sort).skip(skip).limit(limit).lean(),
      Person.countDocuments(filter),
    ]);

    const people: PersonDTO[] = rows.map(row => personToDTO(row as unknown as LeanPerson));
    const recent = await recentByPerson(
      gate.userId,
      people.map(p => p._id)
    );
    for (const person of people) person.recent = recent.get(person._id) ?? [];

    return NextResponse.json({
      people,
      total,
      hasMore: skip + rows.length < total,
      nextSkip: skip + rows.length,
    });
  } catch (error) {
    console.error('Error listing people:', error);
    // No `details`. On a Mongoose error that string names the model and the schema path, which is
    // the leak the tracker write paths had to stop; the real wording is in the log line above.
    return NextResponse.json({ error: 'Failed to list people' }, { status: 500 });
  }
}
