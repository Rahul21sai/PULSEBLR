/**
 * Is a failed capture worth retrying, or has the server already decided against it?
 *
 * PURE, and deliberately separate from `outbox.ts`, for the same reason
 * `lib/tracker/validate.ts` is separate from the route that uses it: the client queue and the
 * server sync route both need this judgement, it has to be the SAME judgement on both sides,
 * and a module with no IndexedDB and no Mongoose can be pinned by `tests/` without a browser,
 * a server or a database.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * THE BUG THIS EXISTS TO FIX, because it is the kind a later simplification re-introduces.
 *
 * All three capture sites used to do this:
 *
 *     const res = await fetch('/api/contacts', { … });
 *     if (!res.ok) throw new Error(`HTTP ${res.status}`);   // ← the mistake
 *     …
 *     catch { await queueContact(record); }                  // ← "the network ate it"
 *
 * `!res.ok` folds two unrelated events into one. A dropped connection means the server never
 * formed an opinion, so the identical request may well succeed in a minute — queue it. A 404
 * `Folder not found` means the server DID form an opinion and refused, and it will refuse the
 * byte-identical request for as long as that folder stays deleted.
 *
 * Queuing the second kind produced a record that could never leave: the banner promised "they
 * will upload on their own", `drain()` re-posted it on every focus change and every
 * `online` event, `markContactFailed()` incremented an `attempts` counter that nothing
 * rendered, and the count never moved. Pressing "Sync now" ran the entire cycle and reported
 * nothing at all, because `syncNow()` only reacted to `synced > 0`. The user's only evidence
 * was a number that would not go down.
 *
 * So a failed capture has THREE outcomes, not two, and the axis is NOT how serious the
 * failure was — it is whether the identical request could ever succeed later:
 *
 *   'transient'  Nobody formed an opinion, or the opinion was "not now". Retry silently;
 *                the existing outbox behaviour is correct for this case and only this case.
 *   'auth'       The session lapsed. Retrying is futile until the user signs in, but it WILL
 *                work afterwards — so the record stays queued and the UI asks them to sign
 *                in rather than blaming the network.
 *   'permanent'  The server refused on the merits. The record is still kept, because losing
 *                a person you met is worse than any wrong status line — but it is flagged so
 *                the count stops lying and the user can fix, retry or discard it.
 *
 * NOTHING HERE EVER DISCARDS A CAPTURE. `outbox.ts`'s header states the guarantee that a
 * record is removed only when the server confirms it, and a classifier is not allowed to
 * weaken that. 'permanent' changes what the UI says and what the auto-drain bothers to
 * attempt; it does not change what is stored.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */

export type FailureKind = 'transient' | 'auth' | 'permanent';

/**
 * Classify an HTTP status from a capture write.
 *
 * The 4xx/5xx split is the main rule, with three carve-outs that matter more than they look:
 *
 * - **401 is its own kind.** It is a 4xx, so the generic rule would call it permanent and
 *   invite the UI to offer "discard" for a capture that is perfectly good and needs only a
 *   sign-in. `requireUser()` answers 401 for every lapsed session, and a conference day is
 *   long enough for a token to expire mid-event.
 * - **408 / 425 / 429 are 4xx but explicitly mean "later".** A rate limit is the one 4xx
 *   whose whole meaning is that the same request will be accepted shortly;
 *   `lib/security/rate-limit.ts` can produce one on the intake path.
 * - **5xx includes 503.** `requireAdmin()` answers 503 when `ADMIN_EMAILS` is unset — a
 *   configuration fault someone can repair without the user re-scanning anybody. Contacts do
 *   not use that guard today, but treating server-side faults as recoverable is right
 *   regardless, and it keeps this function honest if a route later grows a 503.
 */
export function classifyStatus(status: number): FailureKind {
  if (status === 401) return 'auth';
  if (status === 408 || status === 425 || status === 429) return 'transient';
  if (status >= 500) return 'transient';
  if (status >= 400) return 'permanent';
  // A 2xx never reaches here, and `fetch` follows 3xx itself. Anything else is not a refusal
  // we can reason about, so err towards retrying: the cost is one request, and the cost of
  // guessing 'permanent' is telling somebody their capture is broken when it is not.
  return 'transient';
}

/**
 * The per-item refusals `POST /api/contacts/sync` can issue, as CODES rather than prose.
 *
 * The client has to know whether an item-level refusal is permanent, and the alternative was
 * string-matching the server's `error` text on the wire. That is precisely the mirrored
 * constant this repo has now been bitten by twice (`CATEGORY_KEYWORDS`, and
 * `diag-source-caps.ts` checking its own stale copy of a cap): the day somebody improves the
 * wording of an error message, the client silently stops recognising it and every refusal
 * quietly becomes "transient" again — which is the original bug, restored, invisibly.
 *
 * So the server sends a code from this object and the client renders the message from it.
 * The wording lives on the client side of the boundary because it is user-facing copy, and
 * because a server error string is not written to be read by a person mid-event.
 */
export const ITEM_REFUSALS = {
  'missing-client-id': 'This capture lost its id, so it cannot be uploaded without risking a duplicate.',
  'missing-name': 'This capture has no name yet. Add one and it will upload.',
  'no-folder': 'This capture is not attached to any folder.',
  'folder-not-found': 'The folder this capture belonged to no longer exists.',
} as const;

export type ItemRefusal = keyof typeof ITEM_REFUSALS;

/**
 * `hasOwnProperty`, NOT `in` — and that is not pedantry, it was a live bug.
 *
 * `code in ITEM_REFUSALS` walks the prototype chain, so `'toString'`, `'constructor'` and
 * `'valueOf'` all answer true. `refusalMessage()` would then hand back
 * `ITEM_REFUSALS['toString']` — a Function, not a string — and the folders page would render
 * the source of `Function.prototype.toString` as the reason a person's capture failed. The
 * value arrives in a JSON response body, so it is attacker-shaped input by construction.
 * Caught by `tests/scan-failure.test.ts`, which is why that test enumerates prototype keys
 * rather than only obviously-wrong strings.
 */
export function isItemRefusal(code: unknown): code is ItemRefusal {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(ITEM_REFUSALS, code);
}

/**
 * What to show a user about one stuck capture.
 *
 * Falls back to the server's own message, then to a generic line — never to an empty string,
 * because a blocked row with no reason is the state this whole change exists to remove.
 */
export function refusalMessage(code: unknown, serverMessage?: string): string {
  if (isItemRefusal(code)) return ITEM_REFUSALS[code];
  const trimmed = typeof serverMessage === 'string' ? serverMessage.trim() : '';
  if (trimmed) return trimmed;
  return 'The server refused this capture and did not say why.';
}
