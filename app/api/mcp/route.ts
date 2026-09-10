import { NextRequest, NextResponse } from 'next/server';

import { handleMcpPayload } from '@/lib/mcp/server';
import { JSON_RPC_ERRORS, jsonRpcError } from '@/lib/mcp/protocol';
import { runTool } from '@/lib/mcp/handlers';
import { clientKey, rateLimit } from '@/lib/security/rate-limit';
import { absoluteUrl } from '@/lib/canonical-origin';

/**
 * `/api/mcp` — PulseBLR's Model Context Protocol endpoint, Streamable HTTP transport.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS FOR. It puts the Bengaluru engineering-events corpus inside Claude, Cursor, Copilot
 * and anything else that speaks MCP, so a developer asking "what AI meetups are on in Koramangala
 * this week" gets an answer with a link to our page without ever opening a browser. The connect
 * instructions live at `/mcp`.
 *
 * v1 IS READ-ONLY AND UNAUTHENTICATED, DELIBERATELY. There is no per-user data in the surface, so
 * there is no OAuth to build and nothing to leak — see the v2 note on the `/mcp` page for what
 * authentication would buy and why it is not a prerequisite. Concretely: this file reads no cookies,
 * calls no session helper and sets no `Set-Cookie`, and every query is built by
 * `lib/mcp/query-plan.ts`, which passes the ANONYMOUS viewer to `buildEventFilter` — so
 * `visibilityClause(null)` yields the two public arms and no owner arm, and another user's private
 * or pending event cannot match.
 *
 * ── FOUR THINGS IN THIS FILE THAT ARE NOT BOILERPLATE ────────────────────────────────────────
 *
 * 1. THE BODY IS SIZE-CAPPED BEFORE IT IS PARSED. This is the app's only unauthenticated endpoint
 *    that accepts arbitrary JSON, and `JSON.parse` on a 50 MB body is a free way to burn a
 *    function's memory. The cap is read off the text, not `Content-Length`, because that header is
 *    client-supplied.
 *
 * 2. CORS IS WIDE OPEN, AND THAT IS CORRECT HERE. The response contains only public event data, no
 *    credentials are accepted, and browser-based MCP clients cannot connect without it. Note
 *    `Access-Control-Allow-Credentials` is ABSENT: with `Allow-Origin: *` a browser would refuse it
 *    anyway, and stating it would imply this endpoint has a session to attach — it does not, and
 *    that is the property that makes `*` safe rather than a CSRF surface.
 *
 * 3. THERE IS NO SSE, AND `GET` REFUSES RATHER THAN HANGING. Streamable HTTP allows a client to
 *    open a server→client stream with `GET`. A stateless read-only server has nothing to push, and
 *    a 200 that never emits an event is worse than a refusal — the client sits waiting. A `405`
 *    naming the reason is a documented, valid response for a server that does not offer the stream.
 *
 * 4. NOTHING IS CACHED. `Cache-Control: no-store` on every response, including the refusals: a
 *    proxy caching a 429 would extend one client's throttle to everybody behind it.
 *
 * ── WHY THERE IS NO `export const runtime` ───────────────────────────────────────────────────
 * `nodejs` is the default for a route handler on this version, and the bundled docs
 * (`node_modules/next/dist/docs/…/route-segment-config/runtime.md`) say the Edge runtime is
 * DEPRECATED and to remove the export from route files. Mongoose could not run on edge regardless.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

/** Plenty for a JSON-RPC call against these tools; a `tools/call` payload is a few hundred bytes. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * A connect handshake is `initialize` + `notifications/initialized` + `tools/list`, so three
 * requests before a single question is asked. 60 a minute leaves room for a conversation that calls
 * several tools per turn while making a scripted loop uncomfortable.
 *
 * READ `lib/security/rate-limit.ts`'s HEADER BEFORE TRUSTING THIS NUMBER. That module is explicit
 * that per-instance memory on serverless makes it a NUISANCE FILTER, not a control: a cold instance
 * starts with a full bucket, and the platform spreads a burst across instances without the caller
 * doing anything clever. What it does buy is real, and it is the accidental case — a client stuck in
 * a retry loop, or a misconfigured agent polling `tools/list` — which is the failure mode an
 * unauthenticated endpoint actually meets. It cannot stop a deliberate abuser, and the honest reason
 * that is acceptable here is that the endpoint is READ-ONLY over data already published on public
 * web pages: the worst case is Atlas read load, not disclosure or corruption. If this ever needs to
 * be a real control, the upgrade is shared counters (a Mongo collection with a TTL index), not a
 * smaller number here.
 */
