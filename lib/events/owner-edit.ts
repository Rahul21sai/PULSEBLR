/**
 * What the AUTHOR of a hand-added event may change on it, and what editing or deleting it does.
 *
 * PURE — no mongoose, no I/O, no clock — so `tests/owner-edit.test.ts` pins every rule without a
 * database, the same arrangement as `lib/events/submission-edit.ts` and `lib/tracker/validate.ts`.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * TWO PHASES, BECAUSE TWO OF THE CHECKS NEED THE STORED ROW.
 *
 *   `validateOwnerEdit(body)`        shape only: allowlist, types, URL schemes, enums, lengths.
 *                                    Runs BEFORE `connectDB()`, so a malformed request costs no
 *                                    query — the CLAUDE.md §6 ordering.
 *   `resolveOwnerEdit(patch, row)`   the cross-field rules that need what is already stored: end
 *                                    versus the stored start, "paid" versus the stored price, an
 *                                    emptied description falling back to the title — plus change
 *                                    detection and the re-review rule. Runs after the owner-scoped
 *                                    fetch. Still pure: the route hands the row in.
 *
 * `submission-edit.ts` explains why it cannot validate before the database; splitting the phases is
 * how this one can.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE ALLOWLIST, and what is deliberately NOT on it.
 *
 * Every field is coerced by `validateEventUpdate` (imported, not mirrored — one URL rule, one date
 * rule, one category check). Narrowing happens BEFORE delegation, because the delegate ignores
 * unknown keys and accepts several an owner must never reach: `spotlightAt` (editorial — pins a row
 * to the home page), `isTechEvent` (derived below), `soldOut`, `attendeeCount`. Anything not named
 * here is unreachable: `visibility`, `createdByUserId`, `deletedAt`, `dedupHash`, `clusterKey`,
 * `connectionScore`, `companies`, `source`, `lastSeenAt`.
 *
 * `organizer` is OFF the list on purpose. It is the main input to company attribution
 * (`lib/companies/resolve.ts` matches ambiguous names against the organiser field only), so an
 * editable organiser is a way to file your event under "Google" on `/companies` at the next backfill.
 * `hasFood` is off because the brief did not ask for it; both are one line to add.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
import { validateEventUpdate, type EventFieldIssue } from './admin-validate';
import { isTechFromCategories } from '../event-types';
import { connectionScore } from './connection-score';
import { PLACEHOLDER_SOURCE_URL, isPlaceholderSourceUrl } from './placeholder';

export const OWNER_EDIT_FIELDS = [
  'title',
  'description',
  'startDateTime',
  'endDateTime',
  'venue',
  'address',
  'area',
  'format',
  'applyLink',
  'onlineLink',
  'sourceUrl',
  'imageUrl',
  'category',
  'isFree',
  'price',
] as const;

export type OwnerEditField = (typeof OWNER_EDIT_FIELDS)[number];

/**
 * The create path's cap (`manual-input.ts` slices at 6000), not the admin editor's 20000 — an owner
 * must not be able to store by editing what they could not store by creating.
 */
export const OWNER_DESCRIPTION_MAX = 6000;

export type OwnerVisibility = 'private' | 'pending' | 'public';

/** Absent means public — the ~1500-document rule every visibility filter carries. */
export function ownerVisibility(visibility: string | null | undefined): OwnerVisibility {
  if (visibility === 'private' || visibility === 'pending') return visibility;
  return 'public';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'string' && !value.trim());
}

export interface OwnerEditValidation {
  /**
   * Coerced values. `description: null` is a SENTINEL meaning "emptied — fall back to the title",
   * resolved in phase two because the title may not be in this patch.
   */
  patch: Record<string, unknown>;
  issues: EventFieldIssue[];
}

