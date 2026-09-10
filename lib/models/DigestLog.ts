import mongoose, { Schema, Document, Model } from 'mongoose';

/**
 * One row per (user, digest kind, period) — the record that stops anybody being mailed the same
 * digest twice.
 *
 * ── WHY THIS IS NOT `ReminderLog` WITH A DIFFERENT `kind`. ────────────────────────────────────
 * That was the first thing tried, and it does not fit for a structural reason rather than a stylistic
 * one. `ReminderLog`'s guarantee is keyed `{ userId, eventId, kind }` — at most one email per user
 * PER EVENT. A digest's identity is not an event; it is a PERIOD. Forcing it into that key requires
 * one of two things, and both are worse than a second collection:
 *
 *   · A fabricated `eventId`. The field is `required`, an `ObjectId`, and `ref: 'Event'`, documented
 *     as "the event this reminder is about". Synthesising one from a hash of the period key would
 *     make every future `.populate('eventId')` and every audit join return garbage, and the
 *     collection would no longer be readable as what its own header says it is.
 *   · One row per event featured in the digest, keyed on real event ids. That gives the WRONG
 *     guarantee, not a weaker one: the same five events legitimately recur next week, so every row
 *     would already exist and the subscriber would silently never receive another digest. A periodic
 *     mailing must repeat; that is the definition of periodic.
 *
 * So the key here is `{ userId, kind, periodKey }`, and `periodKey` comes from
 * `digestPeriodKey()` in `lib/notifications/digest-schedule.ts` (`weekly:<IST Monday>` /
 * `daily:<IST day>`). Everything else about this collection is copied from `ReminderLog` on purpose,
 * because that stream already got these decisions right:
 *
 * THE GUARANTEE IS THE UNIQUE INDEX, NOT A CHECK. A "have I already sent this?" query followed by a
 * send is correct exactly until two runs overlap — a retried GitHub Action, a manual
 * `workflow_dispatch` firing next to the schedule, or an operator running the script locally against
 * the same Atlas database the cron uses (the normal arrangement here). Both runs read "not sent",
 * both send. The index cannot be raced: the second insert is an E11000 and the sender counts it.
 *
 * SO THE ROW IS WRITTEN BEFORE THE EMAIL GOES OUT, NOT AFTER. Deliberately asymmetric:
 *
 *   claim → send   worst case is a MISSED digest  (the process dies between the two)
 *   send → claim   worst case is a DUPLICATE      (the process dies between the two)
 *
 * A missed digest is one quiet Monday. A duplicate is a spam complaint against the sending domain,
 * and it cannot be taken back. So `status` starts at `'pending'` and becomes `'sent'` or `'failed'`
 * once the provider has answered.
 *
 * A `'failed'` row is NEVER cleaned up automatically. "The send failed" is not knowable with
 * certainty from this side — a timeout after Resend accepted the message looks identical to one
 * before — so automatically freeing the row for a retry would reintroduce exactly the double-send
 * this collection exists to prevent. Clearing them is an explicit operator act:
 * `scripts/send-digest.ts --retry-failed`.
 *
 * `sparse` appears nowhere in here on purpose. CLAUDE.md §9 records what a compound unique+sparse
 * index did to `Folder` (it capped every user at ONE folder). Every field in this key is required and
 * always present, so a plain compound unique index is the right instrument.
 */

/** Lifecycle of one claimed digest. Ordered: every row starts `pending`. */
export const DIGEST_LOG_STATUSES = ['pending', 'sent', 'failed'] as const;
export type DigestLogStatus = (typeof DIGEST_LOG_STATUSES)[number];

export interface IDigestLog extends Document {
  /**
   * Owner. A PLAIN STRING — the Google `sub` in production, `devlogin:<email>` under the dev-only
   * provider. Same convention as `Contact.userId` and `TrackerEntry.userId`; never an ObjectId,
   * never `ref: 'User'`.
   */
  userId: string;
  /** Which periodic mailing this is. Part of the unique key; see `DIGEST_KIND`. */
  kind: string;
  /**
   * The at-most-once identity of one send: `weekly:2026-09-07` or `daily:2026-09-10`.
   *
   * IST, always. A UTC period boundary would file the 02:30 UTC send under the previous day and wave
   * a second email through every single morning — the same reasoning `istDayStart()` records.
   */
  periodKey: string;
  /** The cadence in force when the row was claimed. Recorded because the user may change it. */
  frequency: string;
  /**
   * The address it was sent to, captured at send time.
   *
   * Denormalised deliberately: if the user later changes their email, the log must still say where
   * the message actually went. An audit row that re-resolves its own subject is not an audit row.
   */
  email: string;
  /** How many events the email carried. The digest's only real content metric. */
  eventCount: number;
  /**
   * Which events went out, captured at claim time.
   *
   * A SOFT reference list, like `Folder.eventId`: `pruneStale()` deletes events a week past their
   * start on every scrape without touching anything that references them, so dangling ids here are a
   * normal end state rather than corruption. Nothing reads through them after the send — this is for
   * answering "what did we actually mail this person" later.
   */
  eventIds: mongoose.Types.ObjectId[];
  status: DigestLogStatus;
  /** When the row was CLAIMED, which is within a second of when the email was attempted. */
  sentAt: Date;
  /** Resend's message id, on success. The only handle on a delivered message. */
  providerId?: string;
  /** Why it failed, truncated. Never shown to a user. */
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

const DigestLogSchema = new Schema<IDigestLog>(
  {
    userId: { type: String, required: true, index: true },
    kind: { type: String, required: true },
    periodKey: { type: String, required: true },
    frequency: { type: String, required: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    eventCount: { type: Number, required: true, default: 0 },
    eventIds: { type: [Schema.Types.ObjectId], ref: 'Event', default: () => [] },
    status: {
      type: String,
      required: true,
      enum: DIGEST_LOG_STATUSES as unknown as string[],
      default: 'pending',
    },
    sentAt: { type: Date, required: true, default: () => new Date() },
    providerId: { type: String, trim: true },
    error: { type: String, trim: true, maxlength: 500 },
  },
  { timestamps: true }
);

/**
 * THE DOUBLE-SEND GUARD. One row per user per kind per period, enforced by the database.
 *
 * `kind` is in the key so a second periodic mailing added later gets its own at-most-once guarantee
 * instead of being silently suppressed by this one.
 */
DigestLogSchema.index({ userId: 1, kind: 1, periodKey: 1 }, { unique: true });

/** The per-IST-day cap's query: this user's rows since IST midnight. */
DigestLogSchema.index({ userId: 1, sentAt: -1 });

const DigestLog: Model<IDigestLog> =
  mongoose.models.DigestLog || mongoose.model<IDigestLog>('DigestLog', DigestLogSchema);

export default DigestLog;
