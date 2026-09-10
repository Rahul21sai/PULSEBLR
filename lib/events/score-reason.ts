/**
 * WHY does this event rank where it ranks? In words, from the same arithmetic that ranked it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE PROBLEM THIS SOLVES. `connectionScore` orders the whole feed — it is the app's one signal
 * Luma and Meetup cannot show — and it rendered as three bars and nothing else. Three bars with no
 * words make "Best for connections" look arbitrary, so the ranking cannot be agreed or disagreed
 * with. This turns an event into a short clause: `in person · 40 going · food · hosted by Razorpay`.
 *
 * TWO RULES, both from CLAUDE.md, and both load-bearing:
 *
 *   1. NEVER PRINT THE NUMBER. The score is a ranking signal, not a measurement; printing "83"
 *      implies a precision it does not have. `weight` below exists to ORDER the clauses and must
 *      never reach a screen.
 *
 *   2. THE REASON MUST NOT BE A SECOND OPINION. A reason that disagrees with the score is worse
 *      than no reason, because it teaches the reader to distrust the bars. So nothing here restates
 *      a weight, a threshold or a regex — every number below is MEASURED by calling
 *      `connectionScore` twice and differencing. Change `IN_PERSON_BONUS` from 34 to 6 and
 *      "in person" drops down the list on its own; add a word to `FUNNEL_PATTERN` and the events
 *      that word catches start reading "reads like a course" with no edit here.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * HOW THE MEASUREMENT WORKS, AND WHY IT IS NOT MEASURED IN CONTEXT.
 *
 * The obvious design is a marginal delta: score the event, score it again with one signal removed,
 * and subtract. It is wrong, for one reason that only shows up on the best events —
 * `connectionScore` CLAMPS to 0-100 and the terms sum to 116. On a 100-point event, removing an
 * 8-point term still scores 100, the delta reads 0, and the reason silently vanishes from exactly
 * the event whose panel matters most. The floor clamps too: baseline 20 plus an online penalty
 * cannot absorb the 30-point funnel penalty, so a course advert loses its explanation as well.
 *
 * So each signal is measured against a fixed ANCHOR: the same event with every OTHER scored field
 * at a no-contribution value. One term at a time against a baseline of 54 (20 + in-person) leaves
 * headroom of +46 and -54, which no single current term comes close to, so no probe can clamp.
 *
 * The trade is that a weight is the signal's STANDALONE value rather than its marginal one — an
 * organiser bonus reads as 3 points even on an event whose company bonus already displaced it.
 * That is the better reading for a person anyway: "hosted by Razorpay" is worth what it is worth,
 * and which internal branch it happened to win is not something a reader needs.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * PURE, and tested like `connection-score.ts` (`tests/score-reason.test.ts`). No React, no dates,
 * no I/O — it may be imported by a server component and a client component alike.
 */

import {
  connectionScore,
  connectionTier,
  type ConnectionScoreInput,
} from './connection-score';

/**
 * The signals a reason can be about. ONE reason per signal reaches the reader: `format` is probed
 * from both ends and `host` from two different fields, and a card that said both "hosted by
 * Razorpay" and "hosted by Razorpay Rize" would be repeating itself.
 */
export type ReasonSignal = 'format' | 'framing' | 'attendees' | 'gathering' | 'food' | 'host' | 'price';

export interface ScoreReason {
  signal: ReasonSignal;
  /** Does this term ADD to the score (true) or subtract from it (false)? */
  good: boolean;
  /**
   * Points, measured — see the header. FOR ORDERING ONLY. Rendering it would print the number this
   * module exists to avoid, one term at a time.
   */
  weight: number;
  /** Two or three words, for a card: `in person`, `food`, `reads like a course`. */
  short: string;
  /** A full clause, for the detail page. */
  long: string;
}

/**
 * Every field `ConnectionScoreInput` declares, mapped to the reason that explains it — or to `null`
 * when the scorer reads the field but weights nothing by it.
 *
 * A `Record` over `keyof`, so ADDING A FIELD TO THE SCORER'S INPUT FAILS THE BUILD HERE until
 * somebody decides whether it needs an explanation. That is the guard against the one failure mode
 * this module cannot detect at runtime: a new term quietly moving the ranking with no clause to
 * account for it. `tests/score-reason.test.ts` closes the loop by asserting that every non-null
 * signal really is produced by a probe, and that `capacity` really does still weigh nothing.
 */
export const FIELD_SIGNALS: Record<keyof ConnectionScoreInput, ReasonSignal | null> = {
  format: 'format',
  hasFood: 'food',
  attendeeCount: 'attendees',
  /** Declared on the input and read by nothing in the scorer today. */
  capacity: null,
  category: 'gathering',
  companies: 'host',
  organizer: 'host',
  title: 'framing',
  isFree: 'price',
  price: 'price',
};

/**
 * Every scored field at its no-contribution value, EXCEPT `format`.
 *
 * `format` is anchored to `offline` rather than neutralised because it has no neutral value — the
 * scorer's `else` branch is itself a penalty. Anchoring it high is what lifts the baseline to 54
 * and buys the headroom described in the header. The probes that test `format` overwrite it, so
 * they are unaffected.
 */
