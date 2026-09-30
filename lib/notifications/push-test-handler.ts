import { NextRequest, NextResponse } from 'next/server';
import { hasExactCanonicalOrigin } from '@/lib/account-deletion';
import { requireUser } from '@/lib/api-auth';
import { canonicalOrigin } from '@/lib/canonical-origin';
import PushSubscription from '@/lib/models/PushSubscription';
import connectDB from '@/lib/mongodb';
import {
  configureWebPush,
  pruneGoneEndpoints,
  REQUIRED_PUSH_ENV,
  sendToDevice,
  type DeviceSendResult,
} from '@/lib/notifications/push';
import type { PushPayload } from '@/lib/notifications/reminder-policy';
import { rateLimit, type RateLimitResult } from '@/lib/security/rate-limit';
import { errorLogLine, routeFailure } from '@/lib/http/errors';

/**
 * POST /api/me/push/test: send ONE fixed notification to the caller's own device(s).
 *
 * WHY IT EXISTS. Until now nobody could confirm push worked until a saved event happened to fall
 * inside the reminder window, and the failures that matter are invisible from the page: a runner
 * holding a different VAPID pair from the deployment (every send 403s), a device whose endpoint
 * expired (410), or an OS that silences the browser. This sends the same kind of message a reminder
 * does, through the same `sendToDevice` and the same 404/410 prune, so "the test arrived" means the
 * real thing will too.
 *
 * ── THE ORDER IS THE SECURITY. ─────────────────────────────────────────────────────────────────
 *
 *   1. `requireUser()`: 401 before anything is read. Backwards, an anonymous caller with a bad body
 *      would get a 400, which tells a stranger their payload parsed far enough to be judged, and it
 *      breaks the contract `scripts/diag-api-auth.ts` asserts for every mutating route.
 *   2. The exact-Origin check `DELETE /api/me/account` uses (`hasExactCanonicalOrigin`, imported
 *      rather than retyped so the two state-changing routes cannot drift). The session cookie is
 *      SameSite=Lax, which already keeps a cross-site POST from carrying it; this is the second
 *      layer, and the one that does not depend on a cookie attribute nobody here controls.
 *   3. Is push usable on this server at all? 503 before any per-user work.
 *   4. The rate limit, keyed per USER. Every request past the gate costs a token, a malformed one
 *      included, so nothing below it can be hammered.
 *   5. Only then the body.
 *
 * ── THE PAYLOAD IS A CONSTANT. ─────────────────────────────────────────────────────────────────
 * Nothing in the request reaches the notification. A route that lets a caller choose the title of a
 * notification delivered by this app's name is a phishing primitive, and the endpoint scoping below
 * would not make it safe: an endpoint is a browser profile, and `POST /api/me/push` hands it to
 * whichever account subscribed last on that browser.
 *
 * ── ONLY THE CALLER'S OWN SUBSCRIPTIONS, AND 404 FOR ANYTHING ELSE. ───────────────────────────
 * The query is scoped by `userId`, AND `selectTestDevices` re-checks ownership on every row, so a
 * loader that ever over-returned could not turn this into "push to someone else's phone". An
 * endpoint that is not the caller's gets the same 404 as one that does not exist, never a 403, which
 * would confirm the endpoint is live on another account (the rule `DELETE /api/me/push` states).
 *
 * ── THE RESPONSE IS COUNTS, AND ONLY COUNTS. ───────────────────────────────────────────────────
 * `{ sent, failed, pruned }`. No endpoint: the GET beside this returns only a 12-character tail,
 * because the full URL is a capability (anyone holding it can push to the device, subject only to
 * VAPID). No push-service body: that is the service's wording, not ours, and nothing a user can act
 * on. The statuses go to the server log, where an operator can tell a 403 (wrong key pair) from a
 * 410 (dead endpoint).
 */

/** At most this many devices per test. See `selectTestDevices` for why there is a cap at all. */
export const MAX_TEST_DEVICES = 10;

