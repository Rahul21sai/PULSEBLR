/**
 * WHICH STALE EVENTS THE PRUNER MAY ACTUALLY DELETE.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * `pruneStale()` hard-deletes past events that no source has reported for a week. Until this
 * module it did so without asking whether anything still pointed at them, and three things do:
 *
 *   TrackerEntry.eventId   the user saved this event. Its status, their notes and the people
 *                          they met live on that entry and nowhere else, and `eventId` is
 *                          `required` — so a delete does not remove the entry, it strands it.
 *                          The tracker page then filtered stranded entries out, which is how
 *                          attended history vanished a week after the event with no message.
 *   Folder.eventId         they scanned people there. The folder keeps its own name, so it
 *                          survives, but the link to the event it was for does not.
 *   Interaction.eventId    the person spine's "met at" edge. A dangling one is an encounter that
 *                          has lost the event it happened at.
 *
 * An event any of them references is SPARED, never repointed: a lone delete has no surviving twin
 * to repoint to — the conclusion `scripts/cleanup-non-bengaluru.ts` and `lib/admin/impact.ts`
 * already reached — and keeping the row costs one document. When the last referrer goes (the user
 * untracks it, deletes the folder), the next run prunes it exactly as before.
 *
 * NOT referrers, deliberately: `ReminderLog.eventId` and `DigestLog.eventIds`. Both are logs of a
 * SEND, documented in their own models as soft links the pruner is expected to outrun — and every
 * digest names the day's new events, so counting one would spare most of the corpus and quietly
 * switch the pruner off. `TrackerEntry.connections[].seenAtEventIds` has no writer anywhere.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * Everything except `findReferencesByReferrer` is pure and pinned by `tests/prune-selection.test.ts`.
 * That one function reads the database, and it loads its models with DYNAMIC imports for the reason
 * `lib/admin/impact.ts` gives: a static model import would drag mongoose into a test suite whose
 * declared scope (`vitest.config.mts`) is that it touches neither a database nor the network.
 */

/** A past event is stale once no source has reported it for this long. Unchanged: seven days. */
export const PRUNE_GRACE_MS = 7 * 24 * 3600 * 1000;

/**
 * Candidate ids per referrer round trip.
 *
 * A daily run has a few dozen candidates, so in practice this is one batch; it only matters after an
 * outage leaves a backlog. It bounds the size of every `$in`, and it is also the multiplier on the
 * two collection scans described at `findReferencesByReferrer`, so it is set high rather than low.
 */
export const PRUNE_BATCH_SIZE = 1000;

/** The collections whose `eventId` protects an event from the pruner. Order is report order. */
export const PRUNE_REFERRERS = ['TrackerEntry', 'Folder', 'Interaction'] as const;
export type PruneReferrer = (typeof PRUNE_REFERRERS)[number];

/**
 * The stale-event predicate — the one `pruneStale()` has always used, moved here unchanged so the
 * pruner, the diagnostic and the tests read one definition.
 *
 * `createdByUserId: { $exists: false }` is what keeps every HAND-ENTERED event out of it, and
 * `$exists: false` rather than `null` because the ~1500 scraped documents predate the field and are
 * exactly the rows this is for. See the note on `pruneStale()` for why an owned event would
 * otherwise be deleted the moment it ends. The reference check below is a second, independent
 * filter on top of this one; it narrows what is deleted and never widens it.
 */
export function staleEventFilter(now: Date) {
  const cutoff = new Date(now.getTime() - PRUNE_GRACE_MS);
  return {
    startDateTime: { $lt: cutoff },
    lastSeenAt: { $lt: cutoff },
    createdByUserId: { $exists: false },
  };
}

/**
 * The delete for one batch: the ids that passed the reference check AND the stale predicate again,
 * at the same `now` the candidates were read with.
 *
 * Repeating the predicate is the race guard. Candidates are read, then checked, then deleted, and a
 * row re-sighted by a concurrent ingest in between has a fresh `lastSeenAt` — so it no longer
 * matches and survives, instead of being deleted on a verdict about its old state. What is deleted is
 * therefore always a subset of what the old single `deleteMany(stale)` would have taken.
 */
export function staleDeleteFilter(now: Date, ids: readonly string[]) {
  return { ...staleEventFilter(now), _id: { $in: [...ids] } };
}

export interface PrunePartition<T> {
  /** Nothing references these. */
  deletable: T[];
  /** A tracker entry, a folder or an interaction does. Kept. */
  spared: T[];
}

/**
 * Split candidates into what may be deleted and what must be kept.
 *
 * COMPARED BY STRING, and that is the correctness point. `distinct` hands back ObjectIds, and two
 * ObjectIds holding the same id are different objects: a `Set` of them never matches anything, so
 * an identity comparison here would spare nothing and the whole fix would be a silent no-op that
 * every count still reported as working.
 *
 * `null`/`undefined` referrers are skipped rather than stringified — `Interaction.eventId` defaults
 * to null, and `'null'` is not an id.
 */
