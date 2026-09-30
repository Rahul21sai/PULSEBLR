/**
 * One notification to one device: the wire half of web push, and the verdict it produces.
 *
 * `./push.ts` decides who is sent what and records the outcome, and needs a database to do it. This
 * file is the part that talks to a push service, kept apart so the whole exchange can be driven
 * against a local stub with no database (`tests/push-transport.test.ts`). `sendToDevice` in
 * `./push.ts` is `sendToDeviceVia(PRODUCTION_PUSH_TRANSPORT, …)` and nothing else.
 *
 * ── WHY THIS DOES NOT CALL `webpush.sendNotification()`. ─────────────────────────────────────
 * Read from web-push 3.6.7 (`node_modules/web-push/src/web-push-lib.js`), not assumed:
 *
 *   · IT BUFFERS THE WHOLE RESPONSE BODY, with no limit and on every status: `responseText +=
 *     chunk`, settled only on `'end'`. A subscription's endpoint is a URL the CLIENT chose
 *     (`POST /api/me/push` checks its shape and nothing more), so an account could register a server
 *     that answers an endless body, and the morning run would hold it in memory until the runner
 *     died. `toLogLine`'s 200-character clip ran after the whole body had arrived, so it bounded the
 *     log line, not the process.
 *   · IT HAS NO DEADLINE. Its `timeout` option is Node's socket IDLE timeout, re-armed by every byte
 *     (its own typings say so: three packets 0.9 s apart never trip a 1 s timeout), and push.ts did
 *     not pass one anyway. A peer that accepted the connection and never answered held the run until
 *     GitHub killed the job.
 *   · IT CONNECTS TO A DIFFERENT PARSE OF THE URL THAN THE ONE THAT WAS CHECKED. The guard judged
 *     `new URL(endpoint)`; web-push connects with the legacy `url.parse()`, which Node deprecates for
 *     exactly this (DEP0169). Measured on Node 22 against this repo's own validator:
 *     `https://169.254.169.254%2eattacker.example/fcm/send/x` passes `validatePushSubscriptionInput`,
 *     and `assertSafeUrl` checks `169.254.169.254.attacker.example` (a name whose DNS the attacker
 *     runs, so it answers public), while `url.parse` connects to `169.254.169.254`, port 443. The
 *     same shape reaches `127.0.0.1` and `localhost`. A `;` in place of the `%2e` splits the two
 *     parsers the same way; whether a resolver answers for a name containing `;` was not tested.
 *   · AND IT RESOLVES THE HOST AGAIN, so even without that, the check was check-then-use: a DNS
 *     answer that changed between the check and the connect reached whatever it now pointed at.
 *
 * `web-push` still does what it is for, the aes128gcm encryption and the VAPID JWT, through
 * `generateRequestDetails()`: the half of `sendNotification` that builds the request. This file
 * sends those exact headers and bytes itself.
 *
 * ── THE LIMITS, IN THE ORDER THEY APPLY ──────────────────────────────────────────────────────
 *   1. WHAT. An https endpoint with no credentials, spelled canonically: the raw string must begin
 *      with `https://<the parsed host>/`, which is how every browser writes one. That one rule is what
 *      makes a parser differential unrepresentable, rather than a list of known ones.
 *   2. WHO. Only a known push service, on the default port (`isKnownPushServiceHost`). The limit
 *      that matters most, because it takes the choice of peer away from the caller: every limit
 *      below is then defence in depth against a misbehaving VENDOR, instead of the only thing between
 *      the runner and a hostile server.
 *   3. WHERE. Every address the host resolves to must be public (`isBlockedAddress`, the app's one
 *      definition), and the socket connects to exactly those addresses. The lookup is pinned, so
 *      what was checked is what is used.
 *   4. HOW LONG. A connect deadline (TCP and TLS) and a total deadline that starts before DNS.
 *   5. HOW MUCH. At most `PUSH_RESPONSE_MAX_BYTES` of a non-2xx body is read, then the socket is
 *      destroyed. A 2xx body is not read at all: the status line is the whole verdict.
 *   6. WHERE NEXT. Nowhere. A 3xx is a failed send and its `Location` is never fetched.
 * TLS verification is also stated explicitly (`rejectUnauthorized: true`), so an inherited
 * `NODE_TLS_REJECT_UNAUTHORIZED=0` cannot turn it off on this path.
 *
 * ── THE TEST SEAM, AND WHY IT IS NOT A WEAKENING. ─────────────────────────────────────────────
 * The host policy, the resolver, the address policy, the deadlines and the trust store are fields of
 * a `PushTransport`, so a test can point the real code at `127.0.0.1` with a certificate it made.
 * Production cannot reach that: `PRODUCTION_PUSH_TRANSPORT` is frozen, `sendToDevice` passes it and
 * nothing else, and the scheme, credential and canonical-form rules are not fields at all.
 *
 * No mongoose here, deliberately, so the subscribe route could import `isKnownPushServiceHost` and
 * refuse an unknown push service at the door rather than every morning (see the allowlist note).
 */
