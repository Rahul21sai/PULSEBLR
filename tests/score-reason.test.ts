import { describe, it, expect } from 'vitest';
import { connectionScore, connectionTier } from '@/lib/events/connection-score';
import {
  FIELD_SIGNALS,
  connectionVerdict,
  meterLabel,
  meterLevel,
  scoreReasonLine,
  scoreReasons,
  type ReasonSignal,
  type ScoreReason,
} from '@/lib/events/score-reason';

/**
 * The reason clause beside the connection meter.
 *
 * The thing worth testing here is not the wording — it is the COUPLING. A reason that disagrees
 * with the score is worse than no reason, because it teaches the reader to distrust the bars, so
 * every assertion below is really asking one of two questions:
 *
 *   · does the explanation still come from `connectionScore` rather than from a copy of it?
 *   · does it decline to make a claim the score did not make?
 */

/** A real practitioner meetup: the shape the whole ranking exists to put at the top. */
const MEETUP = {
  title: 'Bangalore Kubernetes Meetup #12',
  format: 'offline' as const,
  attendeeCount: 40,
  hasFood: 'yes' as const,
  category: ['Meetup', 'Cloud/DevOps'],
  companies: ['Razorpay'],
  organizer: 'Bangalore Cloud Native',
  isFree: true,
};

function signals(reasons: ScoreReason[]): ReasonSignal[] {
  return reasons.map(r => r.signal);
}

function find(reasons: ScoreReason[], signal: ReasonSignal): ScoreReason | undefined {
  return reasons.find(r => r.signal === signal);
}

