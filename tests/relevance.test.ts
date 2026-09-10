import { describe, it, expect } from 'vitest';
import {
  relevanceScore,
  relevanceExpr,
  relevanceRankExpr,
  combinedRank,
  hasRankingPreferences,
  preferenceSummary,
  DEFAULT_PREFERENCES,
  RELEVANCE_BASELINE,
  RELEVANCE_WEIGHTS,
  TOPIC_CHOICES,
  AREA_CHOICES,
  type UserPreferences,
  type RelevanceInput,
  type RelevanceContext,
} from '@/lib/events/relevance';

/**
 * `relevanceScore` is the per-user half of the feed's ranking, multiplied against the shared
 * `connectionScore`. Like that one it is pure and deterministic so the ORDER it produces can be
 * pinned rather than trusted.
 *
 * These assert RELATIVE order and the documented weight ordering, not exact totals — with one
 * deliberate exception, `RELEVANCE_BASELINE`, which IS pinned exactly because a specific property
 * depends on its uniformity (see "no preferences" below).
 *
 * WHAT MUST NOT SCORE HIGH is tested as carefully as what must, because this model's failure mode
 * is not a wrong number, it is a personalised feed that quietly ranks the same as the
 * unpersonalised one while claiming to be tailored — which no aggregate reveals.
 */

function prefs(patch: Partial<UserPreferences> = {}): UserPreferences {
  return { ...DEFAULT_PREFERENCES, ...patch };
}

function ctx(patch: Partial<UserPreferences> = {}, targetCompanies?: string[]): RelevanceContext {
  return { preferences: prefs(patch), targetCompanies };
}

/** A Wednesday, 18:30 IST. 2026-09-16T13:00:00Z is 18:30 IST on Wed 16 Sept 2026. */
const WED_EVENING = '2026-09-16T13:00:00.000Z';
/** The Saturday of the same week, same local time. */
const SAT_EVENING = '2026-09-19T13:00:00.000Z';
/**
 * 20:00 IST on a Sunday — 14:30Z. Included because it is the case a naive UTC day-of-week gets
 * WRONG: in UTC this instant is still Sunday, but a 00:30 IST event would be the previous day in
 * UTC and the shift is what catches it.
 */
const SUN_EVENING = '2026-09-20T14:30:00.000Z';
/** 00:30 IST Monday = 19:00Z Sunday. The UTC day and the IST day genuinely differ here. */
const MON_MIDNIGHT_IST = '2026-09-20T19:00:00.000Z';

const kubernetesMeetup: RelevanceInput = {
  area: 'Koramangala',
  format: 'offline',
  category: ['Cloud/DevOps', 'Meetup'],
  companies: ['Razorpay'],
  startDateTime: WED_EVENING,
};

