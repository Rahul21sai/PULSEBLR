/**
 * The outbox's automatic drain — ONE set of triggers however many screens hold it, and never for
 * nobody.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THIS PINS, and the defect behind each:
 *
 *   1. The drain used to be wired only by `/scan`, `/folders` and `/folders/[id]`, so a capture
 *      queued at a venue never uploaded for someone who later opened only the feed. `<OutboxOwner />`
 *      now holds it on every page for a signed-in account — which means those three screens hold it
 *      TWICE. Wired per call, that is two listener sets, two boot drains and two auth-backoff clocks.
 *      `createAutoDrain` counts holders instead, and the counting is what is asserted here.
 *   2. A signed-out visitor never drains, and a drain still scheduled when the last holder leaves
 *      does not fire for the account that just left.
 *   3. `signedInAccount` — the session gate `<OutboxOwner />` applies (and `ViewerEventRows` reuses)
 *      — including the `loading` case that must not tear the triggers down on a session refetch.
 *
 * Pure: the controller is handed fakes for its listeners, timers and drain, so there is no DOM and no
 * IndexedDB. The last block runs the REAL `startAutoDrain()` against a stubbed `window`, because the
 * controller being right is worth nothing if the exported entry point does not use it.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 */
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { signedInAccount } from '@/app/components/OutboxOwner';
import { createAutoDrain, type AutoDrainEnv } from '@/lib/scan/outbox';

type Triggers = { online: () => void; visible: () => void };

