/**
 * The MORNING-AFTER FOLLOW-UP NUDGE, as pure functions.
 *
 * "You met 4 people at GIDS. Draft follow-ups?" — one push notification, the day after an event you
 * captured people at, opening a screen with a one-tap draft per person. The product's point is
 * leaving events with useful contacts; following up is the step people forget, and the morning after
 * is when a message still reads as "we just met" rather than as a cold approach.
 *
 * Everything that DECIDES lives here and is pinned by `tests/followup-nudge.test.ts` without a
 * database. `./followup-nudge.ts` is the thin mongoose + web-push half that loads rows, hands them to
 * `planFollowUpNudges()`, claims `ReminderLog` rows and sends. Same split as `./reminder-policy.ts`
 * and `./push.ts`, for the same reason: the rules a send must obey are the part worth pinning.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * WHO QUALIFIES — the decisions, each one a negative case in the test file.
 *
 *   1. CONTACTS ARE THE TRIGGER, NOT THE TRACKER. A folder with zero contacts nudges nobody, even
 *      when the tracker says Attended or Confirmed — which is exactly the folder
 *      `ensureFolderForEvent()` auto-creates on Confirmed. There is nothing to follow up, and a
 *      notification whose landing screen is empty teaches the reader to ignore the next one. The
 *      tracker is therefore not even an input here, so it cannot leak in.
 *
 *   2. "FOR IT" MEANS THE FOLDER. A contact belongs to an event through its folder. A folder linked to
 *      an event (`Folder.eventId`) is dated by that EVENT'S END — `endDateTime ?? startDateTime` —
 *      because a three-day conference must be nudged the morning after its last day, not after its
 *      first, and a follow-up sent while someone is still at the venue is premature.
 *
 *   3. HAND-MADE FOLDERS COUNT, dated by their own `eventDate`. This is the decision that makes the
 *      feature fire at all: CLAUDE.md §9 records that `Folder.eventId` is null for every folder made by
 *      hand, and a hand-made folder is how you capture people at anything the scraper never saw (an
 *      invite-only evening, Google I/O Connect). `app/folders/page.tsx` defaults a new folder's date to
 *      TODAY at noon IST, so a folder made at the event is dated the day of the event. Excluding them
 *      would leave the nudge for the minority of folders the tracker created.
 *
 *      A linked folder whose event has since been hard-deleted (`pruneStale()` used to do this; see
 *      CLAUDE.md §18) falls back to its own `eventDate`, which `ensureFolderForEvent()` copied from the
 *      event's start. Neither date → no nudge: an undated folder cannot be "yesterday".
 *
 *   4. ENDED YESTERDAY, IN IST, and only yesterday. Today is premature (you may still be there), two
 *      days ago is stale AND would double-count against a run that already had its chance. Every day
 *      is "yesterday" on exactly one morning, so no event falls in a gap between runs — the price is
 *      that a morning the cron does not run is a morning's nudges lost, which is the right direction to
 *      fail for a nice-to-have. Day keys come from `lib/format.ts`, never the ambient clock.
 *
 *   5. AT LEAST ONE CONTACT STILL TO FOLLOW UP. `Contact.followedUp === true` is the completion flag
 *      `completeContactFollowUp()` writes, and it is what the landing screen's "Done" writes too. If
 *      every person is done, the nudge is noise.
 *
 *   6. ARCHIVED FOLDERS ARE SILENT. Archiving is the user saying "get this off my list" (§9).
 *
 *   7. ONLY THE USER'S OWN ROWS. The loader already scopes every query by `userId`; this re-checks,
 *      because an optional scope fails open and the unit under test must not trust its caller.
 *
 * ONCE PER EVENT, NOT PER FOLDER. Folders linked to the same event collapse into one SUBJECT (keyed on
 * the event id) — two folders for one event is one evening, one notification. An unlinked folder is
 * its own subject (keyed on the folder id). See `FOLLOWUP_NUDGE_KIND`.
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * CONSENT. Push consent is the `PushSubscription` row (`./push.ts`) — the user clicked, and granted
 * an OS permission. This nudge is a different PURPOSE from "a reminder about an event you saved", so
 * it gets its own opt-out, `User.pushFollowUpNudges`, which defaults to ON when absent. Reasoning, in
 * `followUpNudgesEnabled()` below. It never reads the email flag: `tests/followup-nudge.test.ts`
 * asserts both files here are free of it, mirroring `tests/push-policy.test.ts`.
 */
import { dayKeyIST, dayKeyOffsetIST } from '../format';
import {
  applyReminderCaps,
  DEFAULT_MAX_PUSHES_PER_DAY,
  pushEventsThisRun,
  PUSH_PAYLOAD_MAX_BYTES,
  type PushPayload,
} from './reminder-policy';

