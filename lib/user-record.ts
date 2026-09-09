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
 * WHY AN ADOPTED ROW'S `card` IS DROPPED. Adoption keys on EMAIL while everything else private is
 * keyed on the Google `sub`: `Contact`, `Folder` and `TrackerEntry` all filter on `userId`, so
 * they stay separated. The `User` row does not — it holds `card`, and a card is a PUBLISHED
 * identity with a live credential in it. An email address that changes hands (a Workspace address
 * reissued to a new employee is the realistic case) would otherwise mean the new Google identity
 * inherits:
 *
 *   · `card.phone`, returned by `GET /api/me/card` to the session owner UNCONDITIONALLY — i.e.
 *     even when the previous holder had `revealPhone: false` and never published it, and
 *   · `card.token`, so every QR the previous holder printed or screenshotted now resolves through
 *     an account they do not control. A printed QR outlives the row it was minted from, which is
 *     the same asymmetry `lib/canonical-origin.ts` throws to protect.
 *
 * So the card is cleared, not carried. Dropping it is safe in a way that refusing to adopt is not:
 * adoption exists because `User.email` is unique and NOT adopting leaves a valid session with no
 * row at all (that is the E11000 bug above), while a cleared card simply means the next visit to
 * `/card` mints a fresh token — which is exactly what a new person's card should be.
 *
 * `targetCompanies` and `contactTags` are deliberately LEFT in place: they are preferences rather
 * than a published identity or a credential, and they seed from a shared default list anyway.
 * That is a judgement call, not a proof — if a recycled address is ever more than theoretical
 * here, clear them too.
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
    if (byEmail) {
      /*
       * The row was found by EMAIL, so it belongs to a different googleId by construction — the
       * lookup above would have returned it otherwise. Strip the card before handing it over; see
       * the header for why the card specifically.
       *
       * `$unset` rather than assigning undefined and saving: `UserSchema.index({ 'card.token' },
       * { unique, sparse })` must actually stop indexing this row, and an unset key is what the
       * sparse index skips. Written straight through the model to keep it a single round trip,
       * then mirrored onto the in-memory document so the caller does not see a stale card.
       *
       * Idempotent, and that matters — the dev-login provider hits this branch on EVERY sign-in
       * for an account that has also used real Google (its googleId is `devlogin:<email>`), so
       * after the first clear there is no `card` and this writes nothing.
       */
      if (byEmail.card) {
        console.warn(
          `ensureUser: adopting the User row for ${normalizedEmail} under a new googleId; ` +
            'clearing its card so no token or phone number carries over.'
        );
        await User.updateOne({ _id: byEmail._id }, { $unset: { card: '' } });
        byEmail.set('card', undefined);
      }
      return byEmail;
    }
  }

  return User.create({
    googleId: userId,
    // A placeholder keeps the required+unique email satisfied for the rare case of a session with
    // no email at all, rather than throwing and leaving the caller with nothing.
    email: normalizedEmail || `${userId}@placeholder.invalid`,
    name: name?.trim() || normalizedEmail?.split('@')[0] || 'PulseBLR user',
  });
}
