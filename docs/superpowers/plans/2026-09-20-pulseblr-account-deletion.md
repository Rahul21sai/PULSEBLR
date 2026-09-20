# PulseBLR Account Deletion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Play-compliant, transaction-safe PulseBLR account deletion with a public deletion page, complete server cascade, owner-scoped browser cleanup, and truthful policy links.

**Architecture:** A server-only deletion service owns the complete MongoDB cascade behind a small transaction-store interface, while a Next.js Route Handler owns authentication, same-origin validation, and response shaping. A separate client orchestrator makes the destructive server call first and only then purges the deleting owner's IndexedDB rows, push state, caches, and Auth.js session. Public policy pages render a required production support contact and link the self-service flow.

**Tech Stack:** Next.js 16.3.4 App Router, React 19.2.4, Auth.js 5 beta, Mongoose 9.7.2/MongoDB transactions, Vitest 4.1.11, fake-indexeddb 6.2.5, TypeScript 5.

**Spec:** `docs/superpowers/specs/2026-09-20-pulseblr-mobile-production-design.md`

## Global Constraints

- Work only in the existing `codex/mobile-twa` worktree; preserve all pre-existing changes.
- Permanent origin is exactly `https://pulseblr-u9f1.vercel.app` through `NEXTAUTH_URL`.
- Authenticate the deletion route with `requireUser()` before reading the request body; never call `ensureUser()`.
- Require exact same-origin `Origin` and exact confirmation value `DELETE`.
- Use one MongoDB transaction for every server-side deletion; never fall back to sequential partial deletion.
- Hard-delete every event whose `createdByUserId` equals the authenticated Google subject.
- Delete audit snapshots for those events; redact the departing actor from unrelated surviving audit rows.
- Delete the `User` document last.
- Purge only IndexedDB rows whose `queuedFor` exactly equals the deleting user ID; retain legacy unowned and other-user rows.
- Never perform browser cleanup before the server confirms deletion.
- Keep Auth.js JWT semantics unchanged; a later Google sign-in is re-registration.
- Public support email comes from required production variable `PULSEBLR_SUPPORT_EMAIL`; never invent or commit a personal address.
- Follow strict red-green-refactor. Every production behavior must first be observed failing for the intended reason.
- Tests assert observable state/results, not source-text presence or mocked-component existence.
- Do not add a password prompt: PulseBLR uses Google OAuth and owns no password.

## File Structure

- Create `lib/account-deletion.ts`: confirmation/origin validation, transaction interfaces, Mongoose transaction adapter, complete cascade.
- Create `app/api/me/account/route.ts`: authenticated destructive endpoint and safe HTTP responses.
- Create `tests/account-deletion.test.ts`: real orchestration behavior against an in-memory transactional store.
- Create `tests/account-deletion-route.test.ts`: real Route Handler behavior with auth/deletion boundaries substituted.
- Modify `lib/scan/outbox.ts`: owner-scoped IndexedDB purge.
- Create `lib/account-deletion-client.ts`: post-commit browser-cleanup sequencing.
- Create `tests/account-deletion-client.test.ts`: real IndexedDB mutation and sequencing tests.
- Create `app/settings/AccountDeletionSection.tsx`: typed-confirmation danger zone.
- Modify `app/settings/page.tsx`: render the danger zone and deletion-policy link.
- Create `lib/public-support.ts`: validate and expose the public support address server-side.
- Create `app/delete-account/page.tsx`: public Play account-deletion URL.
- Modify `app/privacy/page.tsx`: correct provider/deletion/contact disclosures.
- Modify `app/login/page.tsx`: link privacy and deletion policy before sign-in.
- Create `tests/delete-account-policy.test.ts`: rendered public copy and link contracts.
- Modify `tests/privacy-policy.test.ts`: require named AI provider, developer contact, and self-service deletion.
- Modify `scripts/diag-deploy-readiness.ts`: require a valid `PULSEBLR_SUPPORT_EMAIL` for production.
- Modify `.github/workflows/ci.yml`: supply a non-routable CI-only support email during build.
- Modify `package.json` and `package-lock.json`: pin `fake-indexeddb` 6.2.5 as a test-only dependency.

---

### Task 1: Transactional Server Deletion Service

**Files:**
- Create: `tests/account-deletion.test.ts`
- Create: `lib/account-deletion.ts`

