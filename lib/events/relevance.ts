// Is this event FOR ME? — the personalisation signal, and the second half of the feed's ranking.
//
// `connection-score.ts` answers "is this worth attending" over signals every user shares. This
// answers "would THIS user go", from preferences they stated once. The two are deliberately
// separate objects:
//
//   · `connectionScore` is a corpus-wide property. It is STORED on the document, recomputed by
//     `scripts/backfill-connection-score.ts`, and the same for everybody.
//   · `relevanceScore` is per-user and per-request. Nothing about it is ever written to an
//     `Event`, because there is no such thing as one event's relevance.
//
// They are combined at query time as a PRODUCT (see `relevanceRankExpr`), never merged into one
// stored number. Overwriting `connectionScore` with a personalised value would corrupt a shared,
// backfilled field with one user's taste and silently break the `connections` sort for everyone.
//
// This module is PURE — no mongoose, no network, no `Date.now()` except where a caller passes the
// instant in. That is what makes `tests/relevance.test.ts` able to pin the weights, exactly as
// `tests/connection-score.test.ts` pins the other half.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// IT RE-RANKS. IT NEVER HIDES.
//
// Every weight below is a nudge applied on top of a NEUTRAL BASELINE, and the result multiplies a
// score that is already there. No value of any preference can remove an event from the feed. That
// is not a stylistic choice, it is the guard the whole feature is built around: a recommender that
// silently drops events is worse than no recommender, because the reader cannot tell the
// difference between "there is nothing on" and "we decided not to show you". The visible
// `For you` / `Everything` switch in `app/page.tsx` is the other half of the same guarantee.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { EVENT_CATEGORIES, TECH_CATEGORY_NAMES, GATHERING_CATEGORY_NAMES } from '@/lib/event-types';
import { BENGALURU_AREAS } from '@/lib/scrapers/core/geo';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The preference shape
//
// WHY THE SHAPE AND ITS VOCABULARY LIVE IN A PURE MODULE RATHER THAN IN `lib/models/User.ts`.
// Exactly the arrangement `TRACKER_STATUSES` has in `lib/tracker/validate.ts`: the schema enum
// imports the list from here, so the set the API validates against cannot drift from the set the
// schema enforces. It also means the onboarding screen — a client component — can render the
// vocabulary without pulling mongoose into the browser bundle.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Format preference. `'any'` is a real, expressible value and is the default — it means "no
 * opinion", which is different from every other value and must not be confused with the absence
 * of the field. An absent field would make "I genuinely don't mind" indistinguishable from "this
 * user has never been asked".
 */
export const FORMAT_PREFERENCES = ['any', 'offline', 'online', 'hybrid'] as const;
export type FormatPreference = (typeof FORMAT_PREFERENCES)[number];

/**
 * Digest cadence.
 *
 * ── SHARED WITH THE NOTIFICATIONS STREAM. Read before changing. ──────────────────────────────
 * `remindersEnabled` and `digestFrequency` are consumed by `lib/notifications/` (the digest
 * sender and the saved-event reminders), NOT by anything in this file. They live in the same
 * `preferences` object on purpose: one place a user's answers are stored, one round trip to read
 * them, and one shape for both streams to agree on. Nothing here scores on them — if you are
 * looking for why a notification did or did not send, this is not the file.
 *
 * `'weekly'` is the DEFAULT rather than `'daily'`, and that is a decision with a reason: a daily
 * email to engineers gets muted, and a muted sender is gone permanently. Daily is available as an
 * explicit opt-in.
 */
export const DIGEST_FREQUENCIES = ['weekly', 'daily', 'off'] as const;
export type DigestFrequency = (typeof DIGEST_FREQUENCIES)[number];

export interface UserPreferences {
  /** Categories the user cares about. Validated against `EVENT_CATEGORIES`. */
  topics: string[];
  /** Areas the user can actually get to. Validated against `BENGALURU_AREAS`. */
  areas: string[];
  format: FormatPreference;
  /**
   * IST days of the week the user can go out, `0` = Sunday … `6` = Saturday.
   *
   * Numbers rather than names so the value has one representation across the pure scorer
   * (`Date.getUTCDay()` on an IST-shifted instant) and the aggregation
   * (`$dayOfWeek` with `timezone: 'Asia/Kolkata'`, minus one). A day NAME would need a mapping on
   * both sides and the two could disagree.
   */
  evenings: number[];
  /** SHARED with lib/notifications/ — see `DIGEST_FREQUENCIES`. Not scored here. */
  remindersEnabled: boolean;
  /** SHARED with lib/notifications/ — see `DIGEST_FREQUENCIES`. Not scored here. */
  digestFrequency: DigestFrequency;
}

