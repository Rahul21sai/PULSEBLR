import mongoose, { Schema, Document, Model } from 'mongoose';
import crypto from 'crypto';
import { slugify } from '../scrapers/core/text';

/**
 * A folder collects the people you met at one event.
 *
 * WHY THIS IS NOT A `TrackerEntry`. A tracker entry means "this event is in my
 * pipeline"; a folder means "I am collecting people here". They are close enough to be
 * confused and different enough that reusing one for the other breaks:
 *
 *   1. `TrackerEntry.eventId` is REQUIRED, so it cannot hold people met at an event the
 *      scraper has never seen. Google I/O Connect is almost certainly not in the corpus,
 *      and that is precisely the event this feature exists for.
 *   2. A tracker entry is unique per (user, event). A folder is created by hand, on the
 *      morning of the event, and named by the person using it.
 *
 * WHY `eventId` IS OPTIONAL *AND* THE NAME/DATE/VENUE ARE DENORMALISED. `pruneStale()`
 * deletes events 7 days past on every scrape without touching anything that references
 * them, so dangling references are normal, not exceptional — and `getPendingFollowUps`
 * reads `entry.eventId.title` with no null guard, which 500s three endpoints and the
 * digest the moment one event is pruned. A folder that owns its own name can never break
 * that way. `eventId` is a convenience link for showing the event card, nothing more.
 *
 * Note for `scripts/cleanup-duplicate-clusters.ts`: it repoints `TrackerEntry` rows when
 * it collapses a duplicate cluster, and must repoint `Folder.eventId` too.
 */

export interface IFolder extends Document {
  /**
   * Owner. A PLAIN STRING, never an ObjectId and with no `ref: 'User'` — it is the
   * Google `sub` in production and `devlogin:<email>` under the dev-only provider.
   * Declaring it as an ObjectId would break both dev sign-in and every existing row in
   * the sibling collections.
   */
  userId: string;
  /**
   * Client-generated UUID, present only for folders created OFFLINE.
   *
   * You create the folder on the morning of the event, possibly on the way there with no
   * signal. The queued contacts then reference it by `folderClientId` until the server
   * assigns a real `_id`, and this is what lets the sync endpoint resolve that — and lets a
   * replayed folder creation be idempotent rather than a duplicate.
   */
  clientId?: string;
  name: string;
  slug: string;
  eventId?: mongoose.Types.ObjectId;
  eventDate?: Date;
  venue?: string;
  note?: string;
  /** Unguessable token for the public self-registration page at `/f/<token>`. */
  intakeToken?: string;
  intakeEnabled: boolean;
  intakeExpiresAt?: Date;
  archivedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const FolderSchema = new Schema<IFolder>(
  {
    userId: { type: String, required: true, index: true },
    clientId: { type: String },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    slug: { type: String, required: true },
    eventId: { type: Schema.Types.ObjectId, ref: 'Event' },
    eventDate: { type: Date },
    venue: { type: String, trim: true },
    note: { type: String, trim: true, maxlength: 2000 },
    intakeToken: { type: String },
    // Defaults to false so a folder is never publicly writable until asked for.
    intakeEnabled: { type: Boolean, default: false },
    intakeExpiresAt: { type: Date },
    archivedAt: { type: Date },
  },
  { timestamps: true }
);

// One folder per name per user: creating "I/O Connect" twice by accident on the morning
// of the event is exactly the mistake this prevents.
FolderSchema.index({ userId: 1, slug: 1 }, { unique: true });
/**
 * Only folders created offline carry a clientId, so a replayed offline creation is idempotent —
 * the same guarantee Contact gets from { userId, clientId }.
 *
 * PARTIAL, NOT SPARSE, and the difference is the whole bug this replaced. **On a COMPOUND index,
 * `sparse` omits a document only when EVERY indexed field is missing.** `userId` is always
 * present, so every folder was indexed, with `clientId: null` for the ones created in the app —
 * and `unique` then collapsed all of them into a single allowed row.
 *
 * Measured symptom: a user with one folder could never create a second. `Folder.create` threw
 * `E11000 … index: userId_1_clientId_1 dup key: { userId: "…", clientId: null }`, and the route
 * reported it as "You already have a folder with that name" — so the message named the one thing
 * that was NOT wrong. One folder per event is the core of this feature; it was capped at one
 * folder, full stop.
 *
 * `partialFilterExpression` indexes only documents where clientId is really a string, which is
 * what "sparse" was reaching for. `Contact` is unaffected: its clientId is `required`, so every
 * row has one and a plain unique compound index is correct there.
 *
 * Changing this in the schema is NOT enough — Mongoose will not alter an index that already
 * exists. `scripts/migrate-folder-clientid-index.ts` drops and recreates it.
 */
FolderSchema.index(
  { userId: 1, clientId: 1 },
  { unique: true, partialFilterExpression: { clientId: { $type: 'string' } } }
);
FolderSchema.index({ userId: 1, eventDate: -1 });
FolderSchema.index({ userId: 1, updatedAt: -1 });
// Sparse: only folders that have opted into public intake carry a token.
FolderSchema.index({ intakeToken: 1 }, { unique: true, sparse: true });

/**
 * Derive `slug` from `name`.
 *
 * `pre('validate')` and NOT `pre('save')`. Mongoose registers its own validation as the
 * FIRST pre-save middleware, so a `pre('save')` hook that fills a `required` field never
 * runs — validation has already rejected the document. Proven by
 * `scripts/diag-hook-order.ts`, and it cost this project 3 events in one scrape before
 * it was understood. See the same note on `Event.ts`.
 */
FolderSchema.pre('validate', function () {
  const self = this as unknown as IFolder;
  if (!self.name) return; // Let the required-field validator report it cleanly.

  if (!self.slug || self.isModified('name')) {
    self.slug = folderSlug(self.name);
  }
});

/**
 * A stable, non-empty slug.
 *
 * `slugify` strips everything outside `[a-z0-9]`, so a name written entirely in
 * Devanagari or emoji reduces to ''. An empty slug would make the unique index collapse
 * every such folder into one, so fall back to a hash of the name — deterministic, so two
 * folders genuinely named the same thing still collide, which is the intent.
 */
export function folderSlug(name: string): string {
  const slug = slugify(name);
  if (slug) return slug;
  return `f-${crypto.createHash('sha1').update(name.trim()).digest('hex').slice(0, 10)}`;
}

/**
 * A URL-safe token for the public intake page.
 *
 * 16 bytes of CSPRNG entropy. It is the only thing standing in front of an
 * unauthenticated write endpoint, so it must not be sequential, derived from the user id,
 * or short enough to enumerate.
 */
export function newIntakeToken(): string {
  return crypto.randomBytes(16).toString('base64url');
}

const Folder: Model<IFolder> =
  mongoose.models.Folder || mongoose.model<IFolder>('Folder', FolderSchema);

export default Folder;
