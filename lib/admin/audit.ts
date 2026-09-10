/**
 * The audit trail: what an admin action is called, what changed, and what an undo would do.
 *
 * ── SPLIT DISCIPLINE ────────────────────────────────────────────────────────────────────────
 *
 * Everything above the `recordAudit` line is PURE — no mongoose, no network, no clock beyond what
 * is passed in — so `tests/admin-audit.test.ts` pins it with no database and no server, the same
 * arrangement as `lib/tracker/validate.ts` and `lib/events/admin-validate.ts`. The model is pulled
 * in by a DYNAMIC import inside the writer for exactly that reason: a static import would put
 * mongoose and a registered model into the graph of a pure-function test suite whose whole scope
 * (see `vitest.config.mts`) is that it touches neither.
 *
 * ── WHY THE SUMMARY IS WRITTEN AT THE TIME, NOT DERIVED AT READ TIME ────────────────────────
 *
 * A log line has to still make sense after the thing it describes is gone. Deriving "deleted
 * <title>" from the target document at render time gives you "deleted (missing)" for precisely the
 * rows a delete log exists to record. So the summary and the label are copied into the row.
 */

/** Every action the console can take. The list is closed so the audit panel can filter on it. */
export const AUDIT_ACTIONS = [
  'event.update',
  'event.delete',
  'event.restore',
  'event.tech.flag',
  'event.tech.unflag',
  'event.spotlight.pin',
  'event.spotlight.unpin',
  'source.enable',
  'source.disable',
  'source.bulk.disable',
  'source.delete',
  'submission.approve',
  'submission.reject',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export function isAuditAction(value: unknown): value is AuditAction {
  return typeof value === 'string' && (AUDIT_ACTIONS as readonly string[]).includes(value);
}

/**
 * Which actions `POST /api/admin/audit/undo` can reverse, and how.
 *
 * `restore-document` re-creates a row from the whole-document snapshot in `before`.
 * `restore-fields`   writes the `before` values back over the fields the action changed.
 * `none`             a decision that undoing would misrepresent — see below.
 *
 * `submission.approve` / `submission.reject` are deliberately NOT undoable here. Both are already
 * reversible through the submissions queue itself (approve `$unset`s visibility, reject sets
 * 'private'), and re-deciding a submission is a judgement, not a correction — routing it through a
 * generic undo would write the field without the review the panel exists to force.
 */
export type UndoKind = 'restore-document' | 'restore-fields' | 're-enable' | 'none';

const UNDO_BY_ACTION: Record<AuditAction, UndoKind> = {
  'event.update': 'restore-fields',
  'event.delete': 'restore-document',
  'event.restore': 'none',
  'event.tech.flag': 'restore-fields',
  'event.tech.unflag': 'restore-fields',
  'event.spotlight.pin': 'restore-fields',
  'event.spotlight.unpin': 'restore-fields',
  'source.enable': 'restore-fields',
  'source.disable': 'restore-fields',
  'source.bulk.disable': 're-enable',
  'source.delete': 'restore-document',
  'submission.approve': 'none',
  'submission.reject': 'none',
};

export function undoKind(action: string): UndoKind {
  return isAuditAction(action) ? UNDO_BY_ACTION[action] : 'none';
}

export function isUndoable(action: string): boolean {
  return undoKind(action) !== 'none';
}

/** Human label for an action, for the panel's filter chips and each row's verb. */
const ACTION_LABELS: Record<AuditAction, string> = {
  'event.update': 'Edited an event',
  'event.delete': 'Deleted an event',
  'event.restore': 'Restored an event',
  'event.tech.flag': 'Marked an event as tech',
  'event.tech.unflag': 'Removed an event from tech',
  'event.spotlight.pin': 'Pinned to the Spotlight',
  'event.spotlight.unpin': 'Removed from the Spotlight',
  'source.enable': 'Enabled a source',
  'source.disable': 'Disabled a source',
  'source.bulk.disable': 'Disabled several sources',
  'source.delete': 'Deleted a source',
  'submission.approve': 'Approved a submission',
  'submission.reject': 'Kept a submission private',
};

export function actionLabel(action: string): string {
  return isAuditAction(action) ? ACTION_LABELS[action] : action;
}

/* ────────────────────────────── Diffing ────────────────────────────── */

export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

/**
 * Normalise a value for comparison and for storage.
 *
 * Dates become ISO strings because that is what a JSON body carries and what the panel renders; a
 * `Date` compared against the string that produced it is otherwise always "changed". `undefined`
 * collapses to `null` so "field removed" and "field set to null" read the same in the log — which is
 * true of Mongo `$unset` versus `$set: null` for every reader except the `$exists` filters, and
 * those are called out where they matter (`spotlightAt`, `visibility`).
 */
export function normaliseValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normaliseValue);
  if (value && typeof value === 'object') {
    // ObjectId and friends: keep the readable form rather than a Buffer dump.
    if (typeof (value as { toHexString?: unknown }).toHexString === 'function') {
      return String(value);
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = normaliseValue(v);
    return out;
  }
  return value;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(normaliseValue(a)) === JSON.stringify(normaliseValue(b));
}

/**
 * Which of `after`'s keys actually differ from `before`.
 *
 * Only keys PRESENT in `after` are considered: an update is an allowlisted patch, so a key it does
 * not mention was not part of the action and must not appear in the log as though it were.
 * Unchanged keys are dropped, because a no-op logged as a change is how an audit trail becomes
 * unreadable — and how "who broke this" gets the wrong answer.
 */
