/**
 * A JSON read that NEVER THROWS, and that reports every way it can fail as a value.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS: THREE SCREENS HAD THE SAME DEFECT, IN THREE DIFFERENT SHAPES.
 *
 *   · The home feed's "load more" did `if (!res.ok) return;` inside a try/finally with no catch.
 *     The failure was not merely silent — the finally cleared the in-flight flag, the infinite-
 *     scroll observer was recreated with the new callback, fired its initial notification while
 *     the sentinel was still on screen, and requested the SAME page again. Offline, `public/sw.js`
 *     answers every `/api/events` read with an immediate 503, so that loop ran at render speed: a
 *     request storm and a battery drain on the phone at the event, with nothing on screen.
 *   · The home feed's first load awaited seven fetches in one `Promise.all`. A rejection from ANY
 *     of them — the week strip's, say — rejected the lot, and the feed rendered "Couldn't load
 *     events" for a list whose own request had succeeded. The comments beside each secondary
 *     request promised "a failure here must leave the feed intact"; the `Promise.all` broke that
 *     promise before any of those guards ran.
 *   · `/dashboard` did `if (statsRes.ok) setStats(...)` per response and only logged the catch. A
 *     failed request left the initial empty array in place, so the page said "Nobody is waiting on
 *     you." — a confident, reassuring claim, made by a request that never came back.
 *
 * All three are the same mistake: treating "the request failed" as "there is nothing". A caller of
 * `fetchJson` cannot make it, because the result is a discriminated union — the type does not let
 * you reach `data` without first deciding what a failure looks like.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
import { classifyStatus } from '@/lib/scan/failure';

/**
 * Why a read failed, in the terms the reader can act on — NOT an HTTP taxonomy.
 *
 * Four kinds because there are four different things to tell a person:
 *
 *   'offline'      The device has no network. Reconnect, then retry.
 *   'unreachable'  The device thinks it is online, but no server answered: the connection dropped,
 *                  a captive portal intercepted it, or the service worker's own network fetch
 *                  failed. Retry.
 *   'signed-out'   The server answered 401. Retrying cannot help until they sign in again —
 *                  offering only "Try again" here is a button that can never work.
 *   'error'        The server answered and refused (any other 4xx/5xx), or answered with something
 *                  that is not the JSON this app speaks. Retry; there is nothing better to offer.
 */
export type ReadFailure = 'offline' | 'unreachable' | 'signed-out' | 'error';

export type FetchOutcome<T> =
  | { kind: 'ok'; data: T }
  | { kind: 'failed'; failure: ReadFailure; status: number | null }
  /**
   * The caller aborted it — a newer request superseded this one. NOT a failure, and it must never
   * be rendered as one: the request that replaced it is the one whose outcome the reader will see.
   */
  | { kind: 'aborted' };

/**
 * One section's data as a screen holds it. `loading` and `failed` are separate states from an empty
 * `ready`, which is the whole point: "nobody is waiting on you" may only ever be drawn from `ready`.
 */
export type Remote<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'failed'; failure: ReadFailure };

/** Injectable so `tests/` can drive every branch without a network. Production passes nothing. */
export interface FetchEnv {
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  online?: () => boolean;
}

