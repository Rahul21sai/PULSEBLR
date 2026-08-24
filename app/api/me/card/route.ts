import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongodb';
import { newCardToken } from '@/lib/models/User';
import { requireUser } from '@/lib/api-auth';
import { ensureUser } from '@/lib/user-record';
import { auth } from '@/auth';
import { cardUrl } from '@/lib/canonical-origin';
import { coerceLinkedInInput } from '@/lib/scan/linkedin';
import type { MyCardDTO } from '@/lib/contacts/types';
import type { IUserCard } from '@/lib/models/User';

/**
 * The signed-in user's own shareable card — the thing OTHER people scan.
 *
 * GET returns it (minting a token on first read, so the QR screen always has something to
 * draw). PUT updates it, and `{ "rotate": true }` replaces the token, which invalidates
 * every code already printed or screenshotted.
 */

function toDTO(card: IUserCard | undefined, fallbackName?: string | null): MyCardDTO {
  if (!card) {
    return { revealPhone: false, enabled: false, displayName: fallbackName ?? null };
  }
  return {
    displayName: card.displayName ?? fallbackName ?? null,
    headline: card.headline ?? null,
    company: card.company ?? null,
    role: card.role ?? null,
    linkedin: card.linkedin ?? null,
    x: card.x ?? null,
    github: card.github ?? null,
    website: card.website ?? null,
    email: card.email ?? null,
    phone: card.phone ?? null,
    revealPhone: Boolean(card.revealPhone),
    enabled: Boolean(card.enabled),
    url: card.token ? cardUrl(card.token) : null,
  };
}

/** Normalise a handle field: accept a full URL or a bare @handle, store the handle. */
function handleOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    const seg = new URL(trimmed).pathname.split('/').filter(Boolean)[0];
    if (seg) return seg.replace(/^@/, '');
  } catch {
    // Not a URL, which is the common case.
  }
  return trimmed.replace(/^@/, '');
}

export async function GET() {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  try {
    await connectDB();
    const session = await auth();

    // Created if absent rather than 404: the JWT is the identity, the User row is derived from
    // it, and the sign-in upsert can legitimately have failed. See ensureUser().
    const user = await ensureUser(gate.userId, session?.user?.email, session?.user?.name);

    // Mint a token on first read. Doing it lazily means a user who never opens the card
    // screen never gets one, and the QR page never has to handle "no token yet".
    if (!user.card?.token) {
      user.card = {
        ...(user.card ?? { revealPhone: false, enabled: false }),
        token: newCardToken(),
      } as IUserCard;
      await user.save();
    }

    return NextResponse.json({ card: toDTO(user.card, session?.user?.name) });
  } catch (error) {
    console.error('Error reading card:', error);
    return NextResponse.json({ error: 'Failed to read your card' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  try {
    await connectDB();
    const body = await request.json().catch(() => ({}));

    const session = await auth();
    const user = await ensureUser(gate.userId, session?.user?.email, session?.user?.name);

    const card: IUserCard =
      user.card ?? ({ revealPhone: false, enabled: false, token: newCardToken() } as IUserCard);
    if (!card.token) card.token = newCardToken();

    const text = (value: unknown) => (typeof value === 'string' ? value.trim() : undefined);

    if ('displayName' in body) card.displayName = text(body.displayName);
    if ('headline' in body) card.headline = text(body.headline);
    if ('company' in body) card.company = text(body.company);
    if ('role' in body) card.role = text(body.role);
    if ('website' in body) card.website = text(body.website);
    if ('email' in body) card.email = text(body.email);
    if ('phone' in body) card.phone = text(body.phone);
    if ('x' in body) card.x = handleOf(body.x);
    if ('github' in body) card.github = handleOf(body.github);

    // Stored canonically so the card page and any scanned copy of it agree, and so a
    // typed-in bare slug works as well as a pasted URL.
    if ('linkedin' in body) {
      const raw = text(body.linkedin);
      card.linkedin = raw ? coerceLinkedInInput(raw)?.url ?? raw : undefined;
    }

    if (typeof body.revealPhone === 'boolean') card.revealPhone = body.revealPhone;
    if (typeof body.enabled === 'boolean') card.enabled = body.enabled;

    // Rotating invalidates every QR already in circulation. The UI warns before calling it.
    if (body.rotate === true) card.token = newCardToken();

    user.card = card;
    user.markModified('card');
    await user.save();

    return NextResponse.json({ card: toDTO(user.card, user.name) });
  } catch (error) {
    console.error('Error updating card:', error);
    return NextResponse.json(
      {
        error: 'Failed to update your card',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
