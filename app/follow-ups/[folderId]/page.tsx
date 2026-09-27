import FollowUpsClient from './FollowUpsClient';

/**
 * The morning-after screen: the people you met at one event, each with a one-tap drafted follow-up.
 * Opened from the follow-up push notification (`lib/notifications/followup-nudge.ts`), and linkable
 * from anywhere a folder is shown.
 *
 * A thin SERVER shell that awaits `params` (a Promise in this Next version) and reads no user data —
 * the same arrangement as `app/people/[id]/page.tsx`. `/follow-ups` is in `PROTECTED_PATHS`, so
 * `ProtectedRouteGate` draws the sign-in wall; every byte of data comes from
 * `GET /api/follow-ups/[folderId]`, which re-authorises the id against the session and answers 404
 * for a folder that is not the caller's.
 *
 * Its own top-level segment rather than `/folders/[id]/…` because a notification's landing screen is a
 * task list, not the folder's table, and because nothing under `/folders` is this feature's to edit.
 * Safe against the prefix trap in `lib/protected-routes.ts`: no public route begins `/follow-ups`,
 * and `/f/<token>` does not.
 */
export default async function FollowUpsPage({ params }: { params: Promise<{ folderId: string }> }) {
  const { folderId } = await params;
  return <FollowUpsClient folderId={folderId} />;
}
