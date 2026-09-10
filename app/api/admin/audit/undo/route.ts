import { NextRequest, NextResponse } from 'next/server';
import mongoose from 'mongoose';
import connectDB from '@/lib/mongodb';
import AuditLog from '@/lib/models/AuditLog';
import Event from '@/lib/models/Event';
import Source from '@/lib/models/Source';
import { requireAdmin } from '@/lib/api-auth';
import { recordAudit, undoKind } from '@/lib/admin/audit';

/**
 * POST /api/admin/audit/undo — put it back.
 *
 * ── WHY UNDO IS POSSIBLE AT ALL WITHOUT SOFT DELETE ─────────────────────────────────────────
 *
 * Soft delete is the right long-term shape and belongs to another stream. Until it lands, the audit
 * row IS the backup: `event.delete` stores the whole document in `before`, and this re-creates it.
 * Two details make that a real restore rather than an approximation:
 *
 *   · the ORIGINAL `_id` is reused, so every `TrackerEntry.eventId` and `Folder.eventId` that went
 *     dangling becomes live again on its own. Restoring under a fresh id would leave a user's board
 *     pointing at nothing with an identical row beside it — an undo that reports success and fixes
 *     nothing.
 *   · it goes through `new Model(...)` + `.save()`, never `insertOne`, so the `pre('validate')` hooks
 *     re-derive `dedupHash` and `clusterKey` from the stored fields. Same inputs, same keys, so the
 *     row rejoins its own cluster instead of arriving as a duplicate. This is also why a restore
 *     cannot be done with `findOneAndUpdate`: `pre('validate')` does not run on update paths, and
 *     both keys are `required`.
 *
 * ── THE DUPLICATE-KEY CASE IS A SUCCESS, NOT AN ERROR ───────────────────────────────────────
 *
 * A scrape may have re-created the event between the delete and the undo. The restore then hits the
 * unique `dedupHash` index. The desired end state — the event is in the corpus — has been reached,
 * so this answers 200 and says so. Reporting E11000 to the operator would send them looking for a
 * bug in the thing that just worked.
 *
 * ── WHAT UNDO REFUSES ───────────────────────────────────────────────────────────────────────
 *
 * Submission decisions. Both directions are already reversible through the submissions queue, and
 * re-deciding one is a judgement rather than a correction — routing it through a generic undo would
 * write the visibility field without the review the panel exists to force.
 */

