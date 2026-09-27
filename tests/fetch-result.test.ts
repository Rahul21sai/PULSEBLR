import { describe, it, expect } from 'vitest';
import {
  classifyReadFailure,
  failureLead,
  fetchJson,
  toRemote,
  type FetchOutcome,
  type ReadFailure,
} from '@/lib/fetch-result';

/**
 * `fetchJson` is the seam that decides "did this read succeed" for the home feed and the dashboard.
 *
 * Every case below is a way a response can LOOK like an answer or like nothing, and the defect this
 * module replaces was precisely a caller mistaking one for the other: `if (!res.ok) return` read a
 * failure as "no more events", and `if (statsRes.ok) setStats(...)` read one as "nobody is waiting
 * on you". No network — `fetch` and `navigator.onLine` are injected.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/** Exactly what `public/sw.js`'s `offlineJson()` returns when its own network fetch rejects. */
const serviceWorkerOffline = () => json({ error: 'Offline', offline: true }, 503);

const answering = (response: () => Response) => ({
  fetch: async () => response(),
  online: () => true,
});

describe('fetchJson — successes', () => {
  it('returns the parsed body on a 2xx', async () => {
    const outcome = await fetchJson<{ events: number[] }>('/api/events', {}, answering(() => json({ events: [1, 2] })));
    expect(outcome).toEqual({ kind: 'ok', data: { events: [1, 2] } });
  });

  it('passes the caller’s init (and so its AbortSignal) through to fetch', async () => {
    const controller = new AbortController();
    let seen: RequestInit | undefined;
    await fetchJson('/x', { signal: controller.signal }, {
      fetch: async (_url, init) => {
        seen = init;
        return json({});
      },
      online: () => true,
    });
    expect(seen?.signal).toBe(controller.signal);
  });
});

describe('fetchJson — a failure is never an empty answer', () => {
  it('a 500 is a failure the server reported', async () => {
    const outcome = await fetchJson('/api/phase6/stats', {}, answering(() => json({ error: 'Failed' }, 500)));
    expect(outcome).toEqual({ kind: 'failed', failure: 'error', status: 500 });
  });

  it('a 401 is signed-out, because "Try again" can never fix it', async () => {
    const outcome = await fetchJson('/api/phase6/follow-ups', {}, answering(() => json({ error: 'Unauthorized' }, 401)));
    expect(outcome).toEqual({ kind: 'failed', failure: 'signed-out', status: 401 });
  });

  it('a 403 is an error, not signed-out — signing in again would not change the answer', async () => {
    const outcome = await fetchJson('/x', {}, answering(() => json({ error: 'Forbidden' }, 403)));
    expect(outcome).toMatchObject({ kind: 'failed', failure: 'error' });
  });

  it('the service worker’s offline 503 reads as offline when the device IS offline', async () => {
    const outcome = await fetchJson('/api/events', {}, { fetch: async () => serviceWorkerOffline(), online: () => false });
    expect(outcome).toEqual({ kind: 'failed', failure: 'offline', status: 503 });
  });

  it('…and as unreachable when the device claims to be online — the worker says "no server answered"', async () => {
    // sw.js returns this body for ANY rejected network fetch, so on a flaky network with full bars
    // "you're offline, reconnect" would be a false instruction.
    const outcome = await fetchJson('/api/events', {}, answering(serviceWorkerOffline));
    expect(outcome).toEqual({ kind: 'failed', failure: 'unreachable', status: 503 });
  });

  it('a plain 503 without the worker’s marker is the server answering, so it is an error', async () => {
    const outcome = await fetchJson('/api/scrape', {}, answering(() => json({ error: 'ADMIN_EMAILS unset' }, 503)));
    expect(outcome).toMatchObject({ kind: 'failed', failure: 'error', status: 503 });
  });

  it('a rejected fetch is unreachable when online and offline when not', async () => {
    const rejects = async () => {
      throw new TypeError('Failed to fetch');
    };
    expect(await fetchJson('/x', {}, { fetch: rejects, online: () => true })).toEqual({
      kind: 'failed',
      failure: 'unreachable',
      status: null,
    });
    expect(await fetchJson('/x', {}, { fetch: rejects, online: () => false })).toEqual({
      kind: 'failed',
      failure: 'offline',
      status: null,
    });
  });

  it('a 200 carrying HTML is NOT a success — a captive portal is not an answer', async () => {
    const portal = () => new Response('<html>Sign in to Airport WiFi</html>', { status: 200 });
    const outcome = await fetchJson('/api/events', {}, answering(portal));
    expect(outcome).toEqual({ kind: 'failed', failure: 'error', status: 200 });
  });

  it('a non-OK HTML body is classified by its status alone', async () => {
    const gateway = () => new Response('<html>502 Bad Gateway</html>', { status: 502 });
    expect(await fetchJson('/x', {}, answering(gateway))).toEqual({ kind: 'failed', failure: 'error', status: 502 });
  });
});

