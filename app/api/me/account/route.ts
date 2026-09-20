import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/api-auth';
import { canonicalOrigin } from '@/lib/canonical-origin';
import {
  deleteAccountData,
  hasExactCanonicalOrigin,
  parseAccountDeletionConfirmation,
  type AccountDeletionCounts,
} from '@/lib/account-deletion';

type Dependencies = {
  requireUser: typeof requireUser;
  deleteAccountData: (userId: string) => Promise<AccountDeletionCounts>;
  expectedOrigin: () => string;
};

export function createDeleteAccountHandler(deps: Dependencies) {
  return async function DELETE(request: NextRequest): Promise<NextResponse> {
    const gate = await deps.requireUser();
    if ('response' in gate) return gate.response;

    if (!hasExactCanonicalOrigin(request.headers.get('origin'), deps.expectedOrigin())) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await request.json().catch(() => null);
    const confirmation = parseAccountDeletionConfirmation(body);
    if (!confirmation.ok) {
      return NextResponse.json({ error: confirmation.error }, { status: 400 });
    }

    try {
      const counts = await deps.deleteAccountData(gate.userId);
      return NextResponse.json(
        { deleted: true, counts },
        { status: 200, headers: { 'Cache-Control': 'no-store' } },
      );
    } catch (error) {
      console.error('Account deletion transaction failed', error instanceof Error ? error.name : 'unknown');
      return NextResponse.json(
        { error: 'Account deletion could not be confirmed. It is safe to retry.' },
        { status: 503, headers: { 'Cache-Control': 'no-store' } },
      );
    }
  };
}

export const DELETE = createDeleteAccountHandler({ requireUser, deleteAccountData, expectedOrigin: canonicalOrigin });