**Interfaces:**
- Produces: `ACCOUNT_DELETION_CONFIRMATION: 'DELETE'`
- Produces: `parseAccountDeletionConfirmation(body: unknown): { ok: true } | { ok: false; error: string }`
- Produces: `hasExactCanonicalOrigin(origin: string | null, expectedOrigin?: string): boolean`
- Produces: `AccountDeletionCounts`
- Produces: `AccountDeletionTransaction`, `AccountDeletionStore`
- Produces: `deleteAccountData(userId: string, store?: AccountDeletionStore): Promise<AccountDeletionCounts>`
- Produces: `AccountDeletionUnavailableError`
- Consumes later: Task 2 Route Handler calls these exports unchanged.

- [ ] **Step 1: Write failing service tests using a stateful in-memory transaction store**

Create fixtures for two users and every owned data category. The fake transaction must clone its state before the callback and restore it when an injected operation throws, so rollback is behavior rather than a mock assertion.

```ts
import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_DELETION_CONFIRMATION,
  deleteAccountData,
  hasExactCanonicalOrigin,
  parseAccountDeletionConfirmation,
  type AccountDeletionStore,
  type AccountDeletionTransaction,
} from '../lib/account-deletion';

type Row = { id: string; userId?: string; createdByUserId?: string };
type State = {
  owned: Record<string, Row[]>;
  events: Row[];
  audits: Array<{ id: string; targetIds: string[]; actorId: string; actorEmail: string; undoneBy?: string }>;
  users: Array<{ googleId: string }>;
};

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
          const kept = state.audits.filter(row => !row.targetIds.some(id => ids.has(id)));
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
        { id: 'audit-owned-event', targetIds: ['event-a-public'], actorId: 'admin', actorEmail: 'admin@example.com' },
        { id: 'audit-unrelated-by-a', targetIds: ['event-b'], actorId: 'user-a', actorEmail: 'a@example.com', undoneBy: 'user-a' },
        { id: 'audit-undone-by-a', targetIds: ['event-b'], actorId: 'admin', actorEmail: 'admin@example.com', undoneBy: 'user-a' },
        { id: 'audit-unrelated', targetIds: ['event-b'], actorId: 'admin', actorEmail: 'admin@example.com' },
      ],
      users: [{ googleId: 'user-a' }, { googleId: 'user-b' }],
    };
  }

  it('atomically removes every user-a row while preserving every user-b row', async () => {
    const memory = memoryStore(fixture());
    const counts = await deleteAccountData('user-a', memory.store);
    const state = memory.snapshot();

    expect(counts).toMatchObject({ events: 2, eventAuditSnapshots: 1, actorAuditRowsRedacted: 2, users: 1 });
    for (const rows of Object.values(state.owned)) expect(rows).toEqual([{ id: expect.any(String), userId: 'user-b' }]);
    expect(state.events).toEqual([{ id: 'event-b', createdByUserId: 'user-b' }]);
    expect(state.users).toEqual([{ googleId: 'user-b' }]);
    expect(state.audits).toEqual([
      { id: 'audit-unrelated-by-a', targetIds: ['event-b'], actorId: 'deleted-account', actorEmail: 'deleted-account@redacted.invalid', undoneBy: 'deleted-account' },
      { id: 'audit-undone-by-a', targetIds: ['event-b'], actorId: 'admin', actorEmail: 'admin@example.com', undoneBy: 'deleted-account' },
      { id: 'audit-unrelated', targetIds: ['event-b'], actorId: 'admin', actorEmail: 'admin@example.com' },
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
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- tests/account-deletion.test.ts`

Expected: FAIL because `lib/account-deletion.ts` does not exist. The failure must name the missing module, not a malformed fixture.

- [ ] **Step 3: Implement validators, orchestration, and the Mongoose transaction adapter**

Use this exact public shape and explicit deletion order:

