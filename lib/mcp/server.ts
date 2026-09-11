// The MCP method dispatcher: one JSON-RPC payload in, one HTTP-shaped answer out. PURE.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// `runTool` IS A PARAMETER, NOT AN IMPORT, AND THAT IS THE DESIGN. Importing the handlers here would
// pull mongoose into this module and put the entire protocol surface out of reach of the vitest tier
// — which is scoped to pure functions on purpose (`vitest.config.mts`). With the runner injected,
// `tests/mcp-tools.test.ts` drives `initialize`, `tools/list`, `tools/call`, `ping`, batches,
// notifications and every malformed shape against a stub, with no database and no server. The route
// file supplies the real runner and does nothing else of consequence.
//
// STILL STATELESS IN v2, AND AUTHENTICATION DID NOT CHANGE THAT. No sessions, no `Mcp-Session-Id`,
// no server-initiated messages, no SSE. The credential is a bearer token presented on EVERY request
// and verified from the database each time, so there is nothing to keep per client — which is what
// makes it correct on serverless, where two requests from one client routinely land on different
// instances and any in-memory session would be a coin flip. An OAuth flow would have added the one
// thing this design does not have (short-lived tokens with server-side refresh state) and would have
// needed that same shared store to be correct.
//
// `identity` IS THREADED THROUGH AS A PARAMETER, exactly like `runTool`, and for the same reason: this
// module must stay pure and testable. It reads no cookie and calls no session helper — the route
// resolves the identity (`lib/mcp/auth.ts`) and hands it down. So `tests/mcp-auth.test.ts` can drive
// the entire authenticated surface, including the refusals, with no database and no server.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import {
  JSON_RPC_ERRORS,
  jsonRpcError,
  jsonRpcResult,
  negotiateProtocolVersion,
  paramsRecord,
  parseIncoming,
  type JsonRpcMessage,
  type JsonRpcResponse,
} from './protocol';
import { PUBLIC_TOOL_DEFS, findToolDef, isPersonalTool, toolsFor } from './tool-defs';
import type { McpIdentity } from './identity';

export const SERVER_INFO = {
  name: 'pulseblr',
  title: 'PulseBLR — Bengaluru tech events and the people you meet at them',
  version: '2.0.0',
} as const;

/**
 * Sent with `initialize`. A client puts this in front of the model once, so it is where the
 * standing facts about the corpus belong — the things a per-tool description should not have to
 * repeat and that a model would otherwise guess wrong.
 */
export const SERVER_INSTRUCTIONS = [
  'PulseBLR indexes software and hardware engineering events in Bengaluru, India, gathered from',
  'Luma, Meetup, Eventbrite, Devfolio, developers.events, GDG/CNCF community platforms and others,',
  'then de-duplicated across sources.',
  '',
  'Three things worth knowing before you call anything:',
  '',
  '1. BENGALURU ONLY, AND ENGINEERING ONLY. Non-tech events are stored but never returned here, so',
  '   an empty result means no engineering events match — not that the city is quiet.',
  '2. RANKED, NOT LISTED. The default order is a 0-100 "connection potential" score: in-person',
  '   events with a real venue and a host organisation rank high, webinars and paid-course funnels',
  '   rank near zero. If the user asked what is on soonest, pass sort="soonest" explicitly.',
  '3. ALWAYS GIVE THE USER THE `url` FROM A RESULT. It is the canonical page for that event and the',
  '   only reliable way for them to register; do not reconstruct a link or send them to the source',
  '   platform instead.',
  '',
  'All times are India Standard Time. Every row carries both an ISO instant and an IST label.',
].join('\n');

/**
 * Appended to the instructions ONLY for a caller whose token verified.
 *
 * Two reasons it is conditional rather than always sent. It would be actively misleading to an
 * anonymous client — describing four tools that are absent from its `tools/list`, which reads as a
 * broken server. And the personal half needs its own framing that the public half does not: that the
 * data is the user's own record rather than anything scraped, and that an empty answer there means
 * "you have not recorded any" rather than "there are none".
 */