/** Phase one: the body's shape. See the header. */
export function validateOwnerEdit(body: unknown): OwnerEditValidation {
  if (!isPlainObject(body)) {
    return { patch: {}, issues: [{ field: 'body', message: 'must be a JSON object' }] };
  }

  // THE ALLOWLIST, applied as a copy. Nothing outside it reaches the delegate.
  const narrowed: Record<string, unknown> = {};
  for (const field of OWNER_EDIT_FIELDS) {
    if (field in body) narrowed[field] = body[field];
  }

  const issues: EventFieldIssue[] = [];

  /*
   * CLEARING THE ORGANISER'S PAGE WRITES THE PLACEHOLDER BACK. `sourceUrl` is `required` in the
   * schema, and the admin validator answers an empty one with "cannot be empty" — right for a scraped
   * row, wrong for an owner who never had a link. The edit form also round-trips the placeholder it
   * was given, which is the same intent. Either way the stored value becomes the one constant every
   * reader knows to hide.
   */
  let clearSource = false;
  if ('sourceUrl' in narrowed && (isBlank(narrowed.sourceUrl) || isPlaceholderSourceUrl(narrowed.sourceUrl))) {
    clearSource = true;
    delete narrowed.sourceUrl;
  }

  /*
   * AN EMPTIED DESCRIPTION FALLS BACK TO THE TITLE, the create path's rule (`description` is required,
   * and `manual-input.ts` uses the title rather than inventing text).
   */
  let clearDescription = false;
  if ('description' in narrowed) {
    if (isBlank(narrowed.description)) {
      clearDescription = true;
      delete narrowed.description;
    } else if (
      typeof narrowed.description === 'string' &&
      narrowed.description.trim().length > OWNER_DESCRIPTION_MAX
    ) {
      issues.push({ field: 'description', message: `must be ${OWNER_DESCRIPTION_MAX} characters or fewer` });
      delete narrowed.description;
    }
  }

  /*
   * AT LEAST ONE CATEGORY. The admin validator accepts `[]`; the schema's `required` on an array then
   * rejects it at save as a ValidationError — a 400 that cannot name the field. And a category set
   * decides `isTechEvent`, which decides whether the event exists in the (techOnly) feed at all.
   */
  if (Array.isArray(narrowed.category) && narrowed.category.length === 0) {
    issues.push({ field: 'category', message: 'Pick at least one category.' });
    delete narrowed.category;
  }

  const delegated = validateEventUpdate(narrowed);
  const patch = delegated.update;
  issues.push(...delegated.issues);

  // The admin validator clears an optional date to `null` (meaningful for `spotlightAt`). For an end
  // time, "no end" is an ABSENT key, not a stored null — `undefined` becomes `$unset` on save.
  if ('endDateTime' in patch && patch.endDateTime === null) patch.endDateTime = undefined;
  if (clearSource) patch.sourceUrl = PLACEHOLDER_SOURCE_URL;
  if (clearDescription) patch.description = null;

  return { patch, issues };
}

/** The stored row, as far as phase two needs it. Every field optional so a lean doc satisfies it. */
export interface OwnerEditCurrent {
  title: string;
  description?: string | null;
  startDateTime: Date | string;
  endDateTime?: Date | string | null;
  venue?: string | null;
  address?: string | null;
  area?: string | null;
  format?: string | null;
  applyLink?: string | null;
  onlineLink?: string | null;
  sourceUrl?: string | null;
  imageUrl?: string | null;
  category?: string[] | null;
  isFree?: boolean | null;
  price?: number | null;
  visibility?: string | null;
  isTechEvent?: boolean | null;
  // Score inputs the owner cannot edit but the recomputed score must still see.
  hasFood?: string | null;
  organizer?: string | null;
  attendeeCount?: number | null;
  capacity?: number | null;
  companies?: string[] | null;
}

export interface OwnerEditResolution {
  /** What to assign onto the document: only CHANGED owner fields, plus the fields derived from them. */
  update: Record<string, unknown>;
  /** Owner-editable fields that actually changed. Empty ⇒ a no-op, write nothing. */
  changed: OwnerEditField[];
  issues: EventFieldIssue[];
  /** Set when this edit sends a public event back to review. */
  visibility?: 'pending';
}