```ts
import type { ClientSession } from 'mongoose';
import connectDB from './mongodb';
import { canonicalOrigin } from './canonical-origin';
import AuditLog from './models/AuditLog';
import Contact from './models/Contact';
import DigestLog from './models/DigestLog';
import Event from './models/Event';
import Folder from './models/Folder';
import Interaction from './models/Interaction';
import McpToken from './models/McpToken';
import Person from './models/Person';
import PushSubscription from './models/PushSubscription';
import ReminderLog from './models/ReminderLog';
import TrackerEntry from './models/TrackerEntry';
import User from './models/User';

export const ACCOUNT_DELETION_CONFIRMATION = 'DELETE' as const;
export const DELETED_ACTOR_ID = 'deleted-account';
export const DELETED_ACTOR_EMAIL = 'deleted-account@redacted.invalid';

export type OwnedDeletionKind =
  | 'trackerEntries' | 'folders' | 'contacts' | 'people' | 'interactions'
  | 'mcpTokens' | 'pushSubscriptions' | 'reminderLogs' | 'digestLogs';

export type AccountDeletionCounts = Record<OwnedDeletionKind, number> & {
  events: number;
  eventAuditSnapshots: number;
  actorAuditRowsRedacted: number;
  users: number;
};

export interface AccountDeletionTransaction {
  findOwnedEventIds(userId: string): Promise<string[]>;
  deleteOwned(kind: OwnedDeletionKind, userId: string): Promise<number>;
  deleteOwnedEvents(userId: string): Promise<number>;
  deleteEventAuditSnapshots(eventIds: string[]): Promise<number>;
  redactActorAuditRows(userId: string): Promise<number>;
  deleteUser(userId: string): Promise<number>;
}

export interface AccountDeletionStore {
  runInTransaction<T>(work: (tx: AccountDeletionTransaction) => Promise<T>): Promise<T>;
}

export class AccountDeletionUnavailableError extends Error {
  constructor(cause: unknown) {
    super('Account deletion is temporarily unavailable', { cause });
    this.name = 'AccountDeletionUnavailableError';
  }
}

export function parseAccountDeletionConfirmation(body: unknown) {
  return typeof body === 'object' && body !== null &&
    (body as { confirmation?: unknown }).confirmation === ACCOUNT_DELETION_CONFIRMATION
    ? ({ ok: true } as const)
    : ({ ok: false, error: `Type ${ACCOUNT_DELETION_CONFIRMATION} to confirm account deletion.` } as const);
}

export function hasExactCanonicalOrigin(origin: string | null, expectedOrigin = canonicalOrigin()) {
  return origin === expectedOrigin;
}

const ownedKinds: OwnedDeletionKind[] = [
  'trackerEntries', 'folders', 'contacts', 'people', 'interactions',
  'mcpTokens', 'pushSubscriptions', 'reminderLogs', 'digestLogs',
];

export async function deleteAccountData(userId: string, store: AccountDeletionStore = mongooseDeletionStore()) {
  return store.runInTransaction(async tx => {
    const eventIds = await tx.findOwnedEventIds(userId);
    const counts = Object.fromEntries(ownedKinds.map(kind => [kind, 0])) as AccountDeletionCounts;
    counts.eventAuditSnapshots = await tx.deleteEventAuditSnapshots(eventIds);
    counts.actorAuditRowsRedacted = await tx.redactActorAuditRows(userId);
    for (const kind of ownedKinds) counts[kind] = await tx.deleteOwned(kind, userId);
    counts.events = await tx.deleteOwnedEvents(userId);
    counts.users = await tx.deleteUser(userId);
    return counts;
  });
}
```

The private `mongooseDeletionStore()` must map the nine kinds to the nine model objects, pass the same `ClientSession` to every query, delete audit event rows before actor redaction, and wrap any start/transaction failure in `AccountDeletionUnavailableError`. It must use:

```ts
const db = await connectDB();
const session = await db.startSession();
try {
  let value: T | undefined;
  await session.withTransaction(async () => {
    value = await work(mongooseTransaction(session));
  });
  if (value === undefined) throw new Error('Deletion transaction produced no result');
  return value;
} catch (error) {
  throw new AccountDeletionUnavailableError(error);
} finally {
  await session.endSession();
}
```

