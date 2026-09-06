import mongoose, { Schema, Document, Model } from 'mongoose';
import crypto from 'crypto';

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
  createdAt: Date;
  updatedAt: Date;
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