import dns from 'node:dns/promises';
import type { IncomingMessage } from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { LookupFunction } from 'node:net';
import webpush from 'web-push';
import { toLogLine } from '../security/control-chars';
import { isBlockedAddress } from '../security/safe-fetch';

/* ── Who may be contacted: lib/notifications/push-hosts.ts ─────────────────────────────────── */

// Moved to a pure module so the subscribe-time validator can share it; re-exported here so
// every existing importer of this file is unchanged.
import { pushEndpointRefusal } from './push-hosts';
export {
  PUSH_SERVICE_HOSTS,
  PUSH_SERVICE_WILDCARD_PARENTS,
  isKnownPushServiceHost,
  pushEndpointRefusal,
} from './push-hosts';

/* ── The transport ─────────────────────────────────────────────────────────────────────────── */

/** The endpoint may not be contacted at all. Nothing was sent. */
export class PushEndpointRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PushEndpointRefusedError';
  }
}

/** A deadline passed. The notification may still have been delivered: a timeout proves nothing. */
export class PushTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PushTimeoutError';
  }
}

/** What `webpush.generateRequestDetails()` returns, narrowed to the fields this file sends. */
export interface PushRequestDetails {
  method: string;
  headers: Record<string, string | number>;
  body: Buffer | null;
  endpoint: string;
}

export interface PushServiceResponse {
  statusCode: number;
  /** At most `maxResponseBytes` of a non-2xx body, as UTF-8. Always '' for a 2xx, which is never read. */
  body: string;
  bodyBytes: number;
  /** The read stopped before the body ended: the byte cap, the deadline, or a reset mid-body. */
  truncated: boolean;
}

export interface PushTransport {
  /** Why this endpoint may not be contacted, or `null`. Production: `pushEndpointRefusal`. */
  endpointRefusal: (url: URL) => string | null;
  /** Every address a hostname answers with. Production: `dns.lookup`, all of them. */
  resolve: (hostname: string) => Promise<string[]>;
  /** May the socket connect to this address? Production: not `isBlockedAddress`. */
  addressAllowed: (address: string) => boolean;
  /** TCP connect plus TLS handshake, measured from the moment the request is made. */
  connectTimeoutMs: number;
  /** Everything, DNS included. */
  totalTimeoutMs: number;
  /** Of a non-2xx body. The rest is never read: the socket is destroyed. */
  maxResponseBytes: number;
  /** Trust anchors that REPLACE the default store, which is what Node's `ca` does. Tests only. */
  ca?: string;
}

/**
 * The deadlines. Reasoned, not measured: a push service answers in a few hundred milliseconds, so
 * these are an order of magnitude of headroom. They are bounded above by the cron: devices go out in
 * parallel but accounts go one after another, and `daily-push-reminders.yml` gives the whole job 15
 * minutes. A timeout marks the send failed, and a failed reminder is not retried automatically.
 */
export const PUSH_CONNECT_TIMEOUT_MS = 5_000;
export const PUSH_TOTAL_TIMEOUT_MS = 10_000;

/**
 * Of an error body. A push service explains itself in a sentence (FCM's 410 is the one quoted in
 * `isGoneForever`) and `toLogLine` keeps 200 characters of it, so 4 KB is ample and still bounds a
 * hostile answer.
 */
export const PUSH_RESPONSE_MAX_BYTES = 4 * 1024;

/** Node's own default header limit, stated so a `--max-http-header-size` in NODE_OPTIONS cannot raise it here. */
const MAX_RESPONSE_HEADER_BYTES = 16 * 1024;