const DATE_KEYS = new Set(['startDateTime', 'endDateTime']);

/** Inputs to `connectionScore` an owner can change. Changing any of them re-scores the event. */
const SCORE_INPUT_KEYS: ReadonlySet<string> = new Set(['format', 'category', 'title', 'isFree', 'price']);

function toTime(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const date = value instanceof Date ? value : new Date(value as string);
  return Number.isNaN(date.getTime()) ? undefined : date.getTime();
}

/**
 * Is a proposed value the same as the stored one, IN THE SENSE THAT MATTERS HERE.
 *
 * This decides whether a public event goes back to review, so a false "changed" is costly: it
 * hides the event from everybody who saved it for no reason. Hence the tolerances — absent, null and
 * '' are one state; category order is not a change; two placeholders are the same non-link.
 */
function sameValue(key: string, next: unknown, stored: unknown): boolean {
  if (DATE_KEYS.has(key)) return toTime(next) === toTime(stored);
  if (key === 'category') {
    const a = [...((next as string[] | undefined) ?? [])].sort().join('\u0000');
    const b = [...((stored as string[] | undefined) ?? [])].sort().join('\u0000');
    return a === b;
  }
  if (key === 'isFree') return (next ?? true) === (stored ?? true);
  if (key === 'sourceUrl' && isPlaceholderSourceUrl(next) && isPlaceholderSourceUrl(stored)) return true;
  const blank = (v: unknown) => v === null || v === undefined || v === '';
  if (blank(next) && blank(stored)) return true;
  return next === stored;
}

