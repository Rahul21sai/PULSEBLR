import { NextRequest, NextResponse } from 'next/server';

import connectDB from '@/lib/mongodb';
import { requireUser } from '@/lib/api-auth';
import McpToken, { MAX_TOKENS_PER_USER } from '@/lib/models/McpToken';
import {
  TOKEN_TTL_DAYS,
  expiryFromDays,
  hashMcpToken,
  newMcpToken,
  tokenHint,
} from '@/lib/mcp/identity';

/**
 * The signed-in user's MCP access tokens: list, mint, revoke.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THIS ROUTE IS THE ONLY PLACE A TOKEN'S PLAINTEXT EVER EXISTS, and it exists for the duration of one
 * POST response. `POST` mints, returns it once, and stores only `sha256(token)`. There is
 * deliberately NO endpoint that can read a token back — not for the owner, not for an admin. A
 * "show me my token again" feature would require storing the secret, which is the entire thing this
 * design avoids.
 *
 * ── IT IS A SESSION ROUTE, NOT A TOKEN ROUTE, AND THAT IS LOAD-BEARING ───────────────────────
 * `requireUser()` means a cookie session. An MCP token deliberately CANNOT reach here: a read-only
 * credential must not be able to mint another credential, extend its own life, or revoke a sibling —
 * that is privilege escalation from `read` to account management, and it is the shape of bug that
 * makes a scope meaningless. So token management lives behind the browser session only, which is also
 * why `/mcp` (public, indexed, no session) links here rather than doing any of it.
 *
 * ── GUARD FIRST, VALIDATE SECOND ─────────────────────────────────────────────────────────────
 * `requireUser()` is the first statement in all three handlers, above every body read and above
 * `connectDB()`. CLAUDE.md §6: get it backwards and an anonymous caller sending a bad payload gets
 * 400 instead of 401, which tells a stranger their body parsed far enough to be judged.
 *
 * ── EVERY QUERY CARRIES `userId`, INCLUDING THE DELETE ───────────────────────────────────────
 * `DELETE` is `deleteOne({ _id, userId })`, never `findByIdAndDelete`. And it answers 404 for a row
 * that is not the caller's, never 403 — a 403 would confirm the row exists, and a Mongo ObjectId
 * embeds a timestamp and a counter so neighbours are enumerable. Same rule `get_event` follows.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

interface TokenDTO {
  id: string;
  name: string;
  /** Last four characters only. The secret is unrecoverable. */
  hint: string;
  scope: string;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
  lastUsedAt: string | null;
}

