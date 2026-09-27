/**
 * The per-viewer facts an event's detail carries — "have I saved this", and for the author, "who
 * else depends on it". SERVER ONLY (it queries), and batched, so `GET /api/me/events` pays the same
 * three queries for fifty events that the detail page pays for one.
 *
 * ONE MODULE FOR THREE CALLERS on purpose: `GET /api/events/[id]`, the `/events/[id]` page and
 * `GET /api/me/events` must agree on what "saved by others" counts and on what a delete would do, or
 * the confirm dialog on one surface describes a different outcome from the other.
 *
 * WHAT COUNTS AS "SOMEONE ELSE DEPENDS ON IT": another user's `TrackerEntry` OR `Folder` pointing at
 * the event — the same two referrers `lib/admin/impact.ts` prices a delete by. A folder is the
 * stronger of the two (they scanned people there), and it can exist without a tracker entry, since
 * `PATCH /api/folders/[id]` links a folder to an event directly.
 */
import { Types } from 'mongoose';
import TrackerEntry from '../models/TrackerEntry';
import Folder from '../models/Folder';
import { ownerDeleteMode } from './owner-edit';
import type { DetailViewerState } from './serialize';

interface ViewerDoc {
  _id: unknown;
  createdByUserId?: string | null;
  visibility?: string | null;
}

async function countByEvent(
  model: typeof TrackerEntry | typeof Folder,
  eventIds: Types.ObjectId[],
  excludeUserId: string
): Promise<Map<string, number>> {
  const rows = await (model as typeof TrackerEntry).aggregate<{ _id: unknown; n: number }>([
    { $match: { eventId: { $in: eventIds }, userId: { $ne: excludeUserId } } },
    { $group: { _id: '$eventId', n: { $sum: 1 } } },
  ]);
  return new Map(rows.map(row => [String(row._id), row.n]));
}

/** Viewer state per event id. Empty for an anonymous viewer — no key, no query. */
export async function loadViewerStates(
  docs: readonly ViewerDoc[],
  viewerId: string | null
): Promise<Map<string, DetailViewerState>> {
  const out = new Map<string, DetailViewerState>();
  if (!viewerId || docs.length === 0) return out;

  // Normalised to real ObjectIds: `distinct` wants a typed `$in`, and the aggregation below does no
  // casting at all, so a string here would silently match nothing.
  const toObjectId = (doc: ViewerDoc) => new Types.ObjectId(String(doc._id));
  const ids = docs.map(toObjectId);
  const ownedIds = docs.filter(doc => doc.createdByUserId === viewerId).map(toObjectId);

  const [trackedIds, savedByOthers, foldersByOthers] = await Promise.all([
    TrackerEntry.distinct('eventId', { userId: viewerId, eventId: { $in: ids } }),
    ownedIds.length ? countByEvent(TrackerEntry, ownedIds, viewerId) : new Map<string, number>(),
    ownedIds.length ? countByEvent(Folder, ownedIds, viewerId) : new Map<string, number>(),
  ]);
  const tracked = new Set(trackedIds.map(String));

  for (const doc of docs) {
    const key = String(doc._id);
    const state: DetailViewerState = { tracked: tracked.has(key) };
    if (doc.createdByUserId === viewerId) {
      const saved = savedByOthers.get(key) ?? 0;
      state.savedByOthers = saved;
      state.deleteMode = ownerDeleteMode({
        visibility: doc.visibility,
        othersReferencing: saved + (foldersByOthers.get(key) ?? 0),
      });
    }
    out.set(key, state);
  }
  return out;
}
