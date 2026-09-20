import { describe, expect, it } from 'vitest';
import * as accountDeletion from '../lib/account-deletion';
import {
  ACCOUNT_DELETION_CONFIRMATION,
  deleteAccountData,
  hasExactCanonicalOrigin,
  parseAccountDeletionConfirmation,
  type AccountDeletionStore,
  type AccountDeletionTransaction,
} from '../lib/account-deletion';

type Row = { id: string; userId?: string; createdByUserId?: string };
type AuditTargetType = 'event' | 'source' | 'submission' | 'system';
type AuditRow = {
  id: string;
  targetType: AuditTargetType;
  targetId?: string;
  targetIds?: string[];
  actorId: string;
  actorEmail: string;
  undoneBy?: string;
};
type EventAuditSnapshotFilter = {
  targetType: AuditTargetType | { $in: AuditTargetType[] };
  $or: Array<
    | { targetId: { $in: string[] } }
    | { targetIds: { $in: string[] } }
  >;
};
type State = {
  owned: Record<string, Row[]>;
  events: Row[];
  audits: AuditRow[];
  users: Array<{ googleId: string }>;
};

function matchingAuditIds(rows: AuditRow[], filter: EventAuditSnapshotFilter): string[] {
  const allowedTypes = typeof filter.targetType === 'string'
    ? [filter.targetType]
    : filter.targetType.$in;

  return rows.filter(row => {
    if (!allowedTypes.includes(row.targetType)) return false;
    return filter.$or.some(clause => {
      if ('targetId' in clause) {
        return row.targetId !== undefined && clause.targetId.$in.includes(row.targetId);
      }
      return (row.targetIds ?? []).some(id => clause.targetIds.$in.includes(id));
    });
  }).map(row => row.id);
}

function memoryStore(initial: State, failOn?: string) {
  let state = structuredClone(initial);
  const store: AccountDeletionStore = {
    async runInTransaction(work) {
      const before = structuredClone(state);
      const tx: AccountDeletionTransaction = {
        async findOwnedEventIds(userId) {
          return state.events.filter(row => row.createdByUserId === userId).map(row => row.id);
        },
        async deleteOwned(kind, userId) {
          if (failOn === kind) throw new Error('injected failure');
          const rows = state.owned[kind];
          const kept = rows.filter(row => row.userId !== userId);
          const count = rows.length - kept.length;
          state.owned[kind] = kept;
          return count;
        },
        async deleteOwnedEvents(userId) {
          const kept = state.events.filter(row => row.createdByUserId !== userId);
          const count = state.events.length - kept.length;
          state.events = kept;
          return count;
        },
        async deleteEventAuditSnapshots(eventIds) {
          const ids = new Set(eventIds);
          const kept = state.audits.filter(row => {
            const referencesOwnedEvent = [row.targetId, ...(row.targetIds ?? [])]
              .some(id => id !== undefined && ids.has(id));
            return !(['event', 'submission'].includes(row.targetType) && referencesOwnedEvent);
          });
          const count = state.audits.length - kept.length;
          state.audits = kept;
          return count;
        },
        async redactActorAuditRows(userId) {
          let count = 0;
          state.audits = state.audits.map(row => {
            if (row.actorId !== userId && row.undoneBy !== userId) return row;
            count += 1;
            return {
              ...row,
              ...(row.actorId === userId
                ? { actorId: 'deleted-account', actorEmail: 'deleted-account@redacted.invalid' }
                : {}),
              ...(row.undoneBy === userId ? { undoneBy: 'deleted-account' } : {}),
            };
          });
          return count;
        },
        async deleteUser(userId) {
          const kept = state.users.filter(row => row.googleId !== userId);
          const count = state.users.length - kept.length;
          state.users = kept;
          return count;
        },
      };
      try {
        return await work(tx);
      } catch (error) {
        state = before;
        throw error;
      }
    },
  };
  return { store, snapshot: () => structuredClone(state) };
}

describe('account deletion validation', () => {
  it.each([undefined, null, {}, { confirmation: 'delete' }, { confirmation: ' DELETE ' }])(
    'rejects any body other than the exact destructive confirmation: %j',
    body => expect(parseAccountDeletionConfirmation(body).ok).toBe(false),
  );

  it('accepts only the exact destructive confirmation and exact canonical origin', () => {
    expect(parseAccountDeletionConfirmation({ confirmation: ACCOUNT_DELETION_CONFIRMATION })).toEqual({ ok: true });
    expect(hasExactCanonicalOrigin('https://pulseblr-u9f1.vercel.app', 'https://pulseblr-u9f1.vercel.app')).toBe(true);
    expect(hasExactCanonicalOrigin(null, 'https://pulseblr-u9f1.vercel.app')).toBe(false);
    expect(hasExactCanonicalOrigin('https://evil.example', 'https://pulseblr-u9f1.vercel.app')).toBe(false);
  });
});

