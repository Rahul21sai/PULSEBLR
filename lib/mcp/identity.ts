// Who is calling the MCP endpoint. PURE — no mongoose, no network, no `next/server`.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THERE ARE THREE ANSWERS, NOT TWO, AND COLLAPSING ANY PAIR OF THEM BREAKS SOMETHING REAL.
//
//   anonymous   no `Authorization` header at all. This is v1's caller and it MUST STILL BE SERVED
//               — `scripts/diag-api-auth.ts` asserts `POST /api/mcp` answers 200 signed-out, and
//               the four public tools are the reason this server exists at all.
//   identified  a live token that resolved to a user. The four personal tools become reachable.
//   rejected    a header WAS presented and did not resolve — malformed, wrong scheme, unknown,
//               revoked or expired. This is a 401, and it is NOT the same as anonymous.
//
// Folding `rejected` into `anonymous` would silently downgrade a revoked token to public access:
// the client would keep working, the personal tools would quietly vanish from `tools/list`, and
// nobody would learn the credential had died. Folding `anonymous` into `rejected` would 401 every
// v1 client on the planet. So the three states are modelled explicitly and the route branches on
// all three.
//
// ── WHY THE SECRET IS HASHED HERE AND COMPARED NOWHERE ───────────────────────────────────────
// Verification is a lookup on `sha256(token)` against a unique-indexed column, so the presented
// secret is never compared to a stored one and there is no string comparison to time. That is the
// property to preserve: the day someone "simplifies" this into `findById` + `token === stored`, it
// gains a timing side channel and starts storing a credential in plaintext.
//
// SHA-256 AND NOT bcrypt/scrypt/argon2, DELIBERATELY. A slow KDF exists to make GUESSING expensive,
// which matters for a human-chosen password drawn from a tiny space. This token is 32 bytes of
// CSPRNG output — there is no dictionary, and brute force is not a threat model that a work factor
// improves. What a KDF would definitely add is per-request latency on a read endpoint an assistant
// calls several times a turn. Same reasoning GitHub, Stripe and every other PAT issuer applies.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The prefix every PulseBLR MCP token carries.
 *
 * Not decoration. A distinctive, greppable prefix is what lets a leaked string be RECOGNISED — in a
 * pasted config, a CI log, a screenshot, or a secret scanner — as a credential belonging to this app
 * rather than an opaque blob nobody can attribute. It also lets `parseToken` refuse an obviously
 * foreign string (a Google access token, someone's OpenAI key pasted into the wrong field) with no
 * database round trip at all.
 */
export const TOKEN_PREFIX = 'pblr_';

/** 32 bytes of CSPRNG entropy, base64url — 43 characters, so 48 with the prefix. */
const TOKEN_BYTES = 32;
const TOKEN_BODY_CHARS = 43;

/** base64url only: no `+`, no `/`, no `=`. Pinned so a format change cannot pass unnoticed. */
const TOKEN_BODY = /^[A-Za-z0-9_-]{43}$/;

/**
 * The only scope that exists. A single-value union rather than a bare string, so adding a write
 * scope is a deliberate type-level change at every site that reads one — not a string that starts
 * appearing in the database.
 */
export const MCP_SCOPES = ['read'] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

/** A caller that presented a live token. */
export interface McpIdentity {
  /** The Google `sub`, i.e. the same `userId` every other collection in this app is keyed by. */
  userId: string;
  /** The `McpToken` row, so a successful call can refresh `lastUsedAt` without a second lookup. */
  tokenId: string;
  scope: McpScope;
  /** The user's own label for this token. For server logs and the `whoami`-style prose. */
  label: string;
}

export type McpAuthOutcome =
  | { kind: 'anonymous' }
  | { kind: 'identified'; identity: McpIdentity }
  /** `reason` is safe to return to the caller: it never distinguishes "no such token" from
   *  "revoked", for the same reason `get_event` has one message for missing and forbidden. */
  | { kind: 'rejected'; reason: string };

/** Mint a new token. Returned ONCE, to the user who asked for it, and never stored in this form. */
export function newMcpToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString('base64url')}`;
}

/** `sha256` hex of the whole token string, prefix included. What the database stores. */
export function hashMcpToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * The last four characters, shown in the token list so a user can tell two tokens apart.
 *
 * Four characters of a 256-bit secret is 24 bits of a value that needs all 256 — it narrows nothing
 * a brute force could use. Storing the whole thing "so the user can check it" is what this exists to
 * avoid.
 */
export function tokenHint(token: string): string {
  return token.slice(-4);
}

/**
 * Extract a bearer credential from an `Authorization` header.
 *
 * Returns `null` for "nothing was presented" — which the caller MUST map to `anonymous`, not to a
 * refusal. Returns `{ malformed: true }` when something WAS presented and cannot be a credential of
 * ours, which the caller maps to `rejected`.
 *
 * A whitespace-only header counts as nothing presented: that is what a client whose token
 * environment variable is unset actually sends, and answering it with the public tools is more
 * useful than a 401 it cannot act on.
 */
export function parseAuthorizationHeader(
  header: string | null | undefined
): { token: string } | { malformed: string } | null {
  if (header === null || header === undefined) return null;

  const trimmed = header.trim();
  if (trimmed.length === 0) return null;

  // Scheme is case-insensitive per RFC 9110; the token is not.
  const match = /^([A-Za-z]+)[ \t]+(.*)$/.exec(trimmed);
  if (!match) {
    return { malformed: 'The Authorization header must read "Bearer <token>".' };
  }

  const [, scheme, rest] = match;
  if (scheme.toLowerCase() !== 'bearer') {
    return {
      malformed: `Unsupported authorization scheme "${scheme}". PulseBLR MCP accepts "Bearer <token>".`,
    };
  }

  const token = rest.trim();
  if (token.length === 0) {
    return { malformed: 'The Authorization header carried no token.' };
  }
  return { token };
}

/**
 * Is this string shaped like one of our tokens?
 *
 * Checked before hashing so a foreign credential — or a 4 KB blob a confused client pasted — is
 * refused without a database round trip. The prefix is compared in constant time: it is not secret,
 * but the comparison is cheap and it removes the whole "is this branch timing-observable" question
 * rather than reasoning about it.
 */
export function isWellFormedToken(token: string): boolean {
  if (token.length !== TOKEN_PREFIX.length + TOKEN_BODY_CHARS) return false;
  if (!constantTimeEquals(token.slice(0, TOKEN_PREFIX.length), TOKEN_PREFIX)) return false;
  return TOKEN_BODY.test(token.slice(TOKEN_PREFIX.length));
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * How long a freshly minted token lives, in days.
 *
 * EXPIRY IS MANDATORY — there is no "never expires" option, and that is a decision rather than an
 * oversight. A credential with no end date is one you forget you issued; it outlives the laptop it
 * was pasted on. 90 days is the default because it is long enough not to be a chore and short enough
 * that an abandoned config stops working while the person who made it still remembers making it.
 * Re-minting is three clicks in `/settings`.
 */
export const TOKEN_TTL_DAYS = { default: 90, min: 1, max: 365 } as const;

/** Turn a day count into an absolute instant, clamped to the supported range. */
export function expiryFromDays(days: number, now: Date = new Date()): Date {
  const clamped = Math.min(TOKEN_TTL_DAYS.max, Math.max(TOKEN_TTL_DAYS.min, Math.trunc(days)));
  return new Date(now.getTime() + clamped * 24 * 60 * 60 * 1000);
}

/**
 * How stale `lastUsedAt` must be before a successful call bothers to refresh it.
 *
 * An unconditional write would put a second database round trip on every tool call, on an endpoint
 * whose entire job is reads. Five minutes is enough resolution for the only question the field
 * answers — "is this token still in use, and did I expect that?" — at a tiny fraction of the writes.
 */
export const LAST_USED_REFRESH_MS = 5 * 60 * 1000;

export function shouldRefreshLastUsed(
  lastUsedAt: Date | null | undefined,
  now: Date = new Date()
): boolean {
  if (!lastUsedAt) return true;
  return now.getTime() - lastUsedAt.getTime() > LAST_USED_REFRESH_MS;
}