function browserOnline(): boolean {
  // `navigator` is absent during server rendering and in the test environment. Absent is not
  // evidence of being offline, so it reads as online and the failure classifies on the response.
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

function isAbort(error: unknown, signal: AbortSignal | null | undefined): boolean {
  if (signal?.aborted) return true;
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

/**
 * Classify a failed read.
 *
 * `status` is `null` when NO SERVER ANSWERED — a rejected `fetch`, or the service worker's offline
 * marker (see `fetchJson`). `online` is consulted only for failures: a request that succeeded while
 * `navigator.onLine` claims otherwise is still a success.
 *
 * 401 reuses `classifyStatus` from `lib/scan/failure.ts` rather than restating it, so "which statuses
 * mean the session lapsed" has one definition across the capture queue and these reads.
 */
export function classifyReadFailure(status: number | null, online: boolean): ReadFailure {
  if (!online) return 'offline';
  if (status === null) return 'unreachable';
  if (classifyStatus(status) === 'auth') return 'signed-out';
  return 'error';
}

/**
 * GET (or any request) a JSON endpoint and return what happened as a value.
 *
 * THE SERVICE WORKER'S 503 IS "NO SERVER ANSWERED", NOT "THE DEVICE IS OFFLINE". `public/sw.js`
 * answers a private API path with `{ error: 'Offline', offline: true }` and status 503 whenever its
 * OWN `fetch(request)` rejects — which it does for any network failure, including a dropped
 * connection on a device that is nominally online. So that body is treated exactly like a rejected
 * `fetch` (status `null`), and `navigator.onLine` decides between 'offline' and 'unreachable'. Taking
 * the body at its word would tell somebody on a flaky conference network to "reconnect" while their
 * phone shows full bars.
 *
 * A 2xx THAT IS NOT JSON IS NOT AN ANSWER. A captive portal or a proxy error page can arrive as a
 * 200 with HTML; `docs/audit/outbox.md` records the same shape treating an HTML 200 as a saved
 * contact. Here it classifies as 'error' rather than handing the caller a parse exception.
 */
export async function fetchJson<T>(
  url: string,
  init: RequestInit = {},
  env: FetchEnv = {}
): Promise<FetchOutcome<T>> {
  // Wrapped rather than aliased: `const f = fetch` detached from `window` is the shape that throws
  // "Illegal invocation" in some engines, and a failure classifier that fails is worse than none.
  const doFetch = env.fetch ?? ((input: string, options?: RequestInit) => fetch(input, options));
  const online = env.online ?? browserOnline;

  let res: Response;
  try {
    res = await doFetch(url, init);
  } catch (error) {
    if (isAbort(error, init.signal)) return { kind: 'aborted' };
    return { kind: 'failed', failure: classifyReadFailure(null, online()), status: null };
  }

  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch (error) {
      if (isAbort(error, init.signal)) return { kind: 'aborted' };
      // An HTML error page, or an empty body. The status alone decides.
    }
    const noServerAnswered =
      typeof body === 'object' && body !== null && (body as { offline?: unknown }).offline === true;
    return {
      kind: 'failed',
      failure: classifyReadFailure(noServerAnswered ? null : res.status, online()),
      status: res.status,
    };
  }

  try {
    return { kind: 'ok', data: (await res.json()) as T };
  } catch (error) {
    if (isAbort(error, init.signal)) return { kind: 'aborted' };
    return { kind: 'failed', failure: 'error', status: res.status };
  }
}

/**
 * Fold an outcome into a section's state, REQUIRING the field the section reads.
 *
 * `pick` returns the value the section renders, or `undefined` when the body does not carry it — and
 * a body that does not carry it is a failure, not an empty section. A 2xx `{}` handed to
 * `if (res.ok) setFollowUps(data.followUps)` rendered "Nobody is waiting on you." from `undefined`;
 * here it renders the failure state instead. `pick` is also where a shape check belongs
 * (`Array.isArray`), since a list the page will `.map()` must actually be a list.
 *
 * Returns `null` for an abort: a newer request owns the section, so the caller changes nothing.
 */
export function toRemote<T, R>(
  outcome: FetchOutcome<T>,
  pick: (data: T) => R | undefined
): Remote<R> | null {
  if (outcome.kind === 'aborted') return null;
  if (outcome.kind === 'failed') return { status: 'failed', failure: outcome.failure };
  // `null` is valid JSON, so `data` can be null whatever `T` claims.
  const value = outcome.data == null ? undefined : pick(outcome.data);
  return value === undefined
    ? { status: 'failed', failure: 'error' }
    : { status: 'ready', data: value };
}

/**
 * The first sentence of any failure message: what happened, in the interface's voice.
 *
 * Each surface adds its own subject ("Couldn't load more events.") and its own instruction, because
 * "what to do" differs by surface — but the explanation of WHY must not, or the same dropped
 * connection reads three different ways on three screens.
 */
export function failureLead(failure: ReadFailure): string {
  switch (failure) {
    case 'offline':
      return 'You’re offline.';
    case 'unreachable':
      return 'The connection dropped before the server answered.';
    case 'signed-out':
      return 'Your session has ended.';
    case 'error':
      return 'Something went wrong on our side.';
  }
}
