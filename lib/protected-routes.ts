/**
 * Which pages require a signed-in user — ONE list, so the gate and any future caller cannot
 * drift apart.
 *
 * WHY THIS MOVED OUT OF `proxy.ts`. The proxy decided this by looking for a session COOKIE BY
 * NAME, which is the wrong instrument for the job in two ways:
 *
 *   1. IT PROVIDES NO SECURITY. The edge runtime has no secret to verify a JWT with, so the
 *      check could only ever be "is a cookie present". Measured against production:
 *      `Cookie: __Secure-authjs.session-token=dummy` returned **200** on every protected page.
 *      Anyone could walk past it by inventing a cookie, so nothing was ever actually gated —
 *      the real boundary is `requireUser()` / `requireAdmin()` on each API route, plus
 *      `/admin`'s own server-side session + allowlist check.
 *
 *   2. IT PRODUCED FALSE NEGATIVES ON REAL SESSIONS, which is a total lockout. Reported and
 *      then confirmed from the app's own screen: `/login?callbackUrl=%2Ffolders` rendered
 *      "You're already signed in as <the user's address>" — so the browser held a valid session
 *      that `/api/auth/session` could read, while the proxy had just refused the navigation
 *      that led there. A check with no upside and that failure mode is worth deleting, not
 *      tuning.
 *
 * So the gate now asks the SESSION, not a cookie name (`ProtectedRouteGate`). That question has
 * one right answer and it is the same one the API routes get.
 *
 * PREFIX MATCHING, and the trap it carries. Matching is `startsWith`, so each entry also covers
 * every sibling beginning with those characters. That is why the public pages of the scan
 * feature live at deliberately different top-level segments:
 *
 *   /folders, /scan, /card   PRIVATE — listed here
 *   /c/<token>               PUBLIC  — somebody's card, opened from a QR by a stranger
 *   /f/<token>               PUBLIC  — "add yourself to this folder"
 *
 * `'/c/abc'.startsWith('/card')` is false, which is the only reason `/card` does not capture
 * `/c/…`. Never add a bare `/c` or `/f` here, and never nest a public page under a listed
 * prefix — a stranger opening a QR code would hit a sign-in wall for an account they do not have.
 */
export const PROTECTED_PATHS = [
  '/dashboard',
  '/tracker',
  '/add-event',
  '/settings',
  '/admin',
  '/folders',
  /**
   * The cross-folder People list. It was in `proxy.ts`'s own `PROTECTED` array before that file
   * stopped gating pages, so it has to be re-listed here or the page ends up with no gate at all.
   *
   * Safe against the prefix trap above: no public route begins with `/people`.
   */
  '/people',
  '/scan',
  '/card',
] as const;

/** Does this path require a signed-in user? */
export function isProtectedPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return PROTECTED_PATHS.some(p => pathname === p || pathname.startsWith(`${p}/`) || pathname.startsWith(`${p}?`));
}

/**
 * Pages that require an ADMIN, not merely a signed-in user.
 *
 * `/add-event` WAS listed here and has been removed, because the argument for it no longer holds.
 * It read: "a dead end rather than a feature — `POST /api/events` is gated by `requireAdmin()`, so
 * a regular user could fill the whole form and only discover on submit that the write was refused."
 * That was correct when written. The user-added-events work then changed the route: it is
 * `requireUser()` now, and a regular user gets a real outcome — `visibility: 'private'` for an
 * event only they can see, or `'pending'` to offer it to the shared feed. Only
 * `visibility: 'public'` still re-checks the admin allowlist, inside the handler.
 *
 * So the form is no longer a dead end, and admin-gating it would remove the feature rather than
 * protect anything. The curation concern that argument raised — a stranger's `applyLink` reaching
 * every visitor — is answered by the review queue at /admin → Submissions, which is where it
 * belongs: at the point of publication, not at the entry point.
 *
 * `/add-event` remains in `PROTECTED_PATHS`, so it still requires a signed-in user.
 *
 * `/admin` is listed for completeness, but it does NOT depend on this: it is a server component
 * that re-checks the session and the `ADMIN_EMAILS` allowlist and `redirect()`s before any admin
 * markup is generated. Both entries here are a COURTESY — they decide what to draw. The real
 * boundary is `requireAdmin()` on each route, so editing `isAdmin` in devtools buys a 403.
 */
export const ADMIN_ONLY_PATHS = ['/admin'] as const;

/** Does this path require an admin? */
export function isAdminOnlyPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return ADMIN_ONLY_PATHS.some(
    p => pathname === p || pathname.startsWith(`${p}/`) || pathname.startsWith(`${p}?`)
  );
}
