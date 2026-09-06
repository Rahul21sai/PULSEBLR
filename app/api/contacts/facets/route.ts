import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongodb';
import Contact from '@/lib/models/Contact';
import { requireUser } from '@/lib/api-auth';
import { getContactTags, getTargetCompanies, isValidId, listFolders } from '@/lib/contacts/service';
import { buildContactFilter, parseContactQuery } from '@/lib/contacts/query';

/**
 * The counts beside every filter on the People page.
 *
 * PAIRED WITH `GET /api/contacts` THROUGH `buildContactFilter()`, which is the whole reason this is
 * a separate route rather than numbers computed in the browser. `lib/events/query.ts` established
 * the arrangement for the events feed: the list and the facet counts must come from ONE filter
 * definition, or a chip says 12 and shows 9, and nobody notices until they count.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * EACH FACET COUNTS AS IF ITS OWN DIMENSION WERE NOT APPLIED. That is not a detail, it is what
 * makes the chips usable.
 *
 * If the company counts were computed with the current company filter still in place, then picking
 * "Razorpay" would leave Razorpay showing its count and every other company showing zero — so the
 * filter rail would tell you there is nobody anywhere else, which is false and makes the panel
 * useless for changing your mind. Dropping the dimension being counted answers the question the
 * user is actually asking: "if I switched to Postman instead, how many would I get?"
 *
 * Every OTHER active filter is kept, so the counts do narrow as you add constraints.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

interface Bucket {
  value: string;
  count: number;
  /** Only on company buckets: is this one on the user's target list? */
  isTarget?: boolean;
}

/** Distinct values of one array/scalar field under a filter, with counts, most-common first. */
async function bucketsFor(
  field: 'companies' | 'tags',
  filter: Record<string, unknown>
): Promise<Bucket[]> {
  const rows = await Contact.aggregate<{ _id: string; count: number }>([
    { $match: filter },
    { $unwind: `$${field}` },
    { $group: { _id: `$${field}`, count: { $sum: 1 } } },
    { $sort: { count: -1, _id: 1 } },
    // A cap, because a tag vocabulary is user-supplied and a filter rail cannot render 300 chips
    // anyway. The People page has a search box for anything past this.
    { $limit: 60 },
  ]);
  return rows.filter(r => r._id).map(r => ({ value: r._id, count: r.count }));
}

export async function GET(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  try {
    await connectDB();
    const search = request.nextUrl.searchParams;
    const params = parseContactQuery(search);

    if (params.folderId && !isValidId(params.folderId)) {
      return NextResponse.json({ error: 'Invalid folder id' }, { status: 400 });
    }

    // Same params, one dimension dropped each time — see the header.
    const withoutCompany = buildContactFilter(gate.userId, { ...params, company: undefined });
    const withoutTag = buildContactFilter(gate.userId, { ...params, tag: undefined });
    const withoutFolder = buildContactFilter(gate.userId, { ...params, folderId: undefined });
    const full = buildContactFilter(gate.userId, params);

    const [companies, tags, folderRows, folders, vocabulary, targets, total, targetCount, followUpCount] =
      await Promise.all([
        bucketsFor('companies', withoutCompany),
        bucketsFor('tags', withoutTag),
        Contact.aggregate<{ _id: unknown; count: number }>([
          { $match: withoutFolder },
          { $group: { _id: '$folderId', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 60 },
        ]),
        listFolders(gate.userId, true),
        getContactTags(gate.userId),
        getTargetCompanies(gate.userId),
        Contact.countDocuments(full),
        // These two are toggles, so each is counted with ITSELF dropped for the same reason the
        // dimensional facets are — otherwise the badge on an active toggle equals the row count and
        // tells you nothing about turning it off.
        Contact.countDocuments(buildContactFilter(gate.userId, { ...params, targetOnly: true })),
        Contact.countDocuments(buildContactFilter(gate.userId, { ...params, followUpDue: true })),
      ]);

    const targetSet = new Set(targets.map(t => t.toLowerCase()));
    const folderNames = new Map(folders.map(f => [f._id, f.name]));

    return NextResponse.json({
      total,
      companies: companies.map(c => ({ ...c, isTarget: targetSet.has(c.value.toLowerCase()) })),
      tags,
      /**
       * The tag VOCABULARY, separate from the tag buckets above.
       *
       * A tag the user created but has not applied to anybody yet has a count of zero, so it does
       * not appear in the aggregate — and omitting it would make the create button look broken.
       * The page renders vocabulary entries with no members as empty chips rather than hiding them.
       */
      tagVocabulary: vocabulary,
      folders: folderRows
        .filter(r => r._id)
        .map(r => ({
          value: String(r._id),
          // A folder the user has deleted, or one `pruneStale` orphaned, still has contacts
          // pointing at it. Naming it honestly beats dropping the bucket and losing the people.
          label: folderNames.get(String(r._id)) ?? 'Folder no longer exists',
          count: r.count,
        })),
      targetCount,
      followUpCount,
    });
  } catch (error) {
    console.error('Error computing contact facets:', error);
    return NextResponse.json({ error: 'Failed to compute facets' }, { status: 500 });
  }
}