describe('scoreReasons', () => {
  it('explains the meetup in the order the score actually weights it', () => {
    const reasons = scoreReasons(MEETUP);

    // Format is the biggest single term in connection-score.ts, so it must lead. Asserting the
    // ORDER rather than the weights: a future re-weighting should change this list, and a test that
    // pinned "46" would fail for a change that is not a regression.
    expect(reasons[0].signal).toBe('format');
    expect(reasons[0].short).toBe('in person');
    expect(reasons[0].good).toBe(true);

    // Weights descend, which is the only ordering promise the module makes.
    const weights = reasons.map(r => r.weight);
    expect([...weights].sort((a, b) => b - a)).toEqual(weights);

    // Every term the event actually earns gets a clause.
    expect(signals(reasons)).toEqual(
      expect.arrayContaining(['format', 'attendees', 'gathering', 'framing', 'food', 'host', 'price'])
    );
  });

  it('names only the categories the scorer actually rewards', () => {
    // `SOCIAL_CATEGORIES` is private to connection-score.ts. The module discovers membership by
    // probing rather than by holding a copy, so `Cloud/DevOps` — a TOPIC, not a gathering kind —
    // must not be named even though it is on the event.
    const gathering = find(scoreReasons(MEETUP), 'gathering');
    expect(gathering?.long).toContain('Meetup');
    expect(gathering?.long).not.toContain('Cloud/DevOps');
  });

  it('prefers the resolved company over the raw organiser string', () => {
    // Both fields feed the same `host` signal and the score pays 8 for a company against 3 for a
    // bare organiser, so exactly one clause reaches the reader and it is the better one.
    const hosts = scoreReasons(MEETUP).filter(r => r.signal === 'host');
    expect(hosts).toHaveLength(1);
    expect(hosts[0].short).toBe('hosted by Razorpay');

    // With no resolved company the organiser is all there is, and it is still worth saying.
    const noCompany = find(scoreReasons({ ...MEETUP, companies: [] }), 'host');
    expect(noCompany?.short).toBe('hosted by Bangalore Cloud Native');
  });

  it('says nothing about a format it does not know', () => {
    // An event with no format scores the same as an online one, and reporting that as "online" would
    // invent a fact about the venue. Silence is the correct output.
    expect(signals(scoreReasons({ title: 'Something', format: null }))).not.toContain('format');
    expect(signals(scoreReasons({ title: 'Something' }))).not.toContain('format');
  });

  it('resolves format to exactly one of in-person, hybrid or online', () => {
    for (const format of ['offline', 'hybrid', 'online'] as const) {
      const formatReasons = scoreReasons({ ...MEETUP, format }).filter(r => r.signal === 'format');
      expect(formatReasons).toHaveLength(1);
    }
    expect(find(scoreReasons({ ...MEETUP, format: 'hybrid' }), 'format')?.short).toBe('hybrid');

    const online = find(scoreReasons({ ...MEETUP, format: 'online' }), 'format');
    expect(online?.short).toBe('online only');
    expect(online?.good).toBe(false);
  });

  it('never reports an absent perk as a criticism', () => {
    // The score does not PENALISE a missing meal, so "no food" is an absence rather than a fact
    // about the event. Printing it would be a complaint the ranking never made.
    for (const hasFood of ['no', 'unknown', null] as const) {
      expect(signals(scoreReasons({ ...MEETUP, hasFood }))).not.toContain('food');
    }
    expect(find(scoreReasons(MEETUP), 'food')?.good).toBe(true);
  });

  it('does not claim a steep ticket on a free event', () => {
    // `isFree` rides along in the price probe because the scorer only looks at `price` when the
    // event is not free. Dropping it would report a steep ticket on a free event with a stale price.
    const free = find(scoreReasons({ ...MEETUP, isFree: true, price: 9000 }), 'price');
    expect(free?.short).toBe('free');
    expect(free?.good).toBe(true);

    const steep = find(scoreReasons({ ...MEETUP, isFree: false, price: 9000 }), 'price');
    expect(steep?.short).toBe('steep ticket');
    expect(steep?.good).toBe(false);

    // A modest ticket is neither a selling point nor a warning — the score is silent, so this is too.
    expect(signals(scoreReasons({ ...MEETUP, isFree: false, price: 500 }))).not.toContain('price');
  });

  /**
   * THE POINT OF IMPORTING THE SCORER RATHER THAN RESTATING IT.
   *
   * The panel this replaces carried a hand-copied funnel regex that had fallen four entries behind
   * `FUNNEL_PATTERN` — it knew `certifi|cohort|bootcamp|training|masterclass|course|webinar|batch`
   * and none of the coaching-centre forms that were added after two of them reached the top of the
   * live feed. Every title below is one the real pattern was extended to catch, and every one of
   * them would have gone unexplained.
   */
  it('reports the funnel titles the scorer learned AFTER the old copied regex', () => {
    const late = [
      'Free DevOps Demo Class in Electronic City Bangalore',
      'Free Gen AI & Agentic AI Demo at eMexo',
      '25% OFF: 2 Hours to Freedom: Build a Job Hunt AI Agent',
      'Java Training with Placement',
      'Full Stack Trial Class this Saturday',
    ];
    for (const title of late) {
      const framing = find(scoreReasons({ ...MEETUP, title }), 'framing');
      expect(framing, title).toBeDefined();
      expect(framing!.good, title).toBe(false);
      expect(framing!.short, title).toBe('reads like a course');
    }
  });

  /**
   * `demo` sits behind a lookahead in `FUNNEL_PATTERN` because three uses of the word mean opposite
   * things. Writing this test is what surfaced the exact boundary, which is finer than the comment
   * beside the pattern suggests — so it is pinned here rather than paraphrased.
   */
  it('follows the scorer through every sense of the word "demo"', () => {
    // Rewarded: `demo night` is in PEER_PATTERN outright.
    expect(find(scoreReasons({ ...MEETUP, title: 'Bangalore Demo Night' }), 'framing')?.good).toBe(true);

    // NEUTRAL, and therefore unexplained. The lookahead spares a bare "Demo Day", but nothing
    // rewards it either, so the score is silent and so is the clause. Saying "peer gathering" here
    // would be a claim the ranking never made.
    expect(signals(scoreReasons({ ...MEETUP, title: 'Startup Demo Day' }))).not.toContain('framing');

    // Penalised: `demo day for` is a literal funnel entry that the lookahead never reaches, so
    // "Demo Day for ..." is judged a sales session while "Demo Day" is not.
    const forSomebody = find(
      scoreReasons({ ...MEETUP, title: 'Demo Day for Bootcamp Graduates' }),
      'framing'
    );
    expect(forSomebody?.good).toBe(false);
    expect(forSomebody?.short).toBe('reads like a course');
  });

  /**
   * THE CLAMP, which is the whole reason weights are measured against a fixed anchor rather than
   * marginally, in context.
   */
  it('still explains an event whose score has hit the 100 ceiling', () => {
    const maxed = { ...MEETUP, attendeeCount: 1000 };
    expect(connectionScore(maxed)).toBe(100);

    // A marginal measurement reads ZERO for every term on this event, because removing one still
    // leaves the total above the ceiling. This assertion documents the trap rather than the fix.
    expect(connectionScore(maxed) - connectionScore({ ...maxed, hasFood: 'unknown' })).toBe(0);
    expect(connectionScore(maxed) - connectionScore({ ...maxed, companies: [] })).toBe(0);

    // The anchored measurement keeps both.
    const reasons = scoreReasons(maxed);
    expect(signals(reasons)).toEqual(expect.arrayContaining(['food', 'host']));
    expect(find(reasons, 'food')!.weight).toBeGreaterThan(0);
  });

  it('still explains an event whose score has hit the 0 floor', () => {
    const floored = {
      title: 'Get Google AI Certified - Professionals Cohort [6 of 8]',
      format: 'online' as const,
    };
    expect(connectionScore(floored)).toBe(0);

    // Marginally, the funnel penalty is UNDERSTATED rather than erased: the terms sum to -22 and the
    // clamp swallows everything below zero, so removing the title moves the visible score by 8
    // instead of by its real 30. An ordering built on that number would rank the worst events by an
    // arbitrary fraction of their penalty.
    const marginal = connectionScore(floored) - connectionScore({ ...floored, title: '' });
    expect(marginal).toBe(-8);

    const reasons = scoreReasons(floored);
    expect(find(reasons, 'framing')?.short).toBe('reads like a course');
    expect(find(reasons, 'framing')!.weight).toBeGreaterThan(Math.abs(marginal));
    expect(find(reasons, 'format')?.short).toBe('online only');
  });

  it('returns nothing for an event with nothing to say about it', () => {
    // A real outcome, not an error: no format, no host, no categories, no price signal.
    expect(scoreReasons({})).toEqual([]);
    expect(scoreReasonLine({})).toBe('');
  });

  /**
   * NEVER PRINT THE NUMBER. `weight` orders the clauses and must not reach a screen.
   *
   * The attendee count is a genuine count of people and legitimately appears, so the assertion is
   * specific: the score, and each measured weight, must be absent from the rendered strings.
   */
  it('prints no score and no weight', () => {
    const reasons = scoreReasons(MEETUP);
    const rendered = reasons.map(r => `${r.short} ${r.long}`).join(' | ');
    expect(rendered).not.toContain(String(connectionScore(MEETUP)));
    for (const reason of reasons) {
      expect(`${reason.short} ${reason.long}`).not.toContain(String(reason.weight));
    }
  });
});

