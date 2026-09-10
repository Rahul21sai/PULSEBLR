import { NextRequest, NextResponse } from 'next/server';
import mongoose from 'mongoose';
import connectDB from '@/lib/mongodb';
import Person from '@/lib/models/Person';
import Interaction from '@/lib/models/Interaction';
import Contact from '@/lib/models/Contact';
import Event from '@/lib/models/Event';
import { requireUser } from '@/lib/api-auth';
import { buildPersonFilter, buildPersonSort, type PersonSort, parsePersonQuery } from '@/lib/people/query';
import { PERSON_CSV_COLUMNS, type PersonCsvRow } from '@/lib/contacts/export-columns';
import { toCsv, exportFilename } from '@/lib/scan/csv';
import { personToDTO, type LeanPerson } from '@/lib/person-types';

/**
 * Export everyone the current filter matches — ONE ROW PER HUMAN.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS ROUTE HAD TO EXIST RATHER THAN `/people` REUSING `/api/contacts/export`.
 *
 * That route builds its filter with `buildContactFilter`, and its own header claims what downloads is
 * "exactly what was on screen". That sentence was true while `/people` listed captures and became
 * FALSE the moment it listed people: the download would be a different result set (a contact filter
 * cannot express `repeatOnly`, and it emits one row per capture rather than per human), while still
 * looking like it had worked. An export that quietly ignores the active filters is worse than no
 * export, so the link was removed until this existed. The architecture spec flags the divergence as a
 * lifecycle gap that must close "in the same commit as the cutover"; this is that close.
 *
 * THE EQUIVALENCE IS THE WHOLE POINT, so it is enforced structurally rather than by comment: the same
 * `parsePersonQuery` reads the same query string, the same `buildPersonFilter` and `buildPersonSort`
 * produce the filter and order, and each row is built from the same `personToDTO` the list serves. The
 * page hands this route its own `params` object verbatim. There is no second definition of "matching"
 * anywhere in the path.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * `Cache-Control: no-store`. Do NOT copy the ICS route's `public, max-age=3600` — that is a shared
 * calendar and this is a bulk PII export of one person's entire contact list, on an origin whose
 * service worker caches successful GETs.
 *
 * Every cell goes through `lib/scan/csv.ts`, which is security rather than formatting: a cell
 * beginning `=`, `+`, `-`, `@`, tab or CR is executed as a formula by Excel, Sheets and LibreOffice,
 * and every name, headline and tag here originates in a QR code somebody else generated. It also
 * writes the UTF-8 BOM, without which Excel on Windows mangles non-ASCII names — and this is an app
 * for Bengaluru, so that is most of them.
 */

/** A ceiling, because this can span every person the user has ever met. */
const MAX_ROWS = 2000;

/**
 * Just the capture fields the reach columns need.
 *
 * Declared rather than inferred from the query: `Contact.find(...).lean()` in a ternary with `[]`
 * infers a union whose element type collapses to `never` on the first `push`, so the grouping below
 * silently stops typechecking for a reason that has nothing to do with the data.
 */
interface CaptureFacts {
  personId?: unknown;
  email?: string | null;
  phone?: string | null;
  linkedin?: string | null;
  x?: string | null;
  github?: string | null;
  website?: string | null;
}

/** Event titles per person in the "Where you met" cell, before it stops being readable. */
const MAX_EVENT_TITLES = 5;

