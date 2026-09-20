export interface AccountDeletionClientDependencies {
  requestDeletion(): Promise<{ ok: boolean; error?: string }>;
  purgeOutbox(userId: string): Promise<unknown>;
  unsubscribePush(): Promise<unknown>;
  purgeCaches(): Promise<unknown>;
  signOut(callbackUrl: string): Promise<unknown>;
}

/**
 * Remove a deleted account's client-side data only after its server-side deletion commits.
 */
export async function runAccountDeletion(
  userId: string,
  deps: AccountDeletionClientDependencies
): Promise<void> {
  const response = await deps.requestDeletion();
  if (!response.ok) throw new Error(response.error || 'Account deletion failed');

  await deps.purgeOutbox(userId);
  await deps.unsubscribePush().catch(() => undefined);
  await deps.purgeCaches().catch(() => undefined);
  await deps.signOut('/delete-account?complete=1');
}
