import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIntakeHandler, type IntakeDeps, type IntakeFolder } from '../lib/contacts/intake-handler';
import { INTAKE_KEY_FIELD } from '@/lib/contacts/intake-key';

/**
 * `POST /api/intake/[token]` — THE ROUTE'S WIRING, with every effect injected.
 *
 * `tests/intake-key.test.ts` proves the key helper is right. That was never the bug: the route
 * minted a fresh id per request, so a perfect helper the route did not use would pass every one of
 * those tests while retries kept duplicating people. These drive the handler itself through the
 * fake store below, which keeps `upsertContact()`'s contract — look up `{ userId, clientId }` across
 * ALL of the owner's folders, return a hit without writing — so what is asserted is the route's use
 * of the key: one row per submission, a 200 replay shaped like the first success, no reach into the
 * owner's own rows, and the documented guard order and statuses exactly as before.
 *
 * No database, no server: the same dependency-injection shape as tests/account-deletion-route.test.ts.
 */

const NOW = Date.UTC(2026, 8, 27, 12, 0, 0);
const OWNER = 'google-sub-owner';
/** 22 characters, the length `newIntakeToken()` produces. */
const TOKEN_A = 'tokenAAAAAAAAAAAAAAAAA';
const TOKEN_B = 'tokenBBBBBBBBBBBBBBBBB';

interface Row {
  userId: string;
  folderId: string;
  clientId: string;
  name: string;
}

