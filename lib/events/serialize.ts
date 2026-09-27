// One conversion from a stored event to the shape the client components already take.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS. `FeedEvent` (lib/event-types.ts) is defined as "the event shape the client
// actually receives from /api/events" — dates as ISO STRINGS, because that is what JSON does to a
// `Date`. Every event component in the app (`EventRow`, `EventPills`, `EventCover`,
// `SaveButton`) is typed against it.
//
// A SERVER COMPONENT reading Mongo directly gets a lean document with real `Date` objects, and
// handing one to a client component fails in two ways at once: React refuses to serialise some
// values across the boundary, and `timeIST(event.startDateTime)` receives a `Date` where the type
// promised a string. `JSON.parse(JSON.stringify(doc))` is EXACTLY what `NextResponse.json()` does to
// the same document, so a server-rendered page and an API route hand components byte-identical props.
//
// ── THE DETAIL SHAPE IS AN ALLOWLIST NOW ─────────────────────────────────────────────────────
// This file used to note that the round trip passes EVERY field through, including
// `createdByUserId`, and call that "parity, not a new leak" with the detail API. It was a leak on
// both: an approved submission keeps `createdByUserId`, so every visitor to its page received the
// author's Google `sub` — twice, since an owned row's `clusterKey` is `user:<sub>|…`.
// `toEventDetail` copies only `DETAIL_FIELDS` (lib/events/query.ts), and replaces the owner id with
// a boolean. `toFeedEvent(s)` still round-trips whole documents and is only safe on a PROJECTED
// query (`FEED_SELECT`, the related-events `.select`), which is how every remaining caller uses it.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import type { FeedEvent } from '../event-types';
import { DETAIL_FIELDS } from './query';
import { ownerVisibility, type OwnerDeleteMode, type OwnerVisibility } from './owner-edit';

/**
 * A lean Mongo document (or an array of them) as the client shape. ONLY FOR PROJECTED QUERIES —
 * see the header.
 */
export function toFeedEvent(doc: unknown): FeedEvent {
  return JSON.parse(JSON.stringify(doc)) as FeedEvent;
}

export function toFeedEvents(docs: unknown[]): FeedEvent[] {
  return JSON.parse(JSON.stringify(docs)) as FeedEvent[];
}

/** One event's detail, as every detail surface sends it. */
export interface EventDetail extends FeedEvent {
  /**
   * `true` only for the viewer who added this event; ABSENT for everyone else. It stands in for the
   * owner id, which is never sent — not even to the owner, since a boolean is all the UI needs.
   */
  isOwner?: true;
  /** Owner only. Absent `visibility` in storage reads as `'public'` here. */
  visibility?: OwnerVisibility;
  /** Owner only: how many OTHER people have this in their tracker. A count, never who. */
  savedByOthers?: number;
  /** Owner only: what `DELETE /api/events/[id]` would do right now. See `ownerDeleteMode`. */
  deleteMode?: OwnerDeleteMode;
}

/** Per-viewer facts the route or page looked up. All optional; an anonymous viewer passes none. */
export interface DetailViewerState {
  tracked?: boolean;
  savedByOthers?: number;
  deleteMode?: OwnerDeleteMode;
}

/**
 * The detail DTO. `doc` must come from a `DETAIL_SELECT` query (or be a full document — the result
 * is the same, because only `DETAIL_FIELDS` are copied).
 *
 * The owner block is decided HERE from `createdByUserId === viewerId`, never supplied by a caller,
 * so no route can hand one viewer another's owner controls by passing the wrong flag.
 */
export function toEventDetail(
  doc: unknown,
  viewerId: string | null,
  viewer: DetailViewerState = {}
): EventDetail {
  const source = (doc ?? {}) as Record<string, unknown>;
  const picked: Record<string, unknown> = { _id: source._id };
  for (const field of DETAIL_FIELDS) {
    if (source[field] !== undefined) picked[field] = source[field];
  }
  const detail = JSON.parse(JSON.stringify(picked)) as EventDetail;

  if (viewerId && viewer.tracked) detail.tracked = true;

  const isOwner =
    Boolean(viewerId) &&
    typeof source.createdByUserId === 'string' &&
    source.createdByUserId === viewerId;
  if (isOwner) {
    detail.isOwner = true;
    detail.visibility = ownerVisibility(source.visibility as string | null | undefined);
    detail.savedByOthers = viewer.savedByOthers ?? 0;
    if (viewer.deleteMode) detail.deleteMode = viewer.deleteMode;
  }
  return detail;
}
