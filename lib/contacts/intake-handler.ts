import { NextRequest, NextResponse } from 'next/server';
import type { Types } from 'mongoose';
import connectDB from '@/lib/mongodb';
import Folder from '@/lib/models/Folder';
import Contact from '@/lib/models/Contact';
import { rateLimit, clientKey, type RateLimitResult } from '@/lib/security/rate-limit';
import { upsertContact } from '@/lib/contacts/service';
import type { ContactInput } from '@/lib/contacts/types';
import { coerceLinkedInInput } from '@/lib/scan/linkedin';
import {
  INTAKE_KEY_FIELD,
  intakeAccepted,
  isDuplicateClientIdError,
  resolveIntakeClientId,
  type IntakeAccepted,
} from '@/lib/contacts/intake-key';
import { errorLogLine, routeFailure } from '@/lib/http/errors';

/**
 * The form's own fields: the only ones a refusal may name to a SUBMITTER. Everything else on the
 * Contact row is the folder owner's, and a stranger on an unauthenticated endpoint is told nothing
 * about it. `linkedinSlug` is derived from the `linkedin` they typed.
 */
const INTAKE_FORM_FIELDS = {
  rename: { linkedinSlug: 'linkedin' },
  fields: ['name', 'company', 'role', 'email', 'phone', 'linkedin', 'note'],
};

/**
 * PUBLIC — somebody standing in front of you adds THEMSELVES to your folder.
 *
 * This is the "folder QR" mode: you show one code, five people scan it, each fills in a
 * three-field form, and all five land in the right folder without you typing anything.
 *
 * It is the only unauthenticated WRITE endpoint in the app, so it is layered:
 *
 *   1. The token is 16 bytes of CSPRNG entropy — not guessable, not enumerable.
 *   2. `intakeEnabled` must be true. It defaults to false, so no folder is ever publicly
 *      writable by accident.
 *   3. `intakeExpiresAt` must be in the future. Default 12 hours, because a QR projected on
 *      a screen or printed on a poster outlives the event.
 *   4. Rate-limited per IP. In-memory, so per-instance — see lib/security/rate-limit.ts for
 *      an honest account of what that does and does not prevent.
 *   5. It can only CREATE, only in the one named folder, and it reads nothing back. A
 *      successful request returns `{ ok, created, name }` — `name` being what THIS request sent,
 *      never read from the stored row — and not the folder's contents, so the token cannot be
 *      used to enumerate who else registered.
 *   6. A RETRY LANDS ONCE. The form sends one idempotency key per submission and resends it on
 *      every retry. The row's `clientId` is derived from it by `resolveIntakeClientId()`
 *      (lib/contacts/intake-key.ts), so a replay finds the first row and answers 200 with the
 *      first success's shape — never a 409, never a second row. The derivation is namespaced by
 *      a hash of the token, so a submitter can reach neither the owner's own rows nor another
 *      link's. A replay CHANGES NOTHING — `upsertContact` never overwrites — so the key cannot
 *      edit a row, only avoid making a second one; and `created: false` tells the caller only
 *      that this (link, key) pair was used before, which only the device that minted the key is
 *      in a position to ask. A missing or malformed key still saves the person, without replay
 *      protection: a stale page or a broken client must cost idempotency, never the person.
 *
 * There is no session here, so `capturedVia` is `card-page` and the row is owned by the
 * folder's owner — never by whoever submitted the form.
 *
 * The handler is built by `createIntakeHandler()` with its effects injected — the pattern
 * `app/api/me/account/route.ts` uses — so `tests/intake-route.test.ts` can drive the guard order
 * and the replay path with no database. `POST` below is the only wiring of real dependencies.
 */

/** Tight, because a form filled in by hand cannot legitimately fire faster than this. */
const LIMIT = { limit: 10, windowMs: 60_000 };

/** The folder fields this route reads. `Folder.findOne()` satisfies it structurally. */
export interface IntakeFolder {
  _id: Types.ObjectId | string;
  userId: string;
  intakeEnabled?: boolean;
  intakeExpiresAt?: Date | null;
}

export interface IntakeDeps {
  /** Consume one token from this caller's bucket. */
  limit: (request: NextRequest) => RateLimitResult;
  connect: () => Promise<unknown>;
  findFolder: (token: string) => Promise<IntakeFolder | null>;
  /**
   * Create the row, or find the one an earlier send of the same submission created.
   *
   * ONLY `created` comes back, so this handler cannot echo a stored field even by mistake — the
   * "reads nothing back" guarantee above is enforced by this type, not by care.
   */
  upsert: (
    ownerId: string,
    folderId: IntakeFolder['_id'],
    input: ContactInput
  ) => Promise<{ created: boolean }>;
  /** Read-back for a lost insert race: does this owner already hold this clientId? */
  contactExists: (ownerId: string, clientId: string) => Promise<boolean>;
  now: () => number;
  /** Id source for a submission with no usable key. Defaults to `crypto.randomUUID`. */
  mintId?: () => string;
}