function toDTO(row: {
  _id: unknown;
  name: string;
  hint: string;
  scope: string;
  createdAt: Date;
  expiresAt: Date;
  lastUsedAt?: Date | null;
}): TokenDTO {
  return {
    id: String(row._id),
    name: row.name,
    hint: row.hint,
    scope: row.scope,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    expired: row.expiresAt.getTime() <= Date.now(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
  };
}

export async function GET() {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  try {
    await connectDB();
    /**
     * EXPIRED ROWS ARE LISTED, flagged rather than hidden.
     *
     * A token that stopped working is exactly what somebody is looking for when their assistant broke,
     * and filtering it out here would make the answer "you have no tokens" — which is how a fixable
     * problem becomes a mystery. `lib/models/McpToken.ts` records the matching decision not to sweep
     * them with a TTL index, for the same reason.
     *
     * `.select()` is explicit and omits `tokenHash`. Not because the hash is a secret worth much on
     * its own, but because a route that never projects it cannot leak it into a log, an error body or
     * a client-side cache by accident.
     */
    const rows = await McpToken.find({ userId: gate.userId })
      .select('_id name hint scope createdAt expiresAt lastUsedAt')
      .sort({ createdAt: -1 })
      .lean();

    return NextResponse.json(
      { tokens: rows.map(r => toDTO(r as Parameters<typeof toDTO>[0])), max: MAX_TOKENS_PER_USER },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('[mcp-tokens] list failed:', error);
    return NextResponse.json({ error: 'Could not load your access tokens' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  /**
   * The body is read AFTER the guard and validated before the write.
   *
   * Hand-rolled rather than routed through a shared validator because there are two fields; what
   * matters is that the failure is a NAMED 400 and not a Mongoose ValidationError reaching the
   * catch-all as a 500 with `details: err.message` — the leak CLAUDE.md §6 documents for the tracker
   * write paths, which hands back the model name and the schema path.
   */
  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    body = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return NextResponse.json({ error: 'Request body must be valid JSON' }, { status: 400 });
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name.length === 0) {
    return NextResponse.json(
      { error: 'Give the token a name, so you can tell which client it belongs to', field: 'name' },
      { status: 400 }
    );
  }
  if (name.length > 80) {
    return NextResponse.json(
      { error: 'That name is too long (80 characters max)', field: 'name' },
      { status: 400 }
    );
  }

  const requestedDays =
    body.expiresInDays === undefined || body.expiresInDays === null
      ? TOKEN_TTL_DAYS.default
      : Number(body.expiresInDays);
  if (!Number.isFinite(requestedDays)) {
    return NextResponse.json(
      { error: '"expiresInDays" must be a number of days', field: 'expiresInDays' },
      { status: 400 }
    );
  }

  try {
    await connectDB();

    /**
     * The per-account ceiling, counted over LIVE tokens only.
     *
     * Expired rows are kept for the diagnostic value described in the model, so counting them here
     * would eventually lock somebody out of minting with a list of dead credentials. The cap exists to
     * stop a compromised session quietly minting durable credentials, and a dead one is not that.
     */
    const live = await McpToken.countDocuments({
      userId: gate.userId,
      expiresAt: { $gt: new Date() },
    });
    if (live >= MAX_TOKENS_PER_USER) {
      return NextResponse.json(
        {
          error: `You already have ${MAX_TOKENS_PER_USER} active access tokens. Revoke one you no longer use first.`,
        },
        { status: 409 }
      );
    }

    const token = newMcpToken();
    const row = await McpToken.create({
      userId: gate.userId,
      name,
      tokenHash: hashMcpToken(token),
      hint: tokenHint(token),
      scope: 'read',
      expiresAt: expiryFromDays(requestedDays),
    });

    /**
     * THE ONE AND ONLY TIME THE TOKEN IS RETURNED. `no-store` matters more here than anywhere else in
     * this app — a cached response carrying a live credential is a credential in a proxy.
     */
    return NextResponse.json(
      { token, created: toDTO(row as unknown as Parameters<typeof toDTO>[0]) },
      { status: 201, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('[mcp-tokens] create failed:', error);
    // No `details` — the only thing it would carry is the Mongoose wording this exists to withhold.
    return NextResponse.json({ error: 'Could not create that access token' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  const id = request.nextUrl.searchParams.get('id');
  // A 24-hex check before the query, so a malformed id is a named 400 rather than a CastError that
  // reaches the catch-all as a 500 (CLAUDE.md §6, the `eventId` case).
  if (!id || !/^[0-9a-fA-F]{24}$/.test(id)) {
    return NextResponse.json({ error: 'Which token? Pass a valid ?id=', field: 'id' }, { status: 400 });
  }

  try {
    await connectDB();

    /**
     * A HARD DELETE, scoped by BOTH `_id` AND `userId`.
     *
     * `lib/models/McpToken.ts` records why this is not a soft delete when almost everything else in
     * this app is: a soft-deleted event that a query forgets to exclude is a stale listing, while a
     * soft-revoked credential that a query forgets to exclude still works. Deletion cannot be got
     * wrong by omission.
     */
    const result = await McpToken.deleteOne({ _id: id, userId: gate.userId });

    // 404 rather than 403 for somebody else's token — a 403 confirms the row exists.
    if (result.deletedCount === 0) {
      return NextResponse.json({ error: 'No such access token' }, { status: 404 });
    }

    return NextResponse.json({ revoked: true }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[mcp-tokens] revoke failed:', error);
    return NextResponse.json({ error: 'Could not revoke that access token' }, { status: 500 });
  }
}