/**
 * What a user who has never answered anything gets.
 *
 * `topics`, `areas` and `evenings` are EMPTY and `format` is `'any'`, which makes
 * `relevanceScore` return the same number for every event — see `RELEVANCE_BASELINE`. A user who
 * skips onboarding therefore gets today's feed exactly, not an empty one.
 *
 * The two notification fields are NOT empty, because "no answer" has a sensible reading there:
 * a reminder for an event you saved yourself is relevant by construction, and a weekly digest is
 * the cadence that does not get muted.
 */
export const DEFAULT_PREFERENCES: UserPreferences = {
  topics: [],
  areas: [],
  format: 'any',
  evenings: [],
  remindersEnabled: true,
  digestFrequency: 'weekly',
};

/**
 * The topic chips onboarding offers — tech topics and gathering kinds, NOT the non-tech tail.
 *
 * The feed is unconditionally `techOnly`, so a chip for `Arts/Culture` or `Health/Fitness` could
 * only ever match an event the reader cannot reach. That is the same defect the removed
 * "Everything else" filter group had: a control whose every outcome is zero. Validation still
 * accepts all 22 categories (`VALID_TOPICS` below), so a preference set through some other path is
 * stored rather than silently dropped.
 */
export const TOPIC_CHOICES: readonly string[] = [
  ...TECH_CATEGORY_NAMES,
  ...GATHERING_CATEGORY_NAMES,
];

/** Area choices, in the canonical order the gazetteer defines, with `Other` removed. */
export const AREA_CHOICES: readonly string[] = BENGALURU_AREAS.filter(a => a !== 'Other');

/** Day-of-week labels for the onboarding chips. Index is the stored value. */
export const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Weights
//
// Ordered by size, and the ORDER is the substance of this file. It inverts what users think they
// are choosing, on measured evidence:
//
//   TOPIC IS THE WEAKEST DISCRIMINATOR IN THIS CORPUS. `AI/ML` alone carries 189 of 297 upcoming
//   tech events — 63%. "I'm interested in AI" therefore narrows almost nothing, so weighting it
//   heavily would produce a personalised feed that is indistinguishable from the unpersonalised
//   one while claiming to be tailored.
//
//   AREA, FORMAT AND DAY ARE THE STRONG ONES, because in Bengaluru the reason people skip a good
//   event is the commute, not the subject. An excellent Kubernetes talk in Whitefield on a
//   Wednesday is, for someone in Jayanagar who can only go on Fridays, an event they will not
//   attend — and the ranking should say so.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The neutral floor, and the most load-bearing constant here.
 *
 * With no preferences expressed, every event scores exactly this — so the combined rank becomes
 * `connectionScore × 0.36`, a UNIFORM multiplier, which preserves the `connections` order
 * perfectly. That is what makes a skipped onboarding safe: `For you` degrades to today's feed
 * rather than to noise or to nothing. `tests/relevance.test.ts` pins it.
 *
 * Note that the baseline does NOT stop the score reaching 0 — every miss combined is -44, which
 * clamps. That is fine and deliberate: 0 means "nothing you said fits this", a real state worth
 * being able to express. What stops a 0 from ANNIHILATING a good event is
 * `RELEVANCE_MULTIPLIER_FLOOR`, in the combination rather than in the score — see there.
 */
export const RELEVANCE_BASELINE = 36;

