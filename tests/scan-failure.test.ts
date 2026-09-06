import { describe, it, expect } from 'vitest';
import {
  classifyStatus,
  refusalMessage,
  isItemRefusal,
  ITEM_REFUSALS,
  type FailureKind,
} from '@/lib/scan/failure';

/**
 * The offline outbox had one classification for two unrelated events, and that is what let a
 * capture sit in the queue forever.
 *
 * All three capture sites did `if (!res.ok) throw` and queued in the `catch`, so a 404
 * "Folder not found" — a refusal the server will repeat for the byte-identical request until
 * the folder comes back — was filed under the same "the network ate it" as a dropped
 * connection. The record then rode every drain, `markContactFailed()` incremented a counter
 * no screen read, and the banner kept promising it would "upload on their own". The user's
 * only symptom was a count that would not fall and a "Sync now" button that appeared inert.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * THE NEGATIVE HALF OF THIS SUITE IS THE IMPORTANT HALF, for the same reason it is in
 * `tests/off-city.test.ts` and `diag-hardware-vocabulary.ts`: this function fails by being
 * SIMPLIFIED, not by being wrong on the cases it was written for.
 *
 * `status >= 400 ? 'permanent' : 'transient'` is the shape somebody will eventually reduce
 * this to. It passes every obvious test. It also:
 *
 *   - offers to DISCARD a perfectly good capture because the user's token expired (401), and
 *   - permanently condemns records refused by a rate limiter (429) whose entire meaning is
 *     "send this again shortly".
 *
 * So the three carve-outs — 401 is its own kind, 408/425/429 are retryable 4xx, and every 5xx
 * including 503 is retryable — are pinned individually and asserted NOT to be permanent. A
 * count of passing tests would not reveal their loss; these assertions do.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 *
 * Scope note: pure, so it belongs here rather than in `scripts/diag-*.ts`. The wire contract
 * it underpins — that every item-level refusal from `/api/contacts/sync` carries `permanent`
 * and a `refusal` code — is exercised end-to-end by `scripts/diag-contact-flow.ts`.
 */

/** Every status that must be retried, and why it is not merely "a 5xx". */
const TRANSIENT: Array<[number, string]> = [
  [408, 'Request Timeout — the server is telling us to send it again'],
  [425, 'Too Early — replay is explicitly invited'],
  [429, 'Too Many Requests — lib/security/rate-limit.ts can produce this'],
  [500, 'Internal Server Error'],
  [502, 'Bad Gateway'],
  [503, 'Service Unavailable — requireAdmin() answers this when ADMIN_EMAILS is unset'],
  [504, 'Gateway Timeout'],
];

/** Every status where the server considered the record and refused it on the merits. */
const PERMANENT: Array<[number, string]> = [
  [400, 'missing clientId or name'],
  [403, 'forbidden'],
  [404, 'Folder not found — the case that produced the original stuck capture'],
  [409, 'conflict, e.g. a folder name clash from POST /api/folders'],
  [413, 'batch too large for MAX_ITEMS — refused identically every time'],
  [422, 'unprocessable'],
];

describe('classifyStatus', () => {
  it('treats 401 as its own kind, never as permanent', () => {
    // A lapsed session is the one 4xx where the record is flawless and the fix is a sign-in.
    // Folding it into 'permanent' would invite the UI to offer "discard" for a good capture.
    expect(classifyStatus(401)).toBe<FailureKind>('auth');
    expect(classifyStatus(401)).not.toBe('permanent');
  });

  it.each(TRANSIENT)('retries %i (%s)', status => {
    expect(classifyStatus(status)).toBe<FailureKind>('transient');
    expect(classifyStatus(status)).not.toBe('permanent');
  });

  it.each(PERMANENT)('condemns %i (%s)', status => {
    expect(classifyStatus(status)).toBe<FailureKind>('permanent');
  });

  it('does not condemn every 4xx — the three retryable ones survive a naive `>= 400` rule', () => {
    // The single assertion that catches the simplification described in the header.
    const retryable4xx = [408, 425, 429].map(classifyStatus);
    expect(retryable4xx).toEqual(['transient', 'transient', 'transient']);
    expect(classifyStatus(401)).toBe('auth');
  });

  it('errs towards retrying for statuses that are not refusals at all', () => {
    // 2xx never reaches here and `fetch` follows 3xx itself, so these are nonsense inputs.
    // Guessing 'permanent' would tell somebody their capture is broken when nothing said so;
    // the cost of guessing 'transient' is one extra request.
    expect(classifyStatus(200)).toBe<FailureKind>('transient');
    expect(classifyStatus(302)).toBe<FailureKind>('transient');
    expect(classifyStatus(0)).toBe<FailureKind>('transient');
  });
});

