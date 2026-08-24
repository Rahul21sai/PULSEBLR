import mongoose, { Schema, Document, Model } from 'mongoose';
import { deriveContactKey } from '../scan/contact-key';

/**
 * One person you met, in one folder.
 *
 * WHY THIS IS A TOP-LEVEL COLLECTION AND NOT `TrackerEntry.connections[]`. Four
 * independent blockers, each fatal on its own:
 *
 *   1. `TrackerEntry.eventId` is REQUIRED, so the subdocument cannot hold anyone met at
 *      an event the scraper has never seen.
 *   2. `ConnectionSchema` is declared `{ _id: false }`, so there is no stable identifier
 *      to address a person by. That is why `markFollowUpComplete()` has to match on
 *      `name` and silently no-ops on the second person with the same name.
 *   3. The only write path is `PUT /api/tracker/[id]` doing `{ $set: body }`, with the
 *      edit modal sending its ENTIRE local copy of the array. Every save is a full-array
 *      replace, so a scan on the phone clobbers an edit open on the laptop — and a queued
 *      offline scan replayed against a stale base array silently DROPS contacts, which is
 *      the exact data this feature exists to keep.
 *   4. You cannot put a unique index on an element of a subdocument array, and offline
 *      idempotency needs one.
 *
 * `scripts/migrate-connections-to-contacts.ts` moves the existing subdocuments here.
 */

/** How this contact came to exist. Mirrors `CapturedVia` in lib/scan/types.ts. */
export const CAPTURED_VIA = [
  'qr-linkedin',
  'qr-vcard',
  'qr-mecard',
  'qr-url',
  'manual',
  'card-page',
] as const;

export interface IContact extends Document {
  /**
   * Owner. A PLAIN STRING — the Google `sub` in production, `devlogin:<email>` under the
   * dev-only provider. Never an ObjectId, never `ref: 'User'`.
   */
  userId: string;
  folderId: mongoose.Types.ObjectId;
  /**
   * Client-generated UUID, and the IDEMPOTENCY KEY for offline sync.
   *
   * The scanner writes to IndexedDB first and posts later, possibly several times if the
   * network is flaky. `{ userId, clientId }` is unique, and the create endpoint treats a
   * duplicate as SUCCESS returning the existing document rather than a 409 — that is what
   * makes replaying a queued scan safe.
   */
  clientId: string;
  name: string;
  headline?: string;
  role?: string;
  company?: string;
  /** Canonical, query-free profile URL. */
  linkedin?: string;
  /** The vanity slug — the strongest identity signal we can get, and it comes free. */
  linkedinSlug?: string;
  x?: string;
  github?: string;
  website?: string;
  email?: string;
  phone?: string;
  /** "How we met" — the thing you will have forgotten in a fortnight. */
  note?: string;
  tags: string[];
  followUpAt?: Date;
  followedUp: boolean;
  capturedVia: (typeof CAPTURED_VIA)[number];
  /**
   * The literal decoded QR string.
   *
   * Always stored, even when fully parsed, and never overwritten. A payload shape we do
   * not understand today can be re-parsed from stored documents tomorrow without asking
   * anybody to be scanned again.
   */
  rawPayload?: string;
  scannedAt: Date;
  /** Derived cross-folder identity. See lib/scan/contact-key.ts. */
  contactKey: string;
  /** Derived from the registry by `lib/companies/resolve.ts`. */
  companies: string[];
  isTargetCompany: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const ContactSchema = new Schema<IContact>(
  {
    userId: { type: String, required: true, index: true },
    folderId: { type: Schema.Types.ObjectId, ref: 'Folder', required: true, index: true },
    clientId: { type: String, required: true },

    name: { type: String, required: true, trim: true, maxlength: 200 },
    headline: { type: String, trim: true, maxlength: 300 },
    role: { type: String, trim: true, maxlength: 200 },
    company: { type: String, trim: true, maxlength: 200 },

    linkedin: { type: String, trim: true },
    linkedinSlug: { type: String, trim: true, lowercase: true },
    x: { type: String, trim: true },
    github: { type: String, trim: true },
    website: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    phone: { type: String, trim: true },

    note: { type: String, trim: true, maxlength: 4000 },
    tags: { type: [String], default: [] },

    followUpAt: { type: Date },
    followedUp: { type: Boolean, default: false },

    capturedVia: { type: String, required: true, enum: CAPTURED_VIA, default: 'manual' },
    rawPayload: { type: String, maxlength: 4000 },
    scannedAt: { type: Date, default: () => new Date() },

    contactKey: { type: String, required: true },
    companies: { type: [String], default: [] },
    isTargetCompany: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// THE IDEMPOTENCY GUARANTEE. Replaying a queued offline scan cannot create a second row.
ContactSchema.index({ userId: 1, clientId: 1 }, { unique: true });
// The folder table, in the order it is displayed.
ContactSchema.index({ userId: 1, folderId: 1, scannedAt: -1 });
// Repeat-connection detection: "have I met this person before?" is now a lookup.
ContactSchema.index({ userId: 1, contactKey: 1 });
ContactSchema.index({ userId: 1, followUpAt: 1 });
ContactSchema.index({ userId: 1, linkedinSlug: 1 }, { sparse: true });

/**
 * Derive `contactKey`.
 *
 * TWO HOOK TRAPS, both already paid for by this repo:
 *
 * 1. It MUST be `pre('validate')`, not `pre('save')`. Mongoose registers its own
 *    validation as the first pre-save middleware, so a `pre('save')` hook that fills a
 *    `required` field never runs — validation has already rejected the document. Proven
 *    by `scripts/diag-hook-order.ts`; it cost 3 events in one scrape.
 *
 * 2. `pre('validate')` DOES NOT RUN on `findOneAndUpdate`/`updateOne`/`bulkWrite`.
 *    `runValidators` invokes Mongoose's separate update-validator helper, not document
 *    middleware. So every Contact write must go through `findOne` + assign + `.save()`.
 *    Contacts are small single documents with no contention, so that costs nothing — and
 *    it is the only way this hook is guaranteed to run.
 *
 * UNLIKE `Event.clusterKey`, THE KEY IS RECOMPUTED when a source field changes rather
 * than frozen on first write. An event's identity is fixed at ingest; a person's sharpens
 * as you learn more. Meet someone, type their name (`nm:priya sharma`), add their
 * LinkedIn a week later — the key must become `li:…` so the next scan of their QR
 * matches. It also self-heals when absent, so a document written before this field
 * existed repairs itself the next time it is touched instead of throwing
 * "Path `contactKey` is required" and losing the write.
 */
ContactSchema.pre('validate', function () {
  const self = this as unknown as IContact & {
    isModified(path: string): boolean;
  };

  const sourceChanged =
    self.isModified('linkedinSlug') ||
    self.isModified('email') ||
    self.isModified('phone') ||
    self.isModified('name');

  if (!self.contactKey || sourceChanged) {
    const key = deriveContactKey({
      linkedinSlug: self.linkedinSlug,
      email: self.email,
      phone: self.phone,
      name: self.name,
    });
    // Only assign a real key. Leaving it empty lets the required-field validator report
    // a clean message rather than storing a meaningless identity.
    if (key) self.contactKey = key;
  }
});

const Contact: Model<IContact> =
  mongoose.models.Contact || mongoose.model<IContact>('Contact', ContactSchema);

export default Contact;