describe('deleteAccountData', () => {
  const kinds = [
    'trackerEntries', 'folders', 'contacts', 'people', 'interactions',
    'mcpTokens', 'pushSubscriptions', 'reminderLogs', 'digestLogs',
  ] as const;

  function fixture(): State {
    return {
      owned: Object.fromEntries(kinds.map(kind => [kind, [
        { id: `${kind}-a`, userId: 'user-a' },
        { id: `${kind}-b`, userId: 'user-b' },
      ]])),
      events: [
        { id: 'event-a-public', createdByUserId: 'user-a' },
        { id: 'event-a-private', createdByUserId: 'user-a' },
        { id: 'event-b', createdByUserId: 'user-b' },
      ],
      audits: [
        { id: 'audit-owned-event', targetType: 'event', targetId: 'event-a-public', actorId: 'admin', actorEmail: 'admin@example.com' },
        { id: 'audit-owned-submission', targetType: 'submission', targetId: 'event-a-private', actorId: 'admin', actorEmail: 'admin@example.com' },
        { id: 'audit-unrelated-source-same-id', targetType: 'source', targetId: 'event-a-public', actorId: 'admin', actorEmail: 'admin@example.com' },
        { id: 'audit-unrelated-by-a', targetType: 'event', targetId: 'event-b', actorId: 'user-a', actorEmail: 'a@example.com', undoneBy: 'user-a' },
        { id: 'audit-undone-by-a', targetType: 'event', targetId: 'event-b', actorId: 'admin', actorEmail: 'admin@example.com', undoneBy: 'user-a' },
        { id: 'audit-unrelated', targetType: 'submission', targetId: 'event-b', actorId: 'admin', actorEmail: 'admin@example.com' },
      ],
      users: [{ googleId: 'user-a' }, { googleId: 'user-b' }],
    };
  }

  it('atomically removes every user-a row while preserving every user-b row', async () => {
    const memory = memoryStore(fixture());
    const counts = await deleteAccountData('user-a', memory.store);
    const state = memory.snapshot();

    expect(counts).toMatchObject({ events: 2, eventAuditSnapshots: 2, actorAuditRowsRedacted: 2, users: 1 });
    for (const rows of Object.values(state.owned)) expect(rows).toEqual([{ id: expect.any(String), userId: 'user-b' }]);
    expect(state.events).toEqual([{ id: 'event-b', createdByUserId: 'user-b' }]);
    expect(state.users).toEqual([{ googleId: 'user-b' }]);
    expect(state.audits).toEqual([
      { id: 'audit-unrelated-source-same-id', targetType: 'source', targetId: 'event-a-public', actorId: 'admin', actorEmail: 'admin@example.com' },
      { id: 'audit-unrelated-by-a', targetType: 'event', targetId: 'event-b', actorId: 'deleted-account', actorEmail: 'deleted-account@redacted.invalid', undoneBy: 'deleted-account' },
      { id: 'audit-undone-by-a', targetType: 'event', targetId: 'event-b', actorId: 'admin', actorEmail: 'admin@example.com', undoneBy: 'deleted-account' },
      { id: 'audit-unrelated', targetType: 'submission', targetId: 'event-b', actorId: 'admin', actorEmail: 'admin@example.com' },
    ]);
  });

  it('selects event and submission snapshots for owned event IDs without selecting unrelated audit rows', () => {
    const buildFilter = (accountDeletion as unknown as {
      ownedEventAuditSnapshotFilter?: (eventIds: string[]) => EventAuditSnapshotFilter;
    }).ownedEventAuditSnapshotFilter;

    expect(buildFilter).toBeTypeOf('function');
    if (!buildFilter) return;

    const rows: AuditRow[] = [
      { id: 'event-scalar', targetType: 'event', targetId: 'event-a', actorId: 'admin', actorEmail: 'admin@example.com' },
      { id: 'submission-scalar', targetType: 'submission', targetId: 'event-a', actorId: 'admin', actorEmail: 'admin@example.com' },
      { id: 'submission-array', targetType: 'submission', targetIds: ['event-a'], actorId: 'admin', actorEmail: 'admin@example.com' },
      { id: 'source-same-id', targetType: 'source', targetId: 'event-a', actorId: 'admin', actorEmail: 'admin@example.com' },
      { id: 'other-event', targetType: 'event', targetId: 'event-b', actorId: 'admin', actorEmail: 'admin@example.com' },
    ];

    expect(matchingAuditIds(rows, buildFilter(['event-a']))).toEqual([
      'event-scalar',
      'submission-scalar',
      'submission-array',
    ]);
  });

  it('is idempotent', async () => {
    const memory = memoryStore(fixture());
    await deleteAccountData('user-a', memory.store);
    const second = await deleteAccountData('user-a', memory.store);
    expect(Object.values(second).every(count => count === 0)).toBe(true);
  });

  it('rolls back all state when any collection deletion fails', async () => {
    const initial = fixture();
    const memory = memoryStore(initial, 'contacts');
    await expect(deleteAccountData('user-a', memory.store)).rejects.toThrow('injected failure');
    expect(memory.snapshot()).toEqual(initial);
  });
});