const ANCHOR: ConnectionScoreInput = {
  format: 'offline',
  hasFood: 'unknown',
  attendeeCount: 0,
  capacity: null,
  category: [],
  companies: [],
  organizer: null,
  title: '',
  isFree: false,
  price: 0,
};

interface Words {
  short: string;
  long: string;
}

interface Probe {
  signal: ReasonSignal;
  /** Fields of the real event this probe lets through to the anchor. Everything else stays neutral. */
  reads: readonly (keyof ConnectionScoreInput)[];
  /** What those fields become in the comparison run. The difference is the weight. */
  reference: Partial<ConnectionScoreInput>;
  /** Wording when the real value scores ABOVE the reference. Return null to decline. */
  gain?: (input: ConnectionScoreInput) => Words | null;
  /** Wording when it scores BELOW. Return null to decline. */
  loss?: (input: ConnectionScoreInput) => Words | null;
}

/**
 * Which of this event's categories the scorer actually rewards — DISCOVERED, not listed.
 *
 * `SOCIAL_CATEGORIES` is private to `connection-score.ts`, and copying it here is precisely the
 * drift this module exists to prevent (the panel this replaces carried a hand-copied funnel regex
 * that had already fallen four entries behind the real one). Probing each category on its own asks
 * the scorer the question instead.
 */
function rewardedCategories(input: ConnectionScoreInput): string[] {
  const categories = input.category ?? [];
  if (!categories.length) return [];
  const none = connectionScore({ ...ANCHOR, category: [] });
  return categories.filter(c => connectionScore({ ...ANCHOR, category: [c] }) > none);
}

function hosts(input: ConnectionScoreInput): string[] {
  return (input.companies ?? []).filter(Boolean).slice(0, 2);
}

/**
 * Declaration order is the tie-break when two reasons weigh the same, so this list runs from the
 * term that moves the ranking most to the term that moves it least.
 */
const PROBES: readonly Probe[] = [
  // ── Being in a room with people: the single biggest term ────────────────────────────────────
  {
    signal: 'format',
    reads: ['format'],
    reference: { format: 'online' },
    gain: input =>
      input.format === 'offline'
        ? { short: 'in person', long: 'In person — you can actually meet people' }
        : input.format === 'hybrid'
          ? { short: 'hybrid', long: 'Hybrid — go in person if you can' }
          : // An event whose format we do not know earns no claim either way.
            null,
  },
  {
    signal: 'format',
    reads: ['format'],
    reference: { format: 'offline' },
    // Only an event that SAYS it is online gets told so. A missing format scores the same as online
    // in the scorer, and reporting that as "online" would be inventing a fact about the venue.
    loss: input =>
      input.format === 'online'
        ? { short: 'online only', long: 'Online — you will watch, not mingle' }
        : null,
  },

  // ── What the title says this is ─────────────────────────────────────────────────────────────
  // One probe covers both title patterns, because both read the same field and the NET is what
  // moved the ranking. An event matching the peer list and the funnel list is, on balance, a
  // funnel, and that is what the reader is told.
  {
    signal: 'framing',
    reads: ['title'],
    reference: { title: '' },
    gain: () => ({
      short: 'peer gathering',
      long: 'Titled like a practitioner gathering rather than a sales session',
    }),
    loss: () => ({
      short: 'reads like a course',
      long: 'Reads like a course or a webinar — you may be in an audience, not a room',
    }),
  },

  // ── People actually coming ──────────────────────────────────────────────────────────────────
  {
    signal: 'attendees',
    reads: ['attendeeCount'],
    reference: { attendeeCount: 0 },
    gain: input => {
      const going = input.attendeeCount ?? 0;
      return going > 0
        ? { short: `${going} going`, long: `${going} people already going` }
        : null;
    },
  },

  // ── The kind of gathering it is ─────────────────────────────────────────────────────────────
  {
    signal: 'gathering',
    reads: ['category'],
    reference: { category: [] },
    gain: input => {
      const names = rewardedCategories(input);
      if (!names.length) return null;
      return {
        short: names[0].toLowerCase(),
        long: `${names.join(', ')} — mingling is the point here, not a side effect`,
      };
    },
  },

  // ── Food ────────────────────────────────────────────────────────────────────────────────────
  // Positive only, and deliberately: the scorer does not PENALISE a missing meal, so "no food" is
  // an absence rather than a fact about the event, and printing it would read as a criticism the
  // ranking never made.
  {
    signal: 'food',
    reads: ['hasFood'],
    reference: { hasFood: 'unknown' },
    gain: () => ({ short: 'food', long: 'Food — people stay and talk once the talks end' }),
  },

  // ── Who is behind it ────────────────────────────────────────────────────────────────────────
  {
    signal: 'host',
    reads: ['companies'],
    reference: { companies: [] },
    gain: input => {
      const names = hosts(input);
      if (!names.length) return null;
      const joined = names.join(' & ');
      return {
        short: `hosted by ${joined}`,
        long: `Hosted by ${joined} — a named company host means accountable, repeatable events`,
      };
    },
  },
  {
    signal: 'host',
    reads: ['organizer'],
    reference: { organizer: null },
    gain: input =>
      input.organizer
        ? {
            short: `hosted by ${input.organizer}`,
            long: `Hosted by ${input.organizer} — a named host means accountable, repeatable events`,
          }
        : null,
  },

  // ── Price ───────────────────────────────────────────────────────────────────────────────────
  {
    signal: 'price',
    reads: ['isFree'],
    reference: { isFree: false },
    gain: () => ({ short: 'free', long: 'Free — free community events draw practitioners' }),
  },
  {
    signal: 'price',
    // `isFree` rides along unchanged because the scorer only looks at `price` when the event is not
    // free. Leaving it at the anchor's `false` would report a steep ticket on a free event.
    reads: ['price', 'isFree'],
    reference: { price: 0 },
    loss: () => ({
      short: 'steep ticket',
      long: 'A steep ticket — usually a corporate conference, or a course',
    }),
  },
];