Use `String(row._id)` for event IDs. Delete event audit rows with `targetType: 'event'` and either `targetId` or `targetIds` in those string IDs. Redact both `actorId/actorEmail` and matching `undoneBy` where present; do not delete unrelated audit rows.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npm test -- tests/account-deletion.test.ts`

Expected: all validation, isolation, idempotency, and rollback tests PASS.

- [ ] **Step 5: Run typecheck and commit**

Run: `npx tsc --noEmit`

Expected: exit 0.

Commit:

```powershell
git add -- lib/account-deletion.ts tests/account-deletion.test.ts
git commit -m "feat: delete account data atomically"
```

---

### Task 2: Authenticated Same-Origin Deletion Route

**Files:**
- Create: `tests/account-deletion-route.test.ts`
- Create: `app/api/me/account/route.ts`

**Interfaces:**
- Consumes: `requireUser()` from `lib/api-auth.ts`.
- Consumes: validators, error class, and `deleteAccountData()` from Task 1.
- Produces: `createDeleteAccountHandler(deps)` for real handler behavior with substitutable auth/service boundaries.
- Produces: `DELETE(request: NextRequest): Promise<NextResponse>`.

- [ ] **Step 1: Write failing Route Handler behavior tests**

Test the real handler factory, not Next.js itself and not mock call existence:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { describe, expect, it } from 'vitest';
import { createDeleteAccountHandler } from '../app/api/me/account/route';

const request = (origin: string | null, body: string) => new NextRequest(
  'https://pulseblr-u9f1.vercel.app/api/me/account',
  {
    method: 'DELETE',
    headers: {
      'content-type': 'application/json',
      ...(origin ? { origin } : {}),
    },
    body,
  },
);

describe('DELETE /api/me/account', () => {
  it('returns the auth response before parsing an invalid body', async () => {
    const handler = createDeleteAccountHandler({
      requireUser: async () => ({ response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }),
      deleteAccountData: async () => { throw new Error('must not run'); },
      expectedOrigin: () => 'https://pulseblr-u9f1.vercel.app',
    });
    const response = await handler(request('https://pulseblr-u9f1.vercel.app', '{'));
    expect(response.status).toBe(401);
  });

  it.each([null, 'https://evil.example'])('rejects non-canonical origin %s', async origin => {
    const handler = createDeleteAccountHandler({
      requireUser: async () => ({ userId: 'user-a' }),
      deleteAccountData: async () => { throw new Error('must not run'); },
      expectedOrigin: () => 'https://pulseblr-u9f1.vercel.app',
    });
    const response = await handler(request(origin, '{"confirmation":"DELETE"}'));
    expect(response.status).toBe(403);
  });

  it.each(['{', '{}', '{"confirmation":"delete"}'])('rejects malformed confirmation %s', async body => {
    const handler = createDeleteAccountHandler({
      requireUser: async () => ({ userId: 'user-a' }),
      deleteAccountData: async () => ({ events: 0 } as never),
      expectedOrigin: () => 'https://pulseblr-u9f1.vercel.app',
    });
    const response = await handler(request('https://pulseblr-u9f1.vercel.app', body));
    expect(response.status).toBe(400);
  });

  it('returns only deletion counts and disables caching after commit', async () => {
    const counts = {
      trackerEntries: 1, folders: 1, contacts: 1, people: 1, interactions: 1,
      mcpTokens: 1, pushSubscriptions: 1, reminderLogs: 1, digestLogs: 1,
      events: 2, eventAuditSnapshots: 1, actorAuditRowsRedacted: 1, users: 1,
    };
    const handler = createDeleteAccountHandler({
      requireUser: async () => ({ userId: 'user-a' }),
      deleteAccountData: async userId => userId === 'user-a' ? counts : Promise.reject(new Error('wrong owner')),
      expectedOrigin: () => 'https://pulseblr-u9f1.vercel.app',
    });
    const response = await handler(request('https://pulseblr-u9f1.vercel.app', '{"confirmation":"DELETE"}'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ deleted: true, counts });
  });

  it('returns a generic unavailable response without leaking database details', async () => {
    const handler = createDeleteAccountHandler({
      requireUser: async () => ({ userId: 'user-a' }),
      deleteAccountData: async () => { throw new Error('mongodb://user:password@secret-host'); },
      expectedOrigin: () => 'https://pulseblr-u9f1.vercel.app',
    });
    const response = await handler(request('https://pulseblr-u9f1.vercel.app', '{"confirmation":"DELETE"}'));
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain('secret-host');
  });
});
```

- [ ] **Step 2: Run the focused route test and verify RED**

Run: `npm test -- tests/account-deletion-route.test.ts`

Expected: FAIL because `app/api/me/account/route.ts` does not exist.

- [ ] **Step 3: Implement the factory and real DELETE export**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/api-auth';
import { canonicalOrigin } from '@/lib/canonical-origin';
import {
  deleteAccountData,
  hasExactCanonicalOrigin,
  parseAccountDeletionConfirmation,
  type AccountDeletionCounts,
} from '@/lib/account-deletion';

type Dependencies = {
  requireUser: typeof requireUser;
  deleteAccountData: (userId: string) => Promise<AccountDeletionCounts>;
  expectedOrigin: () => string;
};

