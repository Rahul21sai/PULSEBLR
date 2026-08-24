import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongodb';
import User from '@/lib/models/User';
import { rateLimit, clientKey } from '@/lib/security/rate-limit';
import { buildVCard } from '@/lib/contacts/vcf';
import type { PublicCardDTO } from '@/lib/contacts/types';

/**
 * PUBLIC — resolve a card token into the details its owner chose to publish.
 *
 * This endpoint is deliberately unauthenticated: the entire point is that somebody scanning
 * your QR with a stock phone camera, who does not have this app, still lands on something
 * useful. `scripts/diag-api-auth.ts` lists it under MUST_ALLOW so that staying public is a
 * tested decision rather than an oversight.
 *
 * What keeps it safe is not a session:
 *
 *   - the token is 16 bytes of CSPRNG entropy, so profiles cannot be enumerated
 *   - `card.enabled` must be true, so a token alone is not enough
 *   - the response contains ONLY fields the owner filled in, and the phone number only when
 *     `revealPhone` is on — it is the one field people regret publishing
 *   - no user id, no email address unless published, nothing about the user's contacts
 *
 * `?format=vcf` returns a downloadable contact card, which is how the "Save contact" button
 * works for a visitor without the app.
 */

export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  // Unauthenticated, so it is throttled. In-memory and therefore per-instance — it raises
  // the cost of scraping tokens rather than making it impossible. See the module note in
  // lib/security/rate-limit.ts.
  const limit = rateLimit(clientKey(request, 'card'), { limit: 60, windowMs: 60_000 });
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'Too many requests' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } }
    );
  }

  try {
    await connectDB();
    const { token } = await params;
    if (!token || token.length < 16) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const user = await User.findOne({ 'card.token': token }).select('name card').lean();
    // Same 404 whether the token is wrong or the card is switched off: which of the two it
    // is would itself be information about somebody.
    if (!user?.card?.enabled) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const card = user.card;
    const dto: PublicCardDTO = {
      displayName: card.displayName || user.name || 'PulseBLR user',
      headline: card.headline ?? null,
      company: card.company ?? null,
      role: card.role ?? null,
      linkedin: card.linkedin ?? null,
      x: card.x ?? null,
      github: card.github ?? null,
      website: card.website ?? null,
      email: card.email ?? null,
      phone: card.revealPhone ? card.phone ?? null : null,
    };

    if (request.nextUrl.searchParams.get('format') === 'vcf') {
      const vcf = buildVCard({
        name: dto.displayName,
        role: dto.role ?? undefined,
        company: dto.company ?? undefined,
        email: dto.email ?? undefined,
        phone: dto.phone ?? undefined,
        urls: [
          dto.linkedin,
          dto.website,
          dto.github && `https://github.com/${dto.github}`,
          dto.x && `https://x.com/${dto.x}`,
        ],
      });
      return new NextResponse(vcf, {
        headers: {
          'Content-Type': 'text/vcard; charset=utf-8',
          'Content-Disposition': `attachment; filename="${(dto.displayName || 'contact')
            .replace(/[^\w-]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .toLowerCase() || 'contact'}.vcf"`,
          'Cache-Control': 'no-store',
        },
      });
    }

    return NextResponse.json(
      { card: dto },
      // Not cached: rotating the token or switching the card off must take effect at once,
      // and the service worker caches successful GETs into an origin-wide store.
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('Error resolving card token:', error);
    return NextResponse.json({ error: 'Failed to load that card' }, { status: 500 });
  }
}