/** The real event's value for the fields under test, everything else neutral. */
function isolate(input: ConnectionScoreInput, reads: readonly (keyof ConnectionScoreInput)[]) {
  const out: Record<string, unknown> = { ...ANCHOR };
  // ASSIGNED UNCONDITIONALLY, including when the value is `undefined`. Skipping undefined would
  // leave the anchor's own value in place, so an event with no `format` would be measured as if it
  // were `offline` — the anchor leaking into the thing it is supposed to hold still.
  for (const field of reads) out[field] = input[field];
  return out as ConnectionScoreInput;
}

/**
 * Why this event scores what it scores, biggest term first.
 *
 * Returns `[]` for an event with nothing to say about it, which is a real outcome and not an error:
 * a venue-less, host-less, format-unknown row genuinely has no explanation to offer.
 */
export function scoreReasons(input: ConnectionScoreInput): ScoreReason[] {
  const found: Array<ScoreReason & { order: number }> = [];

  PROBES.forEach((probe, order) => {
    const present = isolate(input, probe.reads);
    const absent = { ...present, ...probe.reference };
    const delta = connectionScore(present) - connectionScore(absent);
    if (delta === 0) return;

    const words = delta > 0 ? probe.gain?.(input) : probe.loss?.(input);
    if (!words) return;

    found.push({
      signal: probe.signal,
      good: delta > 0,
      weight: Math.abs(delta),
      short: words.short,
      long: words.long,
      order,
    });
  });

  // One reason per signal: the probe with the biggest effect wins, so `format` resolves to exactly
  // one of in-person / hybrid / online, and `host` prefers the resolved company over the raw
  // organiser string.
  const strongest = new Map<ReasonSignal, ScoreReason & { order: number }>();
  for (const reason of found) {
    const held = strongest.get(reason.signal);
    if (!held || reason.weight > held.weight) strongest.set(reason.signal, reason);
  }

  return [...strongest.values()]
    .sort((a, b) => b.weight - a.weight || a.order - b.order)
    .map(r => ({ signal: r.signal, good: r.good, weight: r.weight, short: r.short, long: r.long }));
}

export interface ReasonLineOptions {
  /** How many clauses to keep. */
  max?: number;
  /**
   * Signals to leave out.
   *
   * A card already carries pills for food, attendee count and price, and an `Online` pill for
   * format — so repeating those in the reason line spends the row's remaining width saying
   * nothing new. The caller decides, because only the caller knows what else is on screen.
   */
  exclude?: readonly ReasonSignal[];
}

/** `in person · 40 going · food · hosted by Razorpay` */
export function scoreReasonLine(
  input: ConnectionScoreInput,
  { max = 4, exclude }: ReasonLineOptions = {}
): string {
  const skip = new Set(exclude ?? []);
  return scoreReasons(input)
    .filter(r => !skip.has(r.signal))
    .slice(0, max)
    .map(r => r.short)
    .join(' · ');
}

/*
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * The meter's three bars and the panel's verdict, from `connectionTier` rather than from a copied
 * pair of thresholds. `>= 70 ? 3 : >= 50 ? 2 : 1` was written out by hand in `EventRow` and again
 * on the detail page, so the bars and the words could have disagreed about the same event.
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 */

const TIER_LEVEL = { high: 3, medium: 2, low: 1 } as const;
const TIER_VERDICT = { high: 'Strong chance', medium: 'Worth a look', low: 'Probably not' } as const;
const TIER_METER_LABEL = {
  high: 'Strong chance of useful contacts',
  medium: 'Some chance of useful contacts',
  low: 'Unlikely to lead to contacts',
} as const;

/** How many of the meter's three bars are lit. */
export function meterLevel(score: number): 1 | 2 | 3 {
  return TIER_LEVEL[connectionTier(score)];
}

/** The detail panel's headline answer to "worth going?". */
export function connectionVerdict(score: number): string {
  return TIER_VERDICT[connectionTier(score)];
}

/** What a screen reader hears in place of the bars. */
export function meterLabel(score: number): string {
  return TIER_METER_LABEL[connectionTier(score)];
}
