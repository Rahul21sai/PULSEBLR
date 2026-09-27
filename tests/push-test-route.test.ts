import { NextRequest, NextResponse } from 'next/server';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createPushTestHandler,
  MAX_TEST_DEVICES,
  originAllowed,
  parseTestRequestBody,
  selectTestDevices,
  summariseTestSend,
  TEST_PUSH_PAYLOAD,
  TEST_PUSH_TOPIC,
  TEST_RATE_LIMIT,
  type PushTestDependencies,
  type StoredDevice,
} from '../lib/notifications/push-test-handler';
import type { DeviceSendResult } from '../lib/notifications/push';
import { PUSH_PAYLOAD_MAX_BYTES } from '../lib/notifications/reminder-policy';
import { rateLimit, resetRateLimits } from '../lib/security/rate-limit';

/**
 * POST /api/me/push/test, driven entirely through its injected collaborators, the pattern
 * `tests/account-deletion-route.test.ts` established. Nothing here touches MongoDB, web-push, a
 * push service or a session: the fakes record what the handler ASKED for, which is what the
 * route's guarantees are about. None of it depends on how `lib/notifications/push.ts` sends.
 */

const ORIGIN = 'https://pulseblr-u9f1.vercel.app';
const URL_ = `${ORIGIN}/api/me/push/test`;

const device = (userId: string, n: number): StoredDevice => ({
  userId,
  endpoint: `https://fcm.googleapis.com/fcm/send/device-${userId}-${n}`,
  p256dh: `p256dh-${userId}-${n}`,
  auth: `auth-${userId}-${n}`,
});
const MINE = device('user-a', 1);
const THEIRS = device('user-b', 1);

function request(body?: string, origin: string | null = ORIGIN): NextRequest {
  return new NextRequest(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    ...(body === undefined ? {} : { body }),
  });
}

interface Calls {
  env: number;
  configure: number;
  rateKeys: string[];
  loads: Array<[string, string | undefined]>;
  sends: Array<{ device: unknown; payload: string; topic: string }>;
  prunes: DeviceSendResult[][];
}

/** Fakes that succeed and RECORD, so a test can assert what was never reached. */
function harness(overrides: Partial<PushTestDependencies> = {}, rows: StoredDevice[] = [MINE]) {
  const calls: Calls = { env: 0, configure: 0, rateKeys: [], loads: [], sends: [], prunes: [] };
  const deps: PushTestDependencies = {
    requireUser: async () => ({ userId: 'user-a' }),
    expectedOrigin: () => ORIGIN,
    consumeRateLimit: key => {
      calls.rateKeys.push(key);
      return { ok: true, remaining: 2, retryAfterSeconds: 0 };
    },
    missingPushEnv: () => {
      calls.env += 1;
      return [];
    },
    configurePush: () => {
      calls.configure += 1;
    },
    loadDevices: async (userId, endpoint) => {
      calls.loads.push([userId, endpoint]);
      return rows;
    },
    sendToDevice: async (target, payload, topic) => {
      calls.sends.push({ device: target, payload, topic });
      return { endpoint: target.endpoint, ok: true, status: 201 };
    },
    pruneGoneEndpoints: async results => {
      calls.prunes.push([...results]);
      return results.filter(result => result.gone).length;
    },
    ...overrides,
  };
  return { handler: createPushTestHandler(deps), calls };
}

afterEach(() => resetRateLimits());

