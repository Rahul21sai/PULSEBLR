import { createHash, randomUUID } from 'node:crypto';

/**
 * THE IDEMPOTENCY KEY BEHIND THE PUBLIC "ADD YOURSELF" FORM — `POST /api/intake/[token]`.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT WAS BROKEN. The route minted `intake-<12 random bytes>` on EVERY request, beside a comment
 * saying that kept the write "idempotent under a double-tap". It could not: `upsertContact()`
 * dedupes on `{ userId, clientId }`, and an id that is new on every request never matches anything.
 * The form's disabled button only covered a tap WHILE a request was in flight, so the ordinary
 * venue-Wi-Fi sequence — the request lands, the response is lost, the person taps again — wrote a
 * second row into the owner's folder every time.
 *
 * THE SHAPE OF THE FIX. The form mints ONE key per submission and resends it on every retry of that
 * submission. The server never stores the key as it arrived:
 *
 *     intake:<first 16 hex of sha256(label + token)>:<the key, as a lower-case v4 UUID>
 *
 * Every part of that is load-bearing:
 *
 *   · THE `intake:` NAMESPACE. `upsertContact()` looks the id up across ALL of the owner's folders
 *     and, on a hit, returns that document and writes nothing. A client string taken verbatim could
 *     therefore name one of the owner's OWN rows — their scans carry plain UUIDs from
 *     `newClientId()`, and `clientId` is in every `ContactDTO`, so it is not a secret — and the
 *     stranger's submission would vanish into it while `created: false` confirmed the row exists.
 *     No other write path produces this prefix, and the submitter controls only its last 36
 *     characters.
 *   · THE TOKEN SEGMENT. A key means something only within the one link it was sent to, so the same
 *     key on two links is two people, never a collision. It is a HASH, not the token: `clientId`
 *     travels in `ContactDTO` to the owner's browser and to the MCP tools, and a live write
 *     credential should not be copied into every row it created. 64 bits is plenty — it only has to
 *     keep one owner's links apart, and the key beside it carries 122 random bits.
 *   · THE STRICT SHAPE. Exactly a v4 UUID, compared case-insensitively and stored lower-case
 *     (RFC 9562 treats UUIDs as case-insensitive on input), so a retry cannot become a second
 *     person by changing case, and nothing can smuggle a `:` into the namespace. No trimming: the
 *     form never sends whitespace, so a padded key did not come from it.
 *
 * A MISSING OR MALFORMED KEY STILL SAVES THE PERSON, under an id the server mints — exactly the old,
 * non-idempotent behaviour. A page loaded before this shipped keeps working, and a broken client
 * costs replay safety rather than the person: `queueContact()`'s rule, "an id is recoverable, a
 * person is not". The `srv-` marker keeps those rows countable, and no valid key can produce one,
 * because a canonical UUID cannot start with `s`.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 */

/** Prefixes every id this route writes. Nothing else in the app mints it. */
export const INTAKE_CLIENT_ID_PREFIX = 'intake:';

/**
 * The body field the key travels in. `app/f/[token]/submission.ts` declares the same string rather
 * than importing it, because this module needs `node:crypto`; `tests/intake-key.test.ts` pins them.
 */
export const INTAKE_KEY_FIELD = 'idempotencyKey';

/** Marks an id the server minted because the request carried no usable key. */
export const SERVER_MINTED_MARKER = 'srv-';

/** Hex characters of the token digest kept in the id — 64 bits, see the header. */
const NAMESPACE_HEX = 16;

/** Domain separation, so this digest is never a prefix of some other sha256 of the same token. */
const NAMESPACE_LABEL = 'pulseblr:intake-client-id:v1:';

/** Version 4, RFC 9562 variant: what `crypto.randomUUID()` produces. Anchored and fixed-width. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The canonical (lower-case) form of a client key, or null when it is not exactly a v4 UUID. */
export function parseIntakeKey(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length !== 36 || !UUID_V4.test(raw)) return null;
  return raw.toLowerCase();
}

/** The per-link segment of the id: a one-way digest of the token, never the token itself. */
export function intakeNamespace(token: string): string {
  return createHash('sha256')
    .update(NAMESPACE_LABEL)
    .update(token)
    .digest('hex')
    .slice(0, NAMESPACE_HEX);
}

export type IntakeClientId =
  | { clientId: string; replaySafe: true }
  | { clientId: string; replaySafe: false; reason: 'missing' | 'malformed' };

/**
 * The `clientId` a submission to `token` is stored under.
 *
 * The same `(token, key)` ALWAYS yields the same id — that is the whole of the idempotency, since
 * `upsertContact()` does the rest. `mint` is used only when there is no usable key, and is
 * injectable so that fallback can be asserted deterministically.
 */
export function resolveIntakeClientId(
  token: string,
  rawKey: unknown,
  mint: () => string = randomUUID
): IntakeClientId {
  const prefix = `${INTAKE_CLIENT_ID_PREFIX}${intakeNamespace(token)}:`;

  const key = parseIntakeKey(rawKey);
  if (key) return { clientId: `${prefix}${key}`, replaySafe: true };

  const missing = rawKey === undefined || rawKey === null || rawKey === '';
  return {
    clientId: `${prefix}${SERVER_MINTED_MARKER}${mint()}`,
    replaySafe: false,
    reason: missing ? 'missing' : 'malformed',
  };
}

/**
 * Did an insert lose a race on `{ userId, clientId }`?
 *
 * Two sends of one submission can overlap: the form gives up on a request after 15 s and the person
 * taps Retry while the first is still being written. Both miss in `upsertContact()`'s lookup, both
 * insert, and the unique index refuses the second. That is the replay arriving early, not a fault.
 *
 * It branches on `keyPattern` because a duplicate-key handler that assumes which index fired reports
 * one bug as another — the `Folder` one-folder cap was misread exactly that way. A driver that omits
 * `keyPattern` is let through, because the caller confirms with a read-back before answering 200.
 */
export function isDuplicateClientIdError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, keyPattern } = error as { code?: unknown; keyPattern?: unknown };
  if (code !== 11000) return false;
  if (keyPattern && typeof keyPattern === 'object') return 'clientId' in keyPattern;
  return true;
}

export interface IntakeAccepted {
  status: 200 | 201;
  body: { ok: true; created: boolean; name: string };
}

/**
 * The one success response, for a first write and for a replay alike.
 *
 * 201 when this request created the row, 200 when it found the one an earlier send created — never
 * 409, which would tell the form its write failed and invite another retry. Same keys either way, so
 * the caller cannot tell a replay from a first success by shape.
 *
 * `name` is the name the CALLER sent, and the route has no way to pass anything else: its store
 * dependency returns only `created`. Echoing the stored row instead would read data back through a
 * public endpoint — by the time a retry arrives the owner may have corrected or annotated that name.
 */
export function intakeAccepted(name: string, created: boolean): IntakeAccepted {
  return { status: created ? 201 : 200, body: { ok: true, created, name } };
}