/**
 * Follow-up nudges one run may fire for one user.
 *
 * TWO, not one, because the case it exists for is real: a conference day with an evening meetup
 * after it is two events, two sets of people, two screens. One would silently drop the second event's
 * people for good — tomorrow it is no longer "yesterday". Still bounded by the shared phone budget
 * (`DEFAULT_MAX_PUSHES_PER_DAY` across every push kind), which reminders reach first because the
 * sender runs them first.
 */
export const DEFAULT_MAX_FOLLOWUP_NUDGES_PER_RUN = 2;

/* ── Inputs: the shapes the loader reads, structurally, so this file stays free of mongoose ── */

type DateLike = Date | string | null | undefined;

export interface NudgeFolderRow {
  id: string;
  userId: string;
  name: string;
  eventId?: string | null;
  eventDate?: DateLike;
  archivedAt?: DateLike;
  createdAt?: DateLike;
}

export interface NudgeEventRow {
  id: string;
  startDateTime?: DateLike;
  endDateTime?: DateLike;
}

export interface NudgeContactRow {
  userId: string;
  folderId: string;
  followedUp?: boolean | null;
}

/** The one preference this feature reads off a `User`. Absent means ON — see below. */
export interface NudgePreferenceLike {
  pushFollowUpNudges?: boolean | null;
}

/**
 * May this user be sent follow-up nudges, given they have a push subscription at all?
 *
 * DEFAULT ON, AND WHY THAT IS NOT THE SILENT OPT-IN `remindersEnabled()` REFUSES. That rule exists
 * because the email flag's schema default is `true` for people who were NEVER ASKED anything. Here the
 * precondition is a `PushSubscription` row, which only exists after the user tapped "Turn on
 * notifications" and granted the OS prompt — they were asked, about notifications from this app, on
 * this device. The nudge is about people THEY captured, fires at most once per event, shares the same
 * three-a-day budget, and the Settings copy beside that button now names it with its own switch.
 * Making it opt-in would mean the feature reaches only people who go looking for a switch they do
 * not know exists, which for a "the step people forget" feature is the same as not shipping it.
 *
 * Only an explicit `false` turns it off: a stray value is not a refusal, but it is not stored either,
 * because the API validator accepts booleans only.
 */
export function followUpNudgesEnabled(user: NudgePreferenceLike | null | undefined): boolean {
  return user?.pushFollowUpNudges !== false;
}

/* ── Output ── */

export interface FollowUpNudge {
  /** The `ReminderLog.eventId` value: the event id when linked, else the folder id. */
  subjectId: string;
  /** The linked event, or null for a hand-made folder. */
  eventId: string | null;
  /** The folder the notification opens. Among siblings, the one with the most people still to do. */
  folderId: string;
  /** Every folder in this subject (siblings linked to one event). */
  folderIds: string[];
  /** The landing folder's NAME — the user's own label, denormalised, never a join to `Event.title`. */
  title: string;
  /** Everyone captured for it. */
  metCount: number;
  /** Of those, not yet followed up. Always ≥ 1 on a nudge. */
  pendingCount: number;
  /** The IST day it ended — always yesterday on a nudge; carried for the log row and the report. */
  endedDayKey: string;
  /** The instant it ended, for `ReminderLog.eventStartDateTime`. */
  endedAt: Date;
}

export type FollowUpPlanOutcome =
  | 'send'
  | 'no-subscription'
  | 'opted-out'
  | 'nothing-due'
  | 'already-sent'
  | 'daily-cap';

export interface FollowUpPlan {
  outcome: FollowUpPlanOutcome;
  /** Every subject that qualifies on the data, before the log and the caps. */
  candidates: FollowUpNudge[];
  /** Of those, how many a `ReminderLog` row already covers. */
  alreadyClaimed: number;
  /** What this run should claim and send, best first. */
  send: FollowUpNudge[];
  /** Held back by a cap. Reported, never silently dropped. */
  deferred: FollowUpNudge[];
}

function validDate(value: DateLike): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isArchived(value: DateLike): boolean {
  // Any stored value means archived — an unparseable one included. Reading garbage as "not archived"
  // would nudge about a folder the user put away.
  return value !== null && value !== undefined && value !== '';
}

/**
 * Which subjects qualify on the data alone: ended yesterday (IST), owned, not archived, with at least
 * one contact still to follow up. No log, no caps, no consent — `planFollowUpNudges` adds those.
 *
 * Sorted by `pendingCount` descending, then title, so a cap keeps the evening with the most people.
 */