describe('POST /api/me/push/test — the order of the guards', () => {
  it('answers 401 before reading the body or touching anything else', async () => {
    const { handler, calls } = harness({
      requireUser: async () => ({ response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }),
    });
    const response = await handler(request('{ not json'));
    expect(response.status).toBe(401);
    expect(calls).toEqual({ env: 0, configure: 0, rateKeys: [], loads: [], sends: [], prunes: [] });
  });

  it.each([
    ['no Origin header', null],
    ['another site', 'https://evil.example'],
    ['a lookalike on the same host with a different scheme', 'http://pulseblr-u9f1.vercel.app'],
  ])('refuses %s with 403, before spending a rate-limit token', async (_label, origin) => {
    const { handler, calls } = harness();
    const response = await handler(request(JSON.stringify({ endpoint: MINE.endpoint }), origin));
    expect(response.status).toBe(403);
    expect(calls.rateKeys).toEqual([]);
    expect(calls.sends).toEqual([]);
  });

  it('refuses when the canonical origin cannot be computed, rather than failing open', async () => {
    const { handler, calls } = harness({
      expectedOrigin: () => {
        throw new Error('NEXTAUTH_URL is not set');
      },
    });
    const response = await handler(request());
    expect(response.status).toBe(403);
    expect(calls.sends).toEqual([]);
  });

  it('answers 503 naming the unset variables, before the rate limit, when VAPID is not configured', async () => {
    const { handler, calls } = harness({ missingPushEnv: () => ['VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'] });
    const response = await handler(request());
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toMatch(/not set up/i);
    expect(body.detail).toContain('VAPID_PRIVATE_KEY, VAPID_SUBJECT');
    expect(calls.configure).toBe(0);
    expect(calls.rateKeys).toEqual([]);
    expect(calls.sends).toEqual([]);
  });

  it('answers 503 when web-push rejects the VAPID values, and does not repeat its wording', async () => {
    const { handler, calls } = harness({
      configurePush: () => {
        throw new Error('Vapid subject is not a valid URL. mailto-operator-secret');
      },
    });
    const response = await handler(request());
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain('mailto-operator-secret');
    expect(calls.sends).toEqual([]);
  });

  it('answers 429 with Retry-After, keyed per USER, and sends nothing', async () => {
    const { handler, calls } = harness({
      consumeRateLimit: key => {
        calls.rateKeys.push(key);
        return { ok: false, remaining: 0, retryAfterSeconds: 17 };
      },
    });
    const response = await handler(request());
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('17');
    expect(calls.rateKeys).toEqual(['push-test:user-a']);
    expect(calls.loads).toEqual([]);
    expect(calls.sends).toEqual([]);
  });

  it('allows three tests a minute per account and refuses the fourth', async () => {
    const now = 1_800_000_000_000;
    const { handler } = harness({ consumeRateLimit: key => rateLimit(key, TEST_RATE_LIMIT, now) });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) statuses.push((await handler(request())).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  it('spends a token on a malformed body too, so a 400 cannot be hammered for free', async () => {
    const { handler, calls } = harness();
    const response = await handler(request('{'));
    expect(response.status).toBe(400);
    expect(calls.rateKeys).toEqual(['push-test:user-a']);
  });
});

describe('POST /api/me/push/test — the body', () => {
  it.each([
    ['not JSON', '{'],
    ['an array', '[]'],
    ['a number endpoint', '{"endpoint":42}'],
    ['an EMPTY endpoint, which must not widen to every device', '{"endpoint":""}'],
    ['an endpoint longer than any stored one', JSON.stringify({ endpoint: `https://a.example/${'x'.repeat(1000)}` })],
  ])('refuses %s with 400 and sends nothing', async (_label, body) => {
    const { handler, calls } = harness();
    const response = await handler(request(body));
    expect(response.status).toBe(400);
    expect(calls.loads).toEqual([]);
    expect(calls.sends).toEqual([]);
  });

  it('refuses an upload that could not be READ, rather than treating it as "every device"', async () => {
    const { handler, calls } = harness();
    const broken = new NextRequest(URL_, {
      method: 'POST',
      headers: { origin: ORIGIN },
      body: new ReadableStream({
        start(controller) {
          controller.error(new Error('client went away'));
        },
      }),
      duplex: 'half',
    } as ConstructorParameters<typeof NextRequest>[1] & { duplex: 'half' });
    const response = await handler(broken);
    expect(response.status).toBe(400);
    expect(calls.loads).toEqual([]);
    expect(calls.sends).toEqual([]);
  });
});

describe('POST /api/me/push/test — who receives it', () => {
  it('sends the FIXED payload, once, to the requested device only', async () => {
    const other = device('user-a', 2);
    const { handler, calls } = harness({}, [MINE, other]);
    const response = await handler(request(JSON.stringify({ endpoint: MINE.endpoint })));

    expect(response.status).toBe(200);
    expect(calls.loads).toEqual([['user-a', MINE.endpoint]]);
    expect(calls.sends).toEqual([
      {
        // The account id is not part of what a push service is handed.
        device: { endpoint: MINE.endpoint, p256dh: MINE.p256dh, auth: MINE.auth },
        payload: JSON.stringify(TEST_PUSH_PAYLOAD),
        topic: TEST_PUSH_TOPIC,
      },
    ]);
  });

  it('ignores anything the caller says about the notification itself', async () => {
    const { handler, calls } = harness();
    await handler(
      request(
        JSON.stringify({
          endpoint: MINE.endpoint,
          title: 'Your account is locked',
          body: 'Sign in again at evil.example',
          url: 'https://evil.example/login',
          tag: 'pblr-event-000000000000000000000000',
        })
      )
    );
    expect(calls.sends.map(send => send.payload)).toEqual([JSON.stringify(TEST_PUSH_PAYLOAD)]);
  });

  it("answers 404 for an endpoint that is not the caller's, even if a loader over-returns it", async () => {
    // The loader is handed exactly the row an attacker would want: someone else's device, at the
    // endpoint they asked for. Ownership is re-checked on the row, so it is never sent to.
    const { handler, calls } = harness({}, [THEIRS]);
    const response = await handler(request(JSON.stringify({ endpoint: THEIRS.endpoint })));
    expect(response.status).toBe(404);
    expect(calls.sends).toEqual([]);
  });

  it('answers 404, not 200, when the account has no device at all', async () => {
    const { handler, calls } = harness({}, []);
    const response = await handler(request());
    expect(response.status).toBe(404);
    expect((await response.json()).error).toMatch(/no device/i);
    expect(calls.sends).toEqual([]);
  });

  it(`fans out to at most ${MAX_TEST_DEVICES} devices when no endpoint is named`, async () => {
    const many = Array.from({ length: MAX_TEST_DEVICES + 5 }, (_, i) => device('user-a', i));
    const { handler, calls } = harness({}, many);
    const response = await handler(request());
    expect(response.status).toBe(200);
    expect(calls.loads).toEqual([['user-a', undefined]]);
    expect(calls.sends).toHaveLength(MAX_TEST_DEVICES);
  });
});

describe('POST /api/me/push/test — what the caller learns', () => {
  it('hands every result to the prune, and returns ONLY the three counts', async () => {
    const rows = [device('user-a', 1), device('user-a', 2), device('user-a', 3)];
    const outcomes: DeviceSendResult[] = [
      { endpoint: rows[0].endpoint, ok: true, status: 201 },
      { endpoint: rows[1].endpoint, ok: false, status: 410, gone: true, error: '410 push subscription has unsubscribed or expired.' },
      { endpoint: rows[2].endpoint, ok: false, status: 503, error: '503 Service Unavailable from upstream' },
    ];
    let pruneInput: DeviceSendResult[] = [];
    const { handler } = harness(
      {
        sendToDevice: async target => outcomes[rows.findIndex(row => row.endpoint === target.endpoint)],
        pruneGoneEndpoints: async results => {
          pruneInput = [...results];
          return 1;
        },
      },
      rows
    );

    const response = await handler(request());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(pruneInput).toEqual(outcomes);

    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ sent: 1, failed: 1, pruned: 1 });
    // No endpoint, and no push-service wording, even in a response that had both to hand.
    for (const row of rows) expect(text).not.toContain(row.endpoint);
    expect(text).not.toMatch(/unsubscribed|Unavailable|upstream/);
  });

  it('is still a 200 with counts when no push service accepted it: the counts ARE the answer', async () => {
    const { handler } = harness({
      sendToDevice: async target => ({ endpoint: target.endpoint, ok: false, status: 403, error: '403 VapidPkHashMismatch' }),
    });
    const response = await handler(request(JSON.stringify({ endpoint: MINE.endpoint })));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sent: 0, failed: 1, pruned: 0 });
  });

  it('answers a generic 500 without leaking what broke', async () => {
    const { handler } = harness({
      loadDevices: async () => {
        throw new Error('connect ECONNREFUSED mongodb://admin:hunter2@db.internal');
      },
    });
    const response = await handler(request());
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toMatch(/hunter2|db\.internal|mongodb/);
  });
});