describe('relevanceScore — bounds and the neutral floor', () => {
  it('stays within 0-100 for any input, including nonsense', () => {
    const inputs: RelevanceInput[] = [
      {},
      { area: null, format: null, category: null, companies: null, startDateTime: null },
      { area: 'Whitefield', format: 'online', category: [], startDateTime: 'not a date' },
      kubernetesMeetup,
    ];
    const contexts: RelevanceContext[] = [
      ctx(),
      ctx({ areas: [...AREA_CHOICES], topics: [...TOPIC_CHOICES], format: 'offline', evenings: [3] }),
      ctx({ areas: ['Jayanagar'], format: 'online', evenings: [5], topics: ['Blockchain/Web3'] }),
    ];
    for (const input of inputs) {
      for (const context of contexts) {
        const score = relevanceScore(input, context);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(100);
      }
    }
  });

  it('BOTH clamps are reachable, so neither is decoration', () => {
    // Everything matching overflows 100; everything missing goes below 0.
    const best = relevanceScore(kubernetesMeetup, ctx(
      { areas: ['Koramangala'], format: 'offline', evenings: [3], topics: ['Cloud/DevOps', 'Meetup'] },
      ['Razorpay']
    ));
    const worst = relevanceScore(
      { area: 'Whitefield', format: 'online', category: ['Arts/Culture'], startDateTime: SAT_EVENING },
      ctx({ areas: ['Jayanagar'], format: 'offline', evenings: [1], topics: ['Cloud/DevOps'] })
    );
    expect(best).toBe(100);
    expect(worst).toBe(0);
  });

  /**
   * THE PROPERTY THAT MAKES A SKIPPED ONBOARDING SAFE.
   *
   * With nothing stated, every event must get the SAME score — the combined rank multiplies
   * `connectionScore` by it, and a uniform multiplier preserves order exactly. So
   * `For you` for a user who skipped is byte-identical in ordering to `Everything`, rather than
   * being noise or being empty. This is the single most important assertion in the file.
   */
  it('scores every event identically when no preference is expressed', () => {
    const events: RelevanceInput[] = [
      kubernetesMeetup,
      { area: 'Other', format: 'online', category: ['AI/ML'], startDateTime: SAT_EVENING },
      {},
      { area: 'Whitefield', format: 'hybrid', category: [], companies: ['Google'] },
    ];
    const scores = events.map(e => relevanceScore(e, ctx()));
    expect(new Set(scores).size).toBe(1);
    expect(scores[0]).toBe(RELEVANCE_BASELINE);
  });

  it('does not treat the notification preferences as ranking signal', () => {
    // They live in the same object and are read by lib/notifications/. Scoring on them would
    // make the digest cadence silently reorder the feed.
    const quiet = relevanceScore(kubernetesMeetup, ctx({ remindersEnabled: false, digestFrequency: 'off' }));
    const loud = relevanceScore(kubernetesMeetup, ctx({ remindersEnabled: true, digestFrequency: 'daily' }));
    expect(quiet).toBe(loud);
    expect(hasRankingPreferences(prefs({ digestFrequency: 'daily', remindersEnabled: false }))).toBe(false);
  });
});

describe('relevanceScore — the weight ORDER is the model', () => {
  /**
   * The headline finding this whole file is shaped around: `AI/ML` is 189 of 297 upcoming tech
   * events, so topic is the WEAKEST discriminator even though it is what users think they are
   * choosing. Area and format must each outrank it.
   */
  it('weights area and format above topic, because commute predicts attendance and subject does not', () => {
    expect(RELEVANCE_WEIGHTS.areaMatch).toBeGreaterThan(RELEVANCE_WEIGHTS.topicFirst);
    expect(RELEVANCE_WEIGHTS.formatMatch).toBeGreaterThan(RELEVANCE_WEIGHTS.topicFirst);
    expect(RELEVANCE_WEIGHTS.dayMatch).toBeGreaterThan(RELEVANCE_WEIGHTS.topicFirst);

    // And it holds end to end, not just as constants: a reachable event on the wrong topic beats
    // the right topic across town.
    const nearbyWrongTopic = relevanceScore(
      { area: 'Koramangala', format: 'offline', category: ['Blockchain/Web3'] },
      ctx({ areas: ['Koramangala'], format: 'offline', topics: ['AI/ML'] })
    );
    const farRightTopic = relevanceScore(
      { area: 'Devanahalli', format: 'online', category: ['AI/ML'] },
      ctx({ areas: ['Koramangala'], format: 'offline', topics: ['AI/ML'] })
    );
    expect(nearbyWrongTopic).toBeGreaterThan(farRightTopic);
  });

  it('penalises a day that does not work more gently than it rewards one that does', () => {
    // Asymmetric on purpose: "Fridays don't usually work" is a tendency, not a calendar filter.
    expect(Math.abs(RELEVANCE_WEIGHTS.dayMiss)).toBeLessThan(RELEVANCE_WEIGHTS.dayMatch);
  });

  it('caps the additional-topic bonus so picking everything is not the way to rank highest', () => {
    const wide = ctx({ topics: [...TOPIC_CHOICES] });
    const oneHit = relevanceScore({ category: ['AI/ML'] }, wide);
    const manyHits = relevanceScore(
      { category: ['AI/ML', 'Cloud/DevOps', 'Web/Mobile', 'Meetup', 'Conference', 'Hackathon'] },
      wide
    );
    expect(manyHits).toBeGreaterThan(oneHit);
    expect(manyHits - oneHit).toBe(RELEVANCE_WEIGHTS.topicExtraCap);
  });
});

