/**
 * What a reviewer may correct on a PENDING submission, before deciding it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS. The submissions queue could approve or reject and nothing else, so a
 * submission that was nearly right had no path forward: approving published the flaw to every
 * visitor and rejecting threw the event away. That is what keeps the microsite LLM-extraction half
 * switched off — its one live extraction would enter the public feed titled
 * "Open Source India | India's #1 Open Source Event", because the model took the page's `<title>`.
 * A reviewer needs to fix the title and then approve, in that order.
 *
 * WHY IT IS A SECOND MODULE AND NOT A FLAG ON `validateEventUpdate`. It is not a second
 * validator — every field below is coerced and checked by `validateEventUpdate`, imported not
 * mirrored, so the URL rule, the date coercion, the category check and the 400 shape have exactly
 * one definition. What this adds is a NARROWER allowlist over the top of it, and two rules that
 * only apply while a row is awaiting review:
 *
 *   1. `spotlightAt` and `isTechEvent` are editable through the admin event editor and must NOT be
 *      editable here. `spotlightAt` is editorial — it pins a row to the home page — and offering it
 *      on a row nobody has approved yet is offering to publish and promote in one step. `isTechEvent`
 *      is DERIVED below rather than typed, so accepting it would let the two disagree.
 *   2. `endDateTime`, `price`, `imageUrl`, `sourceUrl`, `format` and the rest are simply out of
 *      scope: the point of the panel is to correct what the extraction or the submitter got wrong
 *      about WHAT and WHEN, not to become a second event editor. Anything the queue cannot fix is
 *      fixable through `/admin`'s events panel once the row is public.
 *
 * Narrowing happens BEFORE delegation, which is the load-bearing detail. `validateEventUpdate`
 * documents that it ignores unknown keys — necessary there, because its form round-trips a whole
 * event — so a key it accepts and this module does not has to be dropped on the way in, never
 * filtered out on the way back. A field added to that allowlist later is therefore not silently
 * writable from the review queue.
 *
 * Pure: no mongoose, no I/O, no clock. `tests/submission-edit.test.ts` pins it with no database and
 * no server.
 *
 * Note what is NOT claimed, because the sibling validators do claim it: this does not run before
 * `connectDB()`. The end-before-start check reads the `endDateTime` already stored on the row, so the
 * route has to fetch the submission first — and it must fetch it anyway, since the whole operation is
 * scoped to `visibility: 'pending'` in the query. Refusing a bad body without touching the database
 * would mean either dropping that check or trusting the caller's own copy of the stored value.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
import { validateEventUpdate, eventValidationError, type EventFieldIssue } from './admin-validate';
import { TECH_FLAG_CATEGORIES } from '../event-types';

/**
 * Every field a reviewer may correct. The list is closed and it is the whole contract.
 *
 * `title` and `startDateTime` are the two that earn this feature: they are what a bad extraction
 * gets wrong, and they are also the two the identity keys are built from — see the note on key
 * derivation in `app/api/admin/submissions/route.ts`, which is where that consequence is handled.
 */
export const SUBMISSION_EDIT_FIELDS = [
  'title',
  'description',
  'organizer',
  'venue',
  'area',
  'startDateTime',
  'category',
  'applyLink',
] as const;

export type SubmissionEditField = (typeof SUBMISSION_EDIT_FIELDS)[number];

export interface SubmissionEditResult {
  /** Only allowlisted, coerced values. Assign these onto the document, never spread the body. */
  update: Record<string, unknown>;
  issues: EventFieldIssue[];
}

/** The stored values a cross-field check needs. Read from the document, never from the request. */
export interface SubmissionEditContext {
  endDateTime?: Date | string | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateSubmissionEdit(
  body: unknown,
  current: SubmissionEditContext = {}
): SubmissionEditResult {
  if (!isPlainObject(body)) {
    return { update: {}, issues: [{ field: 'body', message: 'must be a JSON object' }] };
  }

  // THE ALLOWLIST, applied as a copy rather than as a deletion. Nothing outside
  // `SUBMISSION_EDIT_FIELDS` reaches the delegate, so `dedupHash`, `clusterKey`, `visibility`,
  // `createdByUserId`, `spotlightAt`, `connectionScore` and `isTechEvent` are unreachable from a
  // request body whether or not the delegate would have accepted them.
  const narrowed: Record<string, unknown> = {};
  for (const field of SUBMISSION_EDIT_FIELDS) {
    if (field in body) narrowed[field] = body[field];
  }

  const { update, issues } = validateEventUpdate(narrowed);

  /*
   * END BEFORE START, checked against the STORED end.
   *
   * `validateEventUpdate` makes this comparison only when both dates are in the same patch, which
   * is right for a form that submits both. Here `endDateTime` is not editable at all, so moving the
   * start past an end already on the row would sail through — and `lib/events/query.ts` treats an
   * event as ongoing once it has started and not yet ended, so a backwards range makes a row that
   * can never be "now" and sorts strangely. The message names the stored value as the reason,
   * because otherwise the reviewer is told their date is wrong with no way to see why.
   */
  const nextStart = update.startDateTime instanceof Date ? update.startDateTime : undefined;
  if (nextStart && current.endDateTime) {
    const storedEnd =
      current.endDateTime instanceof Date ? current.endDateTime : new Date(current.endDateTime);
    if (!Number.isNaN(storedEnd.getTime()) && storedEnd.getTime() < nextStart.getTime()) {
      issues.push({
        field: 'startDateTime',
        message: 'is after the end time already stored on this submission',
      });
    }
  }

  /*
   * `isTechEvent` IS RE-DERIVED, FROM `TECH_FLAG_CATEGORIES` AND NOT `TECH_CATEGORY_NAMES`.
   *
   * The narrower set is the wrong one and the difference is one value: `Hackathon` lives in
   * `GATHERING_CATEGORY_NAMES` because it names a KIND of gathering, but a hackathon is
   * unambiguously a software engineering event. Deriving from `TECH_CATEGORY_NAMES` stored a
   * hand-entered "Internal Hack Day" as `isTechEvent: false`, so it did not appear in the default
   * tech-only feed — the reviewer approves an event and it seems to vanish. `POST /api/events`
   * derives from the same exported set, so the two paths cannot drift.
   *
   * Only when `category` survived validation. An invalid category leaves it out of `update`, and
   * flipping the flag on the strength of a rejected value would be deciding the feed from a typo.
   * A reviewer who wants the flag itself has the toggle in `/admin`'s events panel, after approval.
   */
  if (Array.isArray(update.category)) {
    update.isTechEvent = (update.category as string[]).some(name => TECH_FLAG_CATEGORIES.has(name));
  }

  return { update, issues };
}

/**
 * The 400 body — the SAME shape the admin event editor already answers with, re-exported rather
 * than re-written so a field error lands on its field in both panels.
 */
export { eventValidationError };
