// DEV-ONLY sign-in, so the tracker can be exercised without completing Google OAuth.
//
// WHY THIS EXISTS: Google's consent screen cannot load in a localhost-only preview pane,
// so roughly 800 lines of tracker code — the kanban, the connections form, follow-ups,
// optimistic rollback — had never once executed. Untested code that handles a user's
// private notes is a worse risk than a bypass that cannot exist in production.
//
// ─────────────────────────────────────────────────────────────────────────────
// THIS MUST NEVER BE REACHABLE IN PRODUCTION.
//
// It is gated on TWO independent conditions, because one is a single typo away from
// being an authentication bypass on a public site:
//
//   1. NODE_ENV !== 'production'  — `next build` sets NODE_ENV=production, so a
//      production bundle fails this even if the env flag is set.
//   2. DEV_LOGIN === 'true'       — an explicit, deliberately verbose opt-in. Absent
//      from .env.example on purpose: nobody should enable it by copying a template.
//
// Both must hold. `scripts/diag-dev-login.ts` asserts the provider is absent whenever
// either is false, and diag-api-auth.ts continues to assert that every mutating
// endpoint refuses an unauthenticated caller regardless.
// ─────────────────────────────────────────────────────────────────────────────

/** Is the dev-only credentials provider active? Both conditions must hold. */
export function devLoginEnabled(): boolean {
  return process.env.NODE_ENV !== 'production' && process.env.DEV_LOGIN === 'true';
}

/**
 * A stable synthetic account id for a dev session.
 *
 * Prefixed so a dev-created User document is obvious in the database and can never be
 * mistaken for a real Google `sub` (which is all digits).
 */
export function devUserId(email: string): string {
  return `devlogin:${email.toLowerCase()}`;
}