async function resolveAll(hostname: string): Promise<string[]> {
  const found = await dns.lookup(hostname, { all: true, verbatim: true });
  return found.map(entry => entry.address);
}

export const PRODUCTION_PUSH_TRANSPORT: Readonly<PushTransport> = Object.freeze({
  endpointRefusal: pushEndpointRefusal,
  resolve: resolveAll,
  addressAllowed: (address: string) => !isBlockedAddress(address),
  connectTimeoutMs: PUSH_CONNECT_TIMEOUT_MS,
  totalTimeoutMs: PUSH_TOTAL_TIMEOUT_MS,
  maxResponseBytes: PUSH_RESPONSE_MAX_BYTES,
});

function answerTimeout(transport: PushTransport): PushTimeoutError {
  return new PushTimeoutError(`the push service did not answer within ${transport.totalTimeoutMs} ms`);
}

/**
 * Parse `raw` and apply every rule that needs no network: https, no credentials, canonical form
 * (limit 1), then the transport's host policy. Throws `PushEndpointRefusedError`.
 *
 * The first three are not transport fields, so no transport can relax them.
 */
export function checkPushEndpoint(raw: string, transport: PushTransport): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PushEndpointRefusedError('the endpoint is not a valid URL');
  }
  if (url.protocol !== 'https:') throw new PushEndpointRefusedError('the endpoint is not https');
  if (url.username || url.password) throw new PushEndpointRefusedError('the endpoint carries credentials');
  // See limit 1 in the header. `url.host` carries a non-default port, so a test stub's port passes
  // this and meets the port rule in `pushEndpointRefusal` instead.
  if (!raw.startsWith(`https://${url.host}/`)) {
    throw new PushEndpointRefusedError('the endpoint is not written in canonical form');
  }
  const refusal = transport.endpointRefusal(url);
  if (refusal) throw new PushEndpointRefusedError(refusal);
  return url;
}

function withinDeadline<T>(work: Promise<T>, budgetMs: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), Math.max(0, budgetMs));
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/** The host with IPv6 brackets removed, which is the form `net` and `https.request` want. */
function bareHost(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '');
}

async function resolvePinnedAddresses(url: URL, transport: PushTransport, budgetMs: number): Promise<string[]> {
  const host = bareHost(url);
  let addresses: string[];
  if (net.isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = await withinDeadline(transport.resolve(host), budgetMs, () => answerTimeout(transport));
    } catch (error) {
      if (error instanceof PushTimeoutError) throw error;
      throw new PushEndpointRefusedError('the host could not be resolved');
    }
  }
  if (addresses.length === 0) throw new PushEndpointRefusedError('the host could not be resolved');
  // EVERY address, as `assertSafeUrl` requires. The socket may try any of them, so one private
  // answer among public ones is enough to abuse.
  if (!addresses.every(address => transport.addressAllowed(address))) {
    throw new PushEndpointRefusedError('the host resolves to a non-public address');
  }
  return addresses;
}

/**
 * A `lookup` that answers with the addresses already checked, and never asks DNS again. This is what
 * turns the address check from check-then-use into check-and-use.
 *
 * Both shapes are answered: `all: true` is what `net` asks for under `autoSelectFamily`, on by default
 * since Node 20, and a single address is what it asks for otherwise. Deferred to the next tick, as
 * `dns.lookup` itself is, rather than calling back inside `connect`.
 */
function pinnedLookup(addresses: readonly string[]): LookupFunction {
  const entries = addresses.map(address => ({ address, family: net.isIP(address) }));
  return (_hostname, options, callback) => {
    process.nextTick(() => {
      if (options.all) callback(null, entries);
      else callback(null, entries[0].address, entries[0].family);
    });
  };
}