function harness(options: { signedIn?: boolean } = {}) {
  const state = { signedIn: options.signedIn ?? true, authExpired: false, now: 1_000 };
  const listening: Triggers[] = [];
  const counts = { attached: 0, detached: 0 };
  const timers: Array<{ run: () => void; cancelled: boolean }> = [];
  const armedChanges: boolean[] = [];
  let result: { authExpired?: boolean } = {};

  const drain = vi.fn(async () => result);
  const env: AutoDrainEnv = {
    listen(triggers) {
      counts.attached += 1;
      listening.push(triggers);
      return () => {
        counts.detached += 1;
        listening.splice(listening.indexOf(triggers), 1);
      };
    },
    defer(run) {
      const timer = { run, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    drain,
    signedIn: () => state.signedIn,
    authExpired: () => state.authExpired,
    now: () => state.now,
    armedChanged: () => armedChanges.push(controller.armed()),
  };
  const controller = createAutoDrain(env);

  return {
    controller,
    state,
    counts,
    drain,
    armedChanges,
    answer(next: { authExpired?: boolean }) {
      result = next;
    },
    /** Deliver a browser event to every listener set currently attached. */
    fire(kind: keyof Triggers) {
      for (const triggers of [...listening]) triggers[kind]();
    },
    /** Run every deferred drain that is due and has not been cancelled. */
    elapse() {
      for (const timer of timers.splice(0)) if (!timer.cancelled) timer.run();
    },
  };
}

/** Let the `.then` on a drain run, so the backoff clock sees its result. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe('createAutoDrain — one set of triggers for every holder', () => {
  it('attaches the listeners once for two holders, so one event is one drain', () => {
    const h = harness();
    h.controller.start(); // <OutboxOwner />
    h.controller.start(); // /scan, mounted on top of it
    expect(h.counts.attached).toBe(1);

    h.fire('online');
    expect(h.drain).toHaveBeenCalledTimes(1);
  });

  it("a screen leaving keeps the app's hold; the last release detaches", () => {
    const h = harness();
    const releaseApp = h.controller.start();
    const releasePage = h.controller.start();

    releasePage();
    expect(h.counts.detached).toBe(0);
    h.fire('online');
    expect(h.drain).toHaveBeenCalledTimes(1);

    releaseApp();
    expect(h.counts.detached).toBe(1);
    expect(h.controller.armed()).toBe(false);
  });

  it("a release called twice cannot spend another holder's share", () => {
    const h = harness();
    h.controller.start();
    const releasePage = h.controller.start();

    releasePage();
    releasePage();
    expect(h.controller.armed()).toBe(true);
    expect(h.counts.detached).toBe(0);
  });

  it('attaches afresh after a full release', () => {
    const h = harness();
    h.controller.start()();
    h.controller.start();
    expect(h.counts.attached).toBe(2);
    expect(h.controller.armed()).toBe(true);
  });

  it('reports arming and disarming once each, not on every hold', () => {
    const h = harness();
    const releaseApp = h.controller.start();
    const releasePage = h.controller.start();
    releasePage();
    releaseApp();
    expect(h.armedChanges).toEqual([true, false]);
  });
});

describe('createAutoDrain — the boot drain', () => {
  it('holders arriving before it runs share ONE drain', () => {
    const h = harness();
    h.controller.start(); // the page, on a hard load
    h.controller.start(); // the session resolving a moment later
    h.elapse();
    expect(h.drain).toHaveBeenCalledTimes(1);
  });

  it('a screen opened later still asks for one drain of its own', () => {
    const h = harness();
    h.controller.start();
    h.elapse();
    h.controller.start(); // "Save & close" lands on the folder page
    h.elapse();
    expect(h.drain).toHaveBeenCalledTimes(2);
  });

  it('never fires once the last holder has left', () => {
    const h = harness();
    const release = h.controller.start();
    release(); // signed out inside the boot delay
    h.elapse();
    expect(h.drain).not.toHaveBeenCalled();
  });
});

describe('createAutoDrain — never on nobody’s behalf', () => {
  it('a signed-out holder drains on no trigger at all', () => {
    const h = harness({ signedIn: false });
    h.controller.start();
    h.elapse();
    h.fire('online');
    h.fire('visible');
    expect(h.drain).not.toHaveBeenCalled();
  });

  it('keeps one backoff clock after a 401, whoever holds the triggers', async () => {
    const h = harness();
    h.controller.start();
    h.controller.start();

    h.answer({ authExpired: true });
    h.state.authExpired = true;
    h.fire('online'); // a network change always goes through
    await settle();
    expect(h.drain).toHaveBeenCalledTimes(1);

    h.state.now += 60_000;
    h.fire('visible'); // a glance back at the app inside the backoff: nothing
    expect(h.drain).toHaveBeenCalledTimes(1);

    h.state.now += 5 * 60_000;
    h.fire('visible'); // past it: one retry
    expect(h.drain).toHaveBeenCalledTimes(2);
  });
});

describe('signedInAccount — the session gate for the drain (and for the public lists’ saved state)', () => {
  it('acts for a signed-in account', () => {
    expect(signedInAccount('authenticated', 'u1')).toBe('u1');
  });

  it('never for a signed-out visitor, whatever stale data lingers', () => {
    expect(signedInAccount('unauthenticated', 'u1')).toBeNull();
    expect(signedInAccount('unauthenticated', undefined)).toBeNull();
  });

  it('never before the session has resolved', () => {
    expect(signedInAccount('loading', undefined)).toBeNull();
  });

  it('never for a session with no user id — it looks signed in and every private route 401s it', () => {
    expect(signedInAccount('authenticated', undefined)).toBeNull();
    expect(signedInAccount('authenticated', '')).toBeNull();
  });

  it('keeps the account through a refetch, which reads `loading` with the old data still present', () => {
    expect(signedInAccount('loading', 'u1')).toBe('u1');
  });
});

describe('the real startAutoDrain uses the counted controller', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function browserOutbox() {
    vi.resetModules();
    vi.useFakeTimers();
    const win = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    vi.stubGlobal('window', win);
    vi.stubGlobal('document', doc);
    const add = vi.spyOn(win, 'addEventListener');
    const remove = vi.spyOn(win, 'removeEventListener');
    const outbox = await import('@/lib/scan/outbox');
    const online = (calls: ReadonlyArray<readonly unknown[]>) => calls.filter(([type]) => type === 'online').length;
    return { outbox, onlineAdds: () => online(add.mock.calls), onlineRemoves: () => online(remove.mock.calls) };
  }

  it('two holds add ONE online listener, and only the last release removes it', async () => {
    const { outbox, onlineAdds, onlineRemoves } = await browserOutbox();
    const releaseApp = outbox.startAutoDrain();
    const releasePage = outbox.startAutoDrain();
    expect(onlineAdds()).toBe(1);

    releasePage();
    expect(onlineRemoves()).toBe(0);
    releaseApp();
    expect(onlineRemoves()).toBe(1);
  });

  it('promises an upload only while an account is signed in AND the triggers are held', async () => {
    const { outbox } = await browserOutbox();
    expect(outbox.autoDrainArmed()).toBe(false);

    const release = outbox.startAutoDrain();
    expect(outbox.autoDrainArmed()).toBe(false); // held, but for nobody yet

    outbox.setOutboxOwner('u1');
    expect(outbox.autoDrainArmed()).toBe(true);

    outbox.setOutboxOwner(null); // a session refetch that failed offline reads exactly like this
    expect(outbox.autoDrainArmed()).toBe(false);

    outbox.setOutboxOwner('u1');
    release();
    expect(outbox.autoDrainArmed()).toBe(false);
  });

  it('a server render never holds anything', async () => {
    vi.resetModules();
    const outbox = await import('@/lib/scan/outbox');
    outbox.setOutboxOwner('u1');
    outbox.startAutoDrain();
    expect(outbox.autoDrainArmed()).toBe(false);
  });
});

/**
 * The real path, end to end, on `fake-indexeddb`: `startAutoDrain()` → the boot drain → IndexedDB →
 * `POST /api/contacts/sync`. Only `setTimeout` is faked, so the boot delay can be skipped while
 * fake-indexeddb keeps its real `setImmediate` scheduling.
 */
describe('the app-wide drain against a real outbox database', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  function stubBrowser(factory: IDBFactory, fetchMock: (...args: unknown[]) => unknown) {
    vi.stubGlobal('indexedDB', factory);
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
    vi.stubGlobal('fetch', fetchMock);
  }

  /** Run fake-indexeddb's queued tasks and the promise chains behind them, until `done` or a cap. */
  async function runTasks(done: () => boolean = () => false, cap = 200) {
    for (let i = 0; i < cap && !done(); i++) await new Promise(resolve => setImmediate(resolve));
  }

  it('uploads a capture queued in an EARLIER page, from a page where only the app-wide hold exists', async () => {
    const factory = new IDBFactory();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ folderMap: {}, folders: [], contacts: [{ clientId: 'c1', ok: true }] }),
    }));
    stubBrowser(factory, fetchMock);

    // At the venue, with no signal: captured, then the app was closed.
    vi.resetModules();
    const venue = await import('@/lib/scan/outbox');
    venue.setOutboxOwner('u1');
    await venue.queueContact({ clientId: 'c1', name: 'Asha', folderId: '64b000000000000000000001' });

    // Later, a fresh page — the feed — where nothing but <OutboxOwner />'s hold is taken.
    vi.resetModules();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const feed = await import('@/lib/scan/outbox');
    feed.setOutboxOwner('u1');
    const release = feed.startAutoDrain();
    vi.advanceTimersByTime(1_200);
    await runTasks(() => fetchMock.mock.calls.length > 0);

    expect(fetchMock).toHaveBeenCalledWith('/api/contacts/sync', expect.objectContaining({ method: 'POST' }));
    vi.useRealTimers();
    await runTasks();
    expect(await feed.pendingContacts()).toEqual([]);
    release();
  });

  it('does not CREATE the outbox on a device that never queued anything', async () => {
    const factory = new IDBFactory();
    const fetchMock = vi.fn();
    stubBrowser(factory, fetchMock);

    vi.resetModules();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const outbox = await import('@/lib/scan/outbox');
    outbox.setOutboxOwner('u1');
    const release = outbox.startAutoDrain();
    vi.advanceTimersByTime(1_200); // the boot drain
    window.dispatchEvent(new Event('online')); // and a reconnect
    await runTasks();

    expect(fetchMock).not.toHaveBeenCalled();
    // `/cookies` says this store is set when you scan, add a contact or create a folder — not on sign-in.
    expect((await factory.databases()).map(info => info.name)).not.toContain('pulseblr-outbox');
    release();
  });
});