export function partitionByReference<T>(
  candidates: readonly T[],
  referenced: Iterable<unknown>,
  idOf: (candidate: T) => string = candidate => String(candidate)
): PrunePartition<T> {
  const kept = new Set<string>();
  for (const ref of referenced) {
    if (ref === null || ref === undefined) continue;
    kept.add(String(ref));
  }

  const deletable: T[] = [];
  const spared: T[] = [];
  for (const candidate of candidates) {
    if (kept.has(idOf(candidate))) spared.push(candidate);
    else deletable.push(candidate);
  }
  return { deletable, spared };
}

/** Consecutive slices of at most `size`. Throws on a size that would loop forever or drop rows. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) {
    throw new RangeError(`chunk size must be a positive integer, got ${size}`);
  }
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += size) out.push(items.slice(start, start + size));
  return out;
}

/** Given candidate ids, return every one of them that something references (any order, dupes fine). */
export type ReferenceLookup = (ids: readonly string[]) => Promise<Iterable<unknown>>;

/**
 * Partition a candidate set of any size, one lookup per batch.
 *
 * FAILS CLOSED. A lookup that throws rejects the whole call; it is never read as "nothing references
 * these", which would delete every candidate the lookup failed to protect. `pruneStale()` lets the
 * rejection reach the pipeline's `prune failed:` error, so a run whose reference check broke deletes
 * nothing it had not already checked.
 *
 * Batches are independent — a lookup is scoped to its own batch's ids, so nothing a later batch
 * learns can change an earlier batch's answer.
 */
export async function splitByReference<T>(
  candidates: readonly T[],
  options: {
    idOf?: (candidate: T) => string;
    lookup?: ReferenceLookup;
    batchSize?: number;
  } = {}
): Promise<PrunePartition<T>> {
  const idOf = options.idOf ?? ((candidate: T) => String(candidate));
  const lookup = options.lookup ?? findReferencedEventIds;
  const batchSize = options.batchSize ?? PRUNE_BATCH_SIZE;

  const deletable: T[] = [];
  const spared: T[] = [];
  for (const batch of chunk(candidates, batchSize)) {
    const referenced = await lookup(batch.map(idOf));
    const part = partitionByReference(batch, referenced, idOf);
    for (const candidate of part.deletable) deletable.push(candidate);
    for (const candidate of part.spared) spared.push(candidate);
  }
  return { deletable, spared };
}

/* ═══════════════════════════════ Loading the evidence ═══════════════════════════════ */

/**
 * Of `ids`, which does each referrer point at. The caller must already have called `connectDB()`.
 *
 * ── QUERY COST, per batch of up to `PRUNE_BATCH_SIZE` ids: three `distinct`s, in parallel ────────
 *
 *   TrackerEntry  IXSCAN on `eventId_1`.
 *   Folder        COLLSCAN. No Folder index leads with `eventId` (all four lead with `userId`).
 *   Interaction   COLLSCAN. `{ userId, eventId }` cannot serve a filter that has no `userId`.
 *
 * Both scans are over a user's own capture data — tens of rows today — and run once per batch, so
 * once per daily run. `distinct` scoped by `$in` returns at most the batch's own ids, so the result
 * is bounded by the candidate set however large the collections grow. If either collection ever
 * reaches the size where a nightly scan matters, an `{ eventId: 1 }` index on it turns the scan into
 * an index lookup with no change here.
 */
export async function findReferencesByReferrer(
  ids: readonly string[]
): Promise<Record<PruneReferrer, unknown[]>> {
  if (ids.length === 0) return { TrackerEntry: [], Folder: [], Interaction: [] };

  const [{ default: TrackerEntry }, { default: Folder }, { default: Interaction }] = await Promise.all([
    import('../models/TrackerEntry'),
    import('../models/Folder'),
    import('../models/Interaction'),
  ]);

  const scoped = { $in: [...ids] };
  const [tracked, foldered, met] = await Promise.all([
    TrackerEntry.distinct('eventId', { eventId: scoped }),
    Folder.distinct('eventId', { eventId: scoped }),
    Interaction.distinct('eventId', { eventId: scoped }),
  ]);
  return { TrackerEntry: tracked, Folder: foldered, Interaction: met };
}

/** Every id in `ids` that any referrer points at. The default `ReferenceLookup`. */
export async function findReferencedEventIds(ids: readonly string[]): Promise<unknown[]> {
  const byReferrer = await findReferencesByReferrer(ids);
  return PRUNE_REFERRERS.flatMap(referrer => byReferrer[referrer]);
}
