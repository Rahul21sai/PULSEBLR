// Who counts as an admin. ONE definition, imported by everything that asks.
//
// Three places need this answer and they must never disagree: the API guards
// (lib/api-auth.ts), the JWT/session callbacks (auth.ts) so the client can hide admin
// UI, and the /admin page's own server-side check. A second copy of this comparison is
// how a UI that hides a button ends up guarding an endpoint that doesn't.
//
// Hiding admin controls in the UI is a COURTESY, not the security boundary. The real
// boundary is requireAdmin() on the route. Both exist because a user who can see a
// button they cannot use is a bug, and a button they should not be able to use that
// works is a vulnerability.

/** Emails allowed to administer this deployment, lower-cased, from ADMIN_EMAILS. */
export function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);
}

/** Is the allowlist configured at all? Unset means admin features are switched off. */
export function isAdminConfigured(): boolean {
  return adminEmails().length > 0;
}

/**
 * Is this email an admin?
 *
 * Returns false when ADMIN_EMAILS is unset — FAIL CLOSED. Falling back to "any signed-in
 * user is admin" on a misconfigured deploy would hand control of the whole corpus to
 * anyone with a Google account.
 */
export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const list = adminEmails();
  if (list.length === 0) return false;
  return list.includes(email.toLowerCase());
}
