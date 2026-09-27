import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  INTAKE_CLIENT_ID_PREFIX,
  INTAKE_KEY_FIELD,
  SERVER_MINTED_MARKER,
  intakeAccepted,
  intakeNamespace,
  isDuplicateClientIdError,
  parseIntakeKey,
  resolveIntakeClientId,
} from '@/lib/contacts/intake-key';
import { KEY_FIELD, intakeRequestBody, newSubmissionKey } from '../app/f/[token]/submission';

/**
 * THE IDEMPOTENCY KEY OF THE PUBLIC "ADD YOURSELF" FORM.
 *
 * The defect: `POST /api/intake/[token]` built its `clientId` from fresh randomness on every
 * request, so a retry after a lost response — venue Wi-Fi's normal behaviour — wrote a second row
 * into the owner's folder. The fix takes one key per submission from the form and derives the id
 * from it. What has to hold, and is pinned here:
 *
 *   · the same (link, key) ALWAYS maps to the same id — the idempotency itself
 *   · different links never share an id, and no id can equal one the owner's own devices write
 *   · only an exact v4 UUID is ever trusted; everything else falls back rather than being stored
 *   · the id never carries the token, which is a live write credential
 *   · a replay answers exactly like a first success — 200 against 201, never 409
 *   · every key the FORM can mint is one the SERVER trusts, on every randomness path it has
 */

/** The shape `newIntakeToken()` mints: 16 CSPRNG bytes, base64url. Inlined to keep mongoose out. */
const newToken = () => randomBytes(16).toString('base64url');

const TOKEN = newToken();
const KEY = randomUUID();
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('parseIntakeKey — only an exact v4 UUID is trusted', () => {
  it('accepts what crypto.randomUUID() produces, unchanged', () => {
    for (let i = 0; i < 500; i++) {
      const key = randomUUID();
      expect(parseIntakeKey(key)).toBe(key);
    }
    // RFC 9562's own v4 example, as a fixed positive control for the negatives below.
    expect(parseIntakeKey('f47ac10b-58cc-4372-a567-0e02b2c3d479')).toBe('f47ac10b-58cc-4372-a567-0e02b2c3d479');
  });

  it('canonicalises case, so a retry cannot become a second person by changing it', () => {
    expect(parseIntakeKey(KEY.toUpperCase())).toBe(KEY);
  });

  it.each([
    ['a leading space', ` ${KEY}`],
    ['a trailing newline', `${KEY}\n`],
    ['one character short', KEY.slice(1)],
    ['one character long', `${KEY}0`],
    ['no hyphens', KEY.replace(/-/g, '')],
    ['braces', `{${KEY}}`],
    ['the URN form', `urn:uuid:${KEY}`],
    ['a second segment smuggled in', `${KEY}:x`],
    ['an already-namespaced id', `intake:0123456789abcdef:${KEY}`],
  ])('rejects %s, and never trims', (_label, value) => {
    expect(parseIntakeKey(value)).toBeNull();
  });

  it.each([
    ['the nil UUID', '00000000-0000-0000-0000-000000000000'],
    ['the max UUID', 'ffffffff-ffff-ffff-ffff-ffffffffffff'],
    ['a v1 (time-based) UUID', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'],
    ['a v7 UUID', '017f22e2-79b0-7cc3-98c4-dc0c0c07398f'],
    ['a v4 with the NCS variant', 'f47ac10b-58cc-4372-0567-0e02b2c3d479'],
    ['a v4 with the Microsoft variant', 'f47ac10b-58cc-4372-c567-0e02b2c3d479'],
    ['a non-hex character', 'g47ac10b-58cc-4372-a567-0e02b2c3d479'],
  ])('rejects %s even at the right length', (_label, value) => {
    expect(value).toHaveLength(36);
    expect(parseIntakeKey(value)).toBeNull();
  });

  it("rejects the outbox's non-secure-context id, which is why the form does not reuse newClientId()", () => {
    // `newClientId()` in lib/scan/outbox.ts falls back to this shape when randomUUID is missing.
    expect(parseIntakeKey('cid-lx3k2a0b-9f8e7d6c')).toBeNull();
  });

  it.each<unknown>([undefined, null, 42, true, {}, [KEY], { toString: () => KEY }])('rejects the non-string %p', value => {
    expect(parseIntakeKey(value)).toBeNull();
  });
});

describe('intakeNamespace — one segment per link', () => {
  it('is 16 lower-case hex characters, the same every time', () => {
    const namespace = intakeNamespace(TOKEN);
    expect(namespace).toMatch(/^[0-9a-f]{16}$/);
    expect(intakeNamespace(TOKEN)).toBe(namespace);
  });

  it('never collides across links, including two a character apart', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) seen.add(intakeNamespace(newToken()));
    expect(seen.size).toBe(5000);
    expect(intakeNamespace('AAAAAAAAAAAAAAAAAAAAAA')).not.toBe(intakeNamespace('AAAAAAAAAAAAAAAAAAAAAB'));
  });

  it('does not carry the token, so no id is a copy of a live write credential', () => {
    for (let i = 0; i < 200; i++) {
      const token = newToken();
      expect(resolveIntakeClientId(token, KEY).clientId).not.toContain(token);
      expect(token).not.toContain(intakeNamespace(token));
    }
  });

  it('is domain-separated from a bare sha256 of the token', () => {
    const bare = createHash('sha256').update(TOKEN).digest('hex').slice(0, 16);
    expect(intakeNamespace(TOKEN)).not.toBe(bare);
  });
});

