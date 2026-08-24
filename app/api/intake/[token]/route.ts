import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import connectDB from '@/lib/mongodb';
import Folder from '@/lib/models/Folder';
import { rateLimit, clientKey } from '@/lib/security/rate-limit';
import { upsertContact } from '@/lib/contacts/service';
import { coerceLinkedInInput } from '@/lib/scan/linkedin';

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
 *      successful request returns `{ ok: true }` and not the folder's contents, so the token
 *      cannot be used to enumerate who else registered.
 *
 * There is no session here, so `capturedVia` is `card-page` and the row is owned by the
 * folder's owner — never by whoever submitted the form.
 */

/** Tight, because a form filled in by hand cannot legitimately fire faster than this. */
const LIMIT = { limit: 10, windowMs: 60_000 };

export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const limit = rateLimit(clientKey(request, 'intake'), LIMIT);
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'Too many submissions. Wait a moment and try again.' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } }
    );
  }

  try {
    await connectDB();
    const { token } = await params;
    if (!token || token.length < 16) {
      return NextResponse.json({ error: 'That link is not valid' }, { status: 404 });
    }

    const folder = await Folder.findOne({ intakeToken: token });
    if (!folder || !folder.intakeEnabled) {
      return NextResponse.json({ error: 'That link is no longer active' }, { status: 404 });
    }
    if (folder.intakeExpiresAt && folder.intakeExpiresAt.getTime() < Date.now()) {
      return NextResponse.json({ error: 'That link has expired' }, { status: 410 });
    }

    const body = await request.json().catch(() => ({}));
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 200) : '';
    if (!name) {
      return NextResponse.json({ error: 'Please enter your name' }, { status: 400 });
    }

    const text = (value: unknown, max = 300) =>
      typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;

    const linkedinRaw = text(body.linkedin);
    const linkedin = linkedinRaw ? coerceLinkedInInput(linkedinRaw) : null;

    const { contact, created } = await upsertContact(folder.userId, folder._id, {
      // The submitter has no session, so they cannot supply a trusted id. A random one keeps
      // the write idempotent under a double-tap without letting them address an existing row.
      clientId: `intake-${crypto.randomBytes(12).toString('base64url')}`,
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
    return NextResponse.json({ ok: true, created, name: contact.name }, { status: 201 });
  } catch (error) {
    console.error('Error accepting folder intake:', error);
    return NextResponse.json({ error: 'Could not save that. Try again.' }, { status: 500 });
  }
}
