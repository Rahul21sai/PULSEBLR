import mongoose, { Schema, Document, Model } from 'mongoose';

/**
 * ONE THING THAT HAPPENED between the user and a person. APPEND-ONLY.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY PER-ENCOUNTER ROWS RATHER THAN FIELDS ON `Person`.
 *
 * Two payoffs, and the second is the one that is easy to miss:
 *
 *   1. A REAL LAST-CONTACTED DATE. `completeContactFollowUp()` flips a boolean and records no
 *      timestamp, so "when did I last talk to her" is currently unanswerable. A note and a completed
 *      follow-up ARE contact; `max(Interaction.at)` is the only honest answer to that question, and
 *      it cannot be reconstructed from `Contact.scannedAt`, which is capture time.
 *
 *   2. JOB-CHANGE DETECTION comes free. "Was at Razorpay in July, at Postman in September" is
 *      visible because each encounter is its own row. A single updated-in-place row would silently
 *      overwrite the earlier employer, and the change — which is the interesting part — would leave
 *      no trace.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * `eventId` IS THE SPINE. It replaces the `Contact → Folder → Event` chain whose second hop is null
 * in practice, which is why the tracker reports "People met: 0" over a folder holding forty scans.
 * Both directions are one indexed query:
 *
 *     event  → people :  Interaction.find({ userId, eventId })   → distinct personId
 *     person → events :  Interaction.find({ userId, personId, eventId: { $exists: true } })
 *
 * DEPENDENCY DIRECTION: Relationships references Discovery. An `Interaction` carries an `eventId`;
 * nothing in `lib/events/**` may ever import from here. That rule is what keeps the public event
 * page cacheable and indexable, and it is why "you met 4 people here" is a client-side overlay
 * rather than part of the server-rendered page.
 */

/**
 * What happened. Each value has exactly one writer — see the table in the architecture spec.
 *
 * `met` is the capture path, `note` / `follow-up-set` / `follow-up-done` / `message-sent` are the
 * person page, `intake` is somebody adding themselves via `/f/<token>`, and `merged` is written by a
 * merge so the timeline explains its own history.
 */
export const INTERACTION_KINDS = [
  'met',
  'note',
  'follow-up-set',
  'follow-up-done',
  'message-sent',
  'intake',
  'merged',
] as const;

export type InteractionKind = (typeof INTERACTION_KINDS)[number];

export interface IInteraction extends Document {
  userId: string;
  personId: mongoose.Types.ObjectId;
  kind: InteractionKind;
  /** When it happened — NOT when the row was written. A backfilled `met` carries the scan time. */
  at: Date;
  /** The corpus event, when there is one. Absent for a note, a message, an off-event capture. */
  eventId?: mongoose.Types.ObjectId | null;
  /** The capture this row came from. REQUIRED for `met` — see the index note below. */
  contactId?: mongoose.Types.ObjectId | null;
  note?: string;
  createdAt: Date;
}

const InteractionSchema = new Schema<IInteraction>(
  {
    userId: { type: String, required: true },
    personId: { type: Schema.Types.ObjectId, ref: 'Person', required: true },
    kind: { type: String, required: true, enum: INTERACTION_KINDS },
    at: { type: Date, required: true, default: () => new Date() },
    // A SOFT link, like `Folder.eventId`: `pruneStale()` deletes events 7 days past on every scrape
    // without touching anything that references them, so a dangling reference is normal here.
    eventId: { type: Schema.Types.ObjectId, ref: 'Event', default: null },
    contactId: {
      type: Schema.Types.ObjectId,
      ref: 'Contact',
      default: null,
      /**
       * REQUIRED WHENEVER `kind === 'met'`, enforced by the schema rather than by convention.
       *
       * The uniqueness guard below is `{ userId, contactId }` filtered to `kind: 'met'`. A `met` row
       * written WITHOUT a `contactId` would carry `null`, every such row would collide on that null,
       * and only the FIRST would ever save — so every capture after the first would fail with a
       * duplicate-key error that names a field the caller never set. Refusing the row here makes the
       * bug impossible instead of mysterious.
       */
      required: [
        function (this: IInteraction) {
          return this.kind === 'met';
        },
        'contactId is required for a `met` interaction',
      ],
    },
    note: { type: String, trim: true, maxlength: 4000 },
  },
  {
    /**
     * NO `updatedAt`. APPEND-ONLY IS ENFORCED, NOT DOCUMENTED — a timeline you can edit is not
     * evidence, and an `updatedAt` on this schema would be an invitation to edit one. Editing a note
     * means APPENDING a new `note` interaction; the person page renders the latest and keeps the
     * history. There must also be no PATCH or PUT route for this collection.
     */
    timestamps: { createdAt: true, updatedAt: false },
  }
);

/**
 * THE IDEMPOTENCY GUARANTEE FOR THE TIMELINE, and it has to live in the database.
 *
 * `POST /api/contacts` answers a replayed `clientId` with 200 AND THE EXISTING DOCUMENT — the
 * contract that stops a retried scan on bad conference wifi duplicating anybody. A naive
 * `Interaction.create()` on that path would append a SECOND `met` row on the replay, and a person
 * met once would read "met 2 x". Relying on the caller to check first is how that comes back the
 * moment a second write path appears (the sync drain, the intake page, the backfill), so the
 * constraint is here rather than in a service function.
 *
 * `partialFilterExpression`, NEVER `sparse`. On a COMPOUND index `sparse` omits a document only when
 * EVERY indexed field is missing; `userId` is always present, so every row would be indexed with
 * `contactId: null` standing in, and `unique` would then permit exactly ONE `met` interaction PER
 * USER — the user's second scan ever would fail. This repo has been bitten by that exact
 * substitution twice: `{userId, clientId}` sparse-compound capped every user at one folder, and
 * `Source.index({kind, handle}, {unique, sparse})` is still latent.
 *
 * Note it is also filtered to `kind: 'met'` so the other kinds are free to repeat — several notes
 * against one capture is normal and must not collide.
 */
