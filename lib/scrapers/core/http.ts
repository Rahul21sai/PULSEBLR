// Shared HTTP layer for every adapter.
//
// Every scraper needs the same three things and used to re-implement them badly:
//   1. A browser-like User-Agent — Meetup, Luma and Eventbrite serve stripped or
//      bot-blocked markup to the default fetch UA.
//   2. Retry with backoff on transient failures. A single 503 or socket timeout
//      used to zero out a whole source for the day (Commudle returned 503 during
//      recon; a retry is the difference between 0 and N events).
//   3. A concurrency limit. Fanning out to ~100 Meetup groups unthrottled gets us
//      rate-limited; a small pool keeps us polite and still fast.

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export class HttpError extends Error {
  constructor(readonly status: number, readonly url: string) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
  }
}

export interface FetchOptions {
  timeoutMs?: number;
  /** Total attempts, including the first. */
  retries?: number;
  headers?: Record<string, string>;
  method?: 'GET' | 'POST';
  body?: unknown;
  /** Treat these statuses as final (no retry) and throw immediately. */
  accept?: 'text' | 'json';
}

/** Statuses worth retrying: transient server/proxy/rate-limit failures. */
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504, 522, 524]);

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Fetch a URL as text with browser headers, a hard timeout, and bounded retries.
 * Throws HttpError on a non-retryable bad status or after the final attempt.
 */
export async function fetchText(url: string, opts: FetchOptions = {}): Promise<string> {
  const { timeoutMs = 20000, retries = 3, headers = {}, method = 'GET', body } = opts;

  let lastError: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers: {
          'User-Agent': DEFAULT_UA,
          Accept:
            opts.accept === 'json'
              ? 'application/json, text/plain;q=0.9, */*;q=0.8'
              : 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        // A 404 will never become a 200 — fail fast so a dead URL is reported
        // as dead instead of burning three timeouts per run.
        if (!RETRYABLE.has(res.status)) throw new HttpError(res.status, url);
        lastError = new HttpError(res.status, url);
      } else {
        return await res.text();
      }
    } catch (err) {
      if (err instanceof HttpError && !RETRYABLE.has(err.status)) throw err;
      lastError = err;
    }

    if (attempt < retries) {
      // Exponential backoff with a little jitter so parallel workers don't
      // retry in lockstep against the same host.
      await sleep(500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** fetchText + JSON.parse, with the response body surfaced on parse failure. */
export async function fetchJson<T = unknown>(url: string, opts: FetchOptions = {}): Promise<T> {
  const text = await fetchText(url, { ...opts, accept: 'json' });
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Non-JSON response from ${url}: ${text.slice(0, 160)}`);
  }
}

/**
 * Run `worker` over `items` with at most `limit` in flight.
 *
 * Results keep input order. A worker that throws yields `null` for that slot
 * rather than rejecting the whole batch — one dead Meetup group must not lose
 * the other 57.
 */
export async function mapPool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<Array<R | null>> {
  const results: Array<R | null> = new Array(items.length).fill(null);
  let cursor = 0;

  async function run(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = await worker(items[index], index);
      } catch {
        results[index] = null;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, run));
  return results;
}
