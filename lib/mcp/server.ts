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
// STATELESS. No sessions, no `Mcp-Session-Id`, no server-initiated messages, no SSE. v1 is
// read-only and unauthenticated, so there is nothing to keep per client — which is also what makes
// it correct on serverless, where two requests from one client routinely land on different
// instances and any in-memory session would be a coin flip.
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
import { TOOL_DEFS, findToolDef } from './tool-defs';

export const SERVER_INFO = {
  name: 'pulseblr',
  title: 'PulseBLR — Bengaluru tech events',
  version: '1.0.0',
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

export type ToolRunner = (name: string, args: unknown) => Promise<ToolOutcome>;

export interface McpHttpResult {
  status: number;
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
export async function handleMcpPayload(body: unknown, runTool: ToolRunner): Promise<McpHttpResult> {
  const { batch, entries } = parseIncoming(body);
  const responses: JsonRpcResponse[] = [];

  for (const entry of entries) {
    if ('failure' in entry) {
      responses.push(entry.failure);
      continue;
    }
    const response = await dispatch(entry.message, runTool);
    if (response) responses.push(response);
  }

  if (responses.length === 0) return { status: 202, body: null };
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
  runTool: ToolRunner
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
        instructions: SERVER_INSTRUCTIONS,
      });
    }

    case 'ping':
      // Spec: an empty result object. Used by clients as a liveness check.
      return jsonRpcResult(id, {});

    case 'tools/list':
      // No pagination: four tools. A `nextCursor` is omitted entirely, which is how a client knows
      // the listing is complete.
      return jsonRpcResult(id, { tools: TOOL_DEFS });

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
          `Unknown tool "${name}". Available: ${TOOL_DEFS.map(t => t.name).join(', ')}.`
        );
      }

      try {
        const outcome = await runTool(name, params.arguments);
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