export function diffFields(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined
): FieldChange[] {
  if (!after) return [];
  const out: FieldChange[] = [];
  for (const [field, next] of Object.entries(after)) {
    const prev = before ? before[field] : undefined;
    if (sameValue(prev, next)) continue;
    out.push({ field, before: normaliseValue(prev), after: normaliseValue(next) });
  }
  return out;
}

/** `{ field: before }` for every changed field — the payload an undo writes back. */
export function undoPatch(changes: FieldChange[]): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const c of changes) patch[c.field] = c.before;
  return patch;
}

/* ────────────────────────────── Snapshots ────────────────────────────── */

/** Keys never worth storing: mongoose bookkeeping and the text-index shadow. */
const SNAPSHOT_DROP = new Set(['__v']);

/**
 * Largest snapshot to store, in bytes of JSON.
 *
 * A snapshot exists to make a delete reversible, so trimming it is a real loss and is only done
 * when the alternative is a document too large to be worth storing. 96 KB clears every event in
 * the corpus with room to spare (the longest description measured is a few KB) while capping the
 * damage a pathological row could do to the collection.
 */
export const SNAPSHOT_MAX_BYTES = 96 * 1024;

export interface Snapshot {
  doc: Record<string, unknown>;
  truncated: boolean;
}

/**
 * Prepare a whole-document snapshot for storage.
 *
 * `_id` is KEPT, deliberately: a restore that reuses the original id makes every dangling
 * `TrackerEntry.eventId` and `Folder.eventId` live again by itself. Re-creating under a fresh id
 * would leave a user's tracked event pointing at nothing while an identical row sat beside it.
 */
export function redactSnapshot(doc: Record<string, unknown>): Snapshot {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) {
    if (SNAPSHOT_DROP.has(k)) continue;
    out[k] = normaliseValue(v);
  }
  if (JSON.stringify(out).length <= SNAPSHOT_MAX_BYTES) return { doc: out, truncated: false };

  // Descriptions are the only field here that can be pathologically long, and the only one a
  // restore can survive losing — everything else is identity, timing or a flag.
  const trimmed = { ...out, description: '' };
  return { doc: trimmed, truncated: true };
}

/* ────────────────────────────── Summaries ────────────────────────────── */

/**
 * The one-line sentence stored on the row.
 *
 * Names the thing before the mechanism: "Deleted “Kafka Meetup”" rather than
 * "Event.deleteOne(_id: 66f…)". The id is on the row already for anyone who needs it.
 */
export function summarise(input: {
  action: string;
  targetLabel?: string;
  changes?: FieldChange[];
  count?: number;
}): string {
  const label = input.targetLabel ? `“${input.targetLabel}”` : 'an untitled row';
  const verb = actionLabel(input.action);

  if (input.action === 'source.bulk.disable') {
    return `Disabled ${input.count ?? 0} source${input.count === 1 ? '' : 's'}`;
  }
  if (input.action === 'event.update' && input.changes?.length) {
    const fields = input.changes.map(c => c.field).join(', ');
    return `Edited ${label} — ${fields}`;
  }
  return `${verb}: ${label}`;
}

/* ────────────────────────────── The writer ────────────────────────────── */

export interface AuditInput {
  actorId: string;
  actorEmail: string;
  action: AuditAction;
  targetType: 'event' | 'source' | 'submission' | 'system';
  targetId?: string;
  targetIds?: string[];
  targetLabel?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  impact?: Record<string, unknown>;
  snapshotTruncated?: boolean;
  /** Overrides the derived sentence. Rarely needed; the derived one is usually better. */
  summary?: string;
  changes?: FieldChange[];
}

/**
 * Write one audit row.
 *
 * NON-FATAL, and that is a considered trade rather than laziness. It is called AFTER the mutation
 * has committed, so a throw here would turn a successful action into a 500 and the operator would
 * retry an action that already happened — the failure mode `ensureFolderForEvent()` documents. A
 * failed audit write is logged loudly instead; the mutation is not rolled back, because a rollback
 * of a delete is exactly the thing that needs the log we just failed to write.
 *
 * Returns the new row's id when it wrote one, so a route can hand it back and the UI can offer
 * "Undo" immediately without re-reading the log.
 */
export async function recordAudit(input: AuditInput): Promise<string | null> {
  try {
    const { default: AuditLog } = await import('@/lib/models/AuditLog');
    const row = await AuditLog.create({
      actorId: input.actorId,
      actorEmail: input.actorEmail,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      targetIds: input.targetIds,
      targetLabel: input.targetLabel,
      before: input.before,
      after: input.after,
      impact: input.impact,
      summary:
        input.summary ??
        summarise({
          action: input.action,
          targetLabel: input.targetLabel,
          changes: input.changes,
          count: input.targetIds?.length,
        }),
      undoable: isUndoable(input.action),
      snapshotTruncated: input.snapshotTruncated,
    });
    return String(row._id);
  } catch (error) {
    console.error(
      `AUDIT WRITE FAILED for ${input.action} on ${input.targetId ?? input.targetIds?.length ?? '?'} — ` +
        'the action itself succeeded and was NOT rolled back.',
      error
    );
    return null;
  }
}