describe('selectTestDevices', () => {
  it("keeps only the caller's rows", () => {
    expect(selectTestDevices([THEIRS, MINE], 'user-a').devices).toEqual([MINE]);
  });

  it('matches a requested endpoint EXACTLY, never by prefix', () => {
    const truncated = MINE.endpoint.slice(0, -1);
    expect(selectTestDevices([MINE], 'user-a', truncated)).toEqual({ devices: [], reason: 'not-found' });
    expect(selectTestDevices([MINE], 'user-a', MINE.endpoint)).toEqual({ devices: [MINE] });
  });

  it("does not find the caller's endpoint in another account's row", () => {
    expect(selectTestDevices([THEIRS], 'user-a', THEIRS.endpoint)).toEqual({ devices: [], reason: 'not-found' });
  });

  it('reports no-devices distinctly from not-found', () => {
    expect(selectTestDevices([THEIRS], 'user-a')).toEqual({ devices: [], reason: 'no-devices' });
  });

  it('caps the fan-out, keeping the rows in the order given (most recently seen first)', () => {
    const rows = Array.from({ length: 4 }, (_, i) => device('user-a', i));
    expect(selectTestDevices(rows, 'user-a', undefined, 2).devices).toEqual(rows.slice(0, 2));
  });
});

describe('parseTestRequestBody', () => {
  it.each(['', '   ', '{}', '{"endpoint":null}'])('reads %j as "every device"', raw => {
    expect(parseTestRequestBody(raw)).toEqual({ ok: true });
  });

  it('trims the endpoint, as the schema trims the stored one', () => {
    expect(parseTestRequestBody(JSON.stringify({ endpoint: `  ${MINE.endpoint} ` }))).toEqual({
      ok: true,
      endpoint: MINE.endpoint,
    });
  });

  it('names the field it refuses, and echoes no value back', () => {
    const verdict = parseTestRequestBody('{"endpoint":"   "}');
    expect(verdict).toEqual({ ok: false, issue: { field: 'endpoint', message: expect.any(String) } });
  });
});