export async function GET(request: NextRequest) {
  // GUARD FIRST — nothing above this line touches the query string, so an anonymous caller cannot
  // learn whether their parameters were understood.
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  try {
    await connectDB();
    const search = request.nextUrl.searchParams;
    const params = parsePersonQuery(search);

    const filter = buildPersonFilter(gate.userId, params);
    const sort = buildPersonSort((search.get('sort') as PersonSort) ?? 'recent');

    const rows = await Person.find(filter).sort(sort).limit(MAX_ROWS).lean();
    const people = rows.map(row => personToDTO(row as unknown as LeanPerson));
    const ids = people.map(p => new mongoose.Types.ObjectId(p._id));

    /**
     * TWO joins for the whole export, not per row.
     *
     * `Person` deliberately stores no email or phone — those belong to an encounter, not to the human
     * — so the reach columns are derived from the captures. And "where you met" needs the interaction
     * spine, because `Contact → Folder → Event` is null at its second hop in practice.
     */
    const [captures, eventGroups] = await Promise.all([
      ids.length
        ? (Contact.find({ userId: gate.userId, personId: { $in: ids } })
            .select('personId email phone linkedin x github website scannedAt')
            .sort({ scannedAt: -1 })
            .lean() as unknown as Promise<CaptureFacts[]>)
        : Promise.resolve([] as CaptureFacts[]),
      ids.length
        ? Interaction.aggregate<{ _id: unknown; eventIds: unknown[] }>([
            // Hand-cast ids: an aggregation pipeline gets NO schema casting, so a string here matches
            // nothing and the failure is silent — every "Where you met" cell would come out empty.
            {
              $match: {
                userId: gate.userId,
                personId: { $in: ids },
                eventId: { $ne: null },
              },
            },
            // `$addToSet`, so an event attended once but noted three times counts once — the same
            // distinct-events rule `eventCount` follows.
            { $group: { _id: '$personId', eventIds: { $addToSet: '$eventId' } } },
          ])
        : [],
    ]);

    const eventIds = [
      ...new Set(eventGroups.flatMap(g => g.eventIds.map(id => String(id)))),
    ];
    const events = eventIds.length
      ? await Event.find({ _id: { $in: eventIds } })
          .select('title')
          .lean()
      : [];
    const eventTitle = new Map(events.map(e => [String(e._id), e.title as string]));

    // Captures are sorted newest-first above, so the FIRST non-empty value per field is the newest —
    // the same per-field fallback `derivePersonFields` uses, and for the same reason: a LinkedIn QR
    // carries a slug and no email, so taking the newest capture WHOLE would blank an address already
    // known.
    const capturesByPerson = new Map<string, CaptureFacts[]>();
    for (const capture of captures) {
      const key = String(capture.personId);
      const list = capturesByPerson.get(key);
      if (list) list.push(capture);
      else capturesByPerson.set(key, [capture]);
    }

    const titlesByPerson = new Map<string, string[]>(
      eventGroups.map(group => [
        String(group._id),
        group.eventIds
          // A dangling `eventId` is NORMAL — `pruneStale()` deletes events 7 days past without
          // touching their references — so an unresolvable id is dropped rather than written as a
          // blank entry that reads like a missing title.
          .map(id => eventTitle.get(String(id)))
          .filter((title): title is string => Boolean(title)),
      ])
    );

    const csvRows: PersonCsvRow[] = people.map(person => {
      const mine = capturesByPerson.get(person._id) ?? [];
      const newest = (get: (c: CaptureFacts) => unknown): string | null => {
        for (const capture of mine) {
          const value = String(get(capture) ?? '').trim();
          if (value) return value;
        }
        return null;
      };

      const titles = titlesByPerson.get(person._id) ?? [];
      const shown = titles.slice(0, MAX_EVENT_TITLES);
      if (titles.length > shown.length) shown.push(`+${titles.length - shown.length} more`);

      return {
        displayName: person.displayName,
        headline: person.headline,
        role: person.role,
        company: person.company,
        // The person's own `li:`-derived URL first, then whatever a capture recorded.
        linkedin: person.linkedin ?? newest(c => c.linkedin),
        email: newest(c => c.email),
        phone: newest(c => c.phone),
        x: newest(c => c.x),
        github: newest(c => c.github),
        website: newest(c => c.website),
        tags: person.tags,
        companies: person.companies,
        isTargetCompany: person.isTargetCompany,
        eventCount: person.eventCount,
        interactionCount: person.interactionCount,
        captureCount: mine.length,
        lastInteractionAt: person.lastInteractionAt,
        nextActionAt: person.nextActionAt,
        events: shown,
      };
    });

    return new NextResponse(toCsv(csvRows, PERSON_CSV_COLUMNS), {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        // `exportFilename` normalises and caps the name, so nothing user-supplied can break the
        // header or escape a directory.
        'Content-Disposition': `attachment; filename="${exportFilename('people', 'csv')}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    console.error('Error exporting people:', error);
    /**
     * JSON, not an HTML error page, and the client is a fetch rather than a bare `<a>` for exactly
     * this reason. The spec records the folder export's plain anchor as a known defect: a 500 there
     * navigates the browser to a raw error page and the user loses the filtered view they were on.
     */
    return NextResponse.json({ error: 'Failed to export' }, { status: 500 });
  }
}