/** Phase two: rules against the stored row, change detection and the re-review rule. */
export function resolveOwnerEdit(
  patch: Record<string, unknown>,
  current: OwnerEditCurrent
): OwnerEditResolution {
  const issues: EventFieldIssue[] = [];
  const proposed: Record<string, unknown> = { ...patch };

  if (proposed.description === null) {
    proposed.description = typeof proposed.title === 'string' ? proposed.title : current.title;
  }

  /*
   * END BEFORE START, against the STORED counterpart. The admin validator compares only when both
   * dates are in the same patch; a partial edit moving the start past an end already on the row would
   * sail through and store an event that can never be "now". The issue lands on the field the owner
   * actually changed.
   */
  const start = toTime('startDateTime' in proposed ? proposed.startDateTime : current.startDateTime);
  const end = toTime('endDateTime' in proposed ? proposed.endDateTime : current.endDateTime);
  if (start !== undefined && end !== undefined && end < start) {
    issues.push({
      field: 'endDateTime' in proposed ? 'endDateTime' : 'startDateTime',
      message: 'must be after the start time',
    });
  }

  /*
   * FREE AND PRICE CANNOT DISAGREE. The create path derives `isFree` from `price`; this accepts both
   * because the form has a Free toggle, and reconciles them the same way:
   *   · `isFree: true`  → free, price cleared.
   *   · `isFree: false` → needs a price above zero (sent, or already stored); otherwise refused,
   *                        because a silent flip back to "free" is the lie `priceLabel` would print.
   *   · price alone     → 0 or cleared means free, anything above means paid.
   */
  if ('isFree' in proposed || 'price' in proposed) {
    if (proposed.isFree === true) {
      proposed.price = undefined;
    } else if (proposed.isFree === false) {
      const price = 'price' in proposed ? proposed.price : current.price ?? undefined;
      if (typeof price === 'number' && price > 0) {
        proposed.price = price;
      } else {
        issues.push({ field: 'price', message: 'Add the ticket price, or mark the event free.' });
      }
    } else {
      const price = proposed.price;
      if (price === undefined || price === 0) {
        proposed.isFree = true;
        proposed.price = undefined;
      } else {
        proposed.isFree = false;
      }
    }
  }

  if (issues.length > 0) return { update: {}, changed: [], issues };

  const update: Record<string, unknown> = {};
  const changed: OwnerEditField[] = [];
  for (const field of OWNER_EDIT_FIELDS) {
    if (!(field in proposed)) continue;
    if (sameValue(field, proposed[field], current[field as keyof OwnerEditCurrent])) continue;
    update[field] = proposed[field];
    changed.push(field);
  }

  if (changed.length === 0) return { update: {}, changed, issues };

  /*
   * DERIVED FIELDS FOLLOW THEIR INPUTS — the server sets them, the body never can.
   *
   * `isTechEvent` from the categories (`isTechFromCategories`, the one derivation — four call sites
   * got this wrong before it existed). Without it, an owner who fixes `['Meetup']` to `['AI/ML']`
   * keeps `isTechEvent: false` and the event stays invisible in the unconditionally-techOnly feed.
   *
   * `connectionScore` because the default sort is `connections`: a stale score is a stale RANK, and
   * the create path scores from these same inputs. Recomputed from the merged row, including the
   * inputs the owner cannot edit (host, food, attendance), so it matches what a backfill would store.
   */
  const merged = { ...current, ...update } as OwnerEditCurrent;
  if (changed.includes('category')) {
    update.isTechEvent = isTechFromCategories(merged.category ?? []);
  }
  if (changed.some(field => SCORE_INPUT_KEYS.has(field))) {
    update.connectionScore = connectionScore({
      format: merged.format,
      hasFood: merged.hasFood,
      attendeeCount: merged.attendeeCount,
      capacity: merged.capacity,
      category: merged.category,
      companies: merged.companies,
      organizer: merged.organizer,
      title: merged.title,
      isFree: merged.isFree,
      price: merged.price,
    });
  }

  /*
   * THE RE-REVIEW RULE. An edit to an APPROVED event sends it back to `pending`.
   *
   * Approval is a reviewer publishing a stranger's content — above all its `applyLink` — to every
   * visitor; `/admin → Submissions` exists because that is a phishing vector. If an approved author
   * could then rewrite the link, review would guard only the first version. So any real change to a
   * public event returns it to the queue, where `GET /api/admin/submissions` already lists it.
   *
   * `'pending'`, never `'public'`: an owner can move a row AWAY from public and never onto it.
   * Approval then `$unset`s it again, back to the absent-means-public shape.
   *
   * The cost, stated in the edit form before the owner saves: until re-approved, the event is off the
   * feed and its page 404s for everyone but the owner, including people who saved it. A no-op save
   * never triggers it — that is what the change detection above is for.
   */
  const visibility = ownerVisibility(current.visibility) === 'public' ? ('pending' as const) : undefined;

  return { update, changed, issues, ...(visibility ? { visibility } : {}) };
}

export type OwnerDeleteMode = 'soft' | 'hard';

/**
 * What an owner's delete does to the row.
 *
 * SOFT (`deletedAt`, the admin console's mechanism, so `notDeletedClause()` and `canViewEvent`
 * already hide it everywhere) when either:
 *   · the event is PUBLIC — the city saw it, so the row is kept for moderation and so an admin can
 *     restore it; one author must not be able to irrecoverably erase shared corpus content; or
 *   · ANYONE ELSE references it — another user's tracker entry or folder. This covers the chain the
 *     visibility alone cannot see: public → edited back to pending → deleted. Pending looks like
 *     "only mine", yet people saved it while it was public.
 *
 * HARD otherwise — a private or pending event nobody else has touched is the author's own record,
 * and "delete" should mean gone. Account deletion hard-deletes soft-deleted rows too
 * (`deleteOwnedEvents` filters on the owner only), so nothing is retained past that.
 */
export function ownerDeleteMode(input: {
  visibility: string | null | undefined;
  othersReferencing: number;
}): OwnerDeleteMode {
  if (ownerVisibility(input.visibility) === 'public') return 'soft';
  return input.othersReferencing > 0 ? 'soft' : 'hard';
}
