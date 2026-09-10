import { NextRequest, NextResponse } from 'next/server';
import mongoose from 'mongoose';
import connectDB from '@/lib/mongodb';
import Event from '@/lib/models/Event';
import { requireAdmin } from '@/lib/api-auth';
import { validateEventUpdate, eventValidationError } from '@/lib/events/admin-validate';
import { diffFields, recordAudit, redactSnapshot, type AuditAction } from '@/lib/admin/audit';
import { fetchEventImpacts } from '@/lib/admin/impact';

/**
 * The AUDITED event mutation path, for the control room.
 *
 * ── WHY THIS EXISTS BESIDE `PUT/DELETE /api/events/[id]` ────────────────────────────────────
 *
 * That route is correct and stays. What it cannot do is write an audit row, because an audit row
 * needs a before-snapshot taken in the same handler as the write — and it has no business knowing
 * about the admin console. So the console posts here instead, and gets three things the plain route
 * does not offer:
 *
 *   1. an `AuditLog` row per change, with before/after, so "what did I change last Tuesday" has an
 *      answer and every field edit is attributable;
 *   2. a whole-document snapshot on delete, which is what makes Undo real rather than a promise;
 *   3. a SERVER-SIDE impact gate. The dialog in the UI is a courtesy; this is the boundary. A delete
 *      that would strand a user's tracked event or their scanned contacts is refused with 409 and
 *      the report, and only proceeds with an explicit `?force=true`.
 *
 * It deliberately does NOT import anything from the other route file. A route module is a framework
 * entry point, and importing one from another puts it into a second module graph — which once put
 * every `/api/*` path into a 404, `/api/auth/csrf` included. The shared logic lives in
 * `lib/events/admin-validate.ts` and `lib/admin/*`, which is where it belongs.
 *
 * ── THE DELETE IS SOFT ──────────────────────────────────────────────────────────────────────
 *
 * `$set: { deletedAt }`, not `deleteOne`. A hard delete cannot be undone, and a re-scrape only
 * restores an event if its source still lists it — which for junk removal is precisely when it does
 * not. `lib/events/query.ts` excludes deleted rows from every listing, count and facet, and
 * `canViewEvent` refuses them on the id-addressable paths.
 *
 * ── ONE THING THAT LOOKED LIKE IT WOULD JUST WORK, AND DID NOT ──────────────────────────────
 *
 * An earlier draft of this comment claimed undo needed no change, because `restore-document`
 * already treats a duplicate-key failure as "already back in the corpus". That reasoning is
 * exactly inverted for a soft delete. The row never left, so `new Event(snapshot).save()` collides
 * with the unique `dedupHash`, the handler reports **200 `already-present`**, and `deletedAt` is
 * still set — an undo that tells the operator it succeeded and leaves the event invisible for
 * good. `POST /api/admin/audit/undo` therefore clears `deletedAt` on an existing row FIRST and
 * only falls back to re-creating from the snapshot when no row is there.
 */

