import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongodb';
import Event from '@/lib/models/Event';
import TrackerEntry from '@/lib/models/TrackerEntry';
import Folder from '@/lib/models/Folder';
import mongoose from 'mongoose';
import { requireAdmin, requireUser } from '@/lib/api-auth';
import { getCurrentUserId } from '@/lib/auth-helpers';
import { canViewEvent } from '@/lib/events/visibility';
import { DETAIL_SELECT, notDeletedClause, publicEventScope } from '@/lib/events/query';
import { validateEventUpdate, eventValidationError } from '@/lib/events/admin-validate';
import { validateOwnerEdit, resolveOwnerEdit, ownerDeleteMode } from '@/lib/events/owner-edit';
import { toEventDetail } from '@/lib/events/serialize';
import { loadViewerStates } from '@/lib/events/viewer-state';
/*
 * The same exact-canonical-origin check `DELETE /api/me/account` makes, imported from where it lives
 * rather than retyped: it is the one tested definition of "this request came from our own page".
 * It sits in `lib/account-deletion.ts` today and belongs in `lib/canonical-origin.ts`.
 */
import { hasExactCanonicalOrigin } from '@/lib/account-deletion';

/**
 * Same-origin, failing CLOSED. `canonicalOrigin()` throws in production when `NEXTAUTH_URL` is unset;
 * that must refuse the write, not 500 it.
 *
 * Why an Origin check on top of `requireUser()`: the session cookie is SameSite=Lax, which already
 * keeps a cross-SITE page from sending it on a PATCH/DELETE. This closes the same-site case (a
 * sibling subdomain on a custom domain) for the two requests here that destroy or unpublish somebody's
 * work. Browsers always send `Origin` on a same-origin PATCH/DELETE, so a real client is unaffected.
 */
function isSameOrigin(request: NextRequest): boolean {
  try {
    return hasExactCanonicalOrigin(request.headers.get('origin'));
  } catch {
    return false;
  }
}

const NOT_FOUND = { error: 'Event not found' };

// GET /api/events/[id] - Get a single event
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await connectDB();
    const { id } = await params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json({ error: 'Invalid event ID' }, { status: 400 });
    }

    /*
     * PROJECTED THROUGH `DETAIL_SELECT`, and the projection is the fix for a leak: this used to be an
     * unprojected `findById().lean()` returned whole, which sent every anonymous caller the
     * submitter's Google `sub` on any approved user event (`createdByUserId`, and again inside
     * `clusterKey`). `DETAIL_SELECT` still carries `visibility`, `createdByUserId` and `deletedAt` —
     * the three fields `canViewEvent` reads and treats as permissive when absent — and
     * `toEventDetail` never copies them out.
     */
    const event = await Event.findById(id).select(DETAIL_SELECT).lean();

    if (!event) {
      return NextResponse.json(NOT_FOUND, { status: 404 });
    }

    /**
     * Ownership check BEFORE `related` is built, so a refused request costs one query.
     *
     * 404 rather than 403: a 403 confirms the row exists, and an ObjectId embeds a timestamp and a
     * counter, so one known id makes its neighbours enumerable. The message is identical to the
     * genuinely-missing case on purpose.
     */
    const viewerId = await getCurrentUserId();
    if (!canViewEvent(event, viewerId)) {
      return NextResponse.json(NOT_FOUND, { status: 404 });
    }

    // "Similar events" for the detail page: same categories, still upcoming,
    // soonest first. Excludes this event and anything already finished.
    //
    // THE VISIBILITY CLAUSE HERE IS NOT BELT-AND-BRACES. Without it, other users' private events
    // appear as suggestions at the bottom of every public event page — a leak that needs no id
    // guessing at all, just a visit to any event.
    const [related, viewer] = await Promise.all([
      Event.find({
        _id: { $ne: event._id },
        startDateTime: { $gte: new Date() },
        category: { $in: event.category?.length ? event.category : ['Networking/Meetup'] },
        // `publicEventScope`, NOT `visibilityClause`: this hand-rolled filter must also exclude
        // soft-deleted rows, and would not have inherited that from `buildEventFilter`.
        ...publicEventScope(viewerId),
      })
        .select('title startDateTime venue area format imageUrl category isFree price organizer')
        .sort({ startDateTime: 1 })
        .limit(6)
        .lean(),
      loadViewerStates([event], viewerId),
    ]);

    return NextResponse.json(
      { event: toEventDetail(event, viewerId, viewer.get(String(event._id))), related },
      // Per-viewer now (`tracked`, the owner block), so nothing between here and the browser may
      // keep a copy. `sw.js` already treats `/api/events` as network-only; this says it to everyone.
      { headers: { 'Cache-Control': 'private, no-store' } }
    );
  } catch (error) {
    console.error('Error fetching event:', error);
    return NextResponse.json({ error: 'Failed to fetch event' }, { status: 500 });
  }
}

