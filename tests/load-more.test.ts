import { describe, it, expect } from 'vitest';
import {
  LOAD_MORE_IDLE,
  nextLoadMore,
  type LoadMoreEvent,
  type LoadMoreState,
} from '@/lib/events/load-more';
import type { ReadFailure } from '@/lib/fetch-result';

/**
 * The home feed's load-more state machine.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE ASSERTION THAT MATTERS IS `requests === 1` IN THE OBSERVER-LOOP SIMULATION BELOW.
 *
 * The defect was a loop, not a wrong value: a failed page cleared the in-flight flag, the infinite-
 * scroll observer was recreated, its initial notification fired while the sentinel was still on
 * screen, and the same page was requested again — at render speed when offline, because the service
 * worker answers `/api/events` with an immediate 503. A per-transition test can pass while that loop
 * survives, so the loop itself is modelled here and its request count pinned.
 *
 * The simulation is checked against the OLD behaviour too (a failure that falls back to idle). If
 * that did not produce a runaway count, the harness would be measuring nothing — so it is asserted
 * to, which is what makes `requests === 1` for the real reducer mean something.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

type Reducer = (state: LoadMoreState, event: LoadMoreEvent) => LoadMoreState;

/**
 * Model of `app/page.tsx`'s infinite scroll with the sentinel permanently on screen: every
 * settled request re-arms the observer, and a re-armed observer always reports "intersecting".
 * `observerFires` bounds the run; a correct reducer stops long before it.
 */
function driveObserver(
  reduce: Reducer,
  respond: (requestNumber: number) => 'ok' | ReadFailure,
  observerFires = 200,
  initial: LoadMoreState = LOAD_MORE_IDLE
) {
  let state = initial;
  let requests = 0;
  for (let i = 0; i < observerFires; i++) {
    const next = reduce(state, { type: 'request', trigger: 'auto', hasMore: true });
    if (next === state) continue; // refused — the page sends nothing
    state = next;
    requests++;
    const outcome = respond(requests);
    state = reduce(
      state,
      outcome === 'ok' ? { type: 'succeeded' } : { type: 'failed', failure: outcome }
    );
  }
  return { state, requests };
}

/** The shape the feed had: a failed page simply went back to idle. */
const oldBehaviour: Reducer = (state, event) =>
  event.type === 'failed' && state.status === 'loading' ? LOAD_MORE_IDLE : nextLoadMore(state, event);

const request = (trigger: 'auto' | 'explicit', hasMore = true): LoadMoreEvent => ({
  type: 'request',
  trigger,
  hasMore,
});

describe('the observer loop', () => {
  it('the harness reproduces the original defect: a failure that returns to idle re-requests forever', () => {
    const { requests } = driveObserver(oldBehaviour, () => 'offline', 200);
    expect(requests).toBe(200);
  });

  it('a page that always fails is requested exactly ONCE, however often the observer fires', () => {
    const { state, requests } = driveObserver(nextLoadMore, () => 'offline', 200);
    expect(requests).toBe(1);
    expect(state).toEqual({ status: 'failed', failure: 'offline', trigger: 'auto' });
  });

  it('holds for every failure kind, not just offline', () => {
    for (const failure of ['offline', 'unreachable', 'signed-out', 'error'] as const) {
      expect(driveObserver(nextLoadMore, () => failure, 50).requests).toBe(1);
    }
  });

  it('successful pages keep flowing — the fix must not cost the fill-the-screen behaviour', () => {
    // Pages 1..5 succeed and page 6 fails: the observer keeps loading until the failure, then stops.
    const { state, requests } = driveObserver(nextLoadMore, n => (n <= 5 ? 'ok' : 'unreachable'), 200);
    expect(requests).toBe(6);
    expect(state.status).toBe('failed');
  });
});

describe('explicit retry is the way out', () => {
  const failed: LoadMoreState = { status: 'failed', failure: 'offline', trigger: 'auto' };

  it('the Retry button starts a request from the failed state', () => {
    expect(nextLoadMore(failed, request('explicit'))).toEqual({ status: 'loading', trigger: 'explicit' });
  });

  it('a retry that succeeds hands control back to the observer', () => {
    let state = nextLoadMore(failed, request('explicit'));
    state = nextLoadMore(state, { type: 'succeeded' });
    expect(state).toBe(LOAD_MORE_IDLE);
    expect(nextLoadMore(state, request('auto'))).toEqual({ status: 'loading', trigger: 'auto' });
  });

  it('a retry that fails records that the READER caused it, so focus may return to Retry', () => {
    let state = nextLoadMore(failed, request('explicit'));
    state = nextLoadMore(state, { type: 'failed', failure: 'error' });
    expect(state).toEqual({ status: 'failed', failure: 'error', trigger: 'explicit' });
  });

  it('a new filter set resets a failure — its page 2 is a different request that has never failed', () => {
    const state = nextLoadMore(failed, { type: 'reset' });
    expect(state).toBe(LOAD_MORE_IDLE);
    expect(nextLoadMore(state, request('auto')).status).toBe('loading');
  });
});

describe('never two in flight, never past the end', () => {
  const loading: LoadMoreState = { status: 'loading', trigger: 'auto' };

  it('refuses any request while one is in flight, returning the SAME object', () => {
    // Identity is the contract: the page sends a request only when the state object changed.
    expect(nextLoadMore(loading, request('auto'))).toBe(loading);
    expect(nextLoadMore(loading, request('explicit'))).toBe(loading);
  });

  it('refuses when there is no next page, from every state', () => {
    const failed: LoadMoreState = { status: 'failed', failure: 'offline', trigger: 'auto' };
    expect(nextLoadMore(LOAD_MORE_IDLE, request('auto', false))).toBe(LOAD_MORE_IDLE);
    expect(nextLoadMore(LOAD_MORE_IDLE, request('explicit', false))).toBe(LOAD_MORE_IDLE);
    expect(nextLoadMore(failed, request('explicit', false))).toBe(failed);
  });

  it('ignores a completion it was not waiting for', () => {
    // A late answer for a request that a reset already disowned must not move the machine.
    expect(nextLoadMore(LOAD_MORE_IDLE, { type: 'succeeded' })).toBe(LOAD_MORE_IDLE);
    expect(nextLoadMore(LOAD_MORE_IDLE, { type: 'failed', failure: 'offline' })).toBe(LOAD_MORE_IDLE);
  });

  it('reset is a no-op on idle and returns everything else to idle', () => {
    expect(nextLoadMore(LOAD_MORE_IDLE, { type: 'reset' })).toBe(LOAD_MORE_IDLE);
    expect(nextLoadMore(loading, { type: 'reset' })).toBe(LOAD_MORE_IDLE);
  });
});