function accepted({ status, body }: IntakeAccepted): NextResponse {
  return NextResponse.json(body, { status });
}

export function createIntakeHandler(deps: IntakeDeps) {
  return async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ token: string }> }
  ): Promise<NextResponse> {
    const limit = deps.limit(request);
    if (!limit.ok) {
      return NextResponse.json(
        { error: 'Too many submissions. Wait a moment and try again.' },
        { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } }
      );
    }

    // Hoisted so the catch block can answer a lost insert race as the replay it is.
    let ownerId = '';
    let clientId = '';
    let name = '';

    try {
      await deps.connect();
      const { token } = await params;
      if (!token || token.length < 16) {
        return NextResponse.json({ error: 'That link is not valid' }, { status: 404 });
      }

      const folder = await deps.findFolder(token);
      if (!folder || !folder.intakeEnabled) {
        return NextResponse.json({ error: 'That link is no longer active' }, { status: 404 });
      }
      if (folder.intakeExpiresAt && folder.intakeExpiresAt.getTime() < deps.now()) {
        return NextResponse.json({ error: 'That link has expired' }, { status: 410 });
      }

      // A JSON `null`, array or string body used to reach `body.name` and throw — a caller's
      // mistake reported as a 500. Anything that is not an object is treated as an empty form.
      const parsed: unknown = await request.json().catch(() => null);
      const body: Record<string, unknown> =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {};

      name = typeof body.name === 'string' ? body.name.trim().slice(0, 200) : '';
      if (!name) {
        return NextResponse.json({ error: 'Please enter your name' }, { status: 400 });
      }

      const text = (value: unknown, max = 300) =>
        typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;

      const linkedinRaw = text(body.linkedin);
      const linkedin = linkedinRaw ? coerceLinkedInInput(linkedinRaw) : null;

      // The submitter has no session, so their key is never trusted as an id on its own: it is
      // shape-checked and namespaced to this link. See lib/contacts/intake-key.ts.
      const key = resolveIntakeClientId(token, body[INTAKE_KEY_FIELD], deps.mintId);
      if (!key.replaySafe && key.reason === 'malformed') {
        // Never the value itself: it is caller-chosen text on an unauthenticated endpoint.
        console.warn('[intake] ignored a malformed idempotency key; saved without replay protection');
      }
      ownerId = folder.userId;
      clientId = key.clientId;

      const { created } = await deps.upsert(folder.userId, folder._id, {
        clientId,
        name,
        company: text(body.company, 200),
        role: text(body.role, 200),
        email: text(body.email, 200),
        phone: text(body.phone, 60),
        linkedin: linkedin?.url ?? linkedinRaw,
        linkedinSlug: linkedin?.slug,
        note: text(body.note, 1000),
        capturedVia: 'card-page',
      });

      // Deliberately minimal: no folder contents, no other contacts, no ids that could be
      // used to probe. The submitter needs to know it worked, and nothing else.
      return accepted(intakeAccepted(name, created));
    } catch (error) {
      // Two sends of one submission overlapped and this one lost the insert. The unique index did
      // its job; confirm the winner exists and answer exactly as a replay would. Without the
      // read-back a duplicate on some OTHER index would be reported as a saved person.
      if (ownerId && clientId && isDuplicateClientIdError(error)) {
        const exists = await deps.contactExists(ownerId, clientId).catch(() => false);
        if (exists) return accepted(intakeAccepted(name, false));
      }
      // The one UNAUTHENTICATED write: whatever a stranger typed can be quoted by this error, so it
      // reaches the log as one inert line, never raw (a newline or ESC in a name would forge lines).
      console.error('Error accepting folder intake:', errorLogLine(error));
      // A refusal of what they typed is a 400 naming the form field, which "Try again" would never
      // fix. Anything else, including a refusal of the owner's own fields, stays the 500 it was.
      const failure = routeFailure(error, 'Could not save that. Try again.', INTAKE_FORM_FIELDS);
      return NextResponse.json(failure.body, { status: failure.status });
    }
  };
}

export const POST = createIntakeHandler({
  limit: request => rateLimit(clientKey(request, 'intake'), LIMIT),
  connect: connectDB,
  findFolder: token => Folder.findOne({ intakeToken: token }).exec(),
  upsert: async (ownerId, folderId, input) => {
    const { created } = await upsertContact(ownerId, folderId, input);
    return { created };
  },
  contactExists: async (ownerId, clientId) =>
    (await Contact.exists({ userId: ownerId, clientId })) !== null,
  now: () => Date.now(),
});