const RATE_LIMIT = { limit: 60, windowMs: 60_000 } as const;

/** Headers a client may send us. `mcp-protocol-version` and `mcp-session-id` are the MCP ones. */
const ALLOWED_HEADERS = 'content-type, accept, mcp-protocol-version, mcp-session-id, authorization';

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': ALLOWED_HEADERS,
    'Access-Control-Max-Age': '86400',
  };
}

function baseHeaders(): Record<string, string> {
  return { ...corsHeaders(), 'Cache-Control': 'no-store' };
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

/**
 * The server→client SSE stream this server does not offer. See note 3 above.
 *
 * The body is a JSON-RPC error rather than plain text so a client that parses everything as JSON-RPC
 * gets something it understands instead of a parse failure on top of the 405.
 */
export async function GET(): Promise<Response> {
  return NextResponse.json(
    jsonRpcError(
      null,
      JSON_RPC_ERRORS.invalidRequest,
      'This MCP endpoint is stateless and does not open a server-initiated SSE stream. POST JSON-RPC ' +
        `requests here instead; see ${absoluteUrl('/mcp')} for client configuration.`
    ),
    { status: 405, headers: { ...baseHeaders(), Allow: 'POST, OPTIONS' } }
  );
}

/** Session termination, for a transport that had a session. This one never issues an id. */
export async function DELETE(): Promise<Response> {
  return NextResponse.json(
    jsonRpcError(
      null,
      JSON_RPC_ERRORS.invalidRequest,
      'This MCP endpoint is stateless, so there is no session to terminate.'
    ),
    { status: 405, headers: { ...baseHeaders(), Allow: 'POST, OPTIONS' } }
  );
}

export async function POST(request: NextRequest): Promise<Response> {
  /**
   * RATE LIMIT FIRST, BEFORE THE BODY IS EVEN READ.
   *
   * The ordering matters for the same reason CLAUDE.md §6's "guard first, validate second" rule
   * does: a throttled caller must not learn whether its payload would have parsed, and reading a
   * 64 KB body to then refuse it is work an abusive caller gets for free. There is no auth guard on
   * this route to come first, so the limiter is the outermost check.
   */
  const limit = rateLimit(clientKey(request, 'mcp'), RATE_LIMIT);
  if (!limit.ok) {
    return NextResponse.json(
      jsonRpcError(
        null,
        JSON_RPC_ERRORS.rateLimited,
        `Too many requests. Retry in ${limit.retryAfterSeconds}s.`
      ),
      {
        status: 429,
        headers: { ...baseHeaders(), 'Retry-After': String(limit.retryAfterSeconds) },
      }
    );
  }

  const raw = await request.text().catch(() => null);
  if (raw === null) {
    return jsonRpc(jsonRpcError(null, JSON_RPC_ERRORS.parse, 'Could not read the request body.'), 400);
  }

  // Byte length, not character count: a body of multi-byte characters is bigger than it looks.
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
    return jsonRpc(
      jsonRpcError(
        null,
        JSON_RPC_ERRORS.invalidRequest,
        `Request body exceeds ${MAX_BODY_BYTES} bytes.`
      ),
      413
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return jsonRpc(jsonRpcError(null, JSON_RPC_ERRORS.parse, 'Request body must be valid JSON.'), 400);
  }

  /**
   * `handleMcpPayload` already converts a thrown handler into a `-32603` per message, so this catch
   * is for a failure in the framing itself. It answers 200 with a JSON-RPC error rather than a bare
   * 500: a client speaking JSON-RPC can render an error object, and cannot render an HTML 500 page.
   */
  try {
    const { status, body: payload } = await handleMcpPayload(body, runTool);
    if (payload === null) return new Response(null, { status, headers: baseHeaders() });
    return jsonRpc(payload, status);
  } catch (error) {
    console.error('[mcp] request failed:', error);
    return jsonRpc(
      jsonRpcError(null, JSON_RPC_ERRORS.internal, 'The MCP server could not handle that request.'),
      200
    );
  }
}

function jsonRpc(payload: unknown, status: number): Response {
  return NextResponse.json(payload, { status, headers: baseHeaders() });
}