describe('resolveIntakeClientId — the id a submission is stored under', () => {
  it('maps the same (link, key) to the same id every time — the whole of the idempotency', () => {
    // Different mints on purpose: a valid key must not consult randomness at all.
    const first = resolveIntakeClientId(TOKEN, KEY, () => 'mint-a');
    const retry = resolveIntakeClientId(TOKEN, KEY, () => 'mint-b');
    const shouted = resolveIntakeClientId(TOKEN, KEY.toUpperCase(), () => 'mint-c');
    expect(first.replaySafe).toBe(true);
    expect(retry.clientId).toBe(first.clientId);
    expect(shouted.clientId).toBe(first.clientId);
  });

  it('is exactly intake:<16 hex>:<key>', () => {
    const { clientId } = resolveIntakeClientId(TOKEN, KEY);
    expect(clientId).toBe(`${INTAKE_CLIENT_ID_PREFIX}${intakeNamespace(TOKEN)}:${KEY}`);
    expect(clientId).toMatch(/^intake:[0-9a-f]{16}:/);
  });

  it("can never equal an id the owner's own devices write", () => {
    // The owner's scans store bare UUIDs from newClientId(). A stranger who sends one of those as
    // their key must land in a namespace no owner row can occupy.
    for (let i = 0; i < 500; i++) {
      const ownersScanId = randomUUID();
      const { clientId } = resolveIntakeClientId(newToken(), ownersScanId);
      expect(clientId).not.toBe(ownersScanId);
      expect(clientId.startsWith(INTAKE_CLIENT_ID_PREFIX)).toBe(true);
    }
  });

  it('keeps two links apart: the same key on another link is another person', () => {
    expect(resolveIntakeClientId(newToken(), KEY).clientId).not.toBe(
      resolveIntakeClientId(newToken(), KEY).clientId
    );
  });

  it('keeps two submissions on one link apart', () => {
    expect(resolveIntakeClientId(TOKEN, randomUUID()).clientId).not.toBe(
      resolveIntakeClientId(TOKEN, randomUUID()).clientId
    );
  });

  it.each([undefined, null, ''])('still saves a keyless submission (%p), under a server-minted id', raw => {
    expect(resolveIntakeClientId(TOKEN, raw, () => 'minted')).toEqual({
      clientId: `${INTAKE_CLIENT_ID_PREFIX}${intakeNamespace(TOKEN)}:${SERVER_MINTED_MARKER}minted`,
      replaySafe: false,
      reason: 'missing',
    });
  });

  it.each(['not-a-uuid', 42, `${KEY}:x`, ` ${KEY}`])('ignores a malformed key (%p) rather than storing it', raw => {
    expect(resolveIntakeClientId(TOKEN, raw, () => 'minted')).toEqual({
      clientId: `${INTAKE_CLIENT_ID_PREFIX}${intakeNamespace(TOKEN)}:${SERVER_MINTED_MARKER}minted`,
      replaySafe: false,
      reason: 'malformed',
    });
  });

  it('never lets a server-minted id equal one a client key produces', () => {
    const minted = resolveIntakeClientId(TOKEN, undefined).clientId;
    const lastSegment = minted.slice(minted.lastIndexOf(':') + 1);
    expect(lastSegment.startsWith(SERVER_MINTED_MARKER)).toBe(true);
    expect(parseIntakeKey(lastSegment)).toBeNull();
    // Not replay-safe, by design: two keyless sends are two ids, as they always were.
    expect(resolveIntakeClientId(TOKEN, undefined).clientId).not.toBe(minted);
  });
});

