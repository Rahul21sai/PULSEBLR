import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongodb';
import AuditLog from '@/lib/models/AuditLog';
import { requireAdmin } from '@/lib/api-auth';
import { actionLabel, isAuditAction, isUndoable } from '@/lib/admin/audit';

/**
 * GET /api/admin/audit — the change log.
 *
 * The question this has to answer is the owner's: "what did I change last Tuesday". So the filters
 * are a WINDOW (`since`/`days`), an ACTOR, and an ACTION — not a full query language. `targetId` is
 * also accepted so a row in the events panel can show its own history.
 *
 * ADMIN ONLY, obviously, but worth stating why beyond "it is an admin page": the rows carry
 * before/after snapshots of event documents, which for a pending submission includes a stranger's
 * unreviewed `applyLink`, and they carry admin email addresses.
 *
 * The action facet is computed with the ACTION dimension dropped, the discipline
 * `lib/events/query.ts` and `lib/contacts/query.ts` both follow: counting with the filter applied
 * shows zero everywhere else and makes the chips useless for changing your mind.
 */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function GET(request: NextRequest) {
  const gate = await requireAdmin();
  if ('response' in gate) return gate.response;

  const params = request.nextUrl.searchParams;

  try {
    await connectDB();

    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(params.get('limit')) || DEFAULT_LIMIT));
    const skip = Math.max(0, Number(params.get('skip')) || 0);

    /**
     * The window. `days` is the control the panel offers; `since` is an escape hatch for an exact
     * timestamp. A window is applied by DEFAULT (30 days) rather than showing everything, because an
     * unbounded log is the state in which nobody reads it.
     */
    const filter: Record<string, unknown> = {};
    const since = params.get('since');
    const days = Number(params.get('days'));
    if (since && !Number.isNaN(Date.parse(since))) {
      filter.createdAt = { $gte: new Date(since) };
    } else if (Number.isFinite(days) && days > 0) {
      filter.createdAt = { $gte: new Date(Date.now() - days * 86400_000) };
    }

    const actor = params.get('actor');
    if (actor) filter.actorEmail = actor.toLowerCase();

    const targetId = params.get('targetId');
    if (targetId) filter.targetId = targetId;

    const targetType = params.get('targetType');
    if (targetType) filter.targetType = targetType;

    // Unknown action names are REJECTED rather than silently returning nothing — a typo in a filter
    // that renders an empty log looks exactly like "nothing happened", which is the one wrong answer
    // an audit log must never give.
    const action = params.get('action');
    if (action) {
      if (!isAuditAction(action)) {
        return NextResponse.json({ error: `unknown action: ${action}` }, { status: 400 });
      }
      filter.action = action;
    }

    const facetFilter = { ...filter };
    delete facetFilter.action;

    const [rows, total, byAction, byActor] = await Promise.all([
      AuditLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      AuditLog.countDocuments(filter),
      AuditLog.aggregate<{ _id: string; n: number }>([
        { $match: facetFilter },
        { $group: { _id: '$action', n: { $sum: 1 } } },
        { $sort: { n: -1 } },
      ]),
      AuditLog.aggregate<{ _id: string; n: number }>([
        { $match: facetFilter },
        { $group: { _id: '$actorEmail', n: { $sum: 1 } } },
        { $sort: { n: -1 } },
        { $limit: 20 },
      ]),
    ]);

    return NextResponse.json({
      rows: rows.map(r => ({
        id: String(r._id),
        at: r.createdAt,
        actorEmail: r.actorEmail,
        action: r.action,
        actionLabel: actionLabel(r.action),
        targetType: r.targetType,
        targetId: r.targetId ?? null,
        targetCount: r.targetIds?.length ?? null,
        targetLabel: r.targetLabel ?? null,
        summary: r.summary,
        before: r.before ?? null,
        after: r.after ?? null,
        impact: r.impact ?? null,
        snapshotTruncated: Boolean(r.snapshotTruncated),
        // `undoable` is recomputed from the action rather than trusted from the stored flag, so a
        // change to the undo rules takes effect on existing rows instead of only on new ones.
        undoable: isUndoable(r.action) && !r.undoneAt,
        undoneAt: r.undoneAt ?? null,
        undoneBy: r.undoneBy ?? null,
      })),
      pagination: { total, skip, limit, hasMore: skip + rows.length < total },
      facets: {
        actions: byAction.map(a => ({ action: a._id, label: actionLabel(a._id), count: a.n })),
        actors: byActor.map(a => ({ actorEmail: a._id, count: a.n })),
      },
    });
  } catch (error) {
    console.error('Audit log read failed:', error);
    return NextResponse.json({ error: 'Failed to load the audit log' }, { status: 500 });
  }
}