describe('ITEM_REFUSALS', () => {
  it('covers exactly the five refusals the sync route can issue', () => {
    // Pinned as an exact set, not a subset: the client renders copy per code, so a code the
    // server can send and this object does not know falls back to the server's prose — which is
    // the drift the codes exist to prevent.
    expect(Object.keys(ITEM_REFUSALS).sort()).toEqual([
      'folder-not-found',
      'missing-client-id',
      'missing-name',
      'no-folder',
      'shape-rejected',
    ]);
  });

  it('never leaks Mongoose or schema vocabulary into user-facing copy', () => {
    // The tracker routes had to stop echoing "Contact validation failed: name: Path `name` is
    // required" back to callers. These strings are shown to a person standing at an event, and
    // are also the fallback path for a thrown error, so the same rule applies. `shape-rejected`
    // is the one that would be most tempting to write as a passthrough of `err.message`.
    const all = Object.values(ITEM_REFUSALS).join(' ');
    for (const leak of ['ValidationError', 'CastError', 'Path `', 'schema', 'Mongoose', 'ObjectId']) {
      expect(all).not.toContain(leak);
    }
  });

  it('names a next step on every refusal the user can act on', () => {
    // A blocked row whose reason gives no next step is the state this change exists to remove,
    // and the folders page now offers Retry, "Move to…" and Discard — so the copy has to point at
    // the one that applies.
    expect(ITEM_REFUSALS['missing-name']).toMatch(/add one/i);
    expect(ITEM_REFUSALS['folder-not-found']).toMatch(/move it/i);
    expect(ITEM_REFUSALS['no-folder']).toMatch(/move it/i);
  });
});

describe('isItemRefusal', () => {
  it('accepts the real codes', () => {
    expect(isItemRefusal('folder-not-found')).toBe(true);
    expect(isItemRefusal('missing-name')).toBe(true);
  });

  it('rejects anything else, including values that could arrive over the wire', () => {
    // The server sends this field; a client must not treat arbitrary JSON as a known code.
    for (const bad of ['', 'Folder not found', 'toString', 'constructor', '__proto__', 42, null, undefined, {}]) {
      expect(isItemRefusal(bad)).toBe(false);
    }
  });
});

describe('refusalMessage', () => {
  it('prefers the code, so improving a server message cannot change client copy', () => {
    expect(refusalMessage('folder-not-found', 'Folder not found')).toBe(
      ITEM_REFUSALS['folder-not-found']
    );
  });

  it('falls back to the server message when the code is unknown', () => {
    // Forward compatibility: a newer server can add a refusal this client has never heard of,
    // and the user still gets something specific rather than a shrug.
    expect(refusalMessage('some-future-code', 'Waiting for its folder to upload first.')).toBe(
      'Waiting for its folder to upload first.'
    );
  });

  it('never returns an empty string', () => {
    // A blocked row with a blank reason reads as a UI bug and hides a real one.
    for (const args of [
      [undefined, undefined],
      [undefined, ''],
      [undefined, '   '],
      [null, undefined],
      ['', ''],
    ] as const) {
      expect(refusalMessage(args[0], args[1]).length).toBeGreaterThan(0);
    }
  });

  it('trims the server message rather than rendering its whitespace', () => {
    expect(refusalMessage(undefined, '  Folder is gone.  ')).toBe('Folder is gone.');
  });
});
