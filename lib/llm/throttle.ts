/**
 * Throttle detection and backoff, shared by every LLM caller.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS MODULE EXISTS. It was written twice within a day — once in `tagger.ts` and once in
 * `draft-followup.ts`, because the tagger did not export it and the second author correctly
 * refused to reach into a file they did not own. The second copy carried the note that this
 * extraction was the fix, with the right precedent: the `WorthGoing` panel on `/events/[id]`
 * had COPIED `connection-score.ts`'s funnel regex, the copy fell eight entries behind, and the
 * page went on confidently explaining a heavily-penalised coaching advert without mentioning
 * the penalty. A copied predicate does not stay a copy.
 *
 * WHAT IS SHARED AND WHAT IS NOT, because the two callers genuinely differ and flattening that
 * would be the wrong kind of DRY:
 *
 *   · `isRateLimited` is IDENTICAL in both and always will be — it describes what IBM ICA does,
 *     not what any caller wants. Shared outright.
 *   · The CAP is not shared. The tagger waits up to 20s because it runs on a GitHub Actions
 *     runner with hundreds of batches queued behind it; the draft path waits at most 8s because
 *     a person is watching a spinner. Both are right. So the cap is a parameter and each caller
 *     names its own with the reason beside it.
 *   · ATTEMPT COUNT stays with the caller for the same reason — 4 for a nightly scrape that can
 *     afford to be slow, 3 for an interactive request that must fail visibly rather than hang.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

/**
 * Is this response a throttle?
 *
 * ── THE STATUS CODE IS NOT ENOUGH, AND THAT IS THE WHOLE POINT ───────────────────────────────
 *
 * IBM ICA fronts Bedrock through litellm and **loses the 429 on the way**, delivering a throttle
 * as an HTTP **400** with the real cause only in the body:
 *
 *   400 {"detail":"litellm.RateLimitError: BedrockException - {\"message\":\"Too many requests,
 *        please wait before trying again...\"}. Received Model Group=claude-sonnet-5"}
 *
 * Measured 2026-09-10. Before this predicate existed, `tagger.ts` threw on any 400 that did not
 * mention `temperature`, so a transient throttle was handled as a permanent failure: no backoff,
 * the model chain skipped, straight to the next provider and then to the keyword floor. Because
 * `pipeline.ts` calls `tagEvents()` once for the whole corpus, the first throttled batch tripped
 * the strike counter and every later batch fell to keywords too — a full scrape would have
 * quietly produced a keyword-tagged corpus with a correctly-configured frontier model idle.
 *
 * It also silently invalidated `diag-retag-preview.ts`, which reported `FIXED 0  BROKE 1` while
 * comparing the keyword floor against itself. That reads exactly like "this model is not good
 * enough to rewrite the corpus with", which is the most expensive way for a diagnostic to lie.
 *
 * ── WHY MATCHING ON THE BODY IS ACCEPTABLE HERE, WHEN IT USUALLY IS NOT ──────────────────────
 *
 * A 400 means "your request was bad" and a throttle is not that, so the status alone cannot tell
 * this from a genuinely malformed request — and treating every 400 as retryable would turn a real
 * schema error into several slow retries and a misleading log. The gateway has thrown the truth
 * away everywhere except the body, so the body is the only instrument left. The pattern is kept
 * deliberately narrow, and a real 429 is matched on status as it should be.
 */
export function isRateLimited(status: number, body: string): boolean {
  if (status === 429) return true;
  if (status !== 400) return false;
  return /rate.?limit|too many requests|throttl|quota exceeded/i.test(body);
}

/**
 * How long to wait before retrying a throttled request.
 *
 * `Retry-After` wins when the gateway sends one — it is accepted as either a seconds count or an
 * HTTP date, because both are legal and a caller cannot choose which arrives.
 *
 * Otherwise exponential backoff with **FULL JITTER**. The jitter is not decoration: every caller
 * here is a sequential loop against one shared account quota, so without it two throttled callers
 * retry in lockstep and keep colliding at exactly the moment the window reopens.
 *
 * @param capMs the longest single wait this caller can afford. There is no sensible default —
 *   see the module header for why 20s is right for a nightly runner and wrong for a user
 *   watching a spinner — so it is required.
 * @param random injectable, and that is the second author's improvement over the first copy of
 *   this function rather than a flourish. With `Math.random` hard-wired, the only honest test of
 *   jittered backoff is a statistical one — run it many times and assert a distribution — which
 *   is slow, flaky, and asserts the wrong thing. Injecting it lets a test pin the exact
 *   arithmetic at both ends of the jitter range: `() => 0` gives half the base delay and
 *   `() => 1` gives all of it.
 */
export function retryAfterMs(
  header: string | null,
  attempt: number,
  capMs: number,
  random: () => number = Math.random
): number {
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, capMs);
    const at = Date.parse(header);
    if (!Number.isNaN(at)) return Math.min(Math.max(at - Date.now(), 0), capMs);
  }
  const base = Math.min(1000 * 2 ** attempt, capMs);
  // Full jitter: half the computed delay plus a random half, so no two callers land together.
  return Math.round(base * (0.5 + random() * 0.5));
}

/**
 * The tagger's cap: it runs on a GitHub Actions runner with hundreds of batches behind it, so a
 * generous ceiling multiplied by the queue is the difference between a slow scrape and one that
 * outlives its runner.
 */
export const BATCH_BACKOFF_CAP_MS = 20_000;

/**
 * The interactive cap: a person is watching a spinner, so failing visibly beats waiting quietly.
 */
export const INTERACTIVE_BACKOFF_CAP_MS = 8_000;
