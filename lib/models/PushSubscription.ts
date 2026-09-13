import mongoose, { Schema, Document, Model } from 'mongoose';

/**
 * One row per DEVICE that has agreed to receive notifications — the whole consent record for web
 * push, and the only thing the send path reads to decide who may be pushed to.
 *
 * WHY THIS IS A COLLECTION AND NOT A FIELD ON `User`. Four reasons, and the first three are enough
 * on their own:
 *
 *   1. ONE PERSON HAS SEVERAL DEVICES and each endpoint expires independently. A phone reinstall, a
 *      browser profile reset and Chrome's own periodic key rotation each invalidate one endpoint and
 *      leave the others working. An array on `User` would make every one of those a read-modify-write
 *      of the whole array — the exact shape that made `TrackerEntry.connections[]` lose contacts when
 *      a queued offline scan replayed against a stale base array (CLAUDE.md §9).
 *   2. REVOCATION IS A HARD DELETE OF ONE ROW. When a push service answers 404 or 410 the endpoint
 *      is gone for good, and the correct response is to stop holding it. `deleteOne({ endpoint })`
 *      cannot be got half-right; `$pull` on a subdocument array can.
 *   3. `endpoint` NEEDS A UNIQUE INDEX and you cannot put one on an array element.
 *   4. A brand-new model registers on first use, so it sidesteps the stale-schema trap CLAUDE.md
 *      opens with entirely — no dev-server restart is needed for this file to take effect, unlike a
 *      field added to `User`.
 *
 * ── THE UNIQUE KEY IS `endpoint` ALONE, NOT `{ userId, endpoint }`, AND THAT IS A LEAK FIX. ────
 *
 * A push endpoint identifies a (browser profile, application server key) pair, not a person. So when
 * two Google accounts share a device — the case that made `sw.js` v3 necessary, and the normal case
 * for anybody with a work and a personal account — the SAME endpoint legitimately changes hands.
 * Keyed on `{ userId, endpoint }` the second account's subscribe would insert a SECOND row, both
 * rows would be live, and account A's event reminders would keep arriving on a device account B is
 * now using: A's private saved-event titles, on B's lock screen. Keyed on `endpoint` alone the
 * upsert REASSIGNS `userId`, which is the only correct outcome — a device belongs to whoever most
 * recently granted permission on it.
 *
 * NO `sparse`, AND NO `partialFilterExpression`. `endpoint` is `required` and always present, so a
 * plain unique index is the right instrument. This repo has been misled by `sparse` twice — a
 * compound unique+sparse index on `{ userId, clientId }` capped every user at ONE `Folder`, and
 * `Source.index({ kind, handle }, { unique: true, sparse: true })` is the same bug still latent —
 * so the absence of the option is recorded here on purpose rather than left to look like an omission.
 *
 * ── NO DOCUMENT MIDDLEWARE, WHICH IS WHY `findOneAndUpdate` IS SAFE HERE. ─────────────────────
 * `Contact` and `Folder` must be written through `findOne` + assign + `.save()` because their
 * derived-key hooks are `pre('validate')`, which does not run on `findOneAndUpdate`. There is no
 * derived field on this schema and no hook, so the upsert path is correct — and an upsert is what
 * idempotency-on-`endpoint` requires, since the whole point is that a replayed subscribe is a
 * success rather than a 409.
 */

export interface IPushSubscription extends Document {
  /**
   * Owner. A PLAIN STRING — the Google `sub` in production, `devlogin:<email>` under the dev-only
   * provider. Same convention as `Contact.userId`, `TrackerEntry.userId` and `ReminderLog.userId`;
   * never an ObjectId, never `ref: 'User'`.
   */
  userId: string;
  /**
   * Where the push service accepts a message for this device. Opaque, per-browser, and treated as a
   * URL the SERVER will POST to — see `validatePushSubscriptionInput()` for why that makes it an
   * SSRF surface and what is checked before it is stored.
   */
  endpoint: string;
  /** The device's public P-256 point (65 bytes, base64). Half of the aes128gcm key agreement. */
  p256dh: string;
  /** The 16-byte auth secret from the Web Push spec, base64. */
  auth: string;
  /**
   * Whatever the browser said about itself when it subscribed.
   *
   * Purely so a person can recognise WHICH device they are turning off in Settings. Truncated at the
   * validator, never parsed for behaviour — feature detection happens in the browser, where the
   * answer is a fact rather than a guess from a string.
   */
  userAgent?: string;
  /**
   * Last time this endpoint was confirmed alive — refreshed on a successful send AND on the
   * self-heal re-POST the app does on load. It is the only signal that separates a subscription
   * somebody still has from one on a laptop they sold, and nothing prunes on it automatically: a
   * quiet endpoint has never been shown to be dead, and guessing costs the user their reminders.
   */
  lastSeenAt: Date;
  /**
   * Consecutive send failures that were NOT a 404/410.
   *
   * Deliberately does not trigger deletion. 404 and 410 mean "gone" and are acted on immediately;
   * everything else — 429, 500, a socket timeout on a bad network — is transient, and a threshold
   * that deletes on transient failure would silently unsubscribe every device during one push-service
   * outage. Reset to 0 on any success, so a rising number here is a real signal for an operator to
   * look at rather than an automatic verdict.
   */
  failureCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const PushSubscriptionSchema = new Schema<IPushSubscription>(
  {
    userId: { type: String, required: true, index: true },
    endpoint: { type: String, required: true, trim: true },
    p256dh: { type: String, required: true, trim: true },
    auth: { type: String, required: true, trim: true },
    userAgent: { type: String, trim: true, maxlength: 300 },
    lastSeenAt: { type: Date, required: true, default: () => new Date() },
    failureCount: { type: Number, required: true, default: 0 },
  },
  { timestamps: true }
);

/** See the header: `endpoint` alone, and no `sparse`. */
PushSubscriptionSchema.index({ endpoint: 1 }, { unique: true });

const PushSubscription: Model<IPushSubscription> =
  mongoose.models.PushSubscription ||
  mongoose.model<IPushSubscription>('PushSubscription', PushSubscriptionSchema);

export default PushSubscription;