export const AUTHENTICATED_INSTRUCTIONS = [
  '',
  'THIS CONNECTION IS AUTHENTICATED, so four more tools are available: my_people,',
  'who_did_i_meet_at, my_follow_ups and my_saved_events. They read the signed-in user’s OWN records',
  'and nobody else’s.',
  '',
  'What that means in practice:',
  '',
  '· "Who do I know at <company>?" is answerable — call my_people with `company`. Nothing else has',
  '  this data, because it exists only because this person captured it at an event.',
  '· An empty result from these four means the USER has not recorded anything matching, not that',
  '  nothing exists. Say so that way — "you have not logged anyone at Stripe" rather than "no results".',
  '· my_follow_ups returning nothing is GOOD NEWS. Report it as nothing outstanding.',
  '· These records are private. Do not put a person’s name, employer or contact details into anything',
  '  that leaves this conversation unless the user asked you to.',
].join('\n');

/** The instructions for one caller. Anonymous gets the public half only. */
export function instructionsFor(identity: McpIdentity | null): string {
  return identity ? `${SERVER_INSTRUCTIONS}\n${AUTHENTICATED_INSTRUCTIONS}` : SERVER_INSTRUCTIONS;
}

/** What a tool returns. Mirrors the MCP `CallToolResult` shape. */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: unknown;
  /** True when the tool RAN and could not answer. Not for protocol-level failures — see below. */
  isError?: boolean;
}

/**
 * Either a tool result, or a JSON-RPC error to return instead.
 *
 * The distinction is the one `JSON_RPC_ERRORS` documents and it is not pedantry: bad ARGUMENTS are a
 * protocol failure (`-32602`, the client sent something the declared schema forbids) while "nothing
 * matched" or "that event is not public" is a successful call with a negative answer. Collapsing
 * them makes a client report the server as broken when the honest answer is "no".
 */
export type ToolOutcome =
  | { result: ToolResult }
  | { error: { code: number; message: string; data?: unknown } };

/**
 * Runs one tool.
 *
 * `identity` is the LAST parameter and may be `null`, which keeps every existing two-parameter runner
 * (the test stub included) type-compatible. The real runner in `handlers.ts` narrows it to a
 * non-nullable `userId` before any personal handler is reached, and each of those takes the id as a
 * REQUIRED POSITIONAL argument — so "forgot to scope this query" is not expressible there. That is the
 * `getNewEventsSince(viewerId, since)` precedent: an optional viewer id fails OPEN, and one call site
 * forgetting it leaks every user's data.
 */
export type ToolRunner = (
  name: string,
  args: unknown,
  identity: McpIdentity | null
) => Promise<ToolOutcome>;

export interface McpHttpResult {
  status: number;
  /**
   * True when the ONLY thing wrong with this payload was a missing credential, so the route should
   * add a `WWW-Authenticate` header. Reported rather than inferred from the status, because a 401 can
   * also arrive from the route's own pre-body credential check and the two paths must agree.
   */
  authRequired?: boolean;
  /**
   * `null` ⇒ send an EMPTY body. A payload of nothing but notifications has no response, and
   * JSON-RPC is explicit that a notification must not be answered — the HTTP status carries the
   * acknowledgement instead (202).
   */
  body: JsonRpcResponse | JsonRpcResponse[] | null;
}

/**
 * Handle one already-JSON-parsed request body.
 *
 * A batch answers with an array containing only the entries that had ids; if every entry was a
 * notification the whole batch answers 202 with no body, same as a single notification.
 */