/**
 * Three a minute, per account. A person checking their phone needs one, maybe two if the first was
 * silenced. The bucket is in process memory, so across serverless instances it is a nuisance
 * filter, not a control (the header of `lib/security/rate-limit.ts` says so plainly). That is
 * enough here because every request past it has already been authenticated and can only reach the
 * caller's own devices.
 */
export const TEST_RATE_LIMIT = { limit: 3, windowMs: 60_000 } as const;

/**
 * The test notification. FROZEN, and built from nothing the caller sent.
 *
 * `url` is `/settings` rather than the section anchor, because of how `public/sw.js` handles a
 * click: an exact-URL match is focused as it is, while any other window on the origin is
 * NAVIGATED. The user is almost always still on /settings when the test lands, so the bare path
 * focuses that window without reloading it or wiping the result banner they are reading.
 *
 * `tag` is fixed, so a second test REPLACES the first rather than stacking beside it. It cannot
 * collide with a real reminder, whose tag is `pblr-event-<id>` (`formatPushPayload`).
 */
export const TEST_PUSH_PAYLOAD: Readonly<PushPayload> = Object.freeze({
  title: 'Test notification from PulseBLR',
  body: 'Notifications work on this device. Reminders about events you save will look like this.',
  url: '/settings',
  tag: 'pulseblr-test',
});

/**
 * Service-side coalescing, the counterpart of `tag`: a phone that is off gets ONE queued test, not
 * one per tap. At most 32 URL-safe base64 characters by spec; this is 13.
 */
export const TEST_PUSH_TOPIC = 'pulseblr-test';

/** Serialised once. The payload is a constant, so so is its wire form. */
const TEST_PAYLOAD_JSON = JSON.stringify(TEST_PUSH_PAYLOAD);

/** The longest endpoint `validatePushSubscriptionInput` will ever store. Anything longer cannot match. */
const MAX_ENDPOINT_CHARS = 1000;

/** A subscription row as the loader returns it. `userId` is carried so ownership can be re-checked. */
export interface StoredDevice {
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export type TestDeviceSelection =
  | { devices: StoredDevice[]; reason?: never }
  | { devices: []; reason: 'no-devices' | 'not-found' };

/**
 * Which of these rows may receive a test from `callerId`?
 *
 * OWNERSHIP IS RE-CHECKED HERE, not only in the query. The query's `{ userId }` filter is what keeps
 * this cheap. This is what keeps it correct if a loader is ever changed to over-return, and it is the
 * half a unit test can pin.
 *
 * `requestedEndpoint` narrows to one device, matched EXACTLY. That is what the Settings button sends,
 * so a test on a phone does not also buzz a laptop in another room.
 *
 * THE CAP exists because the list can be made arbitrarily long. `POST /api/me/push` checks a
 * subscription's SHAPE (https, a public host, key lengths) and cannot check that a real browser
 * minted it, so one account can register thousands of endpoints pointing at somebody else's
 * server, and an uncapped fan-out would turn three requests a minute into thousands of outbound
 * POSTs. A person has a handful of devices. The rows arrive most-recently-seen first, so the cap
 * keeps the ones in use.
 */
export function selectTestDevices(
  rows: readonly StoredDevice[],
  callerId: string,
  requestedEndpoint?: string,
  max: number = MAX_TEST_DEVICES
): TestDeviceSelection {
  const own = rows.filter(row => row.userId === callerId);
  if (requestedEndpoint !== undefined) {
    const match = own.find(row => row.endpoint === requestedEndpoint);
    return match ? { devices: [match] } : { devices: [], reason: 'not-found' };
  }
  if (own.length === 0) return { devices: [], reason: 'no-devices' };
  return { devices: own.slice(0, Math.max(0, max)) };
}

export type ParsedTestRequest =
  | { ok: true; endpoint?: string }
  | { ok: false; issue: { field: string; message: string } };

/**
 * The body is OPTIONAL, and at most `{ endpoint }`.
 *
 * No body means every device on the account. Any field other than `endpoint` is ignored rather than
 * refused, because none of them can reach the notification. A `title` in the body is as inert as a
 * `colour`.
 *
 * An endpoint that is present but empty, or not a string, is REFUSED rather than read as absent.
 * Reading it as absent would turn a broken "test this phone" into "test every device I own", which
 * is the wider action, taken because the narrow one was malformed.
 */
export function parseTestRequestBody(raw: string): ParsedTestRequest {
  if (raw.trim() === '') return { ok: true };

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, issue: { field: 'body', message: 'Expected a JSON object.' } };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, issue: { field: 'body', message: 'Expected a JSON object.' } };
  }

  const endpoint = (body as Record<string, unknown>).endpoint;
  if (endpoint === undefined || endpoint === null) return { ok: true };
  if (typeof endpoint !== 'string' || endpoint.trim() === '') {
    return { ok: false, issue: { field: 'endpoint', message: 'Expected the endpoint as a non-empty string.' } };
  }
  if (endpoint.length > MAX_ENDPOINT_CHARS) {
    return { ok: false, issue: { field: 'endpoint', message: `At most ${MAX_ENDPOINT_CHARS} characters.` } };
  }
  // Stored endpoints are trimmed by the schema, so this compares like with like.
  return { ok: true, endpoint: endpoint.trim() };
}