function exchange(
  url: URL,
  addresses: readonly string[],
  details: PushRequestDetails,
  transport: PushTransport,
  budgetMs: number
): Promise<PushServiceResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let response: IncomingMessage | undefined;
    const kept: Buffer[] = [];
    let keptBytes = 0;

    const request = https.request({
      host: bareHost(url),
      port: url.port === '' ? 443 : Number(url.port),
      path: `${url.pathname}${url.search}`,
      method: details.method,
      headers: details.headers,
      // A fresh agent: no pooled socket from another request, and nothing kept alive afterwards.
      agent: false,
      lookup: pinnedLookup(addresses),
      rejectUnauthorized: true,
      insecureHTTPParser: false,
      maxHeaderSize: MAX_RESPONSE_HEADER_BYTES,
      ...(transport.ca === undefined ? {} : { ca: transport.ca }),
    });

    // Every exit comes through here exactly once. Destroying the request is what stops the read, and
    // it frees the socket whether or not the peer ever answered.
    const settle = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(totalTimer);
      request.destroy();
      outcome();
    };
    const answer = (truncated: boolean) =>
      settle(() =>
        resolve({
          statusCode: response?.statusCode ?? 0,
          body: Buffer.concat(kept).toString('utf8'),
          bodyBytes: keptBytes,
          truncated,
        })
      );

    // Armed only when it would fire first. When DNS has eaten the budget down past it, the total
    // deadline is the one that binds, and it should be the one the message names.
    const connectTimer =
      transport.connectTimeoutMs < budgetMs
        ? setTimeout(
            () =>
              settle(() =>
                reject(
                  new PushTimeoutError(`could not connect to the push service within ${transport.connectTimeoutMs} ms`)
                )
              ),
            transport.connectTimeoutMs
          )
        : undefined;
    const totalTimer = setTimeout(() => {
      // Once the status line is here the verdict is known, and running out of time only cuts the log
      // text short. A 410 that trickles its body must still prune the row.
      if (response) answer(true);
      else settle(() => reject(answerTimeout(transport)));
    }, Math.max(0, budgetMs));

    request.on('socket', socket => {
      socket.once('secureConnect', () => clearTimeout(connectTimer));
    });

    request.on('response', incoming => {
      clearTimeout(connectTimer);
      response = incoming;
      // Before anything that can destroy the stream, so a reset mid-body is an answer, not a crash.
      incoming.on('error', () => answer(true));
      const status = incoming.statusCode ?? 0;
      if (status >= 200 && status <= 299) {
        answer(false);
        return;
      }
      incoming.on('data', (chunk: Buffer) => {
        if (settled) return;
        const room = transport.maxResponseBytes - keptBytes;
        if (chunk.length > room) {
          if (room > 0) kept.push(Buffer.from(chunk.subarray(0, room)));
          keptBytes += Math.max(0, room);
          answer(true);
          return;
        }
        kept.push(chunk);
        keptBytes += chunk.length;
      });
      incoming.on('end', () => answer(false));
    });

    request.on('error', error => {
      if (response) answer(true);
      else settle(() => reject(error));
    });

    request.end(details.body ?? undefined);
  });
}

/**
 * POST one prepared request to its endpoint, inside every limit in the header.
 *
 * Resolves with the status for ANY status. Rejects only when no status line arrived:
 * `PushEndpointRefusedError` before anything was sent, `PushTimeoutError` for a deadline, and Node's
 * own error for a refused connection, a reset or a TLS failure.
 */
export async function sendPushRequest(
  details: PushRequestDetails,
  transport: PushTransport
): Promise<PushServiceResponse> {
  const startedAt = Date.now();
  const remaining = () => transport.totalTimeoutMs - (Date.now() - startedAt);
  const url = checkPushEndpoint(details.endpoint, transport);
  const addresses = await resolvePinnedAddresses(url, transport, remaining());
  const budgetMs = remaining();
  if (budgetMs <= 0) throw answerTimeout(transport);
  return exchange(url, addresses, details, transport, budgetMs);
}

/* ── The verdict ───────────────────────────────────────────────────────────────────────────── */

/**
 * A dead endpoint, as opposed to a transient failure. Both are non-2xx; only these two are final.
 *
 * MEASURED, NOT ASSUMED — and the measurement matters. A well-formed aes128gcm POST to a
 * syntactically valid but nonexistent `fcm.googleapis.com/fcm/send/…` endpoint answers
 * **410 `push subscription has unsubscribed or expired.`**, NOT 404. So an implementation that
 * pruned on 404 alone would treat every dead Chrome endpoint as a transient failure, retry it every
 * morning forever, and leave the row in the database claiming a consent that no longer exists. 410
 * is the canonical spec answer; 404 is kept because it is what other services return and it costs
 * nothing.
 *
 * Everything else — 429, 5xx, a socket timeout — is transient and must NOT delete a row. A
 * threshold on `failureCount` would silently unsubscribe every device during one push-service
 * outage, which is why `failureCount` records and does not decide.
 */