describe('fetchJson — an abort is not a failure', () => {
  it('an AbortError from fetch is reported as aborted, never as a failure to render', async () => {
    const outcome = await fetchJson('/x', {}, {
      fetch: async () => {
        throw new DOMException('The operation was aborted.', 'AbortError');
      },
      online: () => true,
    });
    expect(outcome).toEqual({ kind: 'aborted' });
  });

  it('any rejection after the caller aborted is an abort, whatever the engine called it', async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await fetchJson('/x', { signal: controller.signal }, {
      fetch: async () => {
        throw new TypeError('Failed to fetch');
      },
      online: () => false,
    });
    expect(outcome).toEqual({ kind: 'aborted' });
  });
});

describe('classifyReadFailure', () => {
  it('offline wins over any status', () => {
    expect(classifyReadFailure(500, false)).toBe('offline');
    expect(classifyReadFailure(null, false)).toBe('offline');
  });

  it('no status means no server answered', () => {
    expect(classifyReadFailure(null, true)).toBe('unreachable');
  });

  it('401 is the only signed-out status', () => {
    expect(classifyReadFailure(401, true)).toBe('signed-out');
    for (const status of [400, 403, 404, 429, 500, 502, 503]) {
      expect(classifyReadFailure(status, true)).toBe('error');
    }
  });
});

describe('toRemote — a section is ready only when the answer carries what it renders', () => {
  type FollowUpsBody = { followUps?: unknown };
  const pickList = (data: FollowUpsBody) => (Array.isArray(data.followUps) ? data.followUps : undefined);

  it('an answer with the field is ready — including an EMPTY list, which is a real "nobody"', () => {
    expect(toRemote<FollowUpsBody, unknown[]>({ kind: 'ok', data: { followUps: [] } }, pickList)).toEqual({
      status: 'ready',
      data: [],
    });
  });

  it('a 2xx WITHOUT the field is a failure, never an empty section', () => {
    // This is the dashboard's old path: `setFollowUps(data.followUps)` on `{}` rendered
    // "Nobody is waiting on you." from `undefined`.
    expect(toRemote<FollowUpsBody, unknown[]>({ kind: 'ok', data: {} }, pickList)).toEqual({
      status: 'failed',
      failure: 'error',
    });
  });

  it('a field of the wrong shape is a failure — a list the page will .map() must be a list', () => {
    expect(toRemote<FollowUpsBody, unknown[]>({ kind: 'ok', data: { followUps: 'nope' } }, pickList)).toEqual({
      status: 'failed',
      failure: 'error',
    });
  });

  it('a JSON `null` body is a failure, not a crash inside `pick`', () => {
    const outcome = { kind: 'ok', data: null } as unknown as FetchOutcome<FollowUpsBody>;
    expect(toRemote(outcome, pickList)).toEqual({ status: 'failed', failure: 'error' });
  });

  it('a failed read keeps its reason, so the copy can say what to do', () => {
    expect(toRemote({ kind: 'failed', failure: 'signed-out', status: 401 }, pickList)).toEqual({
      status: 'failed',
      failure: 'signed-out',
    });
  });

  it('an abort changes nothing — the request that replaced it owns the section', () => {
    expect(toRemote({ kind: 'aborted' }, pickList)).toBeNull();
  });
});

describe('failureLead', () => {
  it('has a sentence for every kind, each ending in a full stop', () => {
    const kinds: ReadFailure[] = ['offline', 'unreachable', 'signed-out', 'error'];
    for (const kind of kinds) {
      expect(failureLead(kind)).toMatch(/^[A-Z].+\.$/);
    }
    // Distinct, or two different failures would read as one.
    expect(new Set(kinds.map(failureLead)).size).toBe(kinds.length);
  });
});
