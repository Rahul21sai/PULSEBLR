/**
 * The home feed's "load more", as a state machine — and the one rule it exists to enforce.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A FAILED PAGE IS NEVER RE-REQUESTED AUTOMATICALLY. ONLY THE READER CAN RETRY IT.
 *
 * The infinite scroll is an IntersectionObserver on a sentinel below the list, and it is recreated
 * whenever the page's callbacks change. A freshly created observer ALWAYS delivers an initial
 * notification, so while the sentinel is on screen every recreation is a new "intersecting" event.
 * That is what makes the feed fill a tall screen page after page, and it is also what turned a
 * failure into a loop:
 *
 *     request page 2 → 503 → `if (!res.ok) return` → finally clears the in-flight flag
 *       → re-render → observer recreated → initial notification → request page 2 → 503 → …
 *
 * Nothing broke the cycle, because nothing remembered that page 2 had just failed. Offline,
 * `public/sw.js` answers `/api/events` with an immediate 503, so the loop ran at render speed with
 * the bottom of the feed on screen — a request storm and a battery drain, on a phone, at an event,
 * behind a list that silently stopped growing.
 *
 * So failure is a STATE here, not an early return. From `failed`, an `auto` request is refused
 * outright; the observer can fire as often as it likes and it produces nothing. An `explicit`
 * request — the Retry button — is the only way out, apart from a `reset` (a new filter set, whose
 * page 2 is a different request that has never failed).
 *
 * There is deliberately NO automatic retry with backoff. A backoff still spends requests while the
 * reader is offline, and the reader already has a one-tap retry sitting where the next page would
 * be. `tests/load-more.test.ts` drives the observer loop against a page that always fails and pins
 * the request count at exactly one.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * PURE, like `app/components/shelves/precedence.ts` and for the same reason: the page renders the
 * decision and `tests/` can pin it without a DOM, a server or an IntersectionObserver.
 */
import type { ReadFailure } from '@/lib/fetch-result';

/** Who asked for the next page: the scroll observer, or the reader pressing a button. */
export type LoadMoreTrigger = 'auto' | 'explicit';

export type LoadMoreState =
  | { status: 'idle' }
  | { status: 'loading'; trigger: LoadMoreTrigger }
  /**
   * `trigger` is the one that FAILED. A failure the reader caused by pressing Retry is one they are
   * waiting on, so the page may move focus back to the Retry button; a failure the observer caused
   * while they were reading must not steal focus.
   */
  | { status: 'failed'; failure: ReadFailure; trigger: LoadMoreTrigger };

export type LoadMoreEvent =
  /** `hasMore` is the CURRENT generation's cursor — false while a fresh filter set is loading. */
  | { type: 'request'; trigger: LoadMoreTrigger; hasMore: boolean }
  | { type: 'succeeded' }
  | { type: 'failed'; failure: ReadFailure }
  /** A new filter generation started. Whatever the old one was doing no longer applies. */
  | { type: 'reset' };

export const LOAD_MORE_IDLE: LoadMoreState = { status: 'idle' };

/**
 * The next state. Returns the SAME object when an event changes nothing, and the page relies on
 * that: a request that comes back unchanged is a request that must not be sent.
 */
export function nextLoadMore(state: LoadMoreState, event: LoadMoreEvent): LoadMoreState {
  switch (event.type) {
    case 'request':
      // Nothing after this page, or no page of the current filter set has arrived yet.
      if (!event.hasMore) return state;
      // Never two page requests in flight. The second would ask for the same page number, and
      // whichever landed last would decide what the cursor says.
      if (state.status === 'loading') return state;
      // THE LOOP. See the header.
      if (state.status === 'failed' && event.trigger === 'auto') return state;
      return { status: 'loading', trigger: event.trigger };

    case 'succeeded':
      return state.status === 'loading' ? LOAD_MORE_IDLE : state;

    case 'failed':
      return state.status === 'loading'
        ? { status: 'failed', failure: event.failure, trigger: state.trigger }
        : state;

    case 'reset':
      return state.status === 'idle' ? state : LOAD_MORE_IDLE;
  }
}