export function isGoneForever(status: number): boolean {
  return status === 404 || status === 410;
}

export interface DeviceSendResult {
  endpoint: string;
  ok: boolean;
  status?: number;
  /**
   * The push service said this endpoint is gone. `sendToDevice` only REPORTS this; the row is
   * deleted when the caller passes the results to `pruneGoneEndpoints`.
   */
  gone?: boolean;
  error?: string;
}

/**
 * `sendToDevice` with its transport named. Production calls it with `PRODUCTION_PUSH_TRANSPORT`,
 * from `./push.ts`, and nowhere else; tests call it with a stub's.
 *
 * A failure is a per-DEVICE failure, never a thrown one. A refused endpoint or a transient DNS
 * failure must not abort everybody's reminders, and must not delete a row either: nothing has been
 * proven about the subscription. Only a 404 or 410 sets `gone`.
 *
 * ── EVERY `error` STRING BELOW GOES THROUGH `toLogLine` (CWE-117). ───────────────────────────
 * A push service's response body is text somebody else wrote, and it travels into
 * `ReminderLog.error`, the run report, and the operator's terminal via
 * `scripts/send-push-reminders.ts`. It used to go in as a bare `.slice(0, 200)`, which bounded its
 * length and nothing else: a CR or LF forged whole report lines, ESC drove the terminal (colours,
 * cursor moves, OSC title and clipboard sequences), and a leading `::`, or `##[` anywhere, is a
 * GitHub Actions workflow command the moment this runs in CI. Sanitised HERE, where the text enters,
 * so every consumer of `DeviceSendResult` inherits it. The allowlist now means the body comes from a
 * push vendor rather than from whoever registered the endpoint, and it is sanitised all the same.
 * The other two exits can carry text somebody else chose as well (a refusal names the host it
 * refused, and a TLS error quotes the names on the peer's certificate), so "every `error` is inert"
 * is one rule rather than three cases to re-audit.
 */
export async function sendToDeviceVia(
  transport: PushTransport,
  device: { endpoint: string; p256dh: string; auth: string },
  payload: string,
  topic: string
): Promise<DeviceSendResult> {
  try {
    // Refuse BEFORE `generateRequestDetails`, which would otherwise sign a VAPID JWT for an audience
    // that is about to be refused, and answer a malformed endpoint with its own VAPID wording
    // instead of this file's. `sendPushRequest` checks again; that one is the check it relies on.
    checkPushEndpoint(device.endpoint, transport);
    const details = webpush.generateRequestDetails(
      { endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } },
      payload,
      {
        // A reminder is worthless once the event has started, so there is no point in the push
        // service holding it for the default four weeks. Twelve hours comfortably covers a phone
        // that is off overnight and expires well before the next day's run.
        TTL: 12 * 3600,
        // `high` asks the service to wake the device rather than batch the message with the next
        // convenient wakeup. This is a time-sensitive notification; that is what the field is for.
        urgency: 'high',
        /*
         * Coalescing at the SERVICE, complementing the `tag` that coalesces at the notification
         * layer — two different places a repeat can stack up, and both have to be told. `topic`
         * replaces an UNDELIVERED message still queued for a phone that is off; `tag` replaces an
         * already-DISPLAYED notification on a phone that is on. Constrained by spec to at most 32
         * URL-safe base64 characters, which is why the caller passes the bare 24-char ObjectId hex
         * rather than the `pblr-event-…` tag.
         */
        topic,
      }
    );
    const response = await sendPushRequest(details, transport);
    if (response.statusCode >= 200 && response.statusCode <= 299) {
      return { endpoint: device.endpoint, ok: true, status: response.statusCode };
    }
    return {
      endpoint: device.endpoint,
      ok: false,
      status: response.statusCode,
      gone: isGoneForever(response.statusCode),
      // The push service's own wording, never shown to a user. See the header of this function.
      error: `${response.statusCode} ${toLogLine(response.body, 200)}`,
    };
  } catch (error) {
    if (error instanceof PushEndpointRefusedError) {
      return {
        endpoint: device.endpoint,
        ok: false,
        error: toLogLine(`endpoint failed the SSRF check: ${error.message}`, 300),
      };
    }
    return { endpoint: device.endpoint, ok: false, error: toLogLine((error as Error | undefined)?.message, 300) };
  }
}