function harness(overrides: (rows: Row[]) => Partial<IntakeDeps> = () => ({})) {
  const folders = new Map<string, IntakeFolder>([
    [TOKEN_A, { _id: 'folder-a', userId: OWNER, intakeEnabled: true, intakeExpiresAt: new Date(NOW + 3_600_000) }],
    [TOKEN_B, { _id: 'folder-b', userId: OWNER, intakeEnabled: true, intakeExpiresAt: new Date(NOW + 3_600_000) }],
  ]);
  const rows: Row[] = [];
  const calls = { connect: 0, findFolder: 0, upsert: 0 };

  const handler = createIntakeHandler({
    limit: () => ({ ok: true, remaining: 9, retryAfterSeconds: 0 }),
    connect: async () => {
      calls.connect++;
    },
    findFolder: async token => {
      calls.findFolder++;
      return folders.get(token) ?? null;
    },
    upsert: async (ownerId, folderId, input) => {
      calls.upsert++;
      const existing = rows.find(r => r.userId === ownerId && r.clientId === input.clientId);
      // The stored row rides along beyond the declared type, so a route that ever learned to echo a
      // stored field would be caught leaking it by the "reads nothing back" test below.
      if (existing) return Object.assign({ created: false }, { contact: existing });
      const row = { userId: ownerId, folderId: String(folderId), clientId: input.clientId, name: input.name };
      rows.push(row);
      return Object.assign({ created: true }, { contact: row });
    },
    contactExists: async (ownerId, clientId) => rows.some(r => r.userId === ownerId && r.clientId === clientId),
    now: () => NOW,
    ...overrides(rows),
  });

  async function post(token: string, body: unknown) {
    const request = new NextRequest(`https://pulseblr.test/api/intake/${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    const response = await handler(request, { params: Promise.resolve({ token }) });
    return {
      status: response.status,
      headers: response.headers,
      body: (await response.json()) as Record<string, unknown>,
    };
  }

  return { post, rows, folders, calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a retried submission lands once', () => {
  it('writes one row, and answers every replay 200 with the first success’s shape', async () => {
    const { post, rows } = harness();
    const form = { name: 'Asha Rao', company: 'Razorpay', [INTAKE_KEY_FIELD]: randomUUID() };

    const first = await post(TOKEN_A, form);
    const replay = await post(TOKEN_A, form);
    const again = await post(TOKEN_A, form);

    expect(first.status).toBe(201);
    expect(first.body).toEqual({ ok: true, created: true, name: 'Asha Rao' });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ok: true, created: false, name: 'Asha Rao' });
    expect(again.status).toBe(200);
    expect(Object.keys(replay.body).sort()).toEqual(Object.keys(first.body).sort());
    expect(rows).toHaveLength(1);
  });

  it('stores a namespaced id, never the key as sent and never the token', async () => {
    const { post, rows } = harness();
    const key = randomUUID();
    await post(TOKEN_A, { name: 'Asha', [INTAKE_KEY_FIELD]: key });

    expect(rows[0].clientId).not.toBe(key);
    expect(rows[0].clientId).toMatch(/^intake:[0-9a-f]{16}:/);
    expect(rows[0].clientId.endsWith(key)).toBe(true);
    expect(rows[0].clientId).not.toContain(TOKEN_A);
  });

  it('a replay changes nothing and reads nothing back', async () => {
    const { post, rows } = harness();
    const key = randomUUID();
    await post(TOKEN_A, { name: 'Asha', [INTAKE_KEY_FIELD]: key });
    rows[0].name = 'Asha (owner note: met at the Razorpay booth)'; // the owner's private correction

    const replay = await post(TOKEN_A, { name: 'Asha R.', [INTAKE_KEY_FIELD]: key });

    expect(replay.body).toEqual({ ok: true, created: false, name: 'Asha R.' });
    expect(JSON.stringify(replay.body)).not.toContain('owner note');
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Asha (owner note: met at the Razorpay booth)');
  });

  it('answers a lost insert race — two sends of one submission overlapping — as the replay it is', async () => {
    const { post, rows } = harness(store => ({
      upsert: async (ownerId, folderId, input) => {
        // The other send inserted between this one's lookup and its insert.
        store.push({ userId: ownerId, folderId: String(folderId), clientId: input.clientId, name: input.name });
        throw Object.assign(new Error('E11000 duplicate key error collection: contacts'), {
          code: 11000,
          keyPattern: { userId: 1, clientId: 1 },
        });
      },
    }));

    const res = await post(TOKEN_A, { name: 'Asha', [INTAKE_KEY_FIELD]: randomUUID() });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, created: false, name: 'Asha' });
    expect(rows).toHaveLength(1);
  });

  it('does not claim a save the read-back cannot find', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { post } = harness(() => ({
      upsert: async () => {
        throw Object.assign(new Error('E11000 duplicate key error collection: contacts'), {
          code: 11000,
          keyPattern: { userId: 1, clientId: 1 },
        });
      },
    }));

    const res = await post(TOKEN_A, { name: 'Asha', [INTAKE_KEY_FIELD]: randomUUID() });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Could not save that. Try again.' });
  });

  it('does not treat a duplicate on some other index as a replay', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { post } = harness(() => ({
      upsert: async () => {
        throw Object.assign(new Error('E11000 duplicate key error index: email_1'), {
          code: 11000,
          keyPattern: { email: 1 },
        });
      },
    }));

    const res = await post(TOKEN_A, { name: 'Asha', [INTAKE_KEY_FIELD]: randomUUID() });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Could not save that. Try again.' });
  });
});

describe("a submitter cannot reach anybody else's rows", () => {
  it("sending the owner's own scan id as a key makes a separate row and leaves theirs alone", async () => {
    const { post, rows } = harness();
    const ownersScanId = randomUUID(); // what newClientId() writes for the owner's own captures
    rows.push({ userId: OWNER, folderId: 'folder-a', clientId: ownersScanId, name: 'Priya (owner scan)' });

    const res = await post(TOKEN_A, { name: 'Mallory', [INTAKE_KEY_FIELD]: ownersScanId });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true, created: true, name: 'Mallory' });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ userId: OWNER, folderId: 'folder-a', clientId: ownersScanId, name: 'Priya (owner scan)' });
  });

  it('the same key on another of the owner’s links is another person', async () => {
    const { post, rows } = harness();
    const key = randomUUID();

    expect((await post(TOKEN_A, { name: 'Asha', [INTAKE_KEY_FIELD]: key })).status).toBe(201);
    expect((await post(TOKEN_B, { name: 'Asha', [INTAKE_KEY_FIELD]: key })).status).toBe(201);
    expect(rows.map(r => r.folderId)).toEqual(['folder-a', 'folder-b']);
  });
});

describe('a request with no usable key still saves the person', () => {
  it('saves a keyless submission — a page loaded before this shipped — as it always did', async () => {
    const { post, rows } = harness();
    expect((await post(TOKEN_A, { name: 'Asha' })).status).toBe(201);
    expect((await post(TOKEN_A, { name: 'Asha' })).status).toBe(201);
    // Not replay-safe, and documented as such: without a key two sends are two rows.
    expect(rows).toHaveLength(2);
  });

  it('ignores a malformed key instead of storing it, and never logs its value', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { post, rows } = harness();
    const hostile = 'zzzz"}{"$ne":1}';

    const res = await post(TOKEN_A, { name: 'Asha', [INTAKE_KEY_FIELD]: hostile });

    expect(res.status).toBe(201);
    expect(rows[0].clientId).toMatch(/^intake:[0-9a-f]{16}:srv-/);
    expect(rows[0].clientId).not.toContain(hostile);
    expect(warn).toHaveBeenCalledTimes(1);
    // Compared raw, not via JSON.stringify: stringify escapes the quotes, so a logged value would
    // no longer "contain" itself and the check would pass vacuously — which is how it first shipped.
    expect(warn.mock.calls.flat().map(String).some(arg => arg.includes('zzzz'))).toBe(false);
  });
});

describe('the guards run first, in the documented order, with the statuses they always had', () => {
  it('rate-limits before touching the database', async () => {
    const { post, calls } = harness(() => ({
      limit: () => ({ ok: false, remaining: 0, retryAfterSeconds: 7 }),
    }));

    const res = await post(TOKEN_A, { name: 'Asha', [INTAKE_KEY_FIELD]: randomUUID() });

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('7');
    expect(calls).toEqual({ connect: 0, findFolder: 0, upsert: 0 });
  });

  it('refuses a token too short to be real with 404, before any lookup', async () => {
    const { post, calls } = harness();
    const res = await post('short', { name: 'Asha' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'That link is not valid' });
    expect(calls.findFolder).toBe(0);
  });

  it('refuses an unknown token with 404', async () => {
    const { post, calls } = harness();
    const res = await post('tokenZZZZZZZZZZZZZZZZZ', { name: 'Asha' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'That link is no longer active' });
    expect(calls.upsert).toBe(0);
  });

  it('refuses a switched-off link with 404', async () => {
    const { post, folders, calls } = harness();
    folders.get(TOKEN_A)!.intakeEnabled = false;
    const res = await post(TOKEN_A, { name: 'Asha' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'That link is no longer active' });
    expect(calls.upsert).toBe(0);
  });

  it('refuses an expired link with 410', async () => {
    const { post, folders, calls } = harness();
    folders.get(TOKEN_A)!.intakeExpiresAt = new Date(NOW - 1);
    const res = await post(TOKEN_A, { name: 'Asha' });
    expect(res.status).toBe(410);
    expect(res.body).toEqual({ error: 'That link has expired' });
    expect(calls.upsert).toBe(0);
  });

  it('refuses a replay through a link that has since expired — a key opens nothing the token does not', async () => {
    const { post, folders, rows } = harness();
    const form = { name: 'Asha', [INTAKE_KEY_FIELD]: randomUUID() };
    expect((await post(TOKEN_A, form)).status).toBe(201);

    folders.get(TOKEN_A)!.intakeExpiresAt = new Date(NOW - 1);
    const replay = await post(TOKEN_A, form);

    expect(replay.status).toBe(410);
    expect(replay.body).toEqual({ error: 'That link has expired' });
    expect(rows).toHaveLength(1);
  });

  it('refuses a nameless submission with 400, before writing', async () => {
    const { post, calls } = harness();
    const res = await post(TOKEN_A, { name: '   ', [INTAKE_KEY_FIELD]: randomUUID() });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Please enter your name' });
    expect(calls.upsert).toBe(0);
  });

  it.each(['null', 'not json'])('treats the body %s as an empty form — 400, not a crash', async raw => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { post, calls } = harness();
    const res = await post(TOKEN_A, raw);
    expect(res.status).toBe(400);
    expect(calls.upsert).toBe(0);
  });

  it('answers a failure with no raw error text', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { post } = harness(() => ({
      upsert: async () => {
        throw new Error('connect ECONNREFUSED mongodb://user:hunter2@db.internal:27017');
      },
    }));

    const res = await post(TOKEN_A, { name: 'Asha', [INTAKE_KEY_FIELD]: randomUUID() });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Could not save that. Try again.' });
  });
});