export const RELEVANCE_WEIGHTS = {
  /**
   * Area you said you can reach. The single biggest term, because travel time is the measured
   * reason a good event goes unattended in this city.
   */
  areaMatch: 22,
  /**
   * Area that IS resolved and is NOT on your list. A penalty rather than a filter — a great
   * event across town is still worth knowing about, just not worth putting first.
   */
  areaMiss: -14,
  /**
   * An unresolved area (`'Other'`, empty, or absent) scores ZERO — neither credit nor penalty.
   *
   * This is the one weight that exists to protect against a DATA gap rather than to express a
   * preference. `resolveArea` currently resolves about half the corpus, leaving 200+ upcoming
   * events at `'Other'`. Treating unknown as a miss would push a fifth of the feed down for a
   * scraper limitation the reader cannot see and did not cause. Improving `resolveArea` (Phase 0)
   * is what makes this term earn more, not a bigger number here.
   */
  areaUnknown: 0,

  /** Format is exactly what you asked for. */
  formatMatch: 16,
  /**
   * Hybrid against an `offline` or `online` preference, or anything against a `hybrid`
   * preference. A hybrid event does contain the thing you asked for, it is just not exclusively
   * that — so it is neither a match nor a miss, and collapsing it into either was wrong.
   */
  formatPartial: 8,
  /** Online when you said in person, or the reverse. The clearest miss in the whole model. */
  formatMiss: -16,

  /** Starts on an IST day you said works. The second commute term. */
  dayMatch: 14,
  /**
   * Starts on a day you did not pick. DELIBERATELY SOFTER than `dayMatch` is strong: "Fridays
   * don't usually work" is a tendency, not a rule, and a symmetric penalty would make the
   * ranking behave like a hard calendar filter — which is the hiding this feature refuses to do.
   */
  dayMiss: -8,

  /**
   * First matching topic. Smaller than `areaMatch` and `formatMatch` on purpose — see the header
   * above. This is the term users expect to dominate and the evidence says it must not.
   */
  topicFirst: 12,
  /** Each additional matching topic. */
  topicExtra: 4,
  /**
   * Cap on the additional-topic bonus, so selecting eight topics is not eight times the signal of
   * selecting one. Without a cap, the way to rank highest would be to pick everything, which is
   * the same thing as expressing no preference at all.
   */
  topicExtraCap: 8,
  /**
   * No topic overlap, applied ONLY when the event carries categories that could have matched. An
   * untagged event is a tagging gap, not a mismatch, and is scored `0` for the same reason
   * `areaUnknown` is.
   */
  topicNone: -6,

  /**
   * One of the user's own `targetCompanies` is a resolved host on this event.
   *
   * Small, and asymmetric: there is NO penalty for an event with no company. Most community
   * meetups have none, and they are precisely what this product exists to surface — penalising
   * their absence would bury the best events to reward a corporate logo.
   *
   * It reads the user's `targetCompanies` list, NOT the stored `Event.isTargetCompany` flag.
   * That flag is computed at ingest against the shared DEFAULT list, so it is the same for every
   * user and answers a different question.
   */
  companyMatch: 8,
} as const;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Scoring
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface RelevanceInput {
  area?: string | null;
  format?: string | null;
  category?: string[] | null;
  companies?: string[] | null;
  /** ISO string over JSON, `Date` from mongoose. Both accepted; neither is required. */
  startDateTime?: Date | string | null;
}

/** Everything the score needs that is not on the event. */
export interface RelevanceContext {
  preferences: UserPreferences;
  /** The user's own target-company list (`User.targetCompanies`). */
  targetCompanies?: string[];
}

/**
 * IST day of week for an instant, `0` = Sunday.
 *
 * A fixed +5:30 shift is EXACT, not an approximation: India has never observed daylight saving,
 * so `Asia/Kolkata` is UTC+05:30 year-round. That is also why this agrees with the aggregation's
 * `$dayOfWeek: { timezone: 'Asia/Kolkata' }` — the two would drift for any zone with DST.
 * `lib/events/query.ts` does the same shift for the same reason.
 */
function istDayOfWeek(value: Date | string): number | null {
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime();
  if (Number.isNaN(ms)) return null;
  return new Date(ms + 5.5 * 3600 * 1000).getUTCDay();
}

/** Is the area string one we can actually judge against a preference? */
function areaIsResolved(area: string | null | undefined): boolean {
  return Boolean(area && area !== 'Other');
}

/**
 * Do these evenings carry any information? An empty selection and all seven days are the same
 * statement — "any day" — and both must contribute nothing, or picking every day would look like
 * a preference and penalise nothing while inflating every score.
 */
function eveningsAreSelective(evenings: number[]): boolean {
  const distinct = new Set(evenings.filter(d => Number.isInteger(d) && d >= 0 && d <= 6));
  return distinct.size > 0 && distinct.size < 7;
}

/** Per-format delta for a given preference. Shared by the scalar path and the expression path. */
function formatDeltas(pref: FormatPreference): Record<'offline' | 'online' | 'hybrid', number> {
  const { formatMatch, formatPartial, formatMiss } = RELEVANCE_WEIGHTS;
  switch (pref) {
    case 'offline':
      return { offline: formatMatch, hybrid: formatPartial, online: formatMiss };
    case 'online':
      return { online: formatMatch, hybrid: formatPartial, offline: formatMiss };
    case 'hybrid':
      // Everything contains part of what was asked for, so nothing is a miss.
      return { hybrid: formatMatch, offline: formatPartial, online: formatPartial };
    case 'any':
    default:
      return { offline: 0, online: 0, hybrid: 0 };
  }
}