export function followUpCandidates(input: {
  userId: string;
  now: Date;
  folders: NudgeFolderRow[];
  events: NudgeEventRow[];
  contacts: NudgeContactRow[];
}): FollowUpNudge[] {
  const { userId, now } = input;
  const yesterday = dayKeyOffsetIST(-1, now);

  const eventsById = new Map(input.events.map(event => [String(event.id), event]));

  const owned = input.folders.filter(
    folder => folder.userId === userId && !isArchived(folder.archivedAt)
  );

  /* Contacts per folder, counted once. Other users' rows are dropped here — rule 7. */
  const counts = new Map<string, { met: number; pending: number }>();
  for (const contact of input.contacts) {
    if (contact.userId !== userId) continue;
    const key = String(contact.folderId);
    const entry = counts.get(key) ?? { met: 0, pending: 0 };
    entry.met += 1;
    if (contact.followedUp !== true) entry.pending += 1;
    counts.set(key, entry);
  }

  /* Group into subjects: linked folders by event, unlinked folders alone. */
  const subjects = new Map<string, NudgeFolderRow[]>();
  for (const folder of owned) {
    const subjectId = folder.eventId ? String(folder.eventId) : String(folder.id);
    const group = subjects.get(subjectId) ?? [];
    group.push(folder);
    subjects.set(subjectId, group);
  }

  const out: FollowUpNudge[] = [];
  for (const [subjectId, group] of subjects) {
    const byAge = [...group].sort((a, b) => {
      const at = validDate(a.createdAt)?.getTime() ?? 0;
      const bt = validDate(b.createdAt)?.getTime() ?? 0;
      return at - bt || String(a.id).localeCompare(String(b.id));
    });
    const eventId = byAge[0].eventId ? String(byAge[0].eventId) : null;

    /* When did it end? Rule 2 and 3. */
    let endedAt: Date | null = null;
    const event = eventId ? eventsById.get(eventId) : undefined;
    if (event) {
      endedAt = validDate(event.endDateTime) ?? validDate(event.startDateTime);
    }
    if (!endedAt) {
      // Unlinked, or linked to an event that no longer exists: the folder's own date.
      for (const folder of byAge) {
        endedAt = validDate(folder.eventDate);
        if (endedAt) break;
      }
    }
    if (!endedAt) continue;

    const endedDayKey = dayKeyIST(endedAt);
    if (endedDayKey !== yesterday) continue; // Rule 4.

    let met = 0;
    let pending = 0;
    let landing = byAge[0];
    let landingPending = -1;
    for (const folder of byAge) {
      const c = counts.get(String(folder.id)) ?? { met: 0, pending: 0 };
      met += c.met;
      pending += c.pending;
      if (c.pending > landingPending) {
        landing = folder;
        landingPending = c.pending;
      }
    }
    // Rules 1 and 5 in one test: zero contacts means zero pending, so a folder with nobody in it and a
    // folder where everybody is done are refused by the same line. (A separate `met === 0` check was
    // tried and removed — it could never fire on its own, so no test could tell it was there.)
    if (pending === 0) continue;

    out.push({
      subjectId,
      eventId,
      folderId: String(landing.id),
      folderIds: byAge.map(folder => String(folder.id)),
      title: (landing.name || '').trim() || 'yesterday’s event',
      metCount: met,
      pendingCount: pending,
      endedDayKey,
      endedAt,
    });
  }

  return out.sort(
    (a, b) => b.pendingCount - a.pendingCount || a.title.localeCompare(b.title) || a.subjectId.localeCompare(b.subjectId)
  );
}

/**
 * The whole decision for one user and one run.
 *
 * The order of the refusals is the order of the report, and each is its own outcome so "nothing was
 * sent" is never a mystery: no subscription (no consent), opted out, nothing ended yesterday with
 * people still to do, everything already notified, or the day's phone budget spent.
 *
 * `pushesSentToday` must count EVERY push kind since IST midnight (`PUSH_CHANNEL_KINDS`), which is what
 * makes the reminder that went out ten seconds earlier in the same run take its share of the budget.
 */
