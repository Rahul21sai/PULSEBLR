// Resolving an `Authorization` header into an identity. THE SECOND module in `lib/mcp/**` that
// touches Mongo — `handlers.ts` was the first, and its header says so.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THIS FILE IS THE WHOLE AUTHENTICATION BOUNDARY, and it is deliberately small enough to read in
// one sitting. Everything above it is pure (`identity.ts`: parsing, hashing, format) and everything
// below it is a query scoped by the `userId` this returns.
//
// WHY IT IS A SEPARATE FILE FROM `handlers.ts` RATHER THAN A FUNCTION INSIDE IT. `handlers.ts`
// carries a load-bearing comment — "THIS MODULE READS NO SESSION" — and `scripts/diag-api-auth.ts`
// cites that property by name when it blesses `POST /api/mcp` as public. That claim is still true
// and must stay true: the public tools read no identity, and the way to keep that provable is for
// the identity read to live somewhere a reader can see is separate, not threaded through the module
// that answers anonymous calls.
//
// ── THE MESSAGE DISTINGUISHES "EXPIRED" FROM "UNKNOWN", WHICH LOOKS LIKE A RULE VIOLATION ────
// This repo's rule is "always 404, never 403" and `get_event` has ONE message for missing and for
// forbidden. That rule exists because a Mongo ObjectId embeds a timestamp and a counter, so one
// known id makes its neighbours enumerable and a distinguishing message turns a guess into a probe.
// Neither half of that applies to a 32-byte CSPRNG token: there is nothing to enumerate, so the only
// caller who can present a real-but-dead token is the person who owns it. CLAUDE.md draws the same
// distinction for the intake token ("16 bytes of CSPRNG entropy, so it cannot be guessed or
// enumerated"). Telling that person "this token expired on the 4th" instead of "invalid token" is
// the difference between a fixable problem and a mystery, and it costs nothing an attacker can use.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import McpToken from '../models/McpToken';
import connectDB from '../mongodb';
import { dayLabelIST } from '../format';
import {
  hashMcpToken,
  isWellFormedToken,
  parseAuthorizationHeader,
  shouldRefreshLastUsed,
  type McpAuthOutcome,
} from './identity';

/**
 * Resolve the caller.
 *
 * `null`/absent header ⇒ `anonymous`, which the route MUST serve. Anything else that does not
 * resolve ⇒ `rejected`, which the route MUST refuse with a 401.
 */
export async function resolveMcpIdentity(
  authorization: string | null | undefined
): Promise<McpAuthOutcome> {
  const parsed = parseAuthorizationHeader(authorization);
  if (parsed === null) return { kind: 'anonymous' };
  if ('malformed' in parsed) return { kind: 'rejected', reason: parsed.malformed };

  /**
   * Format first, database second. A foreign credential — a Google access token, an API key pasted
   * into the wrong field — is refused here without touching Atlas, which is what stops a spray of
   * junk bearer headers from becoming a spray of database queries.
   */
  if (!isWellFormedToken(parsed.token)) {
    return {
      kind: 'rejected',
      reason: 'That is not a PulseBLR access token. Mint one in Settings → Assistant access.',
    };
  }

  await connectDB();

  /**
   * ONE LOOKUP, BY HASH, WITH THE EXPIRY CHECKED IN CODE RATHER THAN IN THE QUERY.
   *
   * The alternative — folding `expiresAt: { $gt: now }` into the selector — is one line shorter and
   * strictly worse here, because a miss then cannot say WHY. Keeping the check visible costs nothing
   * (the row is already in hand) and this is the only function that performs it, so there is no
   * second call site to forget it. `tests/mcp-auth.test.ts` pins the expired case for that reason:
   * an in-code guard needs a test in a way that a query clause does not.
   *
   * Note there is no `revokedAt` to check. Revocation deletes the row — see `lib/models/McpToken.ts`
   * for why a credential is the one thing in this app that must NOT be soft-deleted.
   */
  const row = await McpToken.findOne({ tokenHash: hashMcpToken(parsed.token) })
    .select('_id userId name scope expiresAt lastUsedAt')
    .exec();

  if (!row) {
    return {
      kind: 'rejected',
      reason:
        'That PulseBLR access token is not recognised. It may have been revoked — mint a new one ' +
        'in Settings → Assistant access.',
    };
  }

  const now = new Date();
  if (row.expiresAt.getTime() <= now.getTime()) {
    return {
      kind: 'rejected',
      reason:
        `That PulseBLR access token expired on ${dayLabelIST(row.expiresAt)}. Mint a new one in ` +
        'Settings → Assistant access.',
    };
  }

  /**
   * Refresh `lastUsedAt`, but only when it has gone stale, and AWAITED.
   *
   * Awaited rather than fire-and-forget because this runs on serverless: work not awaited when the
   * response is returned may simply be killed, so an un-awaited write is a write that sometimes
   * happens. The staleness gate is what keeps the cost off the hot path — see
   * `LAST_USED_REFRESH_MS`.
   */
  if (shouldRefreshLastUsed(row.lastUsedAt, now)) {
    await McpToken.updateOne({ _id: row._id }, { $set: { lastUsedAt: now } }).catch(error => {
      // A bookkeeping write must never fail an otherwise valid call.
      console.error('[mcp] could not refresh lastUsedAt:', error);
    });
  }

  return {
    kind: 'identified',
    identity: {
      userId: row.userId,
      tokenId: String(row._id),
      scope: row.scope,
      label: row.name,
    },
  };
}
