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
  /**
   * The HUMAN this capture is about. Assigned by `resolvePerson()` on the server, never by a client.
   *
   * `contactKey` above answers "is this the same person" as a STRING that gets recomputed the moment
   * a LinkedIn slug arrives — which is why it is a pointer and not an identity. This is the identity:
   * a `Person._id` that survives every key upgrade, so notes, follow-ups and the interaction timeline
   * stay attached to the human rather than to a spelling of their name.
   *
   * OPTIONAL, AND ABSENCE IS A REAL STATE. Every contact written before the spine existed has none
   * until `scripts/backfill-person-spine.ts --apply` runs, and `scripts/diag-people-spine.ts` counts
   * them. Nothing may assume it is set.
   *
   * DELIBERATELY ABSENT FROM `pickWritable`'s ALLOWLIST. That function is the trust boundary for every
   * contact write path — scan, manual add, PATCH, the offline drain, `/c/<token>`, `/f/<token>`. A
   * client able to set this could staple its capture onto any person id it guessed, fabricating an
   * encounter history and corrupting every derived field on that person: `displayName`, `company`,
   * `eventCount` and `lastInteractionAt` are all computed from whichever contacts point here.
   * Server-derived, always.
   */
  personId?: mongoose.Types.ObjectId | null;
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
    // `maxlength` on the element type, matching every sibling text field. `canonicaliseTags()`
    // already caps at 40, so this is the schema-level backstop for a write that somehow bypasses
    // `pickWritable` — and it stops a tag being the one unbounded string on the document.
    tags: { type: [{ type: String, maxlength: 40 }], default: [] },

    followUpAt: { type: Date },
    followedUp: { type: Boolean, default: false },

    capturedVia: { type: String, required: true, enum: CAPTURED_VIA, default: 'manual' },
    rawPayload: { type: String, maxlength: 4000 },
    scannedAt: { type: Date, default: () => new Date() },

    contactKey: { type: String, required: true },
    // No `required`, no default. See the interface comment: an unset value means "not yet
    // backfilled", and defaulting it to anything would hide that from the diagnostic.
    personId: { type: Schema.Types.ObjectId, ref: 'Person' },
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
/**
 * "Every encounter with this human", which is what `recomputePerson()` reads on EVERY capture, note
 * and follow-up — so it is the hottest query the spine adds. It is also what the two delete paths use
 * to decide whether a person still has any history left, and what `personIdsInFolder()` collects
 * before a folder cascade.
 *
 * No `sparse`: an unset `personId` is precisely the state `scripts/diag-people-spine.ts` has to find,
 * and sparse would hide those rows from the index the diagnostic scans.
 */
ContactSchema.index({ userId: 1, personId: 1 });
ContactSchema.index({ userId: 1, followUpAt: 1 });
ContactSchema.index({ userId: 1, linkedinSlug: 1 }, { sparse: true });

/**
 * The cross-folder People page: every person you have met, filterable by employer and by tag.
 *
 * `{ userId, folderId, scannedAt }` above cannot serve these. A compound index can only supply a
 * sort from a prefix, and with `folderId` absent from the filter — which is the entire point of a
 * cross-folder view — `scannedAt` is no longer reachable, so the query selected on `userId` and
 * sorted the user's whole contact set in memory. Tolerable at today's row counts and a hard
 * failure at the top end, because an in-memory sort is capped at 32 MB.
 *
 * THREE TRAPS HERE, and the first is the expensive one:
 *
 * 1. `tags` AND `companies` MUST NOT SHARE ONE INDEX. MongoDB refuses to index two array fields in
 *    a single key ("cannot index parallel arrays"), and it refuses at WRITE time on the first
 *    document that has both — so it presents as contacts failing to save, not as an index that
 *    would not build. They are two separate indexes on purpose; do not "tidy" them into one.
 * 2. NO `sparse` ON THESE. Both fields default to `[]`, an empty array indexes as the
 *    missing-key sentinel, so `sparse` would omit most rows and make the index useless for
 *    precisely the unfiltered listing it exists to serve. (This is a different failure from the
 *    `sparse`-on-compound-`unique` bug that capped every user at one folder — same option, second
 *    distinct way it misleads.)
 * 3. Only ONE text index is allowed per collection, so search here is a regex path rather than
 *    `$text` — see `lib/contacts/query.ts` for why that is also the better fit for a filter box
 *    that has to work mid-typing.
 */
ContactSchema.index({ userId: 1, scannedAt: -1 });
ContactSchema.index({ userId: 1, companies: 1, scannedAt: -1 });
ContactSchema.index({ userId: 1, tags: 1, scannedAt: -1 });

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