export interface TestSendCounts {
  /** Devices whose push service accepted the notification. */
  sent: number;
  /** Devices that failed for a reason that is NOT final (429, 5xx, a timeout, a 403 key mismatch). */
  failed: number;
  /** Subscriptions deleted because the push service said 404/410: gone for good. */
  pruned: number;
}

/**
 * The only thing the client learns. Same split as the cron's per-account report: a `gone` device is
 * not a failure, it is a subscription that no longer exists, and it is counted by what the prune
 * actually removed.
 */
export function summariseTestSend(results: readonly DeviceSendResult[], pruned: number): TestSendCounts {
  return {
    sent: results.filter(result => result.ok).length,
    failed: results.filter(result => !result.ok && !result.gone).length,
    pruned,
  };
}

/** Fails closed: an origin that cannot be computed (no NEXTAUTH_URL in production) matches nothing. */
export function originAllowed(origin: string | null, expectedOrigin: () => string): boolean {
  let expected: string;
  try {
    expected = expectedOrigin();
  } catch {
    return false;
  }
  return hasExactCanonicalOrigin(origin, expected);
}

export interface PushTestDependencies {
  requireUser: typeof requireUser;
  expectedOrigin: () => string;
  /** Consume one token for `key`. */
  consumeRateLimit: (key: string) => RateLimitResult;
  /** Names of the unset VAPID variables; empty when push is configured. */
  missingPushEnv: () => string[];
  /** `configureWebPush`: throws on a malformed VAPID value, a no-op after its first success. */
  configurePush: () => void;
  loadDevices: (userId: string, endpoint?: string) => Promise<StoredDevice[]>;
  sendToDevice: typeof sendToDevice;
  pruneGoneEndpoints: typeof pruneGoneEndpoints;
}