describe('isDuplicateClientIdError — the insert race, and only that', () => {
  it('recognises a duplicate on { userId, clientId }', () => {
    expect(isDuplicateClientIdError({ code: 11000, keyPattern: { userId: 1, clientId: 1 } })).toBe(true);
  });

  it('lets a driver that omits keyPattern through, for the read-back to decide', () => {
    expect(isDuplicateClientIdError({ code: 11000 })).toBe(true);
  });

  it('refuses a duplicate on any other index — that is not a replay', () => {
    expect(isDuplicateClientIdError({ code: 11000, keyPattern: { email: 1 } })).toBe(false);
  });

  it.each([new Error('E11000 duplicate key'), { code: 121 }, { code: '11000' }, null, undefined, 'E11000'])(
    'refuses %p',
    value => {
      expect(isDuplicateClientIdError(value)).toBe(false);
    }
  );
});

describe('intakeAccepted — one success response for a first write and a replay', () => {
  it('answers a first write 201 and a replay 200, never 409', () => {
    expect(intakeAccepted('Asha', true).status).toBe(201);
    expect(intakeAccepted('Asha', false).status).toBe(200);
  });

  it('gives a replay exactly the shape of a first success, and nothing more', () => {
    const first = intakeAccepted('Asha', true).body;
    const replay = intakeAccepted('Asha', false).body;
    expect(Object.keys(replay).sort()).toEqual(Object.keys(first).sort());
    expect(first).toEqual({ ok: true, created: true, name: 'Asha' });
    expect(replay).toEqual({ ok: true, created: false, name: 'Asha' });
  });
});

describe('the form and the route agree on the wire', () => {
  it('name the key field identically', () => {
    expect(KEY_FIELD).toBe(INTAKE_KEY_FIELD);
  });

  it.each([
    ['randomUUID (a secure context)', () => newSubmissionKey(globalThis.crypto)],
    [
      'getRandomValues only (a plain-http page)',
      () => newSubmissionKey({ getRandomValues: array => globalThis.crypto.getRandomValues(array) }),
    ],
    ['no Web Crypto at all', () => newSubmissionKey(null)],
  ])('every key the form can mint is one the server trusts — %s', (_label, mint) => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const key = mint();
      expect(key).toMatch(V4);
      expect(parseIntakeKey(key)).toBe(key);
      seen.add(key);
    }
    expect(seen.size).toBe(500);
  });

  it('a body the form builds resolves as replay-safe on the server', () => {
    const key = newSubmissionKey();
    const details = { name: 'Asha', company: '', role: '', linkedin: '', phone: '', email: '', note: '' };
    const body: Record<string, unknown> = intakeRequestBody(details, key);
    const resolved = resolveIntakeClientId(TOKEN, body[INTAKE_KEY_FIELD]);
    expect(resolved.replaySafe).toBe(true);
    expect(resolved.clientId.endsWith(key)).toBe(true);
  });
});