/** The topic term for a given number of overlapping categories. */
function topicDelta(hits: number, eventHasCategories: boolean): number {
  const { topicFirst, topicExtra, topicExtraCap, topicNone } = RELEVANCE_WEIGHTS;
  if (hits > 0) return topicFirst + Math.min(topicExtraCap, (hits - 1) * topicExtra);
  return eventHasCategories ? topicNone : 0;
}

/**
 * Does this preference set say anything the ranking can act on?
 *
 * The two notification fields are excluded deliberately: they change what arrives in an inbox,
 * not what the feed does, so a user who only set a digest cadence has expressed nothing the
 * `For you` view could honour — and offering them a personalised tab that ranks identically to
 * `Everything` would be a lie the UI tells with a straight face.
 */
export function hasRankingPreferences(preferences: UserPreferences): boolean {
  return (
    preferences.topics.length > 0 ||
    preferences.areas.length > 0 ||
    preferences.format !== 'any' ||
    eveningsAreSelective(preferences.evenings)
  );
}

/**
 * Score 0-100: how well does this event fit what the user said?
 *
 * NOT a probability and not a quality judgement — the quality judgement is `connectionScore`, and
 * this multiplies it. A 100 here on a score-10 event still ranks below a 60 here on a score-90
 * event, which is the intended behaviour: "for me" cannot rescue "not worth going to".
 */
export function relevanceScore(event: RelevanceInput, context: RelevanceContext): number {
  const { preferences: prefs } = context;
  let score = RELEVANCE_BASELINE;

  // ── Area: can you get there ────────────────────────────────────────────────
  if (prefs.areas.length > 0) {
    const area = event.area ?? null;
    if (area && prefs.areas.includes(area)) score += RELEVANCE_WEIGHTS.areaMatch;
    else if (areaIsResolved(area)) score += RELEVANCE_WEIGHTS.areaMiss;
    else score += RELEVANCE_WEIGHTS.areaUnknown;
  }

  // ── Format: in a room, or on a screen ─────────────────────────────────────
  if (prefs.format !== 'any') {
    const deltas = formatDeltas(prefs.format);
    const format = event.format as 'offline' | 'online' | 'hybrid' | undefined | null;
    // An unknown format contributes nothing — same rule as an unresolved area.
    if (format && format in deltas) score += deltas[format];
  }

  // ── Day of week: does the evening work ────────────────────────────────────
  if (eveningsAreSelective(prefs.evenings) && event.startDateTime) {
    const dow = istDayOfWeek(event.startDateTime);
    if (dow !== null) {
      score += prefs.evenings.includes(dow)
        ? RELEVANCE_WEIGHTS.dayMatch
        : RELEVANCE_WEIGHTS.dayMiss;
    }
  }

  // ── Topic ─────────────────────────────────────────────────────────────────
  if (prefs.topics.length > 0) {
    const categories = event.category ?? [];
    const wanted = new Set(prefs.topics);
    const hits = new Set(categories.filter(c => wanted.has(c))).size;
    score += topicDelta(hits, categories.length > 0);
  }

  // ── A company you are targeting is hosting ────────────────────────────────
  const targets = context.targetCompanies ?? [];
  if (targets.length > 0) {
    const wanted = new Set(targets);
    if ((event.companies ?? []).some(c => wanted.has(c))) {
      score += RELEVANCE_WEIGHTS.companyMatch;
    }
  }

  return Math.max(0, Math.min(100, score));
}

/**
 * A one-line readout of what the ranking is currently honouring.
 *
 * The `For you` header prints this. It exists because a ranked list with no stated basis is
 * indistinguishable from an arbitrary one — the same reason the Spotlight caption says whether it
 * is hand-picked or ranked. If the reader cannot see WHY the order is what it is, they have no
 * way to judge or correct it.
 */
