import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongodb';
import Person from '@/lib/models/Person';
import { requireUser } from '@/lib/api-auth';
import { getContactTags, getTargetCompanies } from '@/lib/contacts/service';
import { buildPersonFilter, parsePersonQuery } from '@/lib/people/query';
import type { PersonBucket } from '@/lib/person-types';

/**
 * The counts beside every filter on `/people`.
 *
 * PAIRED WITH `GET /api/people` THROUGH `buildPersonFilter()`, which is the whole reason this is a
 * separate route rather than numbers computed in the browser. Filtering in the browser would cap the
 * feature at one page of rows — the 41st person would be invisible — and the chip counts would be
 * computed from a truncated set, which is confidently wrong rather than merely partial.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * EACH FACET COUNTS AS IF ITS OWN DIMENSION WERE NOT APPLIED. That is not a detail; it is what makes
 * the chips usable.
 *
 * With the company counts computed under the current company filter, picking "Razorpay" leaves
 * Razorpay showing its count and every other company showing zero — so the rail asserts there is
 * nobody anywhere else, which is false, and it becomes useless for the thing a filter rail is for:
 * changing your mind. Dropping the dimension being counted answers the question actually being
 * asked — "if I switched to Postman, how many would I get?"
 *
 * Every OTHER active filter is kept, so counts still narrow as constraints are added. The three
 * toggles are each counted with THEMSELVES forced on, for the same reason: a badge on an active
 * toggle that merely equals the row count tells you nothing about turning it off.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 */

/** A filter rail cannot render 300 chips, and the search box covers anything past this. */
const MAX_BUCKETS = 60;

/** Distinct values of one array field under a filter, with counts, most-common first. */
async function bucketsFor(
  field: 'companies' | 'tags',
  filter: Record<string, unknown>
): Promise<PersonBucket[]> {
  const rows = await Person.aggregate<{ _id: string; count: number }>([
    { $match: filter },
    { $unwind: `$${field}` },
    { $group: { _id: `$${field}`, count: { $sum: 1 } } },
    { $sort: { count: -1, _id: 1 } },
    { $limit: MAX_BUCKETS },
  ]);
  return rows.filter(r => r._id).map(r => ({ value: r._id, count: r.count }));
}

export async function GET(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  try {
    await connectDB();
    const params = parsePersonQuery(request.nextUrl.searchParams);

    // Same params, one dimension dropped each time — see the header.
    const withoutCompany = buildPersonFilter(gate.userId, { ...params, company: undefined });
    const withoutTag = buildPersonFilter(gate.userId, { ...params, tag: undefined });
    const full = buildPersonFilter(gate.userId, params);

    const [companies, tags, vocabulary, personTags, targets, total, targetCount, followUpCount, repeatCount] =
      await Promise.all([
        bucketsFor('companies', withoutCompany),
        bucketsFor('tags', withoutTag),
        getContactTags(gate.userId),
        /**
         * `distinct` over the people, UNIONED with the stored vocabulary below.
         *
         * Each half covers the other's gap, exactly as the contacts facet route documents. `distinct`
         * alone cannot represent a tag created but not yet applied to anybody, so the create button
         * looks broken; the stored list alone misses a tag that arrived on a contact without going
         * through the vocabulary. Scoped to live rows, or a merged tombstone would keep a tag alive.
         */
        Person.distinct('tags', { userId: gate.userId, mergedInto: null }) as Promise<string[]>,
        getTargetCompanies(gate.userId),
        Person.countDocuments(full),
        Person.countDocuments(buildPersonFilter(gate.userId, { ...params, targetOnly: true })),
        Person.countDocuments(buildPersonFilter(gate.userId, { ...params, followUpDue: true })),
        Person.countDocuments(buildPersonFilter(gate.userId, { ...params, repeatOnly: true })),
      ]);

    const targetSet = new Set(targets.map(t => t.toLowerCase()));

    return NextResponse.json({
      total,
      companies: companies.map(c => ({ ...c, isTarget: targetSet.has(c.value.toLowerCase()) })),
      tags,
      // Sorted so the rail is stable between requests — an unsorted union reshuffles chips on every
      // keystroke, which reads as the page flickering rather than as filtering.
      tagVocabulary: [...new Set([...vocabulary, ...personTags.filter(Boolean)])].sort(),
      targetCount,
      followUpCount,
      repeatCount,
    });
  } catch (error) {
    console.error('Error computing person facets:', error);
    return NextResponse.json({ error: 'Failed to compute facets' }, { status: 500 });
  }
}