export async function handleMcpPayload(
  body: unknown,
  runTool: ToolRunner,
  identity: McpIdentity | null = null
): Promise<McpHttpResult> {
  const { batch, entries } = parseIncoming(body);
  const responses: JsonRpcResponse[] = [];

  for (const entry of entries) {
    if ('failure' in entry) {
      responses.push(entry.failure);
      continue;
    }
    const response = await dispatch(entry.message, runTool, identity);
    if (response) responses.push(response);
  }

  if (responses.length === 0) return { status: 202, body: null };

  /**
   * LIFT AN AUTH FAILURE TO AN HTTP 401 — BUT ONLY FOR A SINGLE REQUEST, NEVER FOR A BATCH.
   *
   * A single `tools/call` on a personal tool with no credential is unambiguous, and 401 is what MCP's
   * error table names for "Authorization required" and what makes a client prompt for a credential
   * instead of reporting a broken tool.
   *
   * A BATCH STAYS 200, and that is the interesting case. `["search_events", "my_people"]` is a legal
   * payload from a client negotiating 2024-11-05 or 2025-03-26, and exactly one of its two entries is
   * unauthorised. One HTTP status cannot describe both, and choosing 401 would discard a perfectly
   * good public answer the caller was entitled to — so the batch keeps its per-entry errors and the
   * transport says 200, which is what JSON-RPC batching means. `WWW-Authenticate` is not set either:
   * RFC 9110 defines that header for 401 only, and putting it on a 200 is noise a client may act on.
   */
  const everyResponseIsAuth =
    responses.length > 0 &&
    responses.every(r => 'error' in r && r.error.code === JSON_RPC_ERRORS.unauthorized);

  if (!batch && everyResponseIsAuth) {
    return { status: 401, authRequired: true, body: responses[0] };
  }

  return { status: 200, body: batch ? responses : responses[0] };
}

/**
 * Route one message. Returns `null` for a notification, which must receive no response.
 *
 * ── WHY `resources/list` AND `prompts/list` ANSWER WITH EMPTY LISTS ──────────────────────────
 * This server declares only the `tools` capability, so a well-behaved client will not ask. Several
 * real clients probe anyway on connect, and a `-32601` there is rendered to the user as a red error
 * on an otherwise healthy connection. An empty list is true, costs nothing, and cannot be mistaken
 * for a capability we do not have — the capability block is what a client is supposed to read.
 */