export function createDeleteAccountHandler(deps: Dependencies) {
  return async function DELETE(request: NextRequest): Promise<NextResponse> {
    const gate = await deps.requireUser();
    if ('response' in gate) return gate.response;

    if (!hasExactCanonicalOrigin(request.headers.get('origin'), deps.expectedOrigin())) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await request.json().catch(() => null);
    const confirmation = parseAccountDeletionConfirmation(body);
    if (!confirmation.ok) {
      return NextResponse.json({ error: confirmation.error }, { status: 400 });
    }

    try {
      const counts = await deps.deleteAccountData(gate.userId);
      return NextResponse.json(
        { deleted: true, counts },
        { status: 200, headers: { 'Cache-Control': 'no-store' } },
      );
    } catch (error) {
      console.error('Account deletion transaction failed', error instanceof Error ? error.name : 'unknown');
      return NextResponse.json(
        { error: 'Account deletion is temporarily unavailable. Nothing was deleted.' },
        { status: 503, headers: { 'Cache-Control': 'no-store' } },
      );
    }
  };
}

export const DELETE = createDeleteAccountHandler({ requireUser, deleteAccountData, expectedOrigin: canonicalOrigin });
```

- [ ] **Step 4: Verify route and service tests GREEN**

Run: `npm test -- tests/account-deletion.test.ts tests/account-deletion-route.test.ts`

Expected: both files PASS.

- [ ] **Step 5: Commit**

```powershell
git add -- app/api/me/account/route.ts tests/account-deletion-route.test.ts
git commit -m "feat: expose protected account deletion route"
```

---

### Task 3: Owner-Scoped IndexedDB and Post-Commit Client Cleanup

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `lib/scan/outbox.ts`
- Create: `lib/account-deletion-client.ts`
- Create: `tests/account-deletion-client.test.ts`

**Interfaces:**
- Produces: `purgeOutboxForOwner(userId: string): Promise<{ contacts: number; folders: number }>`.
- Produces: `runAccountDeletion(userId: string, deps: AccountDeletionClientDependencies): Promise<void>`.
- Consumes later: Task 4 danger-zone component supplies browser implementations and calls `runAccountDeletion`.

- [ ] **Step 1: Pin the browser-faithful IndexedDB test implementation**

Run: `npm install --save-dev --save-exact fake-indexeddb@6.2.5`

Expected: `package.json` and lockfile contain exact version `6.2.5`. This is a third-party test-only package; it must never enter production dependencies or browser bundles.

- [ ] **Step 2: Write failing real IndexedDB and orchestration tests**

```ts
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
    outbox.setOutboxOwner(null);
    await outbox.queueContact({ clientId: 'contact-legacy', name: 'Legacy' });

    await expect(outbox.purgeOutboxForOwner('user-a')).resolves.toEqual({ contacts: 1, folders: 1 });
    expect((await outbox.pendingContacts()).map(row => row.clientId).sort()).toEqual(['contact-b', 'contact-legacy']);
    expect(await outbox.pendingFolders()).toEqual([]);
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
});
```

If `ContactInput.name` is not sufficient for a valid compile-time fixture, supply its actual required fields from `lib/scan/types.ts`; do not weaken the production type or cast the fixture to `any`.

- [ ] **Step 3: Run the focused test and verify RED**

Run: `npm test -- tests/account-deletion-client.test.ts`

Expected: FAIL because `purgeOutboxForOwner` and `lib/account-deletion-client.ts` do not exist.

- [ ] **Step 4: Implement owner-scoped cursor deletion**

Add a private helper that opens a read-write cursor and deletes only exact owner matches. Resolve on transaction completion, reject on request or transaction error, and count successful cursor deletions. Do not use `indexedDB.deleteDatabase()`.

```ts
async function purgeStoreForOwner(storeName: string, userId: string): Promise<number> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName);
    const request = store.openCursor();
    let deleted = 0;
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const record = cursor.value as QueueFailureState;
      if (record.queuedFor === userId) {
        cursor.delete();
        deleted += 1;
      }
      cursor.continue();
    };
    request.onerror = () => reject(request.error ?? new Error('Outbox purge failed'));
    transaction.oncomplete = () => resolve(deleted);
    transaction.onerror = () => reject(transaction.error ?? new Error('Outbox purge failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Outbox purge aborted'));
  });
}

