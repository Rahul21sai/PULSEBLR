import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongodb';
import { newIntakeToken } from '@/lib/models/Folder';
import { requireUser } from '@/lib/api-auth';
import { findOwnedFolder, folderToDTO } from '@/lib/contacts/service';
import { intakeUrl } from '@/lib/canonical-origin';

/**
 * Turn a folder's public self-registration QR on or off, or rotate its token.
 *
 * The token this mints is the sole credential on an UNAUTHENTICATED write endpoint
 * (`POST /api/intake/[token]`), so three things are deliberate:
 *
 *   - it is 16 bytes of CSPRNG entropy, not derived from the folder or the user
 *   - it EXPIRES, defaulting to 12 hours, because a QR printed on a poster or projected on
 *     a screen outlives the event it was made for
 *   - rotating replaces it, which invalidates every code already shown — the UI has to say so
 */

/** Default lifetime for a freshly minted intake link. Long enough for one event. */
const DEFAULT_TTL_HOURS = 12;
const MAX_TTL_HOURS = 72;

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  try {
    await connectDB();
    const { id } = await params;
    const folder = await findOwnedFolder(gate.userId, id);
    if (!folder) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const body = await request.json().catch(() => ({}));
    const action = body.action === 'disable' ? 'disable' : body.action === 'rotate' ? 'rotate' : 'enable';

    if (action === 'disable') {
      folder.intakeEnabled = false;
      // The token is cleared rather than kept, so a disabled folder holds no live
      // credential that could be re-enabled by accident with an old QR still in circulation.
      folder.intakeToken = undefined;
      folder.intakeExpiresAt = undefined;
      await folder.save();
      return NextResponse.json({ folder: folderToDTO(folder.toObject()), url: null });
    }

    const requestedHours = Number(body.hours);
    const hours =
      Number.isFinite(requestedHours) && requestedHours > 0
        ? Math.min(requestedHours, MAX_TTL_HOURS)
        : DEFAULT_TTL_HOURS;

    if (action === 'rotate' || !folder.intakeToken) folder.intakeToken = newIntakeToken();
    folder.intakeEnabled = true;
    folder.intakeExpiresAt = new Date(Date.now() + hours * 3600 * 1000);
    await folder.save();

    return NextResponse.json({
      folder: folderToDTO(folder.toObject()),
      // Built from NEXTAUTH_URL, never the request Host: `trustHost: true` in auth.ts makes
      // the Host header attacker-controllable, and this URL gets encoded into a QR code
      // that may end up printed.
      url: intakeUrl(folder.intakeToken!),
    });
  } catch (error) {
    console.error('Error updating folder intake:', error);
    return NextResponse.json(
      {
        error: 'Failed to update the folder link',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