export function preferenceSummary(preferences: UserPreferences): string {
  const parts: string[] = [];
  if (preferences.topics.length > 0) {
    parts.push(
      preferences.topics.length <= 2
        ? preferences.topics.join(' + ')
        : `${preferences.topics.length} topics`
    );
  }
  if (preferences.areas.length > 0) {
    parts.push(
      preferences.areas.length <= 2
        ? preferences.areas.join(' + ')
        : `${preferences.areas.length} areas`
    );
  }
  if (preferences.format === 'offline') parts.push('in person');
  else if (preferences.format === 'online') parts.push('online');
  else if (preferences.format === 'hybrid') parts.push('hybrid');
  if (eveningsAreSelective(preferences.evenings)) {
    const days = [...new Set(preferences.evenings)].sort((a, b) => a - b).map(d => DAY_LABELS[d]);
    parts.push(days.length <= 3 ? days.join('/') : `${days.length} days`);
  }
  return parts.join(' · ');
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The same weights, as a Mongo aggregation expression
//
// WHY THIS EXISTS AND WHY IT IS HERE. The ranking has to happen in the DATABASE, because the feed
// is paginated: scoring a page in JavaScript orders 30 rows that were already chosen by a
// different sort, which is not a ranking at all — it is shuffling the wrong 30 events. So the
// score must be computable as an aggregation expression.
//
// That means two evaluators for one model, which is exactly the drift this codebase spends its
// comments warning about. Three things keep them honest:
//
//   1. BOTH READ `RELEVANCE_WEIGHTS` AND `RELEVANCE_BASELINE`. No number is written twice.
//   2. Both share the branch helpers above (`formatDeltas`, `topicDelta`, `eveningsAreSelective`),
//      so the SHAPE of each term is defined once too.
//   3. `tests/relevance.test.ts` evaluates this expression with a small interpreter and asserts it
//      returns exactly what `relevanceScore` returns, over a table of events. That test is the
//      point of the pair — a weight changed in one place and not the other fails it.
//
// It returns plain JSON, so this module stays free of mongoose and remains client-importable.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** A Mongo aggregation expression. Plain JSON by construction — see above. */
export type MongoExpr = unknown;

const IST_TZ = 'Asia/Kolkata';

/**
 * `relevanceScore` as an aggregation expression over the `Event` document.
 *
 * Every term is built CONDITIONALLY: when a preference says nothing, the term is omitted from the
 * `$add` rather than emitted as a branch that evaluates to zero. That keeps the expression small
 * for the common case and, more usefully, makes "no preference contributes nothing" structural
 * instead of arithmetic.
 *
 * ── EVERY USER-SUPPLIED STRING ARRAY IS WRAPPED IN `$literal`. ────────────────────────────────
 * Inside an aggregation expression, a string beginning with `$` is a FIELD PATH, and array literals
 * are resolved element by element. So a topic, area or company name starting with `$` would be read
 * as a reference to a document field instead of as the value it is — silently, producing a
 * comparison against whatever that path holds. Nothing in the current vocabularies starts with `$`,
 * which is exactly why this is worth writing down: the guard is here so that adding one later is a
 * data change and not a query-semantics change. It is the same class of mistake as an unescaped
 * regex metacharacter in the search filter, which `buildEventFilter` escapes for the same reason.
 */
export function relevanceExpr(context: RelevanceContext): MongoExpr {
  const { preferences: prefs } = context;
  const terms: MongoExpr[] = [RELEVANCE_BASELINE];

  if (prefs.areas.length > 0) {
    terms.push({
      $switch: {
        branches: [
          {
            case: { $in: [{ $ifNull: ['$area', ''] }, { $literal: prefs.areas }] },
            then: RELEVANCE_WEIGHTS.areaMatch,
          },
          // Resolved, but not one of yours. `'Other'` and an absent field both fall through to
          // the default, which is the `areaUnknown` weight.
          {
            case: {
              $and: [
                { $ne: [{ $ifNull: ['$area', ''] }, ''] },
                { $ne: [{ $ifNull: ['$area', ''] }, 'Other'] },
              ],
            },
            then: RELEVANCE_WEIGHTS.areaMiss,
          },
        ],
        default: RELEVANCE_WEIGHTS.areaUnknown,
      },
    });
  }

  if (prefs.format !== 'any') {
    const deltas = formatDeltas(prefs.format);
    terms.push({
      $switch: {
        branches: (['offline', 'online', 'hybrid'] as const).map(f => ({
          case: { $eq: ['$format', f] },
          then: deltas[f],
        })),
        // Unknown or missing format: no opinion, same as the scalar path.
        default: 0,
      },
    });
  }

  if (eveningsAreSelective(prefs.evenings)) {
    const days = [...new Set(prefs.evenings.filter(d => Number.isInteger(d) && d >= 0 && d <= 6))];
    terms.push({
      $cond: [
        // `$dayOfWeek` is 1-based with Sunday = 1; the stored preference is 0-based with
        // Sunday = 0, which is what `Date.getUTCDay()` gives the scalar path. The `- 1` is the
        // whole bridge between them.
        {
          $in: [
            { $subtract: [{ $dayOfWeek: { date: '$startDateTime', timezone: IST_TZ } }, 1] },
            days,
          ],
        },
        RELEVANCE_WEIGHTS.dayMatch,
        RELEVANCE_WEIGHTS.dayMiss,
      ],
    });
  }

  if (prefs.topics.length > 0) {
    const { topicFirst, topicExtra, topicExtraCap, topicNone } = RELEVANCE_WEIGHTS;
    terms.push({
      $let: {
        vars: {
          // `$setIntersection` de-duplicates, which matches the scalar path's `new Set(...)`.
          hits: {
            $size: { $setIntersection: [{ $ifNull: ['$category', []] }, { $literal: prefs.topics }] },
          },
          hasCategories: { $gt: [{ $size: { $ifNull: ['$category', []] } }, 0] },
        },
        in: {
          $cond: [
            { $gt: ['$$hits', 0] },
            {
              $add: [
                topicFirst,
                { $min: [topicExtraCap, { $multiply: [{ $subtract: ['$$hits', 1] }, topicExtra] }] },
              ],
            },
            { $cond: ['$$hasCategories', topicNone, 0] },
          ],
        },
      },
    });
  }

  const targets = context.targetCompanies ?? [];
  if (targets.length > 0) {
    terms.push({
      $cond: [
        {
          $gt: [
            { $size: { $setIntersection: [{ $ifNull: ['$companies', []] }, { $literal: targets }] } },
            0,
          ],
        },
        RELEVANCE_WEIGHTS.companyMatch,
        0,
      ],
    });
  }

  // Clamped in the SAME direction and order as the scalar path, so the two agree at the edges as
  // well as in the middle. Both bounds are reachable, so neither clamp is decoration.
  return { $max: [0, { $min: [100, { $add: terms }] }] };
}

/**
 * How much of an event's OWN worth survives a total preference mismatch.
 *
 * ── THIS NUMBER IS WHY THE FEATURE IS SAFE, AND IT WAS FOUND BY A FAILING TEST. ──────────────
 *
 * The first version of the combination was the plain product, `connectionScore × relevance / 100`.
 * That reads correctly and is wrong at one edge: `relevanceScore` can legitimately reach 0 (three
 * misses is -36, four is -44 against a baseline of 36), and anything times zero is zero. So a
 * 88-scoring in-person meetup that happened to be across town, online-adjacent and off-topic
 * ranked at 0 — BELOW a 12-scoring coaching-centre advert that happened to be in the right
 * neighbourhood. `tests/relevance.test.ts` caught it as
 * `expected 0 to be greater than 10.32`.
 *
 * A preference is a weaker claim than a quality judgement, and the arithmetic has to say so. The
 * multiplier is therefore affine rather than linear: it spans `FLOOR..1`, so a total mismatch
 * DIVIDES an event's worth rather than erasing it.
 *
 * 0.45 gives a 2.2× swing, which is calibrated against the two things that must both hold:
 *
 *   · It must reorder the top. The tech feed's best events cluster at `connectionScore` 88-100, and
 *     a 2.2× swing shuffles that cluster completely — 100 × 0.45 = 45 against 88 × 1.0 = 88. So
 *     personalisation is decisive exactly where a reader actually looks.
 *   · It must not promote junk. A 40-scoring perfect fit (40) still loses to a 100-scoring total
 *     mismatch (45). `connectionScore` already penalises course adverts and webinars hard, and no
 *     amount of "it's nearby on a Tuesday" may undo that.
 *
 * The floor lives HERE and not inside `relevanceScore` on purpose. Clamping the score itself to
 * 45..100 would have destroyed its own resolution — every event with two misses would pile onto the
 * clamp and become indistinguishable — and would have made the score a worse thing to show a user.
 * Keeping the score full-range and flooring the MULTIPLIER separates "how well does this fit" from
 * "how much may fit move the ranking", which are two different questions.
 */
export const RELEVANCE_MULTIPLIER_FLOOR = 0.45;

/**
 * The combined rank: worth-attending × for-me, on a 0-100 scale.
 *
 * MULTIPLICATIVE, not additive, and the difference is the whole design. Added, a superb event you
 * cannot reach and a reachable event that wastes an evening land in the same place. Multiplied,
 * both fall, and only an event that is good on BOTH axes reaches the top — which is what "for you"
 * has to mean if it is going to be worth switching to.
 *
 * `$ifNull: ['$connectionScore', 0]` matches how the existing `connections` sort already treats a
 * document with no score: descending order puts nulls last. Documents predating
 * `scripts/backfill-connection-score.ts` therefore rank the same way in both views instead of
 * jumping when the user switches tabs.
 */
export function relevanceRankExpr(context: RelevanceContext): MongoExpr {
  return {
    $multiply: [
      { $ifNull: ['$connectionScore', 0] },
      {
        $add: [
          RELEVANCE_MULTIPLIER_FLOOR,
          {
            $multiply: [
              1 - RELEVANCE_MULTIPLIER_FLOOR,
              { $divide: [relevanceExpr(context), 100] },
            ],
          },
        ],
      },
    ],
  };
}

/**
 * The same combination in TypeScript, for callers that already hold both numbers.
 *
 * Exists so the pair test can assert the expression and the scalar path agree here too — the
 * combination is where the subtle edge was, so leaving it evaluable in only one place would leave
 * the part that broke untested.
 */
export function combinedRank(connectionScore: number | null | undefined, relevance: number): number {
  const worth = connectionScore ?? 0;
  const multiplier =
    RELEVANCE_MULTIPLIER_FLOOR + (1 - RELEVANCE_MULTIPLIER_FLOOR) * (relevance / 100);
  return worth * multiplier;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Validation
//
// GUARD FIRST, VALIDATE SECOND is the route's job; this is the "validate" half, and it is pure so
// it runs before `connectDB()` — a malformed preference payload needs no database to refuse. It
// returns field-named issues rather than throwing, so the route can answer 400 without ever
// letting a Mongoose ValidationError reach the response and leak the model name and schema path.
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type PreferenceIssue = { field: string; message: string };

const VALID_TOPICS = new Set<string>(EVENT_CATEGORIES);
const VALID_AREAS = new Set<string>(BENGALURU_AREAS);

/**
 * Caps on list length. Belt-and-braces rather than the primary defence — the allowlist plus the
 * de-duplication in `stringList` already bound both lists to the size of their vocabulary, so
 * these can only fire if a vocabulary shrinks while a stored preference still names the old
 * values. Kept because the alternative is a bound that exists only as a side effect of two other
 * rules, and side effects get refactored away.
 */
export const MAX_TOPICS = EVENT_CATEGORIES.length;
export const MAX_AREAS = BENGALURU_AREAS.length;

function stringList(
  raw: unknown,
  field: string,
  allowed: Set<string>,
  cap: number,
  issues: PreferenceIssue[]
): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    issues.push({ field, message: `${field} must be an array.` });
    return undefined;
  }
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') {
      issues.push({ field, message: `${field} must contain only strings.` });
      return undefined;
    }
    const value = item.trim();
    if (!value) continue;
    if (!allowed.has(value)) {
      issues.push({ field, message: `“${value}” is not a recognised ${field.replace(/s$/, '')}.` });
      return undefined;
    }
    // De-duplicated on the way in: a repeated topic must not count twice in the score, and the
    // `$setIntersection` on the aggregation side de-duplicates whether we do or not.
    if (!out.includes(value)) out.push(value);
  }
  if (out.length > cap) {
    issues.push({ field, message: `Pick at most ${cap}.` });
    return undefined;
  }
  return out;
}

