// JSON-RPC 2.0 and the MCP framing, implemented directly rather than through a package.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THERE IS NO SDK HERE. `@modelcontextprotocol/sdk` exists and would work, but the entire
// surface this server needs is `initialize`, `tools/list`, `tools/call` and `ping` over one POST
// handler — a few hundred lines of framing with no transport state to manage, because v1 is
// stateless (no sessions, no server-initiated messages, no SSE). Adding a dependency for that
// would put a moving third-party parser in front of the one endpoint on this app that accepts
// arbitrary JSON from anonymous callers, and `package.json` pins versions exactly on purpose (see
// the Next.js note at the top of CLAUDE.md). The trade is explicit: we own the framing, so we own
// its bugs — which is why every branch here is exercised by `tests/mcp-tools.test.ts` with a stub
// tool runner and no server.
//
// THIS MODULE IS PURE. No mongoose, no network, no `next/server`. That is what lets the whole
// protocol layer be tested in the vitest tier, and it is the reason `dispatch()` takes the tool
// runner as a PARAMETER instead of importing it — see `lib/mcp/server.ts`.
// ─────────────────────────────────────────────────────────────────────────────────────────────

export const JSONRPC_VERSION = '2.0';

/**
 * MCP revisions this server speaks, NEWEST FIRST.
 *
 * Three of them, because clients in the wild are spread across all three: `2024-11-05` is what
 * older Claude Desktop builds send, `2025-03-26` introduced Streamable HTTP, `2025-06-18` removed
 * JSON-RPC batching. The negotiation rule in `negotiateProtocolVersion` is the spec's: echo the
 * client's version when we support it, otherwise answer with our newest and let the client decide
 * whether it can proceed. Answering with a version the client did not ask for is NOT an error —
 * refusing outright would break every future client that asks for a revision published after this
 * file was written, which is the failure mode that matters for a server nobody will redeploy just
 * because a spec revision shipped.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

/**
 * JSON-RPC error codes. The first five are from the JSON-RPC 2.0 spec and their meanings are
 * fixed; `rateLimited` sits in the implementation-defined `-32000..-32099` band.
 *
 * WHICH CODE TO USE IS A REAL DECISION, not bookkeeping. MCP draws the line at whether the
 * PROTOCOL or the TOOL failed: a malformed request, an unknown method or arguments that do not fit
 * the declared schema are JSON-RPC errors, while a tool that ran and could not answer returns a
 * normal result carrying `isError: true`. Getting that backwards is what makes a client show
 * "the server is broken" when the honest answer is "no events match".
 */
export const JSON_RPC_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  rateLimited: -32000,
} as const;

/** A JSON-RPC id. `null` is deliberately absent — see `parseIncoming`. */
export type JsonRpcId = string | number;

export interface JsonRpcMessage {
  method: string;
  params?: unknown;
  /** Absent ⇒ this is a NOTIFICATION and must receive no response. */
  id?: JsonRpcId;
}

export interface JsonRpcSuccess {
  jsonrpc: typeof JSONRPC_VERSION;
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: typeof JSONRPC_VERSION;
  /** `null` when the request was too malformed to recover an id from. */
  id: JsonRpcId | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export function jsonRpcResult(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

export function jsonRpcError(
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: unknown
): JsonRpcFailure {
  return { jsonrpc: JSONRPC_VERSION, id, error: data === undefined ? { code, message } : { code, message, data } };
}

/** One parsed entry, or the error response that entry alone earned. */
export type ParsedEntry = { message: JsonRpcMessage } | { failure: JsonRpcFailure };

export interface ParsedPayload {
  /** True when the body was a JSON-RPC batch array, so the reply must also be an array. */
  batch: boolean;
  entries: ParsedEntry[];
}

/**
 * Turn an already-JSON-parsed request body into messages, rejecting the malformed ones
 * INDIVIDUALLY rather than failing the whole payload.
 *
 * ── WHY BATCHES ARE STILL ACCEPTED ──────────────────────────────────────────────────────────
 * `2025-06-18` removed JSON-RPC batching from MCP, and this server never sends one. It still
 * ACCEPTS one, because a client negotiating `2024-11-05` or `2025-03-26` is entitled to send it
 * and the handling is a loop. Rejecting a batch would be a compatibility failure dressed up as
 * strictness.
 *
 * ── WHY `id: null` IS AN ERROR RATHER THAN A NOTIFICATION ────────────────────────────────────
 * MCP states the request id MUST NOT be null. Treating null as "no id" would silently swallow a
 * request from a client that expected an answer — the caller sees a 202 and waits forever, which
 * is the least debuggable outcome available. An explicit `-32600` names the problem.
 *
 * ── WHY AN EMPTY BATCH IS AN ERROR ───────────────────────────────────────────────────────────
 * JSON-RPC 2.0 says so, and it is the one case where a batch cannot produce a per-entry error to
 * carry the complaint.
 */
export function parseIncoming(body: unknown): ParsedPayload {
  const batch = Array.isArray(body);
  const raw = batch ? (body as unknown[]) : [body];

  if (batch && raw.length === 0) {
    return {
      batch,
      entries: [
        { failure: jsonRpcError(null, JSON_RPC_ERRORS.invalidRequest, 'A JSON-RPC batch must not be empty.') },
      ],
    };
  }

  return { batch, entries: raw.map(parseEntry) };
}

function parseEntry(entry: unknown): ParsedEntry {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return {
      failure: jsonRpcError(
        null,
        JSON_RPC_ERRORS.invalidRequest,
        'A JSON-RPC message must be an object.'
      ),
    };
  }

  const record = entry as Record<string, unknown>;

  // The id is recovered BEFORE anything else is judged, so a request with a valid id and a bad
  // method still gets an answer the client can correlate rather than a dangling `id: null`.
  let id: JsonRpcId | undefined;
  if ('id' in record && record.id !== undefined) {
    if (typeof record.id === 'string' || (typeof record.id === 'number' && Number.isFinite(record.id))) {
      id = record.id;
    } else {
      return {
        failure: jsonRpcError(
          null,
          JSON_RPC_ERRORS.invalidRequest,
          'The JSON-RPC id must be a string or a number, and must not be null.'
        ),
      };
    }
  }

  if (record.jsonrpc !== JSONRPC_VERSION) {
    return {
      failure: jsonRpcError(
        id ?? null,
        JSON_RPC_ERRORS.invalidRequest,
        `Expected "jsonrpc": "${JSONRPC_VERSION}".`
      ),
    };
  }

  if (typeof record.method !== 'string' || record.method.length === 0) {
    return {
      failure: jsonRpcError(id ?? null, JSON_RPC_ERRORS.invalidRequest, '"method" must be a non-empty string.'),
    };
  }

  const message: JsonRpcMessage = { method: record.method };
  if (id !== undefined) message.id = id;
  if (record.params !== undefined) message.params = record.params;
  return { message };
}

/**
 * Which protocol revision to answer `initialize` with.
 *
 * Echoes a supported request, falls back to our newest for anything else — including a missing or
 * non-string value, which is what a hand-rolled client or a `curl` probe sends.
 */
export function negotiateProtocolVersion(requested: unknown): string {
  if (typeof requested === 'string' && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)) {
    return requested;
  }
  return LATEST_PROTOCOL_VERSION;
}

/** `params` as a plain record, or `{}` — so a caller never has to guard the shape twice. */
export function paramsRecord(params: unknown): Record<string, unknown> {
  if (typeof params === 'object' && params !== null && !Array.isArray(params)) {
    return params as Record<string, unknown>;
  }
  return {};
}
