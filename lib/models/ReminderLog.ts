import mongoose, { Schema, Document, Model } from 'mongoose';

/**
 * One row per (user, event, reminder kind) — the record that stops anybody being emailed twice
 * about the same thing.
 *
 * THE GUARANTEE IS THE UNIQUE INDEX, NOT A CHECK. A "have I already sent this?" query followed
 * by a send is correct exactly until two runs overlap — a retried GitHub Action, a manual
 * `workflow_dispatch` while the schedule is firing, an operator running the script locally
 * against the same Atlas database the cron uses (which is the normal arrangement here, see
 * CLAUDE.md on `daily-scrape.yml`). Both runs read "not sent", both send. The index cannot be
 * raced: the second insert is an E11000 and the sender skips that event.
 *
 * SO THE ROW IS WRITTEN BEFORE THE EMAIL GOES OUT, NOT AFTER. That ordering is the whole design
 * and it is deliberately asymmetric:
 *
 *   claim → send   worst case is a MISSED email (the process dies between the two)
 *   send → claim   worst case is a DUPLICATE email (the process dies between the two)
 *
 * A missed reminder is a disappointment. A duplicate reminder is a spam complaint, and the
 * brief names it as the thing that must not happen. So `status` starts at `'pending'`, and
 * becomes `'sent'` or `'failed'` once the provider has answered.
 *
 * A `'failed'` row is NEVER cleaned up automatically, and that is intentional too. "The send
 * failed" is not knowable with certainty from the client side — a timeout after Resend accepted
 * the message looks identical to one before — so automatically freeing the row for a retry
 * would reintroduce exactly the double-send this collection exists to prevent. Clearing them is
 * an explicit operator act: `scripts/send-reminders.ts --retry-failed`.
 *
 * `sparse` appears nowhere in here on purpose. CLAUDE.md §9 records what a compound
 * unique+sparse index did to `Folder` (it capped every user at ONE folder) and that
 * `Source.index({ kind, handle }, { unique: true, sparse: true })` is the same latent bug.
 * Every field in this key is required and always present, so a plain compound unique index is
 * the right instrument.
 */

/** Lifecycle of one claimed reminder. Ordered: every row starts `pending`. */
export const REMINDER_STATUSES = ['pending', 'sent', 'failed'] as const;
export type ReminderStatus = (typeof REMINDER_STATUSES)[number];

export interface IReminderLog extends Document {
  /**
   * Owner. A PLAIN STRING — the Google `sub` in production, `devlogin:<email>` under the
   * dev-only provider. Same convention as `Contact.userId` and `TrackerEntry.userId`; never an
   * ObjectId, never `ref: 'User'`.
   */
  userId: string;
  /**
   * The event this reminder is about.
   *
   * A SOFT link, like `Folder.eventId`: `pruneStale()` deletes events a week past their start
   * on every scrape without touching anything that references them, so a dangling id here is a
   * normal end state rather than corruption. Nothing reads through it after the send — the
   * title and time are captured into `eventTitle` below — so a dangling row still audits
   * correctly.
   */
  eventId: mongoose.Types.ObjectId;
  /** Which reminder this is. Part of the unique key; see `REMINDER_KIND`. */
  kind: string;
  /**
   * All the events that went out in ONE email share a batch id.
   *
   * This is what makes the per-user-per-day FREQUENCY CAP countable. The cap is about how many
   * emails land in an inbox, and a reminder covering three events is one email — so counting
   * rows would over-count by a factor of however many events happened to be due, and the cap
   * would fire on the first morning somebody had a busy week.
   */
  batchId: string;
  /**
   * The address it was sent to, captured at send time.
   *
   * Denormalised deliberately: if the user later changes their email, the log must still say
   * where the message actually went. An audit row that re-resolves its own subject is not an
   * audit row.
   */
  email: string;
  /** Captured at send time, for the same reason as `email` — the event may be pruned later. */
  eventTitle?: string;
  eventStartDateTime?: Date;
  status: ReminderStatus;
  /** When the row was CLAIMED, which is within a second of when the email was attempted. */
  sentAt: Date;
  /** Resend's message id, on success. The only handle on a delivered message. */
  providerId?: string;
  /** Why it failed, truncated. Never shown to a user. */
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ReminderLogSchema = new Schema<IReminderLog>(
  {
    userId: { type: String, required: true, index: true },
    eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true },
    kind: { type: String, required: true },
    batchId: { type: String, required: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    eventTitle: { type: String, trim: true },
    eventStartDateTime: { type: Date },
    status: {
      type: String,
      required: true,
      enum: REMINDER_STATUSES as unknown as string[],
      default: 'pending',
    },
    sentAt: { type: Date, required: true, default: () => new Date() },
    providerId: { type: String, trim: true },
    error: { type: String, trim: true, maxlength: 500 },
  },
  { timestamps: true }
);

/**
 * THE DOUBLE-SEND GUARD. One row per user per event per reminder kind, enforced by the database.
 *
 * `kind` is in the key so a second sort of reminder added later gets its own at-most-once
 * guarantee instead of being silently suppressed by this one.
 */
ReminderLogSchema.index({ userId: 1, eventId: 1, kind: 1 }, { unique: true });

/** The frequency cap's query: this user's rows since IST midnight. */
ReminderLogSchema.index({ userId: 1, sentAt: -1 });

const ReminderLog: Model<IReminderLog> =
  mongoose.models.ReminderLog || mongoose.model<IReminderLog>('ReminderLog', ReminderLogSchema);

export default ReminderLog;