InteractionSchema.index(
  { userId: 1, contactId: 1 },
  { unique: true, partialFilterExpression: { kind: 'met' } }
);

// The person timeline, in the order it is rendered.
InteractionSchema.index({ userId: 1, personId: 1, at: -1 });
// "Who did I meet at this event" — the row no competitor shows at any price, in one indexed query.
InteractionSchema.index({ userId: 1, eventId: 1 });
// The user's own activity feed.
InteractionSchema.index({ userId: 1, at: -1 });

/**
 * The only field a stored interaction may ever change is `personId`, and only a merge changes it.
 *
 * Append-only is a CONVENTION until something enforces it, so this is the enforcement. A merge has
 * to repoint rows onto the survivor — that is the one legitimate update — and everything else is an
 * attempt to rewrite history, which would quietly turn the timeline from evidence into an opinion.
 *
 * Covers the query paths only. Document `.save()` on an existing row is refused separately below,
 * because query middleware does not see it.
 */
const MUTABLE_PATHS = new Set(['personId']);

function assertOnlyRepointing(this: mongoose.Query<unknown, IInteraction>) {
  const update = (this.getUpdate() ?? {}) as Record<string, unknown>;
  const touched = new Set<string>();

  for (const [operator, payload] of Object.entries(update)) {
    /*
     * `$setOnInsert` IS SKIPPED, AND THAT IS WHAT MADE MERGE WORK AT ALL.
     *
     * This guard refused every merge in the app's history, and nothing noticed because 0 tombstones
     * were ever written. Mechanism: `InteractionSchema` declares `timestamps: { createdAt: true }`,
     * so mongoose's `_setTimestampsOnUpdate` adds `$setOnInsert: { createdAt }` to EVERY update
     * unconditionally — the caller never writes it. This loop then found `createdAt` outside
     * `MUTABLE_PATHS` and threw `Interaction is append-only: cannot update createdAt` on the one
     * update the guard's own docblock calls legitimate.
     *
     * Proven to be the query shape rather than the data: the same repoint-only `updateMany` throws
     * on a filter matching ZERO rows, and the identical call with `{ timestamps: false }` succeeds.
     *
     * WHY SKIPPING IT IS SAFE RATHER THAN A LOOPHOLE. `$setOnInsert` applies only when a document is
     * INSERTED, so for a non-upsert update it never executes at all, and on an upsert the row it
     * writes is brand new. Either way it is categorically incapable of the harm this guard exists to
     * prevent — rewriting the history of a STORED interaction. Nothing is weakened: `$set`, `$unset`,
     * `$inc`, `$push` and a bare replacement document are all still walked.
     *
     * Fixed here rather than by passing `{ timestamps: false }` at the two call sites, deliberately.
     * This file's own docblock says append-only "is a CONVENTION until something enforces it"; a rule
     * that every future caller must remember to disarm is the same class of fragility, and it would
     * have to be remembered in a file that does not contain the guard.
     */
    if (operator === '$setOnInsert') continue;
    if (operator.startsWith('$')) {
      if (payload && typeof payload === 'object') {
        for (const path of Object.keys(payload as Record<string, unknown>)) touched.add(path);
      }
    } else {
      // A bare replacement document rewrites everything, including the fields above.
      touched.add(operator);
    }
  }

  const illegal = [...touched].filter(path => !MUTABLE_PATHS.has(path));
  if (illegal.length) {
    throw new Error(
      `Interaction is append-only: cannot update ${illegal.join(', ')}. ` +
        'Append a new interaction instead; only a merge may repoint personId.'
    );
  }
}

InteractionSchema.pre('updateOne', assertOnlyRepointing);
InteractionSchema.pre('updateMany', assertOnlyRepointing);
InteractionSchema.pre('findOneAndUpdate', assertOnlyRepointing);
InteractionSchema.pre('replaceOne', function () {
  throw new Error('Interaction is append-only: replaceOne is never valid.');
});

/**
 * No-argument hook that THROWS, matching `Contact`'s and `Folder`'s `pre('validate')` style rather
 * than taking a `next` callback — Mongoose 9 types the second parameter of a `pre('save')` handler as
 * `SaveOptions`, so the callback form does not typecheck here and a synchronous throw rejects the
 * save just as well.
 */
InteractionSchema.pre('save', function () {
  const self = this as unknown as IInteraction & {
    isNew: boolean;
    modifiedPaths(): string[];
  };
  if (self.isNew) return;

  const illegal = self.modifiedPaths().filter(path => !MUTABLE_PATHS.has(path));
  if (illegal.length) {
    throw new Error(
      `Interaction is append-only: cannot modify ${illegal.join(', ')}. ` +
        'Append a new interaction instead; only a merge may repoint personId.'
    );
  }
});

const Interaction: Model<IInteraction> =
  mongoose.models.Interaction || mongoose.model<IInteraction>('Interaction', InteractionSchema);

export default Interaction;