/** Which audit verb a patch represents. A one-field toggle deserves its own name in the log. */
function actionForPatch(update: Record<string, unknown>): AuditAction {
  const keys = Object.keys(update);
  if (keys.length === 1 && keys[0] === 'isTechEvent') {
    return update.isTechEvent ? 'event.tech.flag' : 'event.tech.unflag';
  }
  if (keys.length === 1 && keys[0] === 'spotlightAt') {
    // `spotlightAt` is EDITORIAL — a human chose it, and nothing recomputes or clears it. Unpinning
    // arrives as an explicit null because `$set` cannot express `$unset`, and the home page matches
    // `{ $type: 'date' }`, so a stored null correctly reads as unpinned. Under `$exists` it would
    // read as pinned, which is the trap this comment exists to keep closed.
    return update.spotlightAt ? 'event.spotlight.pin' : 'event.spotlight.unpin';
  }
  return 'event.update';
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // GUARD FIRST. Before any body parsing, any validation, any param work — an anonymous caller must
  // get 401, never a 400 that tells them their payload parsed far enough to be judged.
  const gate = await requireAdmin();
  if ('response' in gate) return gate.response;

  const { id } = await params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return NextResponse.json({ error: 'Invalid event id' }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'request body must be valid JSON' }, { status: 400 });
  }

  // The SAME allowlist the plain admin route uses, imported not mirrored — so identity
  // (`clusterKey`, `dedupHash`), provenance (`lastSeenAt`, `source`) and derived fields
  // (`connectionScore`, `companies`) are unreachable from here too.
  const { update, issues } = validateEventUpdate(body);
  if (issues.length > 0) return NextResponse.json(eventValidationError(issues), { status: 400 });
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'no editable fields were supplied' }, { status: 400 });
  }

  try {
    await connectDB();

    // Read BEFORE writing, projecting only the fields the patch touches plus the title for the log.
    // A full document would be wasteful and would tempt a future edit into logging fields the action
    // never went near.
    const projection: Record<string, 1> = { title: 1 };
    for (const key of Object.keys(update)) projection[key] = 1;
    const before = await Event.findById(id, projection).lean();
    if (!before) return NextResponse.json({ error: 'Event not found' }, { status: 404 });

    const updated = await Event.findByIdAndUpdate(id, { $set: update }, { new: true, runValidators: true });
    if (!updated) return NextResponse.json({ error: 'Event not found' }, { status: 404 });

    const changes = diffFields(before as unknown as Record<string, unknown>, update);

    // A no-op patch is not logged. An audit trail where every save lists twenty unchanged fields is
    // unreadable, and it makes "who changed this" answer with the wrong person.
    let auditId: string | null = null;
    if (changes.length > 0) {
      const action = actionForPatch(update);
      auditId = await recordAudit({
        actorId: gate.userId,
        actorEmail: gate.email,
        action,
        targetType: 'event',
        targetId: id,
        targetLabel: (before as { title?: string }).title,
        // `before` holds exactly the previous values of the fields that changed — which is also the
        // patch an undo writes back, so no inversion logic is needed at undo time.
        before: Object.fromEntries(changes.map(c => [c.field, c.before])),
        after: Object.fromEntries(changes.map(c => [c.field, c.after])),
        changes,
      });
    }

    return NextResponse.json({
      event: { _id: String(updated._id), title: updated.title },
      changed: changes.map(c => c.field),
      auditId,
    });
  } catch (error) {
    console.error('Admin event update failed:', error);
    if (error instanceof mongoose.Error.ValidationError || error instanceof mongoose.Error.CastError) {
      // 400, and with no `details`: the message carries the model name and the schema path, which is
      // free reconnaissance on the internal shape of the data. The real wording is in the log.
      return NextResponse.json({ error: 'Invalid event' }, { status: 400 });
    }
    return NextResponse.json({ error: 'Failed to update event' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireAdmin();
  if ('response' in gate) return gate.response;

  const { id } = await params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return NextResponse.json({ error: 'Invalid event id' }, { status: 400 });
  }
  const force = request.nextUrl.searchParams.get('force') === 'true';

  try {
    await connectDB();

    const doc = await Event.findById(id).lean();
    if (!doc) return NextResponse.json({ error: 'Event not found' }, { status: 404 });

    // The impact gate. `fetchEventImpacts` runs the referrer queries `cleanup-non-bengaluru.ts`
    // established — tracked by a user, or a scan folder built for it — and a blocking verdict needs
    // an explicit override. Refusing here rather than only in the dialog is the difference between
    // an impact preview and a decoration.
    const impact = (await fetchEventImpacts([id])).get(id);
    if (impact && impact.severity === 'blocked' && !force) {
      return NextResponse.json(
        {
          error: 'A user has acted on this event',
          detail: 'Re-send with ?force=true to delete it anyway. The audit log keeps a restorable copy.',
          impact,
        },
        { status: 409 }
      );
    }

    // The snapshot IS the backup, and it is taken before the row goes. `_id` is kept so a restore
    // reuses it, which makes every dangling TrackerEntry.eventId and Folder.eventId live again by
    // itself rather than leaving a user's board pointing at nothing.
    const snapshot = redactSnapshot(doc as unknown as Record<string, unknown>);

    /*
     * SOFT DELETE. The row stays; `deletedAt` takes it out of every listing, count, facet, ICS
     * file, "similar events" rail and MCP response, via `notDeletedClause()` in
     * `lib/events/query.ts` and the first check in `canViewEvent`.
     *
     * `updateOne` rather than the document's own `.save()` deliberately: `pre('validate')` re-derives
     * `dedupHash` and `clusterKey`, and this write must not be able to change either. Nothing
     * re-derives on an update path, which here is the property we want rather than the trap it
     * usually is.
     *
     * The snapshot above is now belt-and-braces rather than the backup, and is kept for two
     * reasons: it is what the audit log shows as `before`, and `DELETE /api/events/[id]` — the
     * plain non-audited route — still hard-deletes, so a restore path that only knew how to
     * un-delete would have nothing to work from for rows removed that way.
     */
    await Event.updateOne({ _id: id }, { $set: { deletedAt: new Date() } });

    const auditId = await recordAudit({
      actorId: gate.userId,
      actorEmail: gate.email,
      action: 'event.delete',
      targetType: 'event',
      targetId: id,
      targetLabel: (doc as { title?: string }).title,
      before: snapshot.doc,
      snapshotTruncated: snapshot.truncated,
      // What the preview said at the time, including anything that was overridden. Without this the
      // log records that a delete happened but not that it was known to strand somebody's contacts.
      impact: impact ? { ...impact, forced: force } : undefined,
    });

    return NextResponse.json({
      deleted: id,
      auditId,
      undoable: true,
      snapshotTruncated: snapshot.truncated,
    });
  } catch (error) {
    console.error('Admin event delete failed:', error);
    return NextResponse.json({ error: 'Failed to delete event' }, { status: 500 });
  }
}
