/**
 * A token bucket per key, in process memory.
 *
 * WHY IT EXISTS. The scan feature adds the app's first UNAUTHENTICATED write endpoint:
 * `POST /api/intake/[token]`, the public self-registration form behind a folder QR. Before
 * it there was nothing in this repo to rate-limit — the only throttle anywhere is the
 * scraper's own concurrency pool — so a stranger with a photographed folder QR could fill
 * a folder with thousands of rows.
 *
 * WHAT IT HONESTLY DOES AND DOES NOT DO. **This is a nuisance filter, not a control.** Anything
 * that must actually be bounded needs shared state — a Mongo collection with a TTL index would be
 * enough here and adds no dependency — because two independent properties defeat counting in
 * process memory:
 *
 *   1. State lives in module memory, so on a serverless platform each cold instance starts with a
 *      full bucket and an attacker who spreads requests across instances gets a multiple of the
 *      limit. `vercel.json` confirms this deployment is serverless, so that is the live case, not
 *      a hypothetical. Concurrency is not something the caller has to work at: the platform
 *      spreads a burst across instances by itself.
 *   2. Even within one instance, a bucket key derived from request HEADERS is only as trustworthy
 *      as the hop that set them. See `clientKey()` — the leftmost `x-forwarded-for` entry was
 *      caller-chosen, which let one client mint unlimited buckets from one connection.
 *
 * So state the guarantee accurately: this RAISES THE COST OF ABUSE and makes the accidental case
 * (a stuck retry loop, a page hammering a token) harmless. It cannot stop a deliberate one. That
 * is the right amount of engineering here only because it is layered with the defences that do
 * not depend on counting:
 *
 *   - the intake token is 16 bytes of CSPRNG entropy, so it cannot be guessed or enumerated
 *   - `intakeEnabled` defaults to false, so a folder is never publicly writable by accident
 *   - `intakeExpiresAt` defaults to 12 hours, so a QR on a poster stops working after the event
 *   - the endpoint writes only into one named folder and can read nothing back
 *
 * A durable limiter would need Redis or Mongo-backed counters. If this app ever becomes
 * multi-tenant in earnest, that is the upgrade — not a bigger number here.
 */

/**
 * Headers whose value is written by the PLATFORM's own proxy and cannot be supplied by the
 * client, in order of preference. On Vercel the edge network sets `x-vercel-forwarded-for` and
 * `x-real-ip` itself; both are single-valued, so there is no chain to mis-parse.
 *
 * Anything not on this list is caller-influenced and must not be read as an identity.
 */
const TRUSTED_IP_HEADERS = ['x-vercel-forwarded-for', 'x-real-ip'] as const;

interface Bucket {
  /** Fractional tokens remaining. */
  tokens: number;
  /** When `tokens` was last refilled, in ms. */
  updatedAt: number;
}

const buckets = new Map<string, Bucket>();

/** Stop unbounded growth from a spray of distinct keys. */
const MAX_KEYS = 5000;

export interface RateLimitOptions {
  /** Bucket capacity — the most requests allowed in a burst. */
  limit: number;
  /** Window over which the bucket fully refills, in ms. */
  windowMs: number;
}

export interface RateLimitResult {
  ok: boolean;
  /** Whole tokens left after this request. */
  remaining: number;
  /** Seconds until at least one token is available. 0 when allowed. */
  retryAfterSeconds: number;
}

/**
 * Consume one token for `key`. Returns whether the request may proceed.
 *
 * `now` is injectable so the behaviour can be unit-tested without waiting in real time.
 */
export function rateLimit(
  key: string,
  { limit, windowMs }: RateLimitOptions,
  now: number = Date.now()
): RateLimitResult {
  if (buckets.size > MAX_KEYS) buckets.clear();

  const refillPerMs = limit / windowMs;
  const existing = buckets.get(key);

  const tokens = existing
    ? Math.min(limit, existing.tokens + (now - existing.updatedAt) * refillPerMs)
    : limit;

  if (tokens < 1) {
    // Keep `updatedAt` moving so the refill maths stays continuous.
    buckets.set(key, { tokens, updatedAt: now });
    return {
      ok: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((1 - tokens) / refillPerMs / 1000)),
    };
  }

  buckets.set(key, { tokens: tokens - 1, updatedAt: now });
  return { ok: true, remaining: Math.floor(tokens - 1), retryAfterSeconds: 0 };
}

/**
 * The bucket key for a request: the platform's client address, namespaced by endpoint.
 *
 * THIS USED TO TAKE THE LEFTMOST `x-forwarded-for` ENTRY, AND THAT MADE THE LIMITER YIELD
 * NOTHING. Leftmost is the real client only for a proxy that OVERWRITES the header. For any proxy
 * that APPENDS — the behaviour RFC 7239 describes and the safe assumption when you cannot prove
 * otherwise — the leftmost entry is whatever the client typed, so a single attacker sending
 * `X-Forwarded-For: <random>` on each request gets a fresh bucket every time and never sees a
 * 429. One IP, one connection, no instance-spraying needed. That is a strictly cheaper bypass
 * than the per-instance-memory one the module note documents, and it was undocumented.
 *
 * The fix does not depend on knowing whether this platform appends or overwrites:
 *
 *   1. Prefer a header the platform sets and the client cannot supply (`TRUSTED_IP_HEADERS`).
 *      `NextRequest.ip` was REMOVED in Next 15 and does not exist on 16.3.2 — verified against
 *      `node_modules/next/dist/server/web/spec-extension/request.d.ts`, which declares only
 *      `cookies`, `nextUrl`, `url` and two deprecated getters. Vercel's own `ipAddress()` helper
 *      lives in `@vercel/functions`, which is not a dependency here and is not worth adding for
 *      one header read.
 *   2. Fall back to the RIGHTMOST `x-forwarded-for` entry, which is the address the nearest
 *      trusted proxy OBSERVED. A client can prepend as many fake hops as it likes and cannot
 *      change that one — so with an appending proxy this is correct, and with an overwriting
 *      proxy the header holds one entry and rightmost IS leftmost. Correct either way, which is
 *      the property to preserve if anyone revisits this.
 *
 * `unknown` is ONE SHARED BUCKET, not an unlimited one: an unidentifiable caller must be
 * throttled together with every other unidentifiable caller rather than exempted. That is a
 * deliberate accepted cost — a platform that stops setting these headers throttles everyone
 * behind one bucket, which fails noisily instead of silently opening the door.
 */
export function clientKey(request: Request, prefix = ''): string {
  let ip = '';

  for (const header of TRUSTED_IP_HEADERS) {
    const value = request.headers.get(header)?.split(',').pop()?.trim();
    if (value) {
      ip = value;
      break;
    }
  }

  if (!ip) {
    // Rightmost, NOT leftmost. See the note above — this is the one entry the client cannot choose.
    ip = request.headers.get('x-forwarded-for')?.split(',').pop()?.trim() || 'unknown';
  }

  return prefix ? `${prefix}:${ip}` : ip;
}

/** Test-only: drop all state so one test cannot influence another. */
export function resetRateLimits(): void {
  buckets.clear();
}
