import User from './models/User';

/**
 * Get the `User` document for a session, creating it if it is missing.
 *
 * WHY THIS IS NOT JUST `findOne`, AND WHY IT LIVES IN ITS OWN MODULE.
 *
 * The JWT is the source of truth for identity; the `User` row is derived from it by the `jwt`
 * callback in `auth.ts` at sign-in. A route that fails when the row is absent therefore breaks for
 * a perfectly valid session — and the row genuinely does go missing:
 *
 *   - `User.email` is UNIQUE, so
 *     `findOneAndUpdate({ googleId }, { email }, { upsert: true })` throws E11000 whenever a
 *     document with that email already exists under a DIFFERENT googleId. `auth.ts` catches and
 *     logs it, leaving no row at all. The dev-only provider hits this every single time on an
 *     account that has also signed in with real Google, because its googleId is
 *     `devlogin:<email>` rather than the Google `sub` — which is exactly how it was found.
 *   - or the database was reset while a session cookie stayed valid.
 *
 * Resolution order: googleId, then email (ADOPTING the existing row rather than fighting the
 * unique index), then create. An adopted row's `googleId` is deliberately left alone — rewriting
 * it would reassign a real account's identity to whichever session happened to find it first.
 *
 * It has no heavy imports on purpose: `auth.ts` runs on every request, so this must not drag in
 * the company registry or the Contact/Folder models the way importing it from
 * `lib/contacts/service.ts` would.
 */
export async function ensureUser(userId: string, email?: string | null, name?: string | null) {
  const byId = await User.findOne({ googleId: userId });
  if (byId) return byId;

  const normalizedEmail = email?.trim().toLowerCase();
  if (normalizedEmail) {
    const byEmail = await User.findOne({ email: normalizedEmail });
    if (byEmail) return byEmail;
  }

  return User.create({
    googleId: userId,
    // A placeholder keeps the required+unique email satisfied for the rare case of a session with
    // no email at all, rather than throwing and leaving the caller with nothing.
    email: normalizedEmail || `${userId}@placeholder.invalid`,
    name: name?.trim() || normalizedEmail?.split('@')[0] || 'PulseBLR user',
  });
}
