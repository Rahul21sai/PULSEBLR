/**
 * A token bucket per key, in process memory.
 *
 * WHY IT EXISTS. The scan feature adds the app's first UNAUTHENTICATED write endpoint:
 * `POST /api/intake/[token]`, the public self-registration form behind a folder QR. Before
 * it there was nothing in this repo to rate-limit — the only throttle anywhere is the
 * scraper's own concurrency pool — so a stranger with a photographed folder QR could fill
 * a folder with thousands of rows.
 *
 * WHAT IT HONESTLY DOES AND DOES NOT DO. State lives in module memory, so on a serverless
 * platform each cold instance starts with a full bucket and an attacker who spreads
 * requests across instances gets a multiple of the limit. This RAISES THE COST OF ABUSE;
 * it does not eliminate it. That is the right amount of engineering for a personal app,
 * and it is deliberately layered with the defences that do not depend on counting:
 *
 *   - the intake token is 16 bytes of CSPRNG entropy, so it cannot be guessed or enumerated
 *   - `intakeEnabled` defaults to false, so a folder is never publicly writable by accident
 *   - `intakeExpiresAt` defaults to 12 hours, so a QR on a poster stops working after the event
 *   - the endpoint writes only into one named folder and can read nothing back
 *
 * A durable limiter would need Redis or Mongo-backed counters. If this app ever becomes
 * multi-tenant in earnest, that is the upgrade — not a bigger number here.
 */

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
 * Best-effort client address.
 *
 * `x-forwarded-for` is spoofable in general, but behind Vercel (and any sane proxy) the
 * LEFTMOST entry is the real client and later entries are the proxy chain. There is no
 * better signal available to a route handler, and the limiter is defence in depth rather
 * than the security boundary — see the module note.
 */
export function clientKey(request: Request, prefix = ''): string {
  const forwarded = request.headers.get('x-forwarded-for');
  const ip =
    forwarded?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip')?.trim() ||
    'unknown';
  return prefix ? `${prefix}:${ip}` : ip;
}

/** Test-only: drop all state so one test cannot influence another. */
export function resetRateLimits(): void {
  buckets.clear();
}