/**
 * Merge a PATCH-shaped body onto the user's current preferences.
 *
 * PARTIAL BY DESIGN — only the keys actually present in the body are changed. Three callers
 * depend on that and each would be broken by a whole-object replace:
 *
 *   · Onboarding's SKIP sends `{}`. A replace would reset the preferences of a returning user who
 *     opened the flow again and changed their mind, which is the opposite of skipping.
 *   · Each onboarding card can save independently without carrying the other two cards' answers.
 *   · The notifications stream sets `digestFrequency` alone and must not clear a topic list it
 *     knows nothing about.
 */
export function mergePreferences(
  current: UserPreferences,
  patch: unknown
): { preferences: UserPreferences | null; issues: PreferenceIssue[] } {
  const issues: PreferenceIssue[] = [];
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return {
      preferences: null,
      issues: [{ field: 'body', message: 'Expected a JSON object.' }],
    };
  }
  const body = patch as Record<string, unknown>;
  const next: UserPreferences = {
    topics: [...current.topics],
    areas: [...current.areas],
    format: current.format,
    evenings: [...current.evenings],
    remindersEnabled: current.remindersEnabled,
    digestFrequency: current.digestFrequency,
  };

  const topics = stringList(body.topics, 'topics', VALID_TOPICS, MAX_TOPICS, issues);
  if (topics) next.topics = topics;

  const areas = stringList(body.areas, 'areas', VALID_AREAS, MAX_AREAS, issues);
  if (areas) next.areas = areas;

  if (body.format !== undefined) {
    if (typeof body.format !== 'string' || !FORMAT_PREFERENCES.includes(body.format as FormatPreference)) {
      issues.push({
        field: 'format',
        message: `format must be one of: ${FORMAT_PREFERENCES.join(', ')}.`,
      });
    } else {
      next.format = body.format as FormatPreference;
    }
  }

  if (body.evenings !== undefined) {
    if (!Array.isArray(body.evenings)) {
      issues.push({ field: 'evenings', message: 'evenings must be an array of day numbers.' });
    } else {
      const days: number[] = [];
      let bad = false;
      for (const day of body.evenings) {
        if (typeof day !== 'number' || !Number.isInteger(day) || day < 0 || day > 6) {
          issues.push({
            field: 'evenings',
            message: 'evenings must be whole numbers from 0 (Sunday) to 6 (Saturday).',
          });
          bad = true;
          break;
        }
        if (!days.includes(day)) days.push(day);
      }
      if (!bad) next.evenings = days.sort((a, b) => a - b);
    }
  }

  if (body.remindersEnabled !== undefined) {
    if (typeof body.remindersEnabled !== 'boolean') {
      issues.push({ field: 'remindersEnabled', message: 'remindersEnabled must be true or false.' });
    } else {
      next.remindersEnabled = body.remindersEnabled;
    }
  }

  if (body.digestFrequency !== undefined) {
    if (
      typeof body.digestFrequency !== 'string' ||
      !DIGEST_FREQUENCIES.includes(body.digestFrequency as DigestFrequency)
    ) {
      issues.push({
        field: 'digestFrequency',
        message: `digestFrequency must be one of: ${DIGEST_FREQUENCIES.join(', ')}.`,
      });
    } else {
      next.digestFrequency = body.digestFrequency as DigestFrequency;
    }
  }

  if (issues.length > 0) return { preferences: null, issues };
  return { preferences: next, issues };
}

