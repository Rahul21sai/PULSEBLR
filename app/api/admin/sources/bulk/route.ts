import { NextRequest, NextResponse } from 'next/server';
import mongoose from 'mongoose';
import connectDB from '@/lib/mongodb';
import Source from '@/lib/models/Source';
import { requireAdmin } from '@/lib/api-auth';
import { recordAudit } from '@/lib/admin/audit';

/**
 * POST /api/admin/sources/bulk — switch a named set of sources on or off in one action.
 *
 * ── WHY THE CALLER SENDS IDS RATHER THAN A PREDICATE ────────────────────────────────────────
 *
 * The obvious design is `{ action: 'disable-dead' }` and let the server decide what "dead" means. It
 * is the wrong one. 138 sources currently have five or more consecutive empty scrapes, and the
 * operator needs to see WHICH before agreeing — the cap incident in this repo's history is exactly
 * what happens when a rule silently selects rows nobody looked at (200 Meetup groups against a cap
 * of 120 meant the same 80 were dropped on every run, including `microsoft-reactor-bengaluru` with 6
 * events and the Linux Foundation's group with 7). So the panel lists candidates, the operator reads
 * them, and the ids come back explicitly. The server re-checks nothing about "deadness" because the
 * human already did.
 *
 * ── ONE AUDIT ROW FOR THE WHOLE BATCH ──────────────────────────────────────────────────────
 *
 * `targetIds` holds every id, so one Undo re-enables all of them. 138 separate rows would make the
 * audit panel unreadable for a single decision, and undoing that decision would take 138 clicks.
 *
 * ── ENABLE IS NOT SYMMETRICAL WITH DISABLE, AND THAT IS FINE ────────────────────────────────
 *
 * Both are offered because the reverse of a bulk mistake has to be as cheap as the mistake. Neither
 * is destructive: `enabled` is a flag the pipeline reads, the row and its discovery state survive
 * either way, and re-enabling a source simply means the next run fetches it again.
 */

/**
 * Cap. High enough to disable every currently-dead source in one action (138 today), low enough that
 * a runaway client cannot rewrite the whole collection in one request.
 */
const MAX_IDS = 300;

export async function POST(request: NextRequest) {
  const gate = await requireAdmin();
  if ('response' in gate) return gate.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'request body must be valid JSON' }, { status: 400 });
  }

  const { ids, enabled } = (body ?? {}) as { ids?: unknown; enabled?: unknown };

  if (typeof enabled !== 'boolean') {
    return NextResponse.json({ error: 'enabled must be true or false' }, { status: 400 });
  }
  if (!Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json({ error: 'ids must be a non-empty array' }, { status: 400 });
  }
  if (ids.length > MAX_IDS) {
    return NextResponse.json(
      { error: `at most ${MAX_IDS} sources can be changed at once`, count: ids.length },
      { status: 400 }
    );
  }
  const clean = ids.filter((id): id is string => typeof id === 'string' && mongoose.Types.ObjectId.isValid(id));
  if (clean.length !== ids.length) {
    return NextResponse.json({ error: 'every id must be a valid ObjectId' }, { status: 400 });
  }

  try {
    await connectDB();

    /**
     * Only the rows that would actually CHANGE are recorded, and they are read before the write.
     *
     * Disabling 138 sources of which 20 were already off must undo to "those 118 back on", not "all
     * 138 on" — otherwise the undo turns 20 deliberate exclusions back on as a side effect. This is
     * the bulk equivalent of not logging a no-op patch.
     */
    const willChange = await Source.find({ _id: { $in: clean }, enabled: { $ne: enabled } })
      .select('name kind handle enabled')
      .lean();

    if (willChange.length === 0) {
      return NextResponse.json({
        changed: 0,
        enabled,
        detail: `All ${clean.length} were already ${enabled ? 'enabled' : 'disabled'}.`,
        auditId: null,
      });
    }

    const changedIds = willChange.map((s: Record<string, unknown>) => String(s._id));
    const res = await Source.updateMany({ _id: { $in: changedIds } }, { $set: { enabled } });

    const auditId = await recordAudit({
      actorId: gate.userId,
      actorEmail: gate.email,
      // `source.bulk.disable` undoes by RE-ENABLING, so a bulk enable is logged as the individual
      // verb: there is no "bulk enable" undo that would make sense (the reverse of turning things on
      // is turning them off, which is the disable path with its own confirmation).
      action: enabled ? 'source.enable' : 'source.bulk.disable',
      targetType: 'source',
      targetIds: changedIds,
      targetLabel:
        changedIds.length === 1
          ? ((willChange[0] as { name?: string }).name ?? 'one source')
          : `${changedIds.length} sources`,
      before: { enabled: !enabled },
      after: { enabled },
      impact: {
        // The names go in the row, not just the count: "disabled 138 sources" is unauditable a month
        // later, and this is the field that answers "which ones".
        names: willChange
          .slice(0, MAX_IDS)
          .map((s: Record<string, unknown>) => (s.name as string) ?? (s.handle as string) ?? String(s._id)),
        skippedAlreadyInState: clean.length - changedIds.length,
      },
    });

    return NextResponse.json({
      changed: res.modifiedCount,
      enabled,
      skipped: clean.length - changedIds.length,
      auditId,
    });
  } catch (error) {
    console.error('Bulk source update failed:', error);
    return NextResponse.json({ error: 'Failed to update those sources' }, { status: 500 });
  }
}