describe('relevanceScore — what must NOT be penalised', () => {
  /**
   * `resolveArea` resolves about half the corpus; 200+ upcoming events sit at `'Other'`. An
   * unknown area is a SCRAPER gap, not a mismatch, and treating it as one would push a fifth of
   * the feed down for something the reader neither caused nor can see.
   */
  it('scores an unresolved area neutrally rather than as a miss', () => {
    const preference = ctx({ areas: ['Koramangala'] });
    const unknown = relevanceScore({ area: 'Other', format: 'offline' }, preference);
    const absent = relevanceScore({ format: 'offline' }, preference);
    const empty = relevanceScore({ area: '', format: 'offline' }, preference);
    const elsewhere = relevanceScore({ area: 'Devanahalli', format: 'offline' }, preference);

    expect(unknown).toBe(RELEVANCE_BASELINE);
    expect(absent).toBe(RELEVANCE_BASELINE);
    expect(empty).toBe(RELEVANCE_BASELINE);
    expect(elsewhere).toBeLessThan(unknown);
  });

  it('scores an untagged event neutrally rather than as a topic mismatch', () => {
    const preference = ctx({ topics: ['AI/ML'] });
    expect(relevanceScore({ category: [] }, preference)).toBe(RELEVANCE_BASELINE);
    expect(relevanceScore({}, preference)).toBe(RELEVANCE_BASELINE);
    // But a tagged event with no overlap IS a real mismatch.
    expect(relevanceScore({ category: ['Arts/Culture'] }, preference)).toBeLessThan(RELEVANCE_BASELINE);
  });

  /**
   * The asymmetry that protects this product's best events. Most community meetups resolve no
   * company at all; penalising that would reward a corporate logo over a practitioner meetup,
   * which is the exact inversion `connectionScore` exists to prevent.
   */
  it('never penalises an event for having no company', () => {
    const preference = ctx({}, ['Razorpay']);
    const noCompany = relevanceScore({ format: 'offline', category: ['Meetup'] }, preference);
    expect(noCompany).toBe(RELEVANCE_BASELINE);
    expect(relevanceScore({ companies: ['Razorpay'] }, preference)).toBeGreaterThan(noCompany);
    expect(relevanceScore({ companies: ['Zoho'] }, preference)).toBe(noCompany);
  });

  it('treats an unknown format as no opinion, not as a miss', () => {
    const preference = ctx({ format: 'offline' });
    expect(relevanceScore({}, preference)).toBe(RELEVANCE_BASELINE);
    expect(relevanceScore({ format: 'nonsense' }, preference)).toBe(RELEVANCE_BASELINE);
    expect(relevanceScore({ format: 'online' }, preference)).toBeLessThan(RELEVANCE_BASELINE);
  });

  /**
   * Selecting all seven days says exactly what selecting none says. If it were treated as a
   * preference, "every day works" would inflate every score and penalise nothing — a filter that
   * looks active and cannot discriminate.
   */
  it('treats all seven evenings the same as none', () => {
    const all = ctx({ evenings: [0, 1, 2, 3, 4, 5, 6] });
    const none = ctx();
    expect(relevanceScore(kubernetesMeetup, all)).toBe(relevanceScore(kubernetesMeetup, none));
    expect(hasRankingPreferences(prefs({ evenings: [0, 1, 2, 3, 4, 5, 6] }))).toBe(false);
    expect(hasRankingPreferences(prefs({ evenings: [2, 3] }))).toBe(true);
  });
});