export async function purgeOutboxForOwner(userId: string) {
  if (!userId) throw new Error('A user id is required to purge the outbox');
  const contacts = await purgeStoreForOwner(CONTACTS, userId);
  const folders = await purgeStoreForOwner(FOLDERS, userId);
  notify();
  return { contacts, folders };
}
```

- [ ] **Step 5: Implement server-first client orchestration**

```ts
export interface AccountDeletionClientDependencies {
  requestDeletion(): Promise<{ ok: boolean; error?: string }>;
  purgeOutbox(userId: string): Promise<unknown>;
  unsubscribePush(): Promise<unknown>;
  purgeCaches(): Promise<unknown>;
  signOut(callbackUrl: string): Promise<unknown>;
}

export async function runAccountDeletion(userId: string, deps: AccountDeletionClientDependencies) {
  const response = await deps.requestDeletion();
  if (!response.ok) throw new Error(response.error || 'Account deletion failed');
  await deps.purgeOutbox(userId);
  await deps.unsubscribePush().catch(() => undefined);
  await deps.purgeCaches().catch(() => undefined);
  await deps.signOut('/delete-account?complete=1');
}
```

Do not catch `purgeOutbox`: retaining the deleting owner's local PII must surface as an error. The UI in Task 4 must offer retry/clear-site-data guidance when that happens; the server account is already gone, so it must also retain a visible path to sign out.

- [ ] **Step 6: Verify tests and typecheck GREEN**

Run:

```powershell
npm test -- tests/account-deletion-client.test.ts
npx tsc --noEmit
```

Expected: both exit 0.

- [ ] **Step 7: Commit**

```powershell
git add -- package.json package-lock.json lib/scan/outbox.ts lib/account-deletion-client.ts tests/account-deletion-client.test.ts
git commit -m "feat: purge deleted account data from the device"
```

---

### Task 4: Settings Danger Zone and Public Policy Surfaces

**Files:**
- Create: `app/settings/AccountDeletionSection.tsx`
- Modify: `app/settings/page.tsx`
- Create: `lib/public-support.ts`
- Create: `app/delete-account/page.tsx`
- Modify: `app/privacy/page.tsx`
- Modify: `app/login/page.tsx`
- Create: `tests/delete-account-policy.test.ts`
- Modify: `tests/privacy-policy.test.ts`
- Modify: `scripts/diag-deploy-readiness.ts`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `runAccountDeletion()` and `purgeOutboxForOwner()` from Task 3.
- Produces: public `/delete-account` route and authenticated `AccountDeletionSection`.
- Produces: `publicSupportEmail(env?: NodeJS.ProcessEnv): string`.
- Produces: deploy-readiness failure when production support email is absent or syntactically invalid.

- [ ] **Step 1: Write failing rendered policy and support-contact tests**

```ts
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import DeleteAccountPage from '../app/delete-account/page';
import { publicSupportEmail } from '../lib/public-support';

afterEach(() => delete process.env.PULSEBLR_SUPPORT_EMAIL);

