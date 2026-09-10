import { NextRequest, NextResponse } from 'next/server';
import mongoose from 'mongoose';
import connectDB from '@/lib/mongodb';
import Source from '@/lib/models/Source';
import { requireAdmin } from '@/lib/api-auth';
import { diffFields, recordAudit, redactSnapshot } from '@/lib/admin/audit';
import { classifySourceDelete } from '@/lib/admin/impact';

/**
 * The AUDITED source mutation path.
 *
 * `PUT /api/sources/[id]` exists and works; what it cannot do is write an audit row. Disabling a
 * source is the single most consequential reversible action in this app — 423 rows feed a corpus that
 * compounds through auto-discovery, and a source switched off by hand goes quiet in a way that is
 * indistinguishable in the feed from a source with nothing scheduled. Without a log, "why did Meetup
 * coverage drop in September" has no answer.
 *
 * ── WHY ONLY `enabled` IS EDITABLE HERE ─────────────────────────────────────────────────────
 *
 * A `Source` row is not inert data, it is an INSTRUCTION to the scraper: whatever sits in `url` or
 * `handle` gets fetched on the next run by a job with no user in front of it. The console's job is
 * on/off, so this route accepts exactly one boolean and drops everything else. In particular it will
 * not touch the health bookkeeping (`consecutiveEmptyScrapes`, `lastEventCount`, `lastError`), which
 * feeds both the digest's unhealthy-source report and `loadDiscovered()`'s ordering — a hand-set
 * value there either hides a dead feed or pushes a good one to the back of the queue.
 *
 * ── AND WHY DELETE STEERS TOWARDS DISABLE ───────────────────────────────────────────────────
 *
 * Deleting destroys persisted discovery state that took multiple scrapes to build and does not come
 * back on its own. A source currently returning events is BLOCKED outright unless forced.
 */

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireAdmin();
  if ('response' in gate) return gate.response;

  const { id } = await params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return NextResponse.json({ error: 'Invalid source id' }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'request body must be valid JSON' }, { status: 400 });
  }

  const enabled = (body as { enabled?: unknown })?.enabled;
  if (typeof enabled !== 'boolean') {
    return NextResponse.json(
      { error: 'enabled must be true or false', fields: [{ field: 'enabled', message: 'must be a boolean' }] },
      { status: 400 }
    );
  }

  try {
    await connectDB();

    const before = await Source.findById(id).select('name kind handle enabled lastEventCount').lean();
    if (!before) return NextResponse.json({ error: 'Source not found' }, { status: 404 });

    await Source.updateOne({ _id: id }, { $set: { enabled } });

    const changes = diffFields(before as Record<string, unknown>, { enabled });
    let auditId: string | null = null;
    if (changes.length > 0) {
      auditId = await recordAudit({
        actorId: gate.userId,
        actorEmail: gate.email,
        action: enabled ? 'source.enable' : 'source.disable',
        targetType: 'source',
        targetId: id,
        targetLabel: (before as { name?: string }).name,
        before: { enabled: !enabled },
        after: { enabled },
        changes,
      });
    }

    return NextResponse.json({ id, enabled, changed: changes.length > 0, auditId });
  } catch (error) {
    console.error('Admin source update failed:', error);
    return NextResponse.json({ error: 'Failed to update source' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireAdmin();
  if ('response' in gate) return gate.response;

  const { id } = await params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return NextResponse.json({ error: 'Invalid source id' }, { status: 400 });
  }
  const force = request.nextUrl.searchParams.get('force') === 'true';

  try {
    await connectDB();

    const doc = await Source.findById(id).lean();
    if (!doc) return NextResponse.json({ error: 'Source not found' }, { status: 404 });

    const row = doc as Record<string, unknown>;
    const impact = classifySourceDelete({
      source: {
        name: row.name as string,
        kind: row.kind as string,
        lastEventCount: row.lastEventCount as number,
      },
    });
    if (impact.severity === 'blocked' && !force) {
      return NextResponse.json(
        {
          error: 'This source is currently producing events',
          detail: 'Disable it instead, or re-send with ?force=true.',
          impact,
        },
        { status: 409 }
      );
    }

    const snapshot = redactSnapshot(row);
    await Source.deleteOne({ _id: id });

    const auditId = await recordAudit({
      actorId: gate.userId,
      actorEmail: gate.email,
      action: 'source.delete',
      targetType: 'source',
      targetId: id,
      targetLabel: row.name as string,
      before: snapshot.doc,
      snapshotTruncated: snapshot.truncated,
      impact: { ...impact, forced: force },
    });

    return NextResponse.json({ deleted: id, auditId, undoable: true });
  } catch (error) {
    console.error('Admin source delete failed:', error);
    return NextResponse.json({ error: 'Failed to delete source' }, { status: 500 });
  }
}