describe('summariseTestSend', () => {
  it('counts a gone device as pruned, not failed, and takes pruned from the prune', () => {
    const results: DeviceSendResult[] = [
      { endpoint: 'a', ok: true },
      { endpoint: 'b', ok: false, gone: true },
      { endpoint: 'c', ok: false },
    ];
    expect(summariseTestSend(results, 1)).toEqual({ sent: 1, failed: 1, pruned: 1 });
  });
});

describe('originAllowed', () => {
  it('accepts exactly the canonical origin', () => {
    expect(originAllowed(ORIGIN, () => ORIGIN)).toBe(true);
    expect(originAllowed(`${ORIGIN}/`, () => ORIGIN)).toBe(false);
    expect(originAllowed(null, () => ORIGIN)).toBe(false);
  });
});

describe('TEST_PUSH_PAYLOAD — the contract with public/sw.js', () => {
  it('carries exactly the four fields the worker reads', () => {
    expect(Object.keys(TEST_PUSH_PAYLOAD).sort()).toEqual(['body', 'tag', 'title', 'url']);
  });

  it('opens a RELATIVE path, so it cannot be pointed off-site', () => {
    expect(TEST_PUSH_PAYLOAD.url.startsWith('/')).toBe(true);
    expect(TEST_PUSH_PAYLOAD.url.startsWith('//')).toBe(false);
  });

  it('can never replace a real reminder, whose tag is per event', () => {
    expect(TEST_PUSH_PAYLOAD.tag).not.toMatch(/^pblr-event-/);
  });

  it('is frozen, so nothing at runtime can make it caller-shaped', () => {
    expect(Object.isFrozen(TEST_PUSH_PAYLOAD)).toBe(true);
  });

  it('uses a topic the push services accept: at most 32 URL-safe base64 characters', () => {
    expect(TEST_PUSH_TOPIC).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
  });

  it('fits well under the payload ceiling', () => {
    expect(Buffer.byteLength(JSON.stringify(TEST_PUSH_PAYLOAD), 'utf8')).toBeLessThan(PUSH_PAYLOAD_MAX_BYTES);
  });
});
