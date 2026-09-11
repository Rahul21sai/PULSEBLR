import mongoose, { Schema, Document, Model } from 'mongoose';

import { MCP_SCOPES, type McpScope } from '@/lib/mcp/identity';

/**
 * A personal access token for `/api/mcp`'s authenticated half.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE SECRET IS NOT IN HERE. `tokenHash` is `sha256(token)`; the token itself is shown once, at
 * creation, and is unrecoverable afterwards. `Folder.intakeToken` and `User.card.token` are stored
 * in PLAINTEXT and are NOT a precedent for this: both are public identifiers that appear in a URL a
 * stranger is meant to open, so hashing them would break the only thing they do. This one is a
 * credential that grants read access to a person's private contacts. Different thing, different
 * treatment.
 *
 * ── REVOCATION IS A HARD DELETE, WHICH IS THE OPPOSITE OF WHAT THIS REPO DOES TO EVENTS ──────
 * CLAUDE.md §14 records at length why a deleted EVENT is soft-deleted: an admin must be able to
 * undo, so the row survives with `deletedAt` set. Applying that reasoning here would be exactly
 * backwards, because the two failure modes are not symmetric:
 *
 *   · a soft-deleted event that a query forgets to exclude is a stale listing — embarrassing;
 *   · a soft-revoked CREDENTIAL that a query forgets to exclude is a revoked token that still
 *     works — which is the entire thing revocation exists to prevent.
 *
 * A hard delete cannot be got wrong by omission: the row is gone, so the lookup misses whatever the
 * query says. "Undo" for a credential is "mint another one", which costs three clicks and is
 * strictly safer than restoring a secret somebody already decided to kill. So there is deliberately
 * no `revokedAt` field to forget.
 *
 * ── EXPIRY IS REQUIRED, AND THERE IS NO TTL INDEX ────────────────────────────────────────────
 * `expiresAt` is `required`, so "a token that never dies" is not a state this collection can hold —
 * see `TOKEN_TTL_DAYS`. But an expired row is deliberately KEPT rather than swept by a TTL index:
 * the row is what makes "my assistant stopped working" answerable ("that token expired on the 4th"),
 * and a TTL index would delete the evidence at exactly the moment somebody needs it. Expired rows
 * are a few hundred bytes each and are filtered out of every lookup by the query, not by a sweeper.
 *
 * ── A NEW MODEL, SO THE HOT-RELOAD SCHEMA TRAP DOES NOT APPLY ────────────────────────────────
 * CLAUDE.md's opening warning is about adding a FIELD to a model a running dev server has already
 * registered — it keeps the old schema for its whole life and silently drops the write. `McpToken`
 * is brand new, so it registers on first use, exactly like `Folder` and `Contact` did. No restart
 * needed for this file. (Adding a field to it later is a different story.)
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
export interface IMcpToken extends Document {
  /** The Google `sub`, matching `userId` on every other per-user collection. */
  userId: string;
  /** The user's own label, e.g. "Claude Code on the work laptop". */
  name: string;
  /** `sha256` hex of the full token string. The only representation of the secret we hold. */
  tokenHash: string;
  /** Last four characters, so the list can show `pblr_…7Fq2` and the user can tell two apart. */
  hint: string;
  scope: McpScope;
  expiresAt: Date;
  /** Coarse — refreshed at most once every few minutes. See `shouldRefreshLastUsed`. */
  lastUsedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * How many live tokens one account may hold.
 *
 * A ceiling rather than a rate limit: the point is that a compromised session cannot quietly mint
 * hundreds of durable credentials, each of which outlives the session that made it. Ten is more
 * than the number of MCP clients anybody actually runs, and the error names the limit.
 */
export const MAX_TOKENS_PER_USER = 10;

const McpTokenSchema = new Schema<IMcpToken>(
  {
    userId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    tokenHash: { type: String, required: true },
    hint: { type: String, required: true, maxlength: 8 },
    /**
     * Enum from the shared vocabulary, so the set the API validates against and the set the schema
     * enforces cannot drift — the arrangement `TRACKER_STATUSES` and `EVENT_CATEGORIES` already use.
     */
    scope: { type: String, enum: MCP_SCOPES, required: true, default: 'read' },
    expiresAt: { type: Date, required: true },
    lastUsedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

/**
 * The verification lookup, and the reason it is safe to do in one round trip.
 *
 * UNIQUE and NOT `sparse`: `tokenHash` is `required`, so every row has one and there is nothing for
 * sparse to omit. This is the third time in this repo that option has been considered on an index
 * and the note is worth repeating — CLAUDE.md §9 records `sparse` on a COMPOUND unique index capping
 * every user at one folder, and `{userId, tags}` on `Contact` refusing it for a different reason.
 * A single-key unique index over a required field wants neither `sparse` nor a partial filter.
 */
McpTokenSchema.index({ tokenHash: 1 }, { unique: true });

/** Listing a user's own tokens, newest first. */
McpTokenSchema.index({ userId: 1, createdAt: -1 });

const McpToken: Model<IMcpToken> =
  mongoose.models.McpToken || mongoose.model<IMcpToken>('McpToken', McpTokenSchema);

export default McpToken;
