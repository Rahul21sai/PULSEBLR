import mongoose, { Schema, Document, Model } from 'mongoose';

/**
 * Every mutating admin action, with a before/after snapshot.
 *
 * ── WHY THIS IS THE FIRST THING THE CONTROL ROOM GOT ─────────────────────────────────────────
 *
 * The control plane before this was ~60 scripts in `scripts/` run by hand. A script prints to a
 * terminal, the terminal scrolls, and the record is gone — so "what did I change last Tuesday" had
 * no answer at all, and neither did "why is this event flagged non-tech when the tagger says it is".
 * Putting the same powers behind buttons makes them faster to reach, which makes an unrecorded
 * mistake both more likely and harder to reconstruct. The log is what makes the buttons safe to add.
 *
 * ── WHY `before` HOLDS A WHOLE DOCUMENT ON A DELETE ──────────────────────────────────────────
 *
 * Soft delete (a `deletedAt` field plus a filter arm in `lib/events/query.ts`) is the right long-term
 * shape and is owned by another stream. Until it lands, a hard delete is only reversible if something
 * kept the row — so `event.delete` stores the entire document here and `POST /api/admin/audit/undo`
 * re-creates it. That is a real undo, not a promise of one: the audit row IS the backup.
 *
 * Consequences worth knowing:
 *   · a restore re-runs the `pre('validate')` key hooks, so `dedupHash` / `clusterKey` are rebuilt
 *     from the stored fields rather than trusted. Identical inputs give identical keys.
 *   · if a later scrape re-created the event, the restore hits the unique `dedupHash` index. That is
 *     reported as "already back in the corpus", not as a failure — the desired end state is reached.
 *   · nothing repoints `TrackerEntry.eventId` or `Folder.eventId` on delete, matching
 *     `cleanup-non-bengaluru.ts`: there is no surviving twin to point at, dangling soft refs are
 *     normal (`pruneStale()` creates them on every scrape), and a restore reuses the SAME `_id`, so
 *     the references become live again on their own.
 *
 * ── WHAT THIS IS NOT ────────────────────────────────────────────────────────────────────────
 *
 * Not a general activity feed. Only admin mutations land here — a user tracking an event is their
 * own data and belongs in the engagement panel's counts, not in an operator's change log. Nothing
 * reads this collection outside `/admin`, and nothing about a user's private notes is copied into it.
 */

export interface IAuditLog extends Document {
  /** Google `sub` of the admin who acted. A plain string, like every other userId here. */
  actorId: string;
  /** Denormalised on purpose: the log has to stay readable after an allowlist change. */
  actorEmail: string;
  /** Dotted verb, e.g. `event.delete`. See AUDIT_ACTIONS in lib/admin/audit.ts. */
  action: string;
  targetType: 'event' | 'source' | 'submission' | 'system';
  /** Absent for a bulk action; see `targetIds`. */
  targetId?: string;
  /** For a bulk action — one audit row for the whole batch, so one undo reverses all of it. */
  targetIds?: string[];
  /**
   * Human-readable name of the thing acted on, copied at the time.
   *
   * Load-bearing for a delete: after the row is gone, the id names nothing a person recognises.
   */
  targetLabel?: string;
  /** Field values before the change, or the whole document for a delete. */
  before?: Record<string, unknown>;
  /** Field values after the change. Absent for a delete. */
  after?: Record<string, unknown>;
  /** One sentence, written at the time, in the operator's language rather than the schema's. */
  summary: string;
  /** What the impact preview reported when the action was taken. */
  impact?: Record<string, unknown>;
  /** Whether `POST /api/admin/audit/undo` can reverse this row. */
  undoable: boolean;
  undoneAt?: Date;
  undoneBy?: string;
  /** Set when a snapshot had to be trimmed to fit — see redactSnapshot(). */
  snapshotTruncated?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const AuditLogSchema = new Schema<IAuditLog>(
  {
    actorId: { type: String, required: true, index: true },
    actorEmail: { type: String, required: true },
    action: { type: String, required: true, index: true },
    targetType: {
      type: String,
      required: true,
      enum: ['event', 'source', 'submission', 'system'],
    },
    targetId: { type: String },
    targetIds: { type: [String], default: undefined },
    targetLabel: { type: String },
    /**
     * `Schema.Types.Mixed` deliberately. These hold whatever shape the target document had, and
     * pinning a schema would silently drop fields on the one write whose entire job is fidelity.
     */
    before: { type: Schema.Types.Mixed },
    after: { type: Schema.Types.Mixed },
    summary: { type: String, required: true },
    impact: { type: Schema.Types.Mixed },
    undoable: { type: Boolean, default: false },
    undoneAt: { type: Date },
    undoneBy: { type: String },
    snapshotTruncated: { type: Boolean },
  },
  { timestamps: true }
);

// The default view: newest first, whole log.
AuditLogSchema.index({ createdAt: -1 });
// "What did I change last Tuesday" — one actor, one window.
AuditLogSchema.index({ actorId: 1, createdAt: -1 });
// "What has ever happened to this event" — reachable from a row in the events panel.
AuditLogSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });

const AuditLog: Model<IAuditLog> =
  mongoose.models.AuditLog || mongoose.model<IAuditLog>('AuditLog', AuditLogSchema);

export default AuditLog;
