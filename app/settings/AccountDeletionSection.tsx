'use client';

import { useState } from 'react';
import { signOut } from 'next-auth/react';
import { runAccountDeletion } from '@/lib/account-deletion-client';
import { purgeOutboxForOwner } from '@/lib/scan/outbox';

const COMPLETION_URL = '/delete-account?complete=1';
export type AccountDeletionRecoveryKind = 'clear-site-data' | 'sign-out';

export function committedDeletionRecovery(outboxPurged: boolean): AccountDeletionRecoveryKind {
  return outboxPurged ? 'sign-out' : 'clear-site-data';
}

export function AccountDeletionRecovery({
  recovery,
  signOutAfterDeletion,
}: {
  recovery: AccountDeletionRecoveryKind;
  signOutAfterDeletion(callbackUrl: string): void | Promise<unknown>;
}) {
  return (
    <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4">
      <p role="alert" className="text-[13px] font-semibold text-red-800">
        {recovery === 'clear-site-data'
          ? 'Your account is already deleted, but PulseBLR could not remove all queued data from this browser.'
          : 'Your account is already deleted, but PulseBLR could not sign this browser out automatically.'}
      </p>
      {recovery === 'clear-site-data' ? (
        <p className="mt-2 text-[12.5px] leading-relaxed text-red-900">
          Clear this site&apos;s stored data in your browser settings, then use the separate sign-out
          action below to finish on this device.
        </p>
      ) : (
        <p className="mt-2 text-[12.5px] leading-relaxed text-red-900">
          Use the separate sign-out action below to finish. The account deletion request will not
          be sent again.
        </p>
      )}
      <button
        type="button"
        onClick={() => void signOutAfterDeletion(COMPLETION_URL)}
        className="mt-3 rounded-full border border-red-700 px-4 py-2 text-[12.5px] font-semibold text-red-800"
      >
        Sign out after deletion
      </button>
    </div>
  );
}

export default function AccountDeletionSection({ userId }: { userId: string }) {
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<AccountDeletionRecoveryKind | null>(null);

  async function deleteAccount() {
    if (confirmation !== 'DELETE' || busy || recovery) return;

    setBusy(true);
    setError(null);
    let serverCommitted = false;
    let outboxPurged = false;

    try {
      await runAccountDeletion(userId, {
        requestDeletion: async () => {
          const response = await fetch('/api/me/account', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ confirmation }),
            cache: 'no-store',
          });
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          serverCommitted = response.ok;
          return { ok: response.ok, error: body.error };
        },
        purgeOutbox: async ownerId => {
          const result = await purgeOutboxForOwner(ownerId);
          outboxPurged = true;
          return result;
        },
        unsubscribePush: async () => {
          const registration = await navigator.serviceWorker?.getRegistration();
          const subscription = await registration?.pushManager?.getSubscription();
          await subscription?.unsubscribe();
        },
        purgeCaches: async () => {
          if (typeof caches === 'undefined') return;
          await Promise.all((await caches.keys()).map(name => caches.delete(name)));
        },
        signOut: callbackUrl => signOut({ callbackUrl }),
      });
    } catch (reason) {
      if (serverCommitted) {
        setRecovery(committedDeletionRecovery(outboxPurged));
        setError(null);
      } else {
        setError(reason instanceof Error ? reason.message : 'Account deletion failed');
      }
      setBusy(false);
    }
  }

  return (
    <section id="delete-account" className="rounded-[var(--r-flat)] border border-red-300 p-5">
      <h2 className="text-[16px] font-bold text-red-700">Delete account</h2>
      <p className="mt-1 text-[13px] leading-relaxed text-[var(--ink-2)]">
        This permanently removes your private PulseBLR data, saved contacts, events, notes,
        tokens, and notification records.
      </p>

      {recovery ? (
        <AccountDeletionRecovery
          recovery={recovery}
          signOutAfterDeletion={callbackUrl => signOut({ callbackUrl })}
        />
      ) : (
        <>
          <label
            htmlFor="delete-confirmation"
            className="mt-4 block text-[12px] font-semibold"
          >
            Type DELETE to confirm
          </label>
          <input
            id="delete-confirmation"
            value={confirmation}
            onChange={event => setConfirmation(event.target.value)}
            autoComplete="off"
            className="mt-2 w-full rounded-lg border border-[var(--rule)] bg-[var(--surface)] px-3 py-2"
          />
          {error && (
            <p role="alert" className="mt-2 text-[12px] text-red-700">
              {error}
            </p>
          )}
          <button
            type="button"
            disabled={confirmation !== 'DELETE' || busy}
            onClick={() => void deleteAccount()}
            className="mt-4 rounded-full bg-red-700 px-5 py-2.5 text-[13px] font-semibold text-white disabled:opacity-40"
          >
            {busy ? 'Deleting…' : 'Delete account permanently'}
          </button>
        </>
      )}
    </section>
  );
}