describe('relevanceScore — day of week is IST, not UTC', () => {
  it('reads the IST calendar day, so a late-evening event is not filed under the previous day', () => {
    // 19:00Z Sunday is 00:30 IST MONDAY. A UTC reading would call this Sunday.
    const mondayPerson = ctx({ evenings: [1] });
    const sundayPerson = ctx({ evenings: [0] });
    expect(relevanceScore({ startDateTime: MON_MIDNIGHT_IST }, mondayPerson)).toBeGreaterThan(
      relevanceScore({ startDateTime: MON_MIDNIGHT_IST }, sundayPerson)
    );
  });

  it('matches the day the user picked and misses the others', () => {
    const wednesdays = ctx({ evenings: [3] });
    expect(relevanceScore({ startDateTime: WED_EVENING }, wednesdays)).toBe(
      RELEVANCE_BASELINE + RELEVANCE_WEIGHTS.dayMatch
    );
    expect(relevanceScore({ startDateTime: SAT_EVENING }, wednesdays)).toBe(
      RELEVANCE_BASELINE + RELEVANCE_WEIGHTS.dayMiss
    );
    // Sunday is 0, which is falsy — the one index that a truthiness bug would silently drop.
    expect(relevanceScore({ startDateTime: SUN_EVENING }, ctx({ evenings: [0] }))).toBe(
      RELEVANCE_BASELINE + RELEVANCE_WEIGHTS.dayMatch
    );
  });

  it('ignores an unparseable date instead of scoring it as a miss', () => {
    expect(relevanceScore({ startDateTime: 'never' }, ctx({ evenings: [3] }))).toBe(RELEVANCE_BASELINE);
    expect(relevanceScore({ startDateTime: new Date(WED_EVENING) }, ctx({ evenings: [3] }))).toBe(
      RELEVANCE_BASELINE + RELEVANCE_WEIGHTS.dayMatch
    );
  });
});

describe('relevanceScore — hybrid is neither a match nor a miss', () => {
  it('gives hybrid partial credit against an in-person preference', () => {
    const wantsRoom = ctx({ format: 'offline' });
    const offline = relevanceScore({ format: 'offline' }, wantsRoom);
    const hybrid = relevanceScore({ format: 'hybrid' }, wantsRoom);
    const online = relevanceScore({ format: 'online' }, wantsRoom);
    expect(offline).toBeGreaterThan(hybrid);
    expect(hybrid).toBeGreaterThan(online);
    // And the partial is credit, not a smaller penalty.
    expect(hybrid).toBeGreaterThan(RELEVANCE_BASELINE);
  });

  it('never calls anything a miss when the user asked for hybrid', () => {
    const wantsHybrid = ctx({ format: 'hybrid' });
    for (const format of ['offline', 'online', 'hybrid']) {
      expect(relevanceScore({ format }, wantsHybrid)).toBeGreaterThanOrEqual(RELEVANCE_BASELINE);
    }
  });
});

