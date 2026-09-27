/**
 * WHAT THE TRACKER API MAY SAY ABOUT THE EVENT BEHIND AN ENTRY.
 *
 * Pure: no mongoose, no network. The routes query and hand the rows in; this decides what leaves the
 * server. Same arrangement as `lib/tracker/validate.ts`, so `tests/tracker-entry-view.test.ts` can pin
 * it with no database.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THREE DEFECTS THIS REPLACES.
 *
 *   1. `.populate('eventId')` with no projection sent the WHOLE event document with every tracker
 *      entry — dedup and cluster keys, tagger confidence, scraper bookkeeping, and `createdByUserId`,
 *      which on a submitted event is ANOTHER user's id. The tracker page reads nine fields.
 *      `TRACKER_EVENT_FIELDS` is those nine, copied through an allowlist, so a field added to the
 *      select later still cannot reach the client by accident.
 *
 *   2. Nothing re-decided visibility after the entry was made. `POST /api/tracker` checks
 *      `canViewEvent` once, at tracking time, but an event can become unreadable afterwards: an admin
 *      soft-deletes it, or a submission reverts to its author's `private`. The list kept serving it,
 *      and moving the entry to Confirmed copied its title and venue into a folder. `toTrackerEvent`
 *      decides on every read — which is why the SELECT carries the three guard fields even though none
 *      is ever sent (`canViewEvent` treats an unfetched field as permissive, so an incomplete select
 *      fails OPEN).
 *
 *   3. An entry whose event had gone came back with `eventId: null`, and the page dropped it — its
 *      status, notes and people with it. Such an entry is now kept and labelled, and when the user has
 *      a folder for that event (`ensureFolderForEvent` denormalises the title and date onto it) the
 *      entry carries that as `lastKnown`, so the row can still say WHICH event it was. Measured when
 *      this was written: 12 of 16 tracker entries pointed at a deleted event, and 9 of those 12 had a
 *      folder that still knew its name.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
import { canViewEvent, type ViewableEvent } from '../events/visibility';

/** Every event field `app/tracker/page.tsx` reads — and, in `PUT`, `ensureFolderForEvent`. Sent. */
export const TRACKER_EVENT_FIELDS = [
  '_id',
  'title',
  'startDateTime',
  'venue',
  'area',
  'city',
  'format',
  'category',
  'imageUrl',
] as const;

/**
 * Read ONLY to decide visibility, and never sent.
 *
 * `createdByUserId` is the one that matters: on a submitted event it is another user's id. It has to
 * be fetched, because `canViewEvent` reads it to recognise the owner, and it has to be stripped
 * afterwards. `visibility` and `deletedAt` carry nothing the page uses either.
 */
export const TRACKER_EVENT_GUARD_FIELDS = ['visibility', 'createdByUserId', 'deletedAt'] as const;

/** The projection for every tracker read of an event: the sent fields plus the guard fields. */
export const TRACKER_EVENT_SELECT = [...TRACKER_EVENT_FIELDS, ...TRACKER_EVENT_GUARD_FIELDS].join(' ');

export type TrackerEventField = (typeof TRACKER_EVENT_FIELDS)[number];
export type TrackerEventView = Partial<Record<TrackerEventField, unknown>>;

/** What the user's own folder still says about an event the corpus no longer lists. */
export interface LastKnownEvent {
  title: string;
  startDateTime?: unknown;
  folderId: string;
}

/** The folder fields `lastKnown` is built from. The route must select `userId` too — see below. */
export interface FolderForEntry {
  _id: unknown;
  userId?: unknown;
  eventId?: unknown;
  name?: unknown;
  eventDate?: unknown;
}

/**
 * The client's view of one event, or `null` when the viewer may no longer see it.
 *
 * `null` for a missing row AND for a row the viewer may not read, deliberately the same: the tracker
 * says "no longer listed" either way, and distinguishing them would tell a user that somebody else's
 * private event still exists.
 */
export function toTrackerEvent(event: object | null | undefined, viewerId: string): TrackerEventView | null {
  if (!event) return null;
  const doc = event as ViewableEvent & Record<string, unknown>;
  if (!canViewEvent(doc, viewerId)) return null;

  const view: TrackerEventView = {};
  for (const field of TRACKER_EVENT_FIELDS) {
    if (doc[field] !== undefined) view[field] = doc[field];
  }
  return view;
}

/** `lastKnown` from a folder, or null when the folder has no usable name. */
export function lastKnownFromFolder(folder: FolderForEntry | null | undefined): LastKnownEvent | null {
  if (!folder) return null;
  const title = typeof folder.name === 'string' ? folder.name.trim() : '';
  if (!title) return null;
  const known: LastKnownEvent = { title, folderId: String(folder._id) };
  if (folder.eventDate) known.startDateTime = folder.eventDate;
  return known;
}

export type ShapedTrackerEntry<E> = Omit<E, 'eventId'> & {
  eventId: TrackerEventView | null;
  lastKnown?: LastKnownEvent;
};

/**
 * One entry as the client receives it: the event replaced by its view, and `lastKnown` attached only
 * when the view is null. Every field of the entry itself — status, notes, connections — is the
 * caller's own data and passes through untouched.
 */
export function shapeTrackerEntry<E extends object>(
  entry: E,
  event: object | null | undefined,
  viewerId: string,
  lastKnown?: LastKnownEvent | null
): ShapedTrackerEntry<E> {
  const view = toTrackerEvent(event, viewerId);
  const shaped = { ...entry, eventId: view } as unknown as ShapedTrackerEntry<E>;
  if (view === null && lastKnown) shaped.lastKnown = lastKnown;
  return shaped;
}

/**
 * The event ids behind `entries` that the viewer can no longer be shown — missing from `events`, or
 * present and not viewable. Deduplicated. The list route asks for folders for exactly these.
 */
export function orphanedEventIds(
  entries: readonly { eventId?: unknown }[],
  events: readonly object[],
  viewerId: string
): string[] {
  const viewable = new Set<string>();
  for (const event of events) {
    if (toTrackerEvent(event, viewerId)) viewable.add(String((event as { _id?: unknown })._id));
  }
  const out = new Set<string>();
  for (const entry of entries) {
    const id = String(entry.eventId);
    if (!viewable.has(id)) out.add(id);
  }
  return [...out];
}

/**
 * Shape a whole listing.
 *
 * A folder only contributes when its `userId` is the viewer's. The route already scopes its query
 * that way; this is the second lock, because `lastKnown` puts a folder's name on screen and a folder
 * name is somebody's own label for an event. When a user has several folders for one event the FIRST
 * wins, and the route sorts newest first.
 */
export function shapeTrackerEntries<E extends { eventId?: unknown }>(
  entries: readonly E[],
  events: readonly object[],
  folders: readonly FolderForEntry[],
  viewerId: string
): ShapedTrackerEntry<E>[] {
  const eventById = new Map<string, object>();
  for (const event of events) eventById.set(String((event as { _id?: unknown })._id), event);

  const folderByEvent = new Map<string, FolderForEntry>();
  for (const folder of folders) {
    if (folder.userId !== viewerId || !folder.eventId) continue;
    const key = String(folder.eventId);
    if (!folderByEvent.has(key)) folderByEvent.set(key, folder);
  }

  return entries.map(entry => {
    const key = String(entry.eventId);
    return shapeTrackerEntry(
      entry,
      eventById.get(key) ?? null,
      viewerId,
      lastKnownFromFolder(folderByEvent.get(key))
    );
  });
}