describe('public account-deletion policy', () => {
  it('publishes the signed-out deletion path, deleted categories, retention boundary, and contact', async () => {
    process.env.PULSEBLR_SUPPORT_EMAIL = 'support@example.test';
    const node = await DeleteAccountPage({ searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(node);
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    expect(html).toContain('href="/login');
    expect(html).toContain('href="/settings');
    expect(text).toMatch(/contacts|people/i);
    expect(text).toMatch(/saved|tracked events/i);
    expect(text).toMatch(/private notes/i);
    expect(text).toMatch(/calendar|email copies/i);
    expect(html).toContain('mailto:support@example.test');
  });

  it('shows a completion acknowledgement without claiming external copies were recalled', async () => {
    process.env.PULSEBLR_SUPPORT_EMAIL = 'support@example.test';
    const node = await DeleteAccountPage({ searchParams: Promise.resolve({ complete: '1' }) });
    expect(renderToStaticMarkup(node)).toMatch(/account.*deleted/i);
  });
});

describe('publicSupportEmail', () => {
  it('normalizes a configured public address', () => {
    expect(publicSupportEmail({ PULSEBLR_SUPPORT_EMAIL: ' Support@Example.COM ' })).toBe('support@example.com');
  });

  it.each(['', 'not-an-email', 'name@example'])('rejects invalid production contact %j', value => {
    expect(() => publicSupportEmail({ PULSEBLR_SUPPORT_EMAIL: value })).toThrow(/PULSEBLR_SUPPORT_EMAIL/);
  });
});
```

Extend `tests/privacy-policy.test.ts` with rendered assertions for `href="/delete-account"`, `mailto:`, the named AI provider `NVIDIA NIM`, immediate self-service deletion, and data-retention boundaries. Also render the login page's legal copy through its existing Suspense-compatible entry and require both `/privacy` and `/delete-account` links. Do not grep component source.

Extend `tests/protected-routes.test.ts` with a behavioral assertion that `/delete-account` is not protected and therefore remains reachable while signed out.

- [ ] **Step 2: Run policy tests and verify RED**

Run: `npm test -- tests/privacy-policy.test.ts tests/delete-account-policy.test.ts`

Expected: FAIL because `/delete-account` and `lib/public-support.ts` do not exist and the old privacy copy describes manual deletion.

- [ ] **Step 3: Implement strict public support configuration**

```ts
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function publicSupportEmail(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.PULSEBLR_SUPPORT_EMAIL?.trim().toLowerCase() ?? '';
  if (!EMAIL.test(value)) {
    throw new Error('PULSEBLR_SUPPORT_EMAIL must be a valid public support email address');
  }
  return value;
}
```

Add `PULSEBLR_SUPPORT_EMAIL: ci@example.invalid` to the CI production-build environment. Extend `scripts/diag-deploy-readiness.ts` so production readiness fails when the value is absent or invalid, while never printing the address itself.

- [ ] **Step 4: Implement the public deletion page and truthful privacy links**

`app/delete-account/page.tsx` must be an async Server Component with Next.js 16 promise-based `searchParams`:

```tsx
import type { Metadata } from 'next';
import Link from 'next/link';
import { publicSupportEmail } from '@/lib/public-support';

export const metadata: Metadata = {
  title: 'Delete your PulseBLR account',
  description: 'Delete your PulseBLR account and associated private data.',
};

export default async function DeleteAccountPage({
  searchParams,
}: {
  searchParams: Promise<{ complete?: string }>;
}) {
  const { complete } = await searchParams;
  const supportEmail = publicSupportEmail();
  const completed = complete === '1';
  return (
    <main className="mx-auto min-h-screen max-w-[900px] px-5 py-10 text-[var(--ink)] md:px-8 md:py-16">
      <p className="ty-meta">PulseBLR account controls</p>
      <h1 className="t-display mt-2">{completed ? 'Your account was deleted' : 'Delete your account'}</h1>
      <p className="ty-body mt-4 text-[var(--ink-2)]">
        {completed
          ? 'PulseBLR removed the account and private data stored for it.'
          : 'Sign in, open Settings, and use Delete account. You will type DELETE before anything is removed.'}
      </p>
      <h2 className="ty-section mt-8">What is removed</h2>
      <p className="mt-3 text-[14px] leading-7 text-[var(--ink-2)]">
        Your profile, preferences, saved and tracked events, submitted events, contacts, people,
        private notes, folders, QR/card and calendar tokens, MCP tokens, push subscriptions,
        reminder records, and digest records are permanently deleted.
      </p>
      <h2 className="ty-section mt-8">What PulseBLR cannot recall</h2>
      <p className="mt-3 text-[14px] leading-7 text-[var(--ink-2)]">
        Email already delivered to an inbox and calendar copies already imported by another
        provider are controlled by those providers. Delete those copies there.
      </p>
      <div className="mt-8 flex flex-wrap gap-3">
        {!completed && <Link href="/login?callbackUrl=/settings" className="rounded-full bg-[var(--ink)] px-5 py-3 text-[13px] font-semibold text-[var(--accent-ink)]">Sign in to delete</Link>}
        <Link href="/settings" className="rounded-full border border-[var(--rule)] px-5 py-3 text-[13px] font-semibold">Open Settings</Link>
      </div>
      <p className="mt-10 text-[13px] text-[var(--ink-2)]">
        Cannot sign in? Email <a className="font-semibold text-[var(--accent)]" href={`mailto:${supportEmail}`}>{supportEmail}</a> from the Google account you used for PulseBLR.
      </p>
    </main>
  );
}
```

Update privacy copy to name Google, Vercel, MongoDB Atlas, Resend, browser push providers, calendar providers, and NVIDIA NIM. Replace manual deletion wording with the in-app flow and public `/delete-account` link. Update login and Settings legal areas to link both pages.

- [ ] **Step 5: Implement the Settings danger-zone component**

The component must receive `userId: string`, keep confirmation and error state, disable the action until the value is exactly `DELETE`, and call the real orchestrator:

```tsx
'use client';

import { useState } from 'react';
import { signOut } from 'next-auth/react';
import { runAccountDeletion } from '@/lib/account-deletion-client';
import { purgeOutboxForOwner } from '@/lib/scan/outbox';

export default function AccountDeletionSection({ userId }: { userId: string }) {
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function deleteAccount() {
    if (confirmation !== 'DELETE' || busy) return;
    setBusy(true);
    setError(null);
    try {
      await runAccountDeletion(userId, {
        requestDeletion: async () => {
          const response = await fetch('/api/me/account', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ confirmation }),
            cache: 'no-store',
          });
          const body = await response.json().catch(() => ({})) as { error?: string };
          return { ok: response.ok, error: body.error };
        },
        purgeOutbox: purgeOutboxForOwner,
        unsubscribePush: async () => {
          const registration = await navigator.serviceWorker?.getRegistration();
          const subscription = await registration?.pushManager?.getSubscription();
          await subscription?.unsubscribe();
        },
        purgeCaches: async () => {
          if (typeof caches === 'undefined') return;
          await Promise.all((await caches.keys()).map(name => caches.delete(name)));
        },
        signOut: callbackUrl => signOut({ callbackUrl }),
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Account deletion failed');
      setBusy(false);
    }
  }

  return (
    <section id="delete-account" className="rounded-[var(--r-flat)] border border-red-300 p-5">
      <h2 className="text-[16px] font-bold text-red-700">Delete account</h2>
      <p className="mt-1 text-[13px] leading-relaxed text-[var(--ink-2)]">This permanently removes your private PulseBLR data, saved contacts, events, notes, tokens, and notification records.</p>
      <label htmlFor="delete-confirmation" className="mt-4 block text-[12px] font-semibold">Type DELETE to confirm</label>
      <input id="delete-confirmation" value={confirmation} onChange={event => setConfirmation(event.target.value)} autoComplete="off" className="mt-2 w-full rounded-lg border border-[var(--rule)] bg-[var(--surface)] px-3 py-2" />
      {error && <p role="alert" className="mt-2 text-[12px] text-red-700">{error}</p>}
      <button type="button" disabled={confirmation !== 'DELETE' || busy} onClick={() => void deleteAccount()} className="mt-4 rounded-full bg-red-700 px-5 py-2.5 text-[13px] font-semibold text-white disabled:opacity-40">{busy ? 'Deleting…' : 'Delete account permanently'}</button>
    </section>
  );
}
```

Render it only when `session?.user?.id` exists. If local outbox cleanup fails after server success, show the error and an explicit secondary sign-out action explaining that the account is deleted but the user should clear this site's data; do not issue a second server deletion automatically.

- [ ] **Step 6: Verify focused tests, full regression, lint, and build**

Run:

```powershell
npm test -- tests/account-deletion.test.ts tests/account-deletion-route.test.ts tests/account-deletion-client.test.ts tests/privacy-policy.test.ts tests/delete-account-policy.test.ts tests/protected-routes.test.ts
npm test
npx tsc --noEmit
npm run lint
$env:PULSEBLR_SUPPORT_EMAIL='ci@example.invalid'
$env:NEXTAUTH_URL='http://localhost:3000'
$env:NEXTAUTH_SECRET='ci-build-only-not-a-real-secret'
npm run build
```

Expected: all commands exit 0. Existing lint warnings may remain only if they were present before this task; no new warning is accepted.

- [ ] **Step 7: Commit the policy and UI slice**

```powershell
git add -- app/settings/AccountDeletionSection.tsx app/settings/page.tsx app/delete-account/page.tsx app/privacy/page.tsx app/login/page.tsx lib/public-support.ts tests/delete-account-policy.test.ts tests/privacy-policy.test.ts scripts/diag-deploy-readiness.ts .github/workflows/ci.yml
git commit -m "feat: add self-service account deletion"
```

---

## Plan Completion Gate

Before this plan is complete, prove all four task commits exist, every focused red failure was observed before implementation, the full suite/typecheck/lint/build are green, `/delete-account` remains public, the route is authenticated and same-origin guarded, every second-user fixture survives, and no personal support email or signing secret entered Git history.
