import { NextRequest, NextResponse } from 'next/server';
import mongoose from 'mongoose';
import connectDB from '@/lib/mongodb';
import Source from '@/lib/models/Source';
import { requireAdmin } from '@/lib/api-auth';
import { classifySourceDelete, fetchEventImpacts, summariseBulkImpact } from '@/lib/admin/impact';

/**
 * GET /api/admin/impact?type=event&ids=a,b,c — what would happen if I did this.
 *
 * Called by the confirm dialog before any destructive action, and answered from the same functions
 * the mutating routes gate on, so the dialog cannot promise something the route then refuses.
 *
 * A GET with query params rather than a POST with a body, for two reasons: it reads and changes
 * nothing, and keeping the inputs in the URL means the guard runs before any body parsing at all.
 *
 * `ids` is capped. A preview over the whole corpus is not a preview — the dialog would take long
 * enough that nobody reads it, which is the failure mode this feature exists to avoid.
 */
const MAX_IDS = 100;

export async function GET(request: NextRequest) {
  const gate = await requireAdmin();
  if ('response' in gate) return gate.response;

  const params = request.nextUrl.searchParams;
  const type = params.get('type') ?? 'event';
  const ids = (params.get('ids') ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  if (ids.length === 0) {
    return NextResponse.json({ error: 'ids is required' }, { status: 400 });
  }
  if (ids.length > MAX_IDS) {
    return NextResponse.json(
      { error: `at most ${MAX_IDS} ids can be previewed at once`, count: ids.length },
      { status: 400 }
    );
  }
  if (ids.some(id => !mongoose.Types.ObjectId.isValid(id))) {
    return NextResponse.json({ error: 'every id must be a valid ObjectId' }, { status: 400 });
  }
  if (type !== 'event' && type !== 'source') {
    return NextResponse.json({ error: "type must be 'event' or 'source'" }, { status: 400 });
  }

  try {
    await connectDB();

    if (type === 'source') {
      const rows = await Source.find({ _id: { $in: ids } })
        .select('name kind handle lastEventCount enabled')
        .lean();
      const per = rows.map((s: Record<string, unknown>) => ({
        id: String(s._id),
        label: (s.name as string) ?? (s.handle as string) ?? 'unnamed',
        report: classifySourceDelete({
          source: {
            name: s.name as string,
            kind: s.kind as string,
            lastEventCount: s.lastEventCount as number,
          },
        }),
      }));
      return NextResponse.json({
        type,
        rows: per,
        summary: summariseBulkImpact(per.map(p => p.report)),
      });
    }

    const reports = await fetchEventImpacts(ids);
    const per = ids
      .filter(id => reports.has(id))
      .map(id => ({ id, report: reports.get(id)! }));

    return NextResponse.json({
      type,
      rows: per,
      summary: summariseBulkImpact(per.map(p => p.report)),
      // Ids that matched nothing. Reported rather than silently dropped: a stale list in the UI is
      // itself information — somebody else already deleted the row, or a scrape pruned it.
      missing: ids.filter(id => !reports.has(id)),
    });
  } catch (error) {
    console.error('Impact preview failed:', error);
    return NextResponse.json({ error: 'Failed to compute impact' }, { status: 500 });
  }
}