export function planFollowUpNudges(input: {
  userId: string;
  now: Date;
  hasSubscription: boolean;
  preference: NudgePreferenceLike | null | undefined;
  folders: NudgeFolderRow[];
  events: NudgeEventRow[];
  contacts: NudgeContactRow[];
  claimedSubjectIds: Iterable<string>;
  pushesSentToday: number;
  maxPushesPerDay?: number;
  maxNudgesPerRun?: number;
}): FollowUpPlan {
  const empty = (outcome: FollowUpPlanOutcome, candidates: FollowUpNudge[] = []): FollowUpPlan => ({
    outcome,
    candidates,
    alreadyClaimed: 0,
    send: [],
    deferred: [],
  });

  if (!input.hasSubscription) return empty('no-subscription');
  if (!followUpNudgesEnabled(input.preference)) return empty('opted-out');

  const candidates = followUpCandidates(input);
  if (candidates.length === 0) return empty('nothing-due');

  const claimed = new Set([...input.claimedSubjectIds].map(String));
  const unclaimed = candidates.filter(candidate => !claimed.has(candidate.subjectId));
  const alreadyClaimed = candidates.length - unclaimed.length;
  if (unclaimed.length === 0) return { ...empty('already-sent', candidates), alreadyClaimed };

  const maxPushesPerDay = input.maxPushesPerDay ?? DEFAULT_MAX_PUSHES_PER_DAY;
  const capped = applyReminderCaps({
    candidates: unclaimed,
    emailsSentToday: input.pushesSentToday,
    maxEmailsPerDay: maxPushesPerDay,
    // One budget: what is left of the phone's day, clamped to this pass's own per-run cap.
    maxEventsPerEmail: pushEventsThisRun({
      pushesSentToday: input.pushesSentToday,
      maxPushesPerDay,
      maxEventsPerRun: input.maxNudgesPerRun ?? DEFAULT_MAX_FOLLOWUP_NUDGES_PER_RUN,
    }),
  });

  if (capped.send.length === 0) {
    return {
      outcome: capped.blockedBy === 'daily-cap' ? 'daily-cap' : 'nothing-due',
      candidates,
      alreadyClaimed,
      send: [],
      deferred: capped.deferred,
    };
  }
  return { outcome: 'send', candidates, alreadyClaimed, send: capped.send, deferred: capped.deferred };
}

/* ── The notification ── */

const TITLE_EVENT_MAX_CHARS = 60;
const TITLE_MAX_CHARS = 120;
const BODY_MAX_CHARS = 160;

function clamp(value: string, max: number): string {
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/** The landing path. A PATH, resolved by the service worker against its own origin (see `PushPayload.url`). */
export function followUpLandingPath(folderId: string): string {
  return `/follow-ups/${encodeURIComponent(folderId)}`;
}

/**
 * One nudge → one notification.
 *
 * WHAT IS IN IT: the event's title (the user's own folder name) and two counts. WHAT IS NOT: any
 * contact's name, company, note or tag — a lock screen is read by whoever is holding the phone, and
 * the payload is minimal even though it is end-to-end encrypted. The landing URL carries only the
 * folder id, which `GET /api/follow-ups/[folderId]` re-authorises against the session.
 *
 * `tag` is per SUBJECT and prefixed differently from the reminder's `pblr-event-…`, so a follow-up
 * never replaces a reminder that is still on screen.
 */
export function formatFollowUpNudgePayload(nudge: FollowUpNudge): PushPayload {
  const people = nudge.metCount === 1 ? 'person' : 'people';
  const title = clamp(
    `You met ${nudge.metCount} ${people} at ${clamp(nudge.title, TITLE_EVENT_MAX_CHARS)}`,
    TITLE_MAX_CHARS
  );
  const body =
    nudge.pendingCount === nudge.metCount
      ? 'Draft follow-ups while they still remember you — one tap each.'
      : `${nudge.pendingCount} still to follow up. Draft them while they still remember you.`;

  const payload: PushPayload = {
    title,
    body: clamp(body, BODY_MAX_CHARS),
    url: followUpLandingPath(nudge.folderId),
    tag: `pblr-followup-${nudge.subjectId}`,
  };
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > PUSH_PAYLOAD_MAX_BYTES) {
    payload.body = '';
    payload.title = clamp(payload.title, 60);
  }
  return payload;
}

/**
 * The Web Push `Topic` header for this nudge: at most 32 URL-safe base64 characters (RFC 8030).
 *
 * `f` + the 24-hex subject id. The reminder uses the BARE event id as its topic, so without the prefix
 * a follow-up about an event and a queued reminder about the same event would coalesce at the push
 * service and one would silently replace the other.
 */
export function followUpNudgeTopic(subjectId: string): string {
  return `f${subjectId}`.slice(0, 32);
}

/* ── The Settings switch's API body ── */

export type NudgePreferenceBody = { ok: true; enabled: boolean } | { ok: false; error: string };

/**
 * `PUT /api/me/follow-up-nudges` accepts exactly `{ enabled: boolean }`.
 *
 * Strict boolean, like `remindersEnabled()`'s `=== true`: the string `"false"` out of a form is truthy
 * and must not read as consent — nor, here, be stored as something that is neither.
 */
export function parseNudgePreferenceBody(body: unknown): NudgePreferenceBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Expected a JSON object: { "enabled": true | false }.' };
  }
  const enabled = (body as Record<string, unknown>).enabled;
  if (typeof enabled !== 'boolean') {
    return { ok: false, error: '`enabled` must be true or false.' };
  }
  return { ok: true, enabled };
}
