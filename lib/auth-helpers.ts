/**
 * Shared helper: call inside any API route to get the current user's ID.
 * Returns null if the request is unauthenticated.
 */
import { auth } from '@/auth';

export async function getCurrentUserId(): Promise<string | null> {
  const session = await auth();
  return session?.user?.id ?? null;
}
