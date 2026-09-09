import mongoose, { Schema, Document, Model } from 'mongoose';

/**
 * ONE HUMAN. `Contact` stays the capture record — one encounter — and this is the person those
 * encounters are all about.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS, given `Contact.contactKey` already detects duplicates.
 *
 * It detects them and nothing more: the entire product surface for a detected duplicate is a
 * `met 3 x` badge. There is no merge anywhere — no route, no UI, no service function — so the same
 * human met three times is three rows with three notes and three follow-up dates, and "when did I
 * last talk to her" is unanswerable because no last-contacted date exists in the schema at all.
 *
 * `Event` already has this split and it works: `dedupHash` strict per-source, `clusterKey` fuzzy
 * cross-source. Contacts have the same two keys (`clientId` strict, `contactKey` fuzzy) but the
 * fuzzy one was never MATERIALISED into a row you can open, name, correct or merge. That row is
 * this.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * `contactKeys` IS AN ARRAY, AND THE `_id` IS THE IDENTITY. This is the decision the whole model
 * turns on. `contactKey` is a POINTER, not an identity: `Contact`'s `pre('validate')` hook
 * RECOMPUTES it when a source field changes, so `nm:asha rao` becomes `li:asha-rao-123` the day you
 * add her LinkedIn. Keying a Person on that string would orphan the person on every upgrade — you
 * would lose the notes, the timeline and the follow-ups attached to the old spelling. So the person
 * accumulates keys, and `resolvePerson()` appends rather than replaces.
 *
 * A KEY COLLISION NEVER AUTO-MERGES. If a different Person already holds an incoming key, that is a
 * SUGGESTION, not an action. A wrong merge destroys the distinction between two real humans and is
 * very hard to unwind once notes and follow-ups interleave, whereas an un-merged duplicate is
 * merely untidy. `notSamePersonAs` remembers a dismissal so the same suggestion never returns.
 */

/** Fields a user may pin by hand. These always beat the derived value. */
export interface PersonOverrides {
  displayName?: string;
  company?: string;
  role?: string;
}

export interface IPerson extends Document {
  /**
   * Owner. A PLAIN STRING — the Google `sub` in production, `devlogin:<email>` under the dev-only
   * provider. Never an ObjectId, never `ref: 'User'`, matching `Contact` and `Folder`.
   */
  userId: string;

  /**
   * THE EFFECTIVE VALUES — derived from the encounters, with any override already applied on top.
   *
   * They are stored effective rather than raw so that sorting by name, filtering by company and
   * searching free text all agree with what is rendered. Store the raw derived value here instead
   * and a user who corrects a misread name gets a row that cannot be found by the corrected name and
   * sorts under the wrong letter — the correction would be cosmetic.
   *
   * `overrides` remains the source of truth for what the user set, and `derivePersonFields()`
   * re-applies it on EVERY recompute, so the next scan cannot revert a correction.
   */
  displayName: string;
  company?: string;
  role?: string;
  headline?: string;

  /** USER-SET. Always wins over derived, and survives every recompute. No override for `headline`. */
  overrides: PersonOverrides;

  /**
   * Every `contactKey` that has ever pointed at this human. See the class comment: this is a set of
   * pointers, not the identity.
   */
  contactKeys: string[];

  /**
   * RECOMPUTED from `Contact.tags` unioned with `ownTags` — never unioned with its own previous
   * value. See `derivePersonTags()`; a union would make a removed tag permanent.
   */
  tags: string[];
  /**
   * Tags added directly on the person page, stored SEPARATELY precisely so a contact-driven
   * recompute cannot erase them. A tag that belongs to the human rather than to one encounter has
   * nowhere else to live.
   */
  ownTags: string[];

  /** Resolved by `lib/companies/resolve.ts` from the effective company. Recomputed, never unioned. */
  companies: string[];
  isTargetCompany: boolean;

  /**
   * DENORMALISED so `/people` can sort and filter on them at all — neither existed before, which is
   * why "who have I gone quiet on" was unanswerable. `recomputePerson()` owns both, and
   * `scripts/diag-people-spine.ts` re-checks them against a live recount, following the
   * `connectionScore` precedent of a backfill plus a diagnostic rather than trusting increments.
   */
  lastInteractionAt?: Date | null;
  nextActionAt?: Date | null;

