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
