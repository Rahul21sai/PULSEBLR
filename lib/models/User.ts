import mongoose, { Schema, Document, Model } from 'mongoose';
import crypto from 'crypto';
import {
  DIGEST_FREQUENCIES,
  FORMAT_PREFERENCES,
  DEFAULT_PREFERENCES,
  type DigestFrequency,
  type FormatPreference,
} from '@/lib/events/relevance';

/**
 * `card` is the shareable side of the scan feature: the details somebody gets when they
 * scan YOUR QR code. It lives on the user rather than in its own collection because there
 * is exactly one per person and it is read on every card-page request.
 *
 * `token` is what appears in the public URL, NOT the user id. Two reasons:
 *   - the card page is public, so a guessable URL would let anyone enumerate profiles
 *   - the Google `sub` is used as `userId` across every other collection, and putting an
 *     internal identifier in a shareable link is how it ends up somewhere it shouldn't be
 *
 * Rotating the token invalidates every QR already printed or screenshotted, which is the
 * point of having one — but it means the UI has to say so before rotating.
 */
export interface IUserCard {
  /** Overrides the Google account name on the card only. */
  displayName?: string;
  headline?: string;
  company?: string;
  role?: string;
  linkedin?: string;
  x?: string;
  github?: string;
  website?: string;
  email?: string;
  phone?: string;
  /** Phone is opt-in: it is the one field people regret publishing. */
  revealPhone: boolean;
  /** Off means `/c/<token>` returns 404 even with a valid token. */
  enabled: boolean;
  token: string;
}