  /**
   * `eventCount` is the number of DISTINCT `eventId`s on this person's interactions — NOT the number
   * of `met` rows and NOT the number of folders. `detectRepeatConnections` already carries that
   * bug's scar: it keyed on the folder, so two folders for one event counted as two events.
   * `met N x` has to mean N distinct events or the badge is a flattering lie.
   */
  eventCount: number;
  interactionCount: number;

  /** Dismissed merge suggestions. A suggestion refused once must never come back. */
  notSamePersonAs: mongoose.Types.ObjectId[];

  /**
   * SOFT TOMBSTONE. Set on the LOSER of a merge, so an old `/people/<id>` URL still resolves and the
   * merge stays reversible — nothing is deleted. `buildPersonFilter` excludes these by default;
   * forgetting that arm makes a merged human appear twice, which looks exactly like the merge
   * failing.
   */
  mergedInto?: mongoose.Types.ObjectId | null;

  createdAt: Date;
  updatedAt: Date;
}

const PersonSchema = new Schema<IPerson>(
  {
    userId: { type: String, required: true, index: true },

    displayName: { type: String, required: true, trim: true, maxlength: 200 },
    company: { type: String, trim: true, maxlength: 200 },
    role: { type: String, trim: true, maxlength: 200 },
    headline: { type: String, trim: true, maxlength: 300 },

    overrides: {
      // `_id: false` — this is a value object, not a row. An `_id` here would be noise in every
      // response and would change on nothing.
      type: new Schema<PersonOverrides>(
        {
          displayName: { type: String, trim: true, maxlength: 200 },
          company: { type: String, trim: true, maxlength: 200 },
          role: { type: String, trim: true, maxlength: 200 },
        },
        { _id: false }
      ),
      default: () => ({}),
    },

    contactKeys: { type: [String], default: [] },

    // `maxlength` on the element type, matching `Contact.tags`. `canonicaliseTags()` already caps at
    // 40, so this is the schema-level backstop.
    tags: { type: [{ type: String, maxlength: 40 }], default: [] },
    ownTags: { type: [{ type: String, maxlength: 40 }], default: [] },

    companies: { type: [String], default: [] },
    isTargetCompany: { type: Boolean, default: false },

    lastInteractionAt: { type: Date, default: null },
    nextActionAt: { type: Date, default: null },

    eventCount: { type: Number, default: 0 },
    interactionCount: { type: Number, default: 0 },

    notSamePersonAs: { type: [Schema.Types.ObjectId], default: [] },

    /**
     * Default `null`, not absent. `buildPersonFilter` selects `mergedInto: null`, which matches both
     * — but writing the null explicitly means the field is visible in every document, so "is this a
     * tombstone" is answerable by looking at a row rather than by knowing which fields Mongo omits.
     */
    mergedInto: { type: Schema.Types.ObjectId, ref: 'Person', default: null },
  },
  { timestamps: true }
);

/**
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * INDEXES. THREE OF THESE SPAN AN ARRAY, AND THEY MUST STAY THREE SEPARATE INDEXES.
 *
 * MongoDB refuses to index two array fields in ONE key ("cannot index parallel arrays"), and it
 * refuses at WRITE time on the first document that has both — so a "tidied" compound index over
 * `tags` and `companies` does not fail to build, it presents as PEOPLE FAILING TO SAVE, at the
 * moment somebody applies a tag to a person who works somewhere the registry knows. `Contact`
 * carries the identical warning for the identical reason. This document has FIVE arrays
 * (`contactKeys`, `tags`, `ownTags`, `companies`, `notSamePersonAs`), so the trap is easier to fall
 * into here than anywhere else in the codebase.
 *
 * AND NO `sparse` ON ANY OF THEM. `tags`, `companies` and `contactKeys` all default to `[]`, and an
 * empty array indexes as the missing-key sentinel — so `sparse` would omit exactly the rows the
 * unfiltered listing needs. That is the second distinct way this option misleads in this repo; the
 * first capped every user at one folder.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 */
// The resolver lookup, on the hot capture path: "does a person already hold this key?"
PersonSchema.index({ userId: 1, contactKeys: 1 });
// The default `/people` sort — "who have I gone quiet on".
PersonSchema.index({ userId: 1, lastInteractionAt: -1 });
// Follow-ups due.
PersonSchema.index({ userId: 1, nextActionAt: 1 });
// The two facet rails. Separate indexes; see the block above before touching either.
PersonSchema.index({ userId: 1, tags: 1 });
PersonSchema.index({ userId: 1, companies: 1 });

const Person: Model<IPerson> =
  mongoose.models.Person || mongoose.model<IPerson>('Person', PersonSchema);

export default Person;
