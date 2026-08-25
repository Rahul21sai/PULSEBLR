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
  '/scan',
  '/card',
] as const;

/** Does this path require a signed-in user? */
export function isProtectedPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return PROTECTED_PATHS.some(p => pathname === p || pathname.startsWith(`${p}/`) || pathname.startsWith(`${p}?`));
}