describe('scoreReasonLine', () => {
  it('reads as a clause, biggest term first', () => {
    expect(scoreReasonLine(MEETUP, { max: 3 })).toBe('in person · 40 going · meetup');
  });

  it('leaves out the signals a card already shows as pills', () => {
    // Food, attendee count and price all have their own pill on an event card, so repeating them
    // spends the row's remaining width saying nothing new.
    const line = scoreReasonLine(MEETUP, { max: 2, exclude: ['food', 'attendees', 'price'] });
    expect(line).toBe('in person · meetup');
    expect(line).not.toContain('going');
    expect(line).not.toContain('food');
  });

  it('surfaces the warning on a course advert once format is excluded', () => {
    // The card's `Online` pill already covers the format, so what is left is the clause a reader
    // cannot get anywhere else on the row.
    const advert = { ...MEETUP, title: 'Free DevOps Demo Class', format: 'online' as const };
    expect(
      scoreReasonLine(advert, { max: 2, exclude: ['food', 'attendees', 'price', 'format'] })
    ).toContain('reads like a course');
  });

  it('caps the clause count', () => {
    expect(scoreReasonLine(MEETUP, { max: 1 }).split('·')).toHaveLength(1);
    expect(scoreReasonLine(MEETUP, { max: 4 }).split(' · ')).toHaveLength(4);
  });
});

describe('the meter and the verdict come from connectionTier', () => {
  it('agrees with the tier at every boundary', () => {
    // The bars and the words were each written out by hand, in two files, as `>= 70 ? 3 : >= 50`.
    // Routing both through `connectionTier` is what stops them disagreeing about the same event.
    const cases: Array<[number, 1 | 2 | 3]> = [
      [0, 1], [49, 1], [50, 2], [69, 2], [70, 3], [100, 3],
    ];
    for (const [score, level] of cases) {
      expect(meterLevel(score), String(score)).toBe(level);
    }
    expect(connectionTier(70)).toBe('high');
    expect(connectionVerdict(70)).toBe('Strong chance');
    expect(connectionVerdict(50)).toBe('Worth a look');
    expect(connectionVerdict(49)).toBe('Probably not');
    expect(meterLabel(70)).toContain('Strong chance');
  });
});

/**
 * THE GUARD AGAINST THE ONE FAILURE THIS MODULE CANNOT SEE AT RUNTIME: a new term added to
 * `connectionScore` that moves the ranking with no clause to account for it.
 */
describe('coverage of the scorer input', () => {
  it('produces a reason for every field the scorer weights', () => {
    // Assembled so that every weighted term fires at once.
    const everything = { ...MEETUP, isFree: false, price: 9000 };
    const seen = new Set(signals(scoreReasons(everything)).concat(signals(scoreReasons(MEETUP))));

    for (const [field, signal] of Object.entries(FIELD_SIGNALS)) {
      if (signal === null) continue;
      expect(seen.has(signal), `${field} -> ${signal}`).toBe(true);
    }
  });

  it('confirms the fields mapped to null really do weigh nothing', () => {
    // `capacity` is declared on `ConnectionScoreInput` and read by no branch of the scorer. If that
    // changes, this fails and FIELD_SIGNALS has to stop calling it null.
    const unweighted = Object.entries(FIELD_SIGNALS)
      .filter(([, signal]) => signal === null)
      .map(([field]) => field);
    expect(unweighted).toEqual(['capacity']);

    for (const field of unweighted) {
      expect(connectionScore({ ...MEETUP, [field]: 5000 })).toBe(connectionScore(MEETUP));
      expect(connectionScore({ [field]: 5000 })).toBe(connectionScore({}));
    }
  });
});