export async function POST(request: NextRequest) {
  const gate = await requireAdmin();
  if ('response' in gate) return gate.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'request body must be valid JSON' }, { status: 400 });
  }

  const id = (body as { id?: unknown })?.id;
  if (typeof id !== 'string' || !mongoose.Types.ObjectId.isValid(id)) {
    return NextResponse.json({ error: 'a valid audit row id is required' }, { status: 400 });
  }

  try {
    await connectDB();

    const row = await AuditLog.findById(id);
    if (!row) return NextResponse.json({ error: 'No such audit entry' }, { status: 404 });
    if (row.undoneAt) {
      return NextResponse.json(
        { error: 'That change has already been undone.', undoneAt: row.undoneAt },
        { status: 409 }
      );
    }

    const kind = undoKind(row.action);
    if (kind === 'none') {
      return NextResponse.json(
        {
          error: `“${row.summary}” cannot be undone from here.`,
          detail:
            row.targetType === 'submission'
              ? 'Re-decide it in Submissions — that keeps the review step the queue exists for.'
              : 'This action has no automatic reverse.',
        },
        { status: 400 }
      );
    }

    let outcome = '';

    if (kind === 'restore-document') {
      const snapshot = row.before as Record<string, unknown> | undefined;
      if (!snapshot || !snapshot._id) {
        return NextResponse.json(
          { error: 'That entry has no restorable snapshot.' },
          { status: 400 }
        );
      }

      if (row.targetType === 'event') {
        /*
         * UN-DELETE FIRST, RE-CREATE SECOND. The order is the whole correctness argument.
         *
         * `DELETE /api/admin/events/[id]` is a SOFT delete, so the row is still there with
         * `deletedAt` set. Going straight to `new Event(snapshot).save()` collides with the unique
         * `dedupHash`, lands in the duplicate-key branch below, and answers 200 `already-present`
         * — while `deletedAt` stays set and the event remains invisible in every listing. An undo
         * that reports success and restores nothing is worse than one that fails, because nobody
         * goes looking.
         *
         * So: clear the flag if a row exists, and only reach for the snapshot when none does. The
         * fallback is not dead code — `DELETE /api/events/[id]`, the plain non-audited route, still
         * hard-deletes, and audit rows written before soft delete existed describe rows that are
         * genuinely gone.
         */
        const undeleted = await Event.updateOne(
          { _id: snapshot._id as string },
          { $unset: { deletedAt: '' } }
        );

        if (undeleted.matchedCount > 0) {
          outcome = 'restored';
        } else {
          try {
            await new Event(snapshot).save();
            outcome = 'restored';
          } catch (err) {
            if ((err as { code?: number }).code === 11000) {
              // Genuinely already back: no row under the original `_id`, but a scrape re-created
              // the event under a new one between the delete and the undo. End state reached.
              outcome = 'already-present';
            } else {
              throw err;
            }
          }
        }
      } else {
        try {
          await new Source(snapshot).save();
          outcome = 'restored';
        } catch (err) {
          if ((err as { code?: number }).code === 11000) outcome = 'already-present';
          else throw err;
        }
      }
    } else if (kind === 'restore-fields') {
      // `before` holds exactly the previous values of the fields that changed, which IS the patch —
      // no inversion needed. A null in it means "clear this", which is correct for `spotlightAt`:
      // `$set: null` is what the home page's `{ $type: 'date' }` filter reads as unpinned.
      const patch = (row.before ?? {}) as Record<string, unknown>;
      if (Object.keys(patch).length === 0) {
        return NextResponse.json({ error: 'That entry recorded no field changes.' }, { status: 400 });
      }
      // Branched rather than selecting a model into a variable: the two Model types are structurally
      // different enough that a union of them is not callable, and `as any` here would switch off
      // checking on the one write whose whole job is to put a document back exactly as it was.
      const res =
        row.targetType === 'event'
          ? await Event.updateOne({ _id: row.targetId }, { $set: patch })
          : await Source.updateOne({ _id: row.targetId }, { $set: patch });
      outcome = res.matchedCount === 0 ? 'target-missing' : 'restored';
    } else {
      // 're-enable' — a bulk disable, reversed in one write so one undo covers the whole batch.
      const ids = row.targetIds ?? [];
      if (ids.length === 0) {
        return NextResponse.json({ error: 'That entry names no sources.' }, { status: 400 });
      }
      const res = await Source.updateMany({ _id: { $in: ids } }, { $set: { enabled: true } });
      outcome = `re-enabled ${res.modifiedCount} of ${ids.length}`;
    }

    if (outcome === 'target-missing') {
      return NextResponse.json(
        {
          error: 'The row this change applied to no longer exists, so there is nothing to restore.',
          detail: 'It was probably deleted afterwards — undo that delete first.',
        },
        { status: 409 }
      );
    }

    row.undoneAt = new Date();
    row.undoneBy = gate.email;
    await row.save();

    // The undo is itself an admin mutation, so it gets its own row. An audit log that records the
    // change but not the reversal tells you the wrong current state.
    await recordAudit({
      actorId: gate.userId,
      actorEmail: gate.email,
      action: row.targetType === 'event' ? 'event.restore' : 'source.enable',
      targetType: row.targetType,
      targetId: row.targetId,
      targetIds: row.targetIds,
      targetLabel: row.targetLabel,
      summary: `Undid: ${row.summary}${outcome === 'already-present' ? ' (it was already back)' : ''}`,
    });

    return NextResponse.json({ undone: id, outcome });
  } catch (error) {
    console.error('Undo failed:', error);
    return NextResponse.json({ error: 'Failed to undo that change' }, { status: 500 });
  }
}