export interface IUser extends Document {
  name: string;
  email: string;
  image?: string;
  googleId: string;
  card?: IUserCard;
  /**
   * Companies whose people are worth flagging in the contacts table.
   *
   * Per-user and stored, replacing the module-level array in `lib/helpers/phase6.ts` whose
   * `getTargetCompanies()` returned it BY REFERENCE — so `addTargetCompany()` mutated a
   * process-global shared by every user of the deployment.
   */
  targetCompanies: string[];
  /**
   * The user's own tag vocabulary for people. Lowercase, canonicalised by
   * `canonicaliseTags()` in `lib/contacts/service.ts` — the same function that canonicalises
   * `Contact.tags`, so a vocabulary entry and the tag stored on a person are always the same
   * string and the facet cannot split.
   */
  contactTags: string[];
  /**
   * What this user told us in onboarding, plus how they want to be contacted.
   *
   * ── SHAPE LIVES IN `lib/events/relevance.ts`, NOT HERE. ──────────────────────────────────────
   * The vocabulary (`FORMAT_PREFERENCES`, `DIGEST_FREQUENCIES`) and the default object are
   * imported from that pure module, exactly as `lib/models/TrackerEntry.ts` imports
   * `TRACKER_STATUSES` from `lib/tracker/validate.ts`. That is what makes the set the API
   * validates against the same set the schema enforces — and it lets the onboarding screen, a
   * client component, render the choices without pulling mongoose into the browser bundle.
   *
   * ── TWO STREAMS READ THIS OBJECT, AND THAT IS DELIBERATE. ────────────────────────────────────
   * `topics` / `areas` / `format` / `evenings` are the FEED's — read by
   * `lib/events/relevance.ts` to rank "For you". `remindersEnabled` / `digestFrequency` are the
   * NOTIFICATIONS stream's — read by `lib/notifications/` for saved-event reminders and the
   * digest, and scored by nothing. One object rather than two because they are answers to one
   * conversation and are read on the same round trip; each half is commented so a change to one
   * does not get made on the assumption it affects the other.
   *
   * ── ABSENCE IS THE NORMAL STATE. ─────────────────────────────────────────────────────────────
   * Every existing user predates this field. Never read it directly — go through
   * `readPreferences()` in the relevance module, which coerces a missing, partial or
   * since-invalidated value into a complete object. An empty `topics`/`areas`/`evenings` with
   * `format: 'any'` scores every event identically, so a user who skips onboarding gets today's
   * feed rather than an empty one. `default: () => ({ ...DEFAULT_PREFERENCES })` is a FACTORY for
   * the same reason `targetCompanies` spreads its seed list: no two documents may share one
   * object instance.
   */
  preferences: IUserPreferences;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The stored preference document.
 *
 * Structurally `UserPreferences` from `lib/events/relevance.ts` plus `onboardedAt`, which is
 * server-set bookkeeping rather than a preference and therefore is NOT part of the payload the
 * API accepts. It records that the user has BEEN ASKED — set on any successful save and on an
 * explicit skip — so the prompt in the feed stops appearing. `null`/absent means never asked,
 * which is the only state that shows the prompt.
 */
export interface IUserPreferences {
  topics: string[];
  areas: string[];
  format: FormatPreference;
  /** IST day-of-week, 0 = Sunday. See `UserPreferences.evenings`. */
  evenings: number[];
  /** SHARED with lib/notifications/. */
  remindersEnabled: boolean;
  /** SHARED with lib/notifications/. */
  digestFrequency: DigestFrequency;
  onboardedAt?: Date | null;
}

const UserCardSchema = new Schema<IUserCard>(
  {
    displayName: { type: String, trim: true, maxlength: 120 },
    headline: { type: String, trim: true, maxlength: 200 },
    company: { type: String, trim: true, maxlength: 120 },
    role: { type: String, trim: true, maxlength: 120 },
    linkedin: { type: String, trim: true },
    x: { type: String, trim: true },
    github: { type: String, trim: true },
    website: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    phone: { type: String, trim: true },
    revealPhone: { type: Boolean, default: false },
    enabled: { type: Boolean, default: false },
    token: { type: String, required: true },
  },
  { _id: false }
);

/**
 * `_id: false` like `UserCardSchema` — it is one embedded object per user, never queried on its
 * own, so an id would be noise in every document.
 *
 * Enums come from the imported vocabularies, so the schema cannot accept a value the API rejects
 * or vice versa. `evenings` is deliberately NOT enum-constrained to 0-6 by mongoose: the range
 * check belongs in `mergePreferences`, which runs before `connectDB()` and can answer 400 with
 * the field named, rather than in the schema, where a bad value becomes a ValidationError that a
 * route then has to catch to avoid leaking the model name and path.
 */
const UserPreferencesSchema = new Schema<IUserPreferences>(
  {
    topics: { type: [String], default: [] },
    areas: { type: [String], default: [] },
    format: { type: String, enum: FORMAT_PREFERENCES, default: DEFAULT_PREFERENCES.format },
    evenings: { type: [Number], default: [] },
    remindersEnabled: { type: Boolean, default: DEFAULT_PREFERENCES.remindersEnabled },
    digestFrequency: {
      type: String,
      enum: DIGEST_FREQUENCIES,
      default: DEFAULT_PREFERENCES.digestFrequency,
    },
    onboardedAt: { type: Date, default: null },
  },
  { _id: false }
);

const UserSchema = new Schema<IUser>(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    image: { type: String, trim: true },
    googleId: { type: String, required: true, unique: true, index: true },
    card: { type: UserCardSchema },
    targetCompanies: { type: [String], default: () => [...DEFAULT_TARGET_COMPANIES] },
    /**
     * The user's own tag vocabulary for people they have met.
     *
     * WHY IT LIVES HERE RATHER THAN IN A `Tag` COLLECTION. The People page's tag facet is built
     * from the UNION of this list and `Contact.distinct('tags')`, and each half covers the other's
     * gap: `distinct` alone cannot represent a tag that has been created but not yet applied to
     * anybody, and this list alone would miss a tag that arrived on a contact before the
     * vocabulary knew about it (an offline capture, or the CSV of a folder somebody else set up).
     *
     * A `Tag` collection would buy a `{ userId, slug }` unique index and a rename that cascades
     * over `Contact.tags[]`. That is real machinery, and nothing has asked for rename yet — so
     * this follows `targetCompanies` exactly: a per-user string list on the User document, read
     * through one accessor in `lib/contacts/service.ts`.
     *
     * Seeded EMPTY, unlike `targetCompanies`. A default tag list would be this app guessing how
     * somebody labels the people they meet, and every unused seed tag is a facet row with nobody
     * in it.
     *
     * Read it with `ensureUser()`, never `findOne` — a valid session can legitimately have no
     * `User` row, which is what made `/api/me/card` return 404.
     */
    contactTags: { type: [{ type: String, maxlength: 40 }], default: [] },
    /**
     * A FACTORY default, never a shared literal — the same rule `targetCompanies` follows, and for
     * the reason recorded there: `getTargetCompanies()` once returned a module-level array by
     * reference and `addTargetCompany()` mutated a process-global shared by every user.
     *
     * ⚠ ADDING THIS FIELD HITS THE WARNING AT THE TOP OF CLAUDE.md. `User` is an EXISTING model
     * behind the `mongoose.models.X || mongoose.model(...)` hot-reload guard, so a dev server that
     * has already touched it keeps the OLD schema for its whole life and silently drops writes to
     * `preferences` — no error, the in-memory document even shows the value, and only the database
     * disagrees. RESTART `npm run dev` after pulling this, or verify from a fresh `tsx` process.
     */
    preferences: { type: UserPreferencesSchema, default: () => ({ ...DEFAULT_PREFERENCES }) },
  },
  { timestamps: true }
);

// Resolving `/c/<token>` is a lookup on every public card view. Sparse because most users
// never enable a card.
UserSchema.index({ 'card.token': 1 }, { unique: true, sparse: true });

/**
 * Seed list for a new user's `targetCompanies`.
 *
 * Spread on assignment (`[...DEFAULT_TARGET_COMPANIES]`) so no document ever shares this
 * array instance — the bug in the function this replaces.
 */
export const DEFAULT_TARGET_COMPANIES = [
  'JPMorgan Chase',
  'Goldman Sachs',
  'Visa',
  'Salesforce',
  'Shell',
  'AMD',
  'Google',
  'Microsoft',
  'Amazon',
  'Apple',
  'Atlassian',
  'Stripe',
  'Uber',
  'Razorpay',
] as const;

/**
 * A URL-safe token for a public card page.
 *
 * 16 bytes of CSPRNG entropy. It is the only thing in front of a public endpoint, so it
 * must not be sequential or derived from anything about the user.
 */
export function newCardToken(): string {
  return crypto.randomBytes(16).toString('base64url');
}

const User: Model<IUser> =
  mongoose.models.User || mongoose.model<IUser>('User', UserSchema);

export default User;
