import { NextRequest, NextResponse } from 'next/server';

import { handleMcpPayload } from '@/lib/mcp/server';
import { JSON_RPC_ERRORS, jsonRpcError } from '@/lib/mcp/protocol';
import { runTool } from '@/lib/mcp/handlers';
import { resolveMcpIdentity } from '@/lib/mcp/auth';
import type { McpIdentity } from '@/lib/mcp/identity';
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
 * v2 ADDS AN AUTHENTICATED HALF WITHOUT TAKING THE PUBLIC HALF AWAY. An anonymous caller still gets
 * the four public tools and still gets a 200 — `scripts/diag-api-auth.ts` asserts exactly that, and
 * it must keep passing. A caller presenting a valid `Authorization: Bearer pblr_…` additionally gets
 * `my_people`, `who_did_i_meet_at`, `my_follow_ups` and `my_saved_events`, scoped to the account that
 * minted the token.
 *
 * The public plans are unchanged and still provably anonymous: `lib/mcp/query-plan.ts` passes the
 * ANONYMOUS viewer to `buildEventFilter` on every one of them, so `visibilityClause(null)` yields the
 * two public arms and no owner arm. `runTool` does not forward an identity to those four even when one
 * exists — see the note on `PUBLIC_HANDLERS`.
 *
 * ── WHY A PERSONAL ACCESS TOKEN AND NOT OAUTH 2.1 ────────────────────────────────────────────
 * The MCP authorization spec is explicit that "Authorization is OPTIONAL for MCP implementations" and
 * that an HTTP transport "SHOULD conform" when it is supported — a SHOULD, not a MUST. Conforming
 * properly means being an OAuth 2.1 authorization server: RFC 9728 protected-resource metadata, RFC
 * 8414 AS metadata, RFC 7591 dynamic client registration, an `/authorize` consent screen, `/token`
 * with PKCE verification, refresh rotation, and two new collections with TTLs for codes and clients.
 * That is roughly eight endpoints whose ONLY failure mode is a browser redirect dance that cannot be
 * exercised without driving a real browser through it.
 *
 * A token is chosen because it is TESTABLE and the OAuth flow, here, would not have been: every
 * branch of `lib/mcp/identity.ts` and `lib/mcp/server.ts`'s partition is asserted in
 * `tests/mcp-auth.test.ts` with no database and no server. Untested OAuth in front of somebody's
 * private contact list is worse than tested bearer auth in front of it. The cost is stated plainly on
 * `/mcp`: a client that can set a header (Claude Code, Cursor, VS Code/Copilot, anything reading an
 * `mcp.json`) can use the personal tools; the Claude.ai / Claude Desktop *connector directory* flow,
 * which drives OAuth and offers no header field, cannot. It reaches the public four as before.
 *
 * ── FIVE THINGS IN THIS FILE THAT ARE NOT BOILERPLATE ────────────────────────────────────────
 *
 * 1. THE CREDENTIAL IS CHECKED BEFORE THE BODY IS READ. GUARD FIRST, VALIDATE SECOND (CLAUDE.md §6):
 *    a caller presenting a BAD token gets 401 without its payload ever being parsed, so it cannot
 *    learn whether the body would have validated. The partition for a caller presenting NO token is
 *    enforced one layer in, by `dispatch`, above `runTool` — because that caller is legitimate and
 *    must still be served the public tools.
 *
 * 2. THE BODY IS SIZE-CAPPED BEFORE IT IS PARSED. This endpoint still accepts arbitrary JSON from
 *    anonymous callers, and `JSON.parse` on a 50 MB body is a free way to burn a function's memory.
 *    The cap is read off the text, not `Content-Length`, because that header is client-supplied.
 *
 * 3. CORS IS STILL `*`, AND A BEARER TOKEN DOES NOT CHANGE THAT CALCULUS. Worth the paragraph,
 *    because it looks like it should:
 *
 *    · CSRF exists because browsers attach AMBIENT credentials — cookies, HTTP auth, client certs —
 *      to cross-origin requests by themselves. A bearer token is not ambient. A page must set the
 *      header explicitly, which means already knowing the token; an attacker who knows it does not
 *      need the victim's browser at all.
 *    · `Allow-Origin: *` lets a cross-origin page READ the response. That only matters when the
 *      request carried authority the attacker did not supply. Here it cannot: no cookie is read on
 *      this route (`resolveMcpIdentity` is handed the `Authorization` header STRING and nothing else),
 *      so ambient authority is structurally unreachable rather than merely unused.
 *    · `Access-Control-Allow-Credentials` STAYS ABSENT, and the two settings are coupled in a way
 *      worth knowing: browsers FORBID `Allow-Origin: *` together with `Allow-Credentials: true`. So
 *      anyone adding the latter is forced to narrow the former, and that combined change is what
 *      would make the app's own session cookie flow here and turn this into a real CSRF surface. Do
 *      not add it.
 *    · What is left is that a hostile page can make an UNCREDENTIALED call and read public event
 *      data. It could equally call this endpoint from its own server. Unchanged from v1.
 *    · The real risks to a bearer token are exfiltration — pasted into a config that gets committed,
 *      a shell history, a screenshot. Those are answered by hashing at rest, the recognisable `pblr_`
 *      prefix, mandatory expiry and one-click revocation, not by CORS.
 *
 * 4. THERE IS NO SSE, AND `GET` REFUSES RATHER THAN HANGING. Streamable HTTP allows a client to
 *    open a server→client stream with `GET`. A stateless read-only server has nothing to push, and
 *    a 200 that never emits an event is worse than a refusal — the client sits waiting. A `405`
 *    naming the reason is a documented, valid response for a server that does not offer the stream.
 *
 * 5. NOTHING IS CACHED. `Cache-Control: no-store` on every response, including the refusals: a
 *    proxy caching a 429 would extend one client's throttle to everybody behind it, and a proxy
 *    caching an authenticated 200 would serve one user's contacts to the next caller. `Vary:
 *    Authorization` is sent as well — belt and braces, since `no-store` already forbids the reuse,
 *    but a heuristic cache that ignores `no-store` must at least not ignore both.
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
 * requests before a single question is asked. Raised from 60 to 120 for v2: there are eight tools
 * now, and a single conversational turn like "who do I know at Razorpay and what are they likely to
 * be at this month" legitimately calls three or four of them.
 *
 * ── IS THIS STILL ACCEPTABLE NOW THAT A TOKEN GRANTS ACCESS TO PRIVATE DATA? YES, AND THE REASON
 *    IS STRONGER THAN IT WAS, NOT WEAKER. ──────────────────────────────────────────────────────
 * `lib/security/rate-limit.ts`'s header is explicit that per-instance memory on serverless makes this
 * a NUISANCE FILTER rather than a control: a cold instance starts with a full bucket, and the platform
 * spreads a burst across instances without the caller doing anything clever. v1's justification was
 * "the worst case is Atlas read load, not disclosure", which stops being true on its own terms the
 * moment private data is reachable. So it has to be re-argued rather than inherited:
 *
 *   · The limiter is NOT what protects the private half — the token is. A caller with no token gets
 *     nothing from the personal tools at any request rate, and a caller with one is the owner of the
 *     data it returns. Bypassing the limiter does not move a caller across that boundary.
 *   · The thing a limiter classically protects a credential from is GUESSING, and that threat does not
 *     exist here: the token is 32 bytes of CSPRNG output, so the keyspace is ~10^77. No achievable
 *     request rate is relevant to it, which is why the entropy and not the counter is load-bearing.
 *     `isWellFormedToken` also refuses a malformed credential before any database round trip, so a
 *     spray of junk bearer headers costs one regex each and never reaches Atlas.
 *   · What is NOT bounded is what was never bounded: a determined caller can burn Atlas reads on the
 *     public half. Unchanged from v1, and still the honest residual.
 *
 * It would NOT be acceptable if any of three things changed: a write tool, a lower-entropy credential,
 * or per-user quota billing. Each of those needs shared counters (a Mongo collection with a TTL index
 * adds no dependency), not a smaller number here.
 *
 * The bucket is keyed by client IP and NOT by token, deliberately: the limiter runs before the token
 * is resolved, which is what keeps an unauthenticated flood away from the database in the first place.
 * The cost is that two users behind one NAT share a bucket — acceptable at 120/minute.
 */
const RATE_LIMIT = { limit: 120, windowMs: 60_000 } as const;

/** Headers a client may send us. `mcp-protocol-version` and `mcp-session-id` are the MCP ones. */
const ALLOWED_HEADERS = 'content-type, accept, mcp-protocol-version, mcp-session-id, authorization';

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': ALLOWED_HEADERS,
    'Access-Control-Max-Age': '86400',
    // NO `Access-Control-Allow-Credentials`. See note 3 in the header — it is absent on purpose and
    // adding it would force `Allow-Origin` to narrow, which is the change that creates a CSRF surface.
  };
}

function baseHeaders(): Record<string, string> {
  return {
    ...corsHeaders(),
    'Cache-Control': 'no-store',
    // The response now depends on a request header, so any cache between us and the client must key on
    // it. `no-store` should make this redundant; a cache that honours only one of the two must honour
    // the one that prevents serving one user's people to the next caller.
    Vary: 'Authorization',
  };
}

/**
 * The `WWW-Authenticate` challenge for a 401.
 *
 * ── IT DELIBERATELY CARRIES NO `resource_metadata` PARAMETER, AND THAT IS THE HONEST CHOICE ───
 * RFC 9728 §5.1 defines a `resource_metadata` parameter here, and the MCP spec says a server
 * implementing OAuth MUST use it to point at `/.well-known/oauth-protected-resource`. This server does
 * NOT implement OAuth, so emitting that pointer would send a spec-conformant client off to fetch a
 * document that does not exist, get a 404, and fail with an OAuth discovery error instead of the
 * actionable message sitting in the response body. A challenge that lies about the mechanism is worse
 * than one that is merely minimal.
 *
 * `error="invalid_token"` is included only when a credential was actually presented and rejected —
 * RFC 6750 §3.1 says a server SHOULD NOT include an error code when the request carried no
 * authentication information at all, because there is nothing yet to call invalid.
 */
function challenge(kind: 'missing' | 'invalid'): string {
  const parts = ['Bearer realm="PulseBLR MCP"'];
  if (kind === 'invalid') parts.push('error="invalid_token"');
  parts.push(
    `error_description="Mint a read-only access token in PulseBLR Settings and send it as an Authorization: Bearer header. Setup: ${absoluteUrl('/mcp')}"`
  );
  return parts.join(', ');
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

  /**
   * IDENTITY SECOND, STILL BEFORE THE BODY.
   *
   * Three outcomes and all three are distinct (`lib/mcp/identity.ts` explains why collapsing any pair
   * breaks something):
   *
   *   anonymous   → carry on with `identity = null`. The public tools answer 200. This is v1's caller
   *                 and `scripts/diag-api-auth.ts` asserts it keeps working.
   *   rejected    → 401 HERE, with the body NEVER READ. That is the "guard first, validate second"
   *                 ordering CLAUDE.md §6 insists on: a caller with a dead token and a malformed
   *                 payload must not be told its payload was malformed.
   *   identified  → carry on with the identity, which `dispatch` uses to widen `tools/list` and to
   *                 permit a personal `tools/call`.
   */
  let identity: McpIdentity | null = null;
  const outcome = await resolveMcpIdentity(request.headers.get('authorization'));
  if (outcome.kind === 'rejected') {
    return NextResponse.json(
      jsonRpcError(null, JSON_RPC_ERRORS.unauthorized, outcome.reason),
      { status: 401, headers: { ...baseHeaders(), 'WWW-Authenticate': challenge('invalid') } }
    );
  }
  if (outcome.kind === 'identified') identity = outcome.identity;

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
    const { status, body: payload, authRequired } = await handleMcpPayload(body, runTool, identity);
    if (payload === null) return new Response(null, { status, headers: baseHeaders() });
    /**
     * A personal tool called with NO credential comes back as a 401 from `handleMcpPayload`, and it
     * needs the challenge header too — `kind: 'missing'`, not `'invalid'`, because nothing was
     * presented for us to call invalid. A batch never lands here: it stays 200 with per-entry errors,
     * so its public half still answers. See `handleMcpPayload`.
     */
    if (authRequired) {
      return NextResponse.json(payload, {
        status,
        headers: { ...baseHeaders(), 'WWW-Authenticate': challenge('missing') },
      });
    }
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