/** Error body for a rejected preference payload. Same shape as `manualEventError`. */
export function preferenceError(issues: PreferenceIssue[]) {
  return {
    error: issues[0]?.message ?? 'Those preferences could not be saved.',
    issues,
  };
}

/**
 * Coerce whatever is stored on a `User` document into a complete `UserPreferences`.
 *
 * ABSENCE IS THE NORMAL STATE and must not be a special case at every call site: every user
 * predates this field. Reading through here means a missing `preferences`, a partially-written
 * one, and a complete one all behave identically — and a value that has somehow gone invalid in
 * the database degrades to the default for that field rather than poisoning the score.
 */
export function readPreferences(stored: unknown): UserPreferences {
  const raw = (stored ?? {}) as Record<string, unknown>;
  const { preferences } = mergePreferences(DEFAULT_PREFERENCES, {
    // Only pass through values that are already the right shape; `mergePreferences` rejects the
    // whole payload on a bad field, which is right for a request and wrong for a read.
    ...(Array.isArray(raw.topics) ? { topics: raw.topics.filter(t => VALID_TOPICS.has(t as string)) } : {}),
    ...(Array.isArray(raw.areas) ? { areas: raw.areas.filter(a => VALID_AREAS.has(a as string)) } : {}),
    ...(typeof raw.format === 'string' && FORMAT_PREFERENCES.includes(raw.format as FormatPreference)
      ? { format: raw.format }
      : {}),
    ...(Array.isArray(raw.evenings)
      ? { evenings: raw.evenings.filter(d => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6) }
      : {}),
    ...(typeof raw.remindersEnabled === 'boolean' ? { remindersEnabled: raw.remindersEnabled } : {}),
    ...(typeof raw.digestFrequency === 'string' &&
    DIGEST_FREQUENCIES.includes(raw.digestFrequency as DigestFrequency)
      ? { digestFrequency: raw.digestFrequency }
      : {}),
  });
  return preferences ?? { ...DEFAULT_PREFERENCES };
}