export async function dispatch(
  message: JsonRpcMessage,
  runTool: ToolRunner,
  /**
   * DEFAULTS TO `null`, i.e. ANONYMOUS, and the default direction is the whole point: a call site that
   * forgets this argument advertises and runs only the public tools. That loses a feature; the
   * opposite default would hand every anonymous caller the personal ones.
   */
  identity: McpIdentity | null = null
): Promise<JsonRpcResponse | null> {
  const { method, id } = message;
  const isNotification = id === undefined;

  // Notifications are acknowledged by silence whether or not we know the method. `cancelled`,
  // `initialized`, `progress` and anything a future revision adds all land here, and answering an
  // unknown one with an error would be a protocol violation as well as noise.
  if (isNotification) return null;

  switch (method) {
    case 'initialize': {
      const params = paramsRecord(message.params);
      return jsonRpcResult(id, {
        protocolVersion: negotiateProtocolVersion(params.protocolVersion),
        capabilities: {
          // `listChanged: false` is stated rather than omitted: the tool set is compiled in, so it
          // cannot change while a client is connected and a client should not subscribe.
          tools: { listChanged: false },
        },
        serverInfo: SERVER_INFO,
        instructions: instructionsFor(identity),
      });
    }

    case 'ping':
      // Spec: an empty result object. Used by clients as a liveness check.
      return jsonRpcResult(id, {});

    case 'tools/list':
      /**
       * THE LISTING IS IDENTITY-DEPENDENT, and this line is the one that keeps a personal tool out of
       * an anonymous client's tool picker. No pagination either way — four or eight tools — and a
       * `nextCursor` is omitted entirely, which is how a client knows the listing is complete.
       */
      return jsonRpcResult(id, { tools: toolsFor(identity !== null) });

    case 'tools/call': {
      const params = paramsRecord(message.params);
      const name = params.name;

      if (typeof name !== 'string' || name.length === 0) {
        return jsonRpcError(id, JSON_RPC_ERRORS.invalidParams, 'tools/call requires a tool "name".');
      }
      if (!findToolDef(name)) {
        return jsonRpcError(
          id,
          JSON_RPC_ERRORS.invalidParams,
          `Unknown tool "${name}". Available: ${toolsFor(identity !== null)
            .map(t => t.name)
            .join(', ')}.`
        );
      }

      /**
       * GUARD FIRST, VALIDATE SECOND — enforced HERE, above `runTool`, so no argument of a personal
       * call is ever parsed for an unauthenticated caller.
       *
       * CLAUDE.md §6 records why the order matters: get it backwards and an anonymous caller sending a
       * bad payload receives 400 instead of 401, which tells a stranger their body parsed and
       * validated far enough to be judged. `tests/mcp-auth.test.ts` probes exactly that — a personal
       * tool called anonymously with a deliberately invalid body must answer with the auth code, and a
       * `-32602` there would mean validation outran the guard.
       *
       * Note the ordering against "unknown tool" above is also deliberate and the other way round: a
       * name that is not a tool at all is a `-32602` for everybody, because refusing to say whether a
       * misspelling exists would make a typo indistinguishable from a permissions problem.
       */
      if (identity === null && isPersonalTool(name)) {
        return jsonRpcError(
          id,
          JSON_RPC_ERRORS.unauthorized,
          `"${name}" reads this user's own saved events, people and follow-ups, so it needs a ` +
            'PulseBLR access token. The user can mint one at /settings → Assistant access and add it ' +
            'to this client as an "Authorization: Bearer <token>" header; /mcp has the exact config. ' +
            `The public tools (${PUBLIC_TOOL_DEFS.map(t => t.name).join(', ')}) need no credential.`
        );
      }

      try {
        const outcome = await runTool(name, params.arguments, identity);
        if ('error' in outcome) {
          return jsonRpcError(id, outcome.error.code, outcome.error.message, outcome.error.data);
        }
        return jsonRpcResult(id, outcome.result);
      } catch (error) {
        /**
         * A THROW FROM A HANDLER IS AN INTERNAL ERROR AND ITS MESSAGE DOES NOT LEAVE THIS PROCESS.
         *
         * The message on a Mongoose error names the model and the schema path, which is free
         * reconnaissance on the internal shape of the data — the same leak the tracker write paths
         * had to stop returning as `details: err.message` (CLAUDE.md §6). The real wording goes to
         * the server log.
         */
        console.error(`[mcp] tool "${name}" threw:`, error);
        return jsonRpcError(
          id,
          JSON_RPC_ERRORS.internal,
          'That lookup failed on our side. Try again shortly.'
        );
      }
    }

    case 'resources/list':
      return jsonRpcResult(id, { resources: [] });
    case 'resources/templates/list':
      return jsonRpcResult(id, { resourceTemplates: [] });
    case 'prompts/list':
      return jsonRpcResult(id, { prompts: [] });

    default:
      return jsonRpcError(
        id,
        JSON_RPC_ERRORS.methodNotFound,
        `Method "${method}" is not supported. This server implements initialize, ping, tools/list and tools/call.`
      );
  }
}

/** Build the `-32602` reply for a validated-arguments failure, naming every issue at once. */
export function invalidArgs(issues: string[]): ToolOutcome {
  return {
    error: {
      code: JSON_RPC_ERRORS.invalidParams,
      message: issues.join(' '),
      data: { issues },
    },
  };
}

/** Build a successful tool result carrying both the prose and the structured payload. */
export function toolResult(text: string, structuredContent: unknown): ToolOutcome {
  return { result: { content: [{ type: 'text', text }], structuredContent } };
}

/** A tool that ran and has a negative answer. `isError` so the model does not read it as data. */
export function toolFailure(text: string): ToolOutcome {
  return { result: { content: [{ type: 'text', text }], isError: true } };
}
