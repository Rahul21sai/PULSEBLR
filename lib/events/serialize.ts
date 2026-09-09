// One conversion from a stored event to the shape the client components already take.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS. `FeedEvent` (lib/event-types.ts) is defined as "the event shape the client
// actually receives from /api/events" — dates as ISO STRINGS, because that is what JSON does to a
// `Date`. Every event component in the app (`EventRow`, `EventPills`, `EventCover`,
// `SaveButton`) is typed against it.
//
// Until the events surface went server-rendered, only route handlers produced that shape, and
// `NextResponse.json()` did the conversion invisibly. A SERVER COMPONENT reading Mongo directly gets
// a lean document with real `Date` objects, and handing one to a client component fails in two ways
// at once: React refuses to serialise some values across the server/client boundary, and any code
// doing `timeIST(event.startDateTime)` receives a `Date` where the type promised a string.
//
// WHY A JSON ROUND TRIP RATHER THAN A FIELD-BY-FIELD MAPPER. A hand-written mapper is a second
// definition of the wire shape, and a second definition drifts: the field it forgets is the field a
// component silently renders as `undefined`. `JSON.parse(JSON.stringify(doc))` is EXACTLY what
// `NextResponse.json()` does to the same document, so a server-rendered page and `/api/events` hand
// the same components byte-identical props by construction. `Date.prototype.toJSON` gives the ISO
// string and BSON's `ObjectId.prototype.toJSON` gives the hex string, which is why `_id` arrives as
// the string the type declares.
//
// CONSEQUENCE TO KNOW: this passes through EVERY field on the document, including internal ones
// (`dedupHash`, `clusterKey`, `lastSeenAt`, `tagConfidence`, `visibility`, `createdByUserId`). That
// is the same exposure `GET /api/events/[id]` has always had — it returns the whole document — so
// this is parity, not a new leak. If that ever needs narrowing, narrow it with a `.select()` at the
// query, which fixes both paths at once rather than only the one that remembered.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import type { FeedEvent } from '../event-types';

/**
 * A lean Mongo document (or an array of them) as the client shape.
 *
 * Takes `unknown` on purpose: the input is a `.lean()` result whose Mongoose type is neither
 * `FeedEvent` nor usefully assignable to it, and pretending otherwise would put a cast at every
 * call site instead of one here, next to the reasoning.
 */
export function toFeedEvent(doc: unknown): FeedEvent {
  return JSON.parse(JSON.stringify(doc)) as FeedEvent;
}

export function toFeedEvents(docs: unknown[]): FeedEvent[] {
  return JSON.parse(JSON.stringify(docs)) as FeedEvent[];
}
