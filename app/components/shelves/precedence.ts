/**
 * Precedence by SUBTRACTION, as a pure function.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A FUNCTION AND NOT FOUR MORE LINES INSIDE THE MEMO.
 *
 * The home page renders the same corpus through several requests — what is on now, what an admin
 * pinned, what a human typed in, what a company you follow is hosting, and the ranked page — and
 * THE SETS ARE NOT DISJOINT. A hand-added event can be in progress; an admin can pin one; an event
 * hosted by a followed company can also rank onto page 1 on its own merit. So the same `_id`
 * legitimately arrives from four requests, and whichever section claims it first has to win.
 *
 * That rule was previously spelled out once per section, as a `!seen.has(id) && !featuredIds.has(id)`
 * chain that grows by one clause every time a shelf is added. Each new shelf therefore had to
 * remember every earlier one, and the failure mode of forgetting is not a crash — it is one event
 * rendered twice, in two sections that each look correct in isolation. Stating the rule once, with
 * the claimed set threaded through, makes forgetting impossible rather than merely unlikely.
 *
 * It is in `.ts` (not `.tsx`) and imports nothing, so `tests/shelves.test.ts` can pin it: `vitest`
 * is configured for pure functions only, and the whole point of extracting this is that the
 * precedence chain becomes something a test can assert instead of something a reader has to trace.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

/** The minimum a row needs for precedence: an identity. */
export interface Claimable {
  _id: string;
}

/**
 * May the page show curated shelves at all?
 *
 * ONLY THE UNTOUCHED LANDING VIEW. Once a reader has typed a search or narrowed a filter they have
 * said what they want, and promoting rows above their own query is noise dressed as curation — so
 * every shelf withdraws together rather than each deciding for itself.
 *
 * `activeFilterCount === 0`, NOT `<= 1`. It was `<= 1` on the reasoning that `techOnly` "is on by
 * default and counts as one", but `countActive` has never counted `techOnly` — so the allowance was
 * spurious and the shelves kept rendering above a feed the reader had already narrowed with one real
 * filter. `techOnly` is not in `FilterState` at all now, which makes the off-by-one unambiguous.
 *
 * NOTE WHAT IS *NOT* HERE: the selected time window. Neither `when` nor `day` retires a shelf,
 * because `countActive` does not count either — a window is a question about WHEN, and a shelf
 * answering "who is hosting" is still worth showing inside it. Both are passed through to the shelf's
 * own request, so a shelf under a selected Thursday shows Thursday's events rather than the week's.
 *
 * Extracted from an inline expression in `app/page.tsx` so it can be pinned: the rule decides
 * whether four sections render, and "is this view untouched" is exactly the kind of predicate that
 * drifts one call site at a time.
 */
export function shelfEligible(query: string, activeFilterCount: number): boolean {
  return !query && activeFilterCount === 0;
}

/**
 * Split a claimed section's rows into the ones drawn immediately and the ones behind an expander.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE POINT OF THIS FUNCTION IS THE PROPERTY ITS TEST ASSERTS: `[...shown, ...deferred]` is `rows`,
 * for every `preview`. That is the difference between deferring a card and losing one, and on this
 * page it is the difference that matters — every section above the feed SUBTRACTS its ids from
 * "Coming up" so nothing renders twice, so a row a section holds and does not draw is gone from the
 * page entirely. `rows.slice(0, n)` on its own is exactly how that happens: it is one line, it looks
 * obviously correct, and it silently discards the tail.
 *
 * So the split is a function with a total on both sides, and the caller renders BOTH halves — the
 * deferred half hidden rather than absent, with a control that names how many it holds. "Happening
 * now" is the caller: it has no cap at all, so three live events cost 809px on a 390px screen before
 * the ranked feed begins, and a quiet Tuesday and a festival week produce very different pages.
 *
 * `preview` is clamped rather than validated. A negative value defers everything (which a caller can
 * legitimately want) and a value past the end defers nothing; neither is an error worth throwing over
 * in a render path, and both keep the total.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
export function splitForPreview<T>(
  rows: readonly T[],
  preview: number
): { shown: T[]; deferred: T[] } {
  const at = Math.min(Math.max(0, preview), rows.length);
  return { shown: rows.slice(0, at), deferred: rows.slice(at) };
}

export interface SectionClaim<T> {
  /** The rows this section shows — deduplicated, capped, and free of anything already claimed. */
  rows: T[];
  /**
   * Every id claimed so far, INCLUDING this section's. A NEW set: the input is never mutated, so
   * a caller cannot accidentally widen an earlier section's view of the world by running a later
   * one, and the chain stays safe to compute inside a `useMemo`.
   */
  claimed: ReadonlySet<string>;
}

/**
 * Take up to `cap` rows from `candidates` that no earlier section has claimed.
 *
 * ROWS ARE FILTERED BY ID, NEVER SLICED BLIND. A pinned or followed-company event need not be at
 * the top of the ranked page, or on it at all, so `slice(0, cap)` before filtering would drop the
 * wrong rows — it would spend the cap on events that are about to be removed and render fewer than
 * `cap` for no reason. Filter first, then cap.
 *
 * IT ALSO DEDUPLICATES WITHIN `candidates`. Two requests can return the same event (the live set
 * and the ranked page are merged before reaching here), and a section that shows one event twice is
 * exactly the bug this file exists to prevent — it would be perverse to guard against it across
 * sections and not within one.
 *
 * `cap <= 0` yields no rows and leaves `claimed` untouched, which is what a disabled shelf needs:
 * it must not silently consume events that the ranked feed is then missing. Same for an ineligible
 * section — pass an empty `candidates` rather than skipping the call, and the chain stays linear.
 */
export function claimSection<T extends Claimable>(
  candidates: readonly T[],
  claimed: ReadonlySet<string>,
  cap: number
): SectionClaim<T> {
  if (cap <= 0 || candidates.length === 0) return { rows: [], claimed };

  const rows: T[] = [];
  const next = new Set(claimed);
  for (const row of candidates) {
    if (rows.length >= cap) break;
    if (next.has(row._id)) continue;
    next.add(row._id);
    rows.push(row);
  }
  // Nothing was taken, so hand back the ORIGINAL set rather than the copy. Identity matters to
  // React: an unchanged reference lets a downstream `useMemo` skip, and a shelf that shows nothing
  // should cost nothing downstream.
  return rows.length === 0 ? { rows: [], claimed } : { rows, claimed: next };
}
