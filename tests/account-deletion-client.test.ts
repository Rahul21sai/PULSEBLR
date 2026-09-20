import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runAccountDeletion } from '../lib/account-deletion-client';

describe('owner-scoped outbox deletion', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('indexedDB', new IDBFactory());
  });

  it('deletes current-owner contacts and folders but preserves another owner and legacy rows', async () => {
    const outbox = await import('../lib/scan/outbox');
    outbox.setOutboxOwner('user-a');
    await outbox.queueContact({ clientId: 'contact-a', name: 'A' });
    await outbox.queueFolder({ clientId: 'folder-a', name: 'A folder', queuedFor: 'user-a' });
    outbox.setOutboxOwner('user-b');
    await outbox.queueContact({ clientId: 'contact-b', name: 'B' });
    await outbox.queueFolder({ clientId: 'folder-b', name: 'B folder' });
    outbox.setOutboxOwner(null);
    await outbox.queueContact({ clientId: 'contact-legacy', name: 'Legacy' });
    await outbox.queueFolder({ clientId: 'folder-legacy', name: 'Legacy folder' });

    await expect(outbox.purgeOutboxForOwner('user-a')).resolves.toEqual({ contacts: 1, folders: 1 });
    expect((await outbox.pendingContacts()).map(row => row.clientId).sort()).toEqual(['contact-b', 'contact-legacy']);
    expect((await outbox.pendingFolders()).map(row => row.clientId).sort()).toEqual(['folder-b', 'folder-legacy']);
  });
});

describe('runAccountDeletion', () => {
  it('runs local cleanup and sign-out only after the server commits', async () => {
    const order: string[] = [];
    await runAccountDeletion('user-a', {
      requestDeletion: async () => { order.push('server'); return { ok: true }; },
      purgeOutbox: async () => { order.push('outbox'); },
      unsubscribePush: async () => { order.push('push'); },
      purgeCaches: async () => { order.push('caches'); },
      signOut: async callbackUrl => { order.push(callbackUrl); },
    });
    expect(order).toEqual(['server', 'outbox', 'push', 'caches', '/delete-account?complete=1']);
  });

  it('leaves local state and session untouched when the server rejects deletion', async () => {
    const local = vi.fn();
    await expect(runAccountDeletion('user-a', {
      requestDeletion: async () => ({ ok: false, error: 'temporarily unavailable' }),
      purgeOutbox: local,
      unsubscribePush: local,
      purgeCaches: local,
      signOut: local,
    })).rejects.toThrow('temporarily unavailable');
    expect(local).not.toHaveBeenCalled();
  });

  it('propagates an outbox-purge failure without signing out', async () => {
    const order: string[] = [];
    await expect(runAccountDeletion('user-a', {
      requestDeletion: async () => { order.push('server'); return { ok: true }; },
      purgeOutbox: async () => { order.push('outbox'); throw new Error('outbox purge failed'); },
      unsubscribePush: async () => { order.push('push'); },
      purgeCaches: async () => { order.push('caches'); },
      signOut: async () => { order.push('sign-out'); },
    })).rejects.toThrow('outbox purge failed');
    expect(order).toEqual(['server', 'outbox']);
  });

  it('signs out after rejected push and cache cleanup', async () => {
    const order: string[] = [];
    await runAccountDeletion('user-a', {
      requestDeletion: async () => { order.push('server'); return { ok: true }; },
      purgeOutbox: async () => { order.push('outbox'); },
      unsubscribePush: async () => { order.push('push'); throw new Error('push cleanup failed'); },
      purgeCaches: async () => { order.push('caches'); throw new Error('cache cleanup failed'); },
      signOut: async callbackUrl => { order.push(callbackUrl); },
    });
    expect(order).toEqual(['server', 'outbox', 'push', 'caches', '/delete-account?complete=1']);
  });
});