describe('preferenceSummary', () => {
  it('is empty when nothing is set, so the header can decide not to draw it', () => {
    expect(preferenceSummary(prefs())).toBe('');
  });

  it('names small selections and counts large ones', () => {
    expect(preferenceSummary(prefs({ topics: ['AI/ML', 'Cloud/DevOps'] }))).toBe('AI/ML + Cloud/DevOps');
    expect(preferenceSummary(prefs({ topics: ['AI/ML', 'Cloud/DevOps', 'Web/Mobile'] }))).toBe('3 topics');
    expect(preferenceSummary(prefs({ areas: ['Koramangala'], format: 'offline', evenings: [2, 3] }))).toBe(
      'Koramangala · in person · Tue/Wed'
    );
  });

  it('says nothing about seven-day or empty evenings, matching the score', () => {
    expect(preferenceSummary(prefs({ evenings: [0, 1, 2, 3, 4, 5, 6] }))).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE PAIR TEST — the scalar scorer and the aggregation expression must agree exactly.
//
// The model has two evaluators because the ranking has to happen in the database (a score
// computed in JavaScript orders 30 rows that a DIFFERENT sort already chose, which is not a
// ranking). Two evaluators for one model is the drift this codebase's comments are full of
// warnings about, so it is pinned here rather than trusted: the expression is run through a small
// interpreter and asserted equal to the function, over a table of events × preference sets.
//
// The interpreter THROWS on any operator it does not know. That matters — an evaluator that
// silently returned 0 for an unrecognised stage would make this whole section pass while measuring
// nothing, which is the failure mode of every "assert two things agree" test.
// ─────────────────────────────────────────────────────────────────────────────────────────────

type Doc = Record<string, unknown>;

function evalExpr(expr: unknown, doc: Doc, vars: Doc = {}): unknown {
  if (typeof expr === 'number' || typeof expr === 'boolean') return expr;

  if (typeof expr === 'string') {
    if (expr.startsWith('$$')) {
      const name = expr.slice(2);
      if (!(name in vars)) throw new Error(`unbound variable ${expr}`);
      return vars[name];
    }
    if (expr.startsWith('$')) {
      const path = expr.slice(1);
      // No dotted paths are used by relevanceExpr; refuse rather than silently mis-read one.
      if (path.includes('.')) throw new Error(`interpreter does not support dotted path ${expr}`);
      return path in doc ? doc[path] : undefined;
    }
    return expr;
  }

  if (Array.isArray(expr)) return expr.map(e => evalExpr(e, doc, vars));
  if (expr === null || expr === undefined) return expr ?? null;

  const keys = Object.keys(expr as Doc);
  if (keys.length !== 1) throw new Error(`expected exactly one operator, got ${keys.join(',')}`);
  const op = keys[0];
  const arg = (expr as Doc)[op];
  const args = () => (Array.isArray(arg) ? arg.map(a => evalExpr(a, doc, vars)) : [evalExpr(arg, doc, vars)]);
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

  switch (op) {
    case '$literal':
      return arg;
    case '$add':
      return args().reduce((a, b) => num(a) + num(b), 0);
    case '$subtract': {
      const [a, b] = args();
      return num(a) - num(b);
    }
    case '$multiply':
      return args().reduce((a: unknown, b) => num(a) * num(b), 1);
    case '$divide': {
      const [a, b] = args();
      return num(a) / num(b);
    }
    case '$min':
      return Math.min(...args().flat().map(num));
    case '$max':
      return Math.max(...args().flat().map(num));
    case '$size': {
      const [v] = args();
      if (!Array.isArray(v)) throw new Error('$size on a non-array');
      return v.length;
    }
    case '$setIntersection': {
      const sets = args().map(v => (Array.isArray(v) ? v : []));
      const [first, ...rest] = sets;
      const out = [...new Set(first)].filter(x => rest.every(s => s.includes(x)));
      return out;
    }
    case '$ifNull': {
      const [value, fallback] = args();
      return value === null || value === undefined ? fallback : value;
    }
    case '$eq': {
      const [a, b] = args();
      return a === b;
    }
    case '$ne': {
      const [a, b] = args();
      return a !== b;
    }
    case '$gt': {
      const [a, b] = args();
      return num(a) > num(b);
    }
    case '$in': {
      const [value, list] = args();
      if (!Array.isArray(list)) throw new Error('$in without an array');
      return list.includes(value);
    }
    case '$and':
      return args().every(Boolean);
    case '$or':
      return args().some(Boolean);
    case '$cond': {
      if (Array.isArray(arg)) {
        const [test, then, otherwise] = arg;
        return evalExpr(test, doc, vars) ? evalExpr(then, doc, vars) : evalExpr(otherwise, doc, vars);
      }
      const spec = arg as Doc;
      return evalExpr(spec.if, doc, vars)
        ? evalExpr(spec.then, doc, vars)
        : evalExpr(spec.else, doc, vars);
    }
    case '$switch': {
      const spec = arg as { branches: Array<{ case: unknown; then: unknown }>; default?: unknown };
      if (!Array.isArray(spec.branches) || spec.branches.length === 0) {
        throw new Error('$switch with no branches');
      }
      for (const branch of spec.branches) {
        if (evalExpr(branch.case, doc, vars)) return evalExpr(branch.then, doc, vars);
      }
      if (!('default' in spec)) throw new Error('$switch fell through with no default');
      return evalExpr(spec.default, doc, vars);
    }
    case '$let': {
      const spec = arg as { vars: Doc; in: unknown };
      const bound: Doc = { ...vars };
      for (const [name, value] of Object.entries(spec.vars)) {
        bound[name] = evalExpr(value, doc, bound);
      }
      return evalExpr(spec.in, doc, bound);
    }
    case '$dayOfWeek': {
      const spec = arg as { date: unknown; timezone?: string };
      if (spec.timezone !== 'Asia/Kolkata') {
        throw new Error(`interpreter only models Asia/Kolkata, got ${String(spec.timezone)}`);
      }
      const raw = evalExpr(spec.date, doc, vars);
      const date = raw instanceof Date ? raw : new Date(String(raw));
      const ms = date.getTime();
      // Mongo errors on a non-date here; the pipeline is only ever run over `Event` documents
      // whose `startDateTime` is required, so an unparseable value is an interpreter fault.
      if (Number.isNaN(ms)) throw new Error('$dayOfWeek on an invalid date');
      // 1-based with Sunday = 1, which is what the real operator returns.
      return new Date(ms + 5.5 * 3600 * 1000).getUTCDay() + 1;
    }
    default:
      throw new Error(`unsupported operator ${op}`);
  }
}

describe('relevanceExpr agrees with relevanceScore', () => {
  const events: RelevanceInput[] = [
    kubernetesMeetup,
    { area: 'Whitefield', format: 'online', category: ['AI/ML'], startDateTime: SAT_EVENING },
    { area: 'Other', format: 'hybrid', category: ['AI/ML', 'Conference'], startDateTime: SUN_EVENING },
    { area: '', format: 'offline', category: [], startDateTime: MON_MIDNIGHT_IST },
    { format: 'offline', category: ['Meetup'], companies: ['Google', 'Razorpay'], startDateTime: WED_EVENING },
    {
      area: 'Jayanagar',
      format: 'offline',
      category: ['Cloud/DevOps', 'AI/ML', 'Web/Mobile', 'Meetup', 'Conference'],
      companies: [],
      startDateTime: WED_EVENING,
    },
    // Fields genuinely absent, which is the shape of a document written before a field existed.
    { startDateTime: WED_EVENING },
  ];

  const contexts: Array<{ label: string; context: RelevanceContext }> = [
    { label: 'no preferences', context: ctx() },
    { label: 'areas only', context: ctx({ areas: ['Koramangala', 'Jayanagar'] }) },
    { label: 'format only', context: ctx({ format: 'offline' }) },
    { label: 'hybrid preference', context: ctx({ format: 'hybrid' }) },
    { label: 'evenings only', context: ctx({ evenings: [1, 2, 3] }) },
    { label: 'all seven evenings', context: ctx({ evenings: [0, 1, 2, 3, 4, 5, 6] }) },
    { label: 'topics only', context: ctx({ topics: ['AI/ML', 'Cloud/DevOps'] }) },
    { label: 'target companies only', context: ctx({}, ['Razorpay', 'Postman']) },
    {
      label: 'everything at once',
      context: ctx(
        { areas: ['Koramangala'], format: 'offline', evenings: [3], topics: ['Cloud/DevOps', 'Meetup', 'AI/ML'] },
        ['Razorpay']
      ),
    },
  ];

  for (const { label, context } of contexts) {
    it(`matches for: ${label}`, () => {
      const expr = relevanceExpr(context);
      for (const event of events) {
        // The document as Mongo would see it: absent fields are absent, not null.
        const doc: Doc = {};
        for (const [key, value] of Object.entries(event)) {
          if (value !== undefined) doc[key] = value;
        }
        expect(evalExpr(expr, doc)).toBe(relevanceScore(event, context));
      }
    });
  }

  it('refuses to evaluate an operator it does not model, so agreement cannot be vacuous', () => {
    expect(() => evalExpr({ $sqrt: 4 }, {})).toThrow(/unsupported operator/);
    expect(() => evalExpr({ $dayOfWeek: { date: '$startDateTime', timezone: 'UTC' } }, {})).toThrow(
      /Asia\/Kolkata/
    );
  });
});

describe('relevanceRankExpr — worth-attending × for-me', () => {
  const context = ctx({ areas: ['Koramangala'], format: 'offline', topics: ['Cloud/DevOps'] });
  const rank = (doc: Doc) => evalExpr(relevanceRankExpr(context), doc) as number;
  const perfectFit = { area: 'Koramangala', format: 'offline', category: ['Cloud/DevOps'] };
  const totalMiss = { area: 'Devanahalli', format: 'online', category: ['Arts/Culture'] };

  it('agrees with combinedRank, so the edge that broke is evaluable on both paths', () => {
    for (const event of [perfectFit, totalMiss, {} as RelevanceInput]) {
      for (const score of [0, 12, 55, 88, 100]) {
        const doc: Doc = { ...event, connectionScore: score };
        expect(rank(doc)).toBeCloseTo(combinedRank(score, relevanceScore(event, context)), 10);
      }
    }
  });

  it('stays on a 0-100 scale, and reaches 100 only at both extremes', () => {
    // A relevance of 100 needs every term, so this context is wider than the one above.
    const saturated = ctx(
      { areas: ['Koramangala'], format: 'offline', evenings: [3], topics: ['Cloud/DevOps', 'Meetup'] },
      ['Razorpay']
    );
    const best = evalExpr(relevanceRankExpr(saturated), {
      ...kubernetesMeetup,
      connectionScore: 100,
    } as Doc) as number;
    expect(relevanceScore(kubernetesMeetup, saturated)).toBe(100);
    expect(best).toBeCloseTo(100, 10);

    expect(rank({ ...perfectFit, connectionScore: 100 })).toBeLessThanOrEqual(100);
    // A total mismatch is DIVIDED, never erased — the whole point of the floor.
    expect(rank({ ...totalMiss, connectionScore: 100 })).toBeCloseTo(45, 10);
  });

  /**
   * The reason it multiplies rather than adds. Added, a superb event you cannot reach and a
   * reachable waste of an evening land in the same place; multiplied, only an event that is good
   * on BOTH axes reaches the top.
   */
  it('ranks good-and-relevant above good-but-irrelevant AND above relevant-but-poor', () => {
    const bothGood = rank({ ...perfectFit, connectionScore: 88 });
    const goodButFar = rank({ ...totalMiss, connectionScore: 88 });
    const relevantButPoor = rank({ ...perfectFit, connectionScore: 12 });
    expect(bothGood).toBeGreaterThan(goodButFar);
    expect(bothGood).toBeGreaterThan(relevantButPoor);
    /*
     * THE ASSERTION THAT FOUND `RELEVANCE_MULTIPLIER_FLOOR`. Under a plain product this failed
     * with `expected 0 to be greater than 10.32`: `relevanceScore` legitimately reaches 0 on a
     * triple miss, and zero annihilates. A preference is a weaker claim than a quality judgement,
     * so "for me" must never rescue "not worth going to" — a perfect fit on a 12-scoring coaching
     * advert still loses to a total mismatch on an 88-scoring meetup.
     */
    expect(goodButFar).toBeGreaterThan(relevantButPoor);
  });

  /**
   * The other half of the calibration: fit must still be able to beat quality when the quality
   * gap is small. If it could not, "For you" would be the `connections` sort with extra steps.
   */
  it('lets a modest but relevant event beat a strong but irrelevant one', () => {
    expect(rank({ ...perfectFit, connectionScore: 60 })).toBeGreaterThan(
      rank({ ...totalMiss, connectionScore: 100 })
    );
  });

  it('treats a document with no connectionScore the way the connections sort already does', () => {
    // Descending order puts nulls last, which is 0 here — so a document predating the backfill
    // ranks the same in both views instead of jumping when the user switches tabs.
    expect(rank(perfectFit as Doc)).toBe(0);
  });

  /**
   * With nothing stated, the multiplier is the same for every event — so `For you` produces
   * EXACTLY the `connections` order. This is the skipped-onboarding guarantee expressed at the
   * level that actually decides the page order, rather than at the score.
   */
  it('preserves the connections order exactly when no preference is expressed', () => {
    const neutral = ctx();
    const rankNeutral = (doc: Doc) => evalExpr(relevanceRankExpr(neutral), doc) as number;
    const corpus: Doc[] = [
      { ...perfectFit, connectionScore: 42 },
      { ...totalMiss, connectionScore: 91 },
      { connectionScore: 67 },
      { ...perfectFit, connectionScore: 91 },
    ];
    const byRank = [...corpus]
      .map((doc, i) => ({ i, rank: rankNeutral(doc) }))
      .sort((a, b) => b.rank - a.rank || a.i - b.i)
      .map(r => r.i);
    const byConnection = [...corpus]
      .map((doc, i) => ({ i, score: doc.connectionScore as number }))
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .map(r => r.i);
    expect(byRank).toEqual(byConnection);
  });
});