// PUT /api/events/[id] - Update an event. ADMIN ONLY: events are global, so an open
// update endpoint lets anyone rewrite any event's title, time or applyLink.
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const gate = await requireAdmin();
  if ('response' in gate) return gate.response;

  const { id } = await params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return NextResponse.json({ error: 'Invalid event ID' }, { status: 400 });
  }

  /*
   * VALIDATE BEFORE connectDB(), AFTER the guard. A bad request needs no database to refuse, and
   * the guard must answer first so an anonymous caller gets 401 rather than 400 — a 400 would tell
   * a stranger their body parsed far enough to be judged. See the ordering note in CLAUDE.md §6.
   */
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'request body must be valid JSON' }, { status: 400 });
  }

  /*
   * An ALLOWLIST, replacing `{ $set: body }` with only `dedupHash` removed.
   *
   * That was survivable while the only caller sent two booleans and a date; it is not once a real
   * edit form exists. A raw `$set` let a typo rewrite `clusterKey` (identity — the event detaches
   * from its cluster and the next scrape stores a duplicate), `lastSeenAt` (provenance — decides
   * when `pruneStale()` deletes the row), or `connectionScore` / `companies` (derived — the next
   * backfill silently reverts the change, so the admin watches their edit vanish).
   */
  const { update, issues } = validateEventUpdate(body);
  if (issues.length > 0) {
    return NextResponse.json(eventValidationError(issues), { status: 400 });
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'no editable fields were supplied' }, { status: 400 });
  }

  try {
    await connectDB();

    const event = await Event.findByIdAndUpdate(
      id,
      { $set: update },
      { new: true, runValidators: true }
    );

    if (!event) {
      return NextResponse.json(NOT_FOUND, { status: 404 });
    }

    return NextResponse.json({ event });
  } catch (error) {
    console.error('Error updating event:', error);
    // `details` used to carry `error.message`, which handed back the model name and the schema
    // path — free reconnaissance on the internal shape of the data. Nothing read it; the real
    // wording is in the server log. Unreachable while the validator and the schema agree.
    if (error instanceof mongoose.Error.ValidationError || error instanceof mongoose.Error.CastError) {
      return NextResponse.json({ error: 'Invalid event' }, { status: 400 });
    }
    return NextResponse.json({ error: 'Failed to update event' }, { status: 500 });
  }
}

