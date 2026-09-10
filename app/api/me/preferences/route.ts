import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongodb';
import { requireUser } from '@/lib/api-auth';
import { ensureUser } from '@/lib/user-record';
import { auth } from '@/auth';
import {
  mergePreferences,
  preferenceError,
  readPreferences,
  hasRankingPreferences,
  type UserPreferences,
} from '@/lib/events/relevance';

/**
 * The signed-in user's feed and notification preferences.
 *
 * GET returns them plus two derived booleans the UI needs and must not compute for itself.
 * PUT is a PATCH in HTTP clothing — see `mergePreferences` — and stamps `onboardedAt`.
 *
 * ── GUARD FIRST, VALIDATE SECOND. ────────────────────────────────────────────────────────────
 * `requireUser()` runs before the body is read on PUT. Backwards, an anonymous caller sending a
 * bad payload would receive 400 instead of 401 — which tells a stranger their body parsed and
 * validated far enough to be judged, and breaks the contract `scripts/diag-api-auth.ts` asserts
 * for every mutating route. The validator is the newest thing in this file, which is exactly when
 * this ordering gets inverted: the natural place to put validation is the top of the handler, and
 * the top of the handler is above the guard.
 *
 * ── NO `details: err.message` ON THE 500 BRANCH. ─────────────────────────────────────────────
 * On a Mongoose error that string names the model and the schema path. `mergePreferences` runs
 * before `connectDB()` and rejects every shape the schema would have rejected, so a 400 is
 * answered with field-named issues of our own wording and the 500 carries nothing.
 */

/** What the client gets. Flat, and every field is present — absence is resolved server-side. */
type PreferencesDTO = UserPreferences & {
  /** Has this user been ASKED yet? `false` is what shows the onboarding prompt in the feed. */
  onboarded: boolean;
  /**
   * Does the stored set say anything the ranking can act on?
   *
   * Computed here rather than in the browser because the rule is not obvious — an all-seven-day
   * `evenings` selection says exactly what an empty one says, and the notification fields say
   * nothing about the feed at all. Two implementations of that would drift, and the symptom would
   * be a `For you` tab that the UI offers and the ranking cannot honour.
   */
  personalised: boolean;
};

function toDTO(preferences: UserPreferences, onboardedAt: Date | null | undefined): PreferencesDTO {
  return {
    ...preferences,
    onboarded: Boolean(onboardedAt),
    personalised: hasRankingPreferences(preferences),
  };
}

export async function GET() {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  try {
    await connectDB();
    const session = await auth();
    // Created if absent rather than 404, exactly as `/api/me/card` does: the JWT is the identity
    // and the `User` row is derived from it, so a valid session can legitimately have no row.
    const user = await ensureUser(gate.userId, session?.user?.email, session?.user?.name);
    const stored = user.preferences;
    return NextResponse.json({
      preferences: toDTO(readPreferences(stored), stored?.onboardedAt ?? null),
    });
  } catch (error) {
    console.error('Error reading preferences:', error);
    return NextResponse.json({ error: 'Failed to read your preferences' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  // Read and shape-check the body BEFORE touching the database. A malformed request needs no
  // connection to refuse, and `request.json()` throwing on a non-JSON body is handled here rather
  // than becoming a 500 one layer down.
  const body = await request.json().catch(() => null);
  if (body === null) {
    return NextResponse.json(
      preferenceError([{ field: 'body', message: 'Expected a JSON object.' }]),
      { status: 400 }
    );
  }

  try {
    await connectDB();
    const session = await auth();
    const user = await ensureUser(gate.userId, session?.user?.email, session?.user?.name);

    /*
     * MERGED ONTO WHAT IS STORED, not onto the defaults — the difference is the whole reason
     * onboarding's SKIP button is safe. Skip sends `{}`, so a user who opens the flow a second
     * time, changes nothing and skips must come out with the preferences they already had. Merging
     * onto defaults would silently reset them, which is the opposite of "skip".
     */
    const currentPreferences = readPreferences(user.preferences);
    const { preferences, issues } = mergePreferences(currentPreferences, body);
    if (!preferences) return NextResponse.json(preferenceError(issues), { status: 400 });

    /*
     * ASSIGN + `.save()`, not `findOneAndUpdate`. `ensureUser` has already handed us the document,
     * and going through the document path keeps this consistent with `/api/me/card` — which has to
     * use it, because `Contact`/`Folder`-style `pre('validate')` hooks do not run on
     * `findOneAndUpdate`. `User` has no such hook today; matching the shape means adding one later
     * does not quietly skip this write path.
     *
     * `onboardedAt` is stamped by the SERVER on any successful save, including a skip. It records
     * "this user has been asked", which is the only thing the feed's prompt needs to know, and it
     * is deliberately not accepted from the body — a client that could set it would be able to
     * dismiss the prompt for a user who never saw the flow. Set once and never refreshed, so it
     * stays the date they were first asked rather than the date they last fiddled with a chip.
     */
    const onboardedAt = user.preferences?.onboardedAt ?? new Date();
    user.set('preferences', { ...preferences, onboardedAt });
    await user.save();

    return NextResponse.json({ preferences: toDTO(preferences, onboardedAt) });
  } catch (error) {
    console.error('Error saving preferences:', error);
    return NextResponse.json({ error: 'Failed to save your preferences' }, { status: 500 });
  }
}