function reply(body: unknown, status: number, headers: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

/**
 * The handler, with its collaborators injected. The same shape as `createDeleteAccountHandler`, so
 * the ORDER above can be pinned by a test with no database, no web-push and no session.
 */
export function createPushTestHandler(deps: PushTestDependencies) {
  return async function POST(request: NextRequest): Promise<NextResponse> {
    const gate = await deps.requireUser();
    if ('response' in gate) return gate.response;

    if (!originAllowed(request.headers.get('origin'), deps.expectedOrigin)) {
      return reply({ error: 'Forbidden' }, 403);
    }

    const missing = deps.missingPushEnv();
    if (missing.length > 0) {
      return reply(
        {
          error: 'Push notifications are not set up on this server yet.',
          // Names, never values, and all three names are in `.env.example` already. The same courtesy
          // `requireAdmin()` extends when ADMIN_EMAILS is unset: the operator reading this is the one
          // who can fix it.
          detail: `Unset on the server: ${missing.join(', ')}.`,
        },
        503
      );
    }
    try {
      deps.configurePush();
    } catch (error) {
      // web-push's own wording can quote VAPID_SUBJECT back, so it stays in the log.
      console.error('Test push refused: web-push rejected the VAPID configuration:', errorLogLine(error));
      return reply({ error: 'Push notifications are misconfigured on this server.' }, 503);
    }

    const limit = deps.consumeRateLimit(`push-test:${gate.userId}`);
    if (!limit.ok) {
      return reply(
        { error: 'Too many test notifications. Wait a moment and try again.' },
        429,
        { 'Retry-After': String(limit.retryAfterSeconds) }
      );
    }

    let raw: string;
    try {
      raw = await request.text();
    } catch {
      // An aborted upload is not an empty body. Read as one, it would widen "test this phone" into
      // "test every device".
      return reply({ error: 'Invalid request', issues: [{ field: 'body', message: 'The request body could not be read.' }] }, 400);
    }
    const parsed = parseTestRequestBody(raw);
    if (!parsed.ok) return reply({ error: 'Invalid request', issues: [parsed.issue] }, 400);

    try {
      const rows = await deps.loadDevices(gate.userId, parsed.endpoint);
      const selection = selectTestDevices(rows, gate.userId, parsed.endpoint);
      if (selection.reason) {
        return reply(
          {
            error:
              selection.reason === 'not-found'
                ? 'This device is not registered for notifications on your account.'
                : 'No device on your account has notifications turned on.',
          },
          404
        );
      }

      const results = await Promise.all(
        selection.devices.map(device =>
          deps.sendToDevice(
            { endpoint: device.endpoint, p256dh: device.p256dh, auth: device.auth },
            TEST_PAYLOAD_JSON,
            TEST_PUSH_TOPIC
          )
        )
      );
      const pruned = await deps.pruneGoneEndpoints(results);
      const counts = summariseTestSend(results, pruned);

      if (counts.sent === 0) {
        // Statuses only. A 403 across the board is a VAPID pair the push service does not recognise;
        // a 410 is a dead endpoint. The endpoints themselves never reach a log.
        console.warn('Test push reached no device', {
          ...counts,
          statuses: results.map(result => result.status ?? 'no-status'),
        });
      }

      // 200 whenever the attempt was made: the request did what it was asked, and whether a push
      // service accepted it is the ANSWER, carried in the counts, not a fault in this route.
      return reply(counts, 200);
    } catch (error) {
      // `sendToDevice` never throws (it returns sanitised results), so what lands here is a database
      // fault from the device load or the prune. One inert line; the endpoint is the only caller input.
      console.error('Test push failed:', errorLogLine(error));
      const failure = routeFailure(error, 'Could not send a test notification. Try again.', {
        fields: ['endpoint'],
      });
      return reply(failure.body, failure.status);
    }
  };
}

async function loadDevices(userId: string, endpoint?: string): Promise<StoredDevice[]> {
  await connectDB();
  // Scoped by `userId` IN THE FILTER, so another account's endpoint cannot match; see the header.
  const rows = await PushSubscription.find(endpoint ? { userId, endpoint } : { userId })
    .select('userId endpoint p256dh auth')
    // Most recently seen first, so the device cap keeps the devices somebody actually uses.
    .sort({ lastSeenAt: -1 })
    .limit(endpoint ? 1 : MAX_TEST_DEVICES)
    .lean();
  return rows.map(row => ({
    userId: String(row.userId),
    endpoint: String(row.endpoint),
    p256dh: String(row.p256dh),
    auth: String(row.auth),
  }));
}

export const POST = createPushTestHandler({
  requireUser,
  expectedOrigin: canonicalOrigin,
  consumeRateLimit: key => rateLimit(key, TEST_RATE_LIMIT),
  missingPushEnv: () => REQUIRED_PUSH_ENV.filter(name => !process.env[name]),
  configurePush: configureWebPush,
  loadDevices,
  sendToDevice,
  pruneGoneEndpoints,
});