/**
 * PATCH /api/events/[id] — the AUTHOR edits their own hand-added event.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * OWNER ONLY, and the scope is in the QUERY: `{ _id, createdByUserId: me, deletedAt: null }`. Anyone
 * else — an admin included, who has `PUT` here and the audited `/api/admin/events/[id]` — gets the
 * same 404 as a missing id, never a 403: a 403 would confirm the row exists. `deletedAt: null` means
 * an event an admin removed cannot be revived by its author editing it.
 *
 * ORDER: guard (401) → origin (403) → id (400) → body (400) → phase-one validation (400), all before
 * `connectDB()`; then the owner-scoped fetch; then phase-two rules against the stored row.
 *
 * WHAT IT DOES (`lib/events/owner-edit.ts`): allowlisted fields only; `isTechEvent` and
 * `connectionScore` re-derived from their inputs; a no-op save writes nothing; and a REAL change to
 * an approved public event sends it back to `visibility: 'pending'` for re-review.
 *
 * `findOne` + assign + `.save()`, the rule for Event writes: the `pre('validate')` key hook is
 * fill-if-missing, so `dedupHash` and the owner-namespaced `clusterKey` are PRESERVED, which is what
 * keeps an owned row structurally unmergeable by a scrape (see `Event.generateClusterKey`).
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;
  if (!isSameOrigin(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { id } = await params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return NextResponse.json({ error: 'Invalid event ID' }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'request body must be valid JSON' }, { status: 400 });
  }

  const { patch, issues } = validateOwnerEdit(body);
  if (issues.length > 0) return NextResponse.json(eventValidationError(issues), { status: 400 });
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'no editable fields were supplied' }, { status: 400 });
  }

  try {
    await connectDB();

    const event = await Event.findOne({
      _id: id,
      createdByUserId: gate.userId,
      ...notDeletedClause(),
    });
    if (!event) return NextResponse.json(NOT_FOUND, { status: 404 });

    const resolved = resolveOwnerEdit(patch, event.toObject());
    if (resolved.issues.length > 0) {
      return NextResponse.json(eventValidationError(resolved.issues), { status: 400 });
    }

    if (resolved.changed.length > 0) {
      // `set(key, undefined)` becomes `$unset` on save, which is how a cleared end time or price
      // leaves the row rather than being stored as null.
      for (const [key, value] of Object.entries(resolved.update)) event.set(key, value);
      if (resolved.visibility) event.set('visibility', resolved.visibility);
      await event.save();
    }

    const saved = event.toObject();
    const viewer = await loadViewerStates([saved], gate.userId);
    return NextResponse.json(
      {
        event: toEventDetail(saved, gate.userId, viewer.get(String(saved._id))),
        changed: resolved.changed,
        reReview: resolved.visibility === 'pending',
      },
      { headers: { 'Cache-Control': 'private, no-store' } }
    );
  } catch (error) {
    console.error('Owner event update failed:', error);
    // `.save()` validates the WHOLE document, so a legacy value already on the row (a retired
    // category, say) can refuse a save that touched only the title. Named in the log, not here —
    // the Mongoose message carries the model and the schema path.
    if (error instanceof mongoose.Error.ValidationError || error instanceof mongoose.Error.CastError) {
      return NextResponse.json(
        { error: 'This event holds a value that can no longer be saved. Nothing was changed.' },
        { status: 400 }
      );
    }
    return NextResponse.json({ error: 'Failed to update event' }, { status: 500 });
  }
}

/**
 * DELETE /api/events/[id].
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * TWO CALLERS, DISPATCHED BY OWNERSHIP, OWNERSHIP FIRST.
 *
 *   · The event's AUTHOR (admin or not): the owner rule. SOFT (`deletedAt`) when the event is public
 *     or anyone else has tracked it or built a folder for it; HARD otherwise. Reasoning on
 *     `ownerDeleteMode`. An admin's own event follows the owner rule too, because "somebody else
 *     depends on this row" does not stop being true for an admin.
 *   · Anyone else: the ADMIN hard delete below, unchanged — `requireAdmin()` and
 *     `findByIdAndDelete`. No UI calls it (the console uses the audited, soft
 *     `/api/admin/events/[id]`).
 *
 * A signed-in non-owner who is not an admin gets 404 for EVERY id, existing or not — never the 403
 * `requireAdmin()` would give — so the answer says nothing about whether the row exists.
 *
 * Anonymous is 401 now (it was 401/403/503 from `requireAdmin()`); `diag-api-auth.ts` accepts any
 * refusal code for a signed-out request.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await requireUser();
  if ('response' in user) return user.response;

  try {
    const { id } = await params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json({ error: 'Invalid event ID' }, { status: 400 });
    }

    await connectDB();

    const owned = await Event.findOne({
      _id: id,
      createdByUserId: user.userId,
      ...notDeletedClause(),
    })
      .select('_id visibility createdByUserId deletedAt')
      .lean();

    if (owned) {
      if (!isSameOrigin(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

      // Counted at delete time, not trusted from the confirm dialog: the dialog's numbers are a
      // preview, and a row other people depend on must never be hard-deleted on a stale preview.
      const [savedByOthers, foldersByOthers] = await Promise.all([
        TrackerEntry.countDocuments({ eventId: owned._id, userId: { $ne: user.userId } }),
        Folder.countDocuments({ eventId: owned._id, userId: { $ne: user.userId } }),
      ]);
      const mode = ownerDeleteMode({
        visibility: owned.visibility,
        othersReferencing: savedByOthers + foldersByOthers,
      });

      // Both writes re-state the owner in the filter, so a race can only ever act on the caller's
      // own row. `updateOne`, not `.save()`, for the soft delete — the admin console's reason: a
      // delete must not be able to touch either identity key.
      if (mode === 'soft') {
        await Event.updateOne(
          { _id: owned._id, createdByUserId: user.userId },
          { $set: { deletedAt: new Date() } }
        );
      } else {
        await Event.deleteOne({ _id: owned._id, createdByUserId: user.userId });
      }

      return NextResponse.json(
        { deleted: id, mode, savedByOthers },
        { headers: { 'Cache-Control': 'private, no-store' } }
      );
    }

    // Not the author. The admin path, exactly as it was — and a 404 for everyone else.
    const admin = await requireAdmin();
    if ('response' in admin) return NextResponse.json(NOT_FOUND, { status: 404 });

    const event = await Event.findByIdAndDelete(id);

    if (!event) {
      return NextResponse.json(NOT_FOUND, { status: 404 });
    }

    return NextResponse.json({ message: 'Event deleted successfully' });
  } catch (error) {
    console.error('Error deleting event:', error);
    return NextResponse.json({ error: 'Failed to delete event' }, { status: 500 });
  }
}
