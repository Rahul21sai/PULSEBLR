import { describe, it, expect } from 'vitest';
import { connectionScore, connectionTier } from '@/lib/events/connection-score';

/**
 * connectionScore powers the feed's flagship "Best for connections" sort and the detail
 * page's "Worth going?" panel. It is pure and deterministic, which is the whole reason it
 * was built that way — so the ORDERING it produces can be pinned down rather than trusted.
 *
 * These assert RELATIVE order and documented weights, not exact totals. Pinning exact
 * numbers would make every future weight tweak fail the suite for no reason; pinning the
 * order means the tests fail only when the ranking actually changes meaning.
 */
describe('connectionScore', () => {
  const base = { title: 'Some Event', format: 'offline' as const };

  it('stays within 0-100 for any input', () => {
    const extremes = [
      {},
      { ...base, attendeeCount: 1_000_000 },
      { title: 'Webinar: Get Certified Cohort', format: 'online' as const, price: 99_999 },
    ];
    for (const input of extremes) {
      const score = connectionScore(input);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    }
  });

  it('ranks in-person above hybrid above online — the biggest single factor', () => {
    const offline = connectionScore({ ...base, format: 'offline' });
    const hybrid = connectionScore({ ...base, format: 'hybrid' });
    const online = connectionScore({ ...base, format: 'online' });
    expect(offline).toBeGreaterThan(hybrid);
    expect(hybrid).toBeGreaterThan(online);
  });

  it('penalises a commercial funnel below a peer gathering', () => {
    // The exact pair the score exists to separate: a real practitioner meetup should beat
    // a certification cohort even though both are "tech events" in the same city.
    const meetup = connectionScore({
      title: 'Bangalore Kubernetes Meetup #12',
      format: 'offline',
      attendeeCount: 60,
      hasFood: 'yes',
      category: ['Meetup'],
      isFree: true,
    });
    const cohort = connectionScore({
      title: 'Get Google AI Certified — Professionals Cohort [6 of 8]',
      format: 'online',
      category: ['Workshop'],
    });
    expect(meetup).toBeGreaterThan(cohort);
    // And the gap should be decisive, not incidental.
    expect(meetup - cohort).toBeGreaterThan(40);
  });

  /**
   * The coaching-centre variants. Two of these reached the top of the live feed scoring 58 and
   * 70 because the funnel list was built around the word "paid" and these advertise as FREE.
   *
   * The `demo` cases are the subtle ones and the reason this test exists: the same word marks
   * the best kind of event and the worst, so it is matched under a lookahead. That is exactly
   * the sort of pattern that breaks silently when someone later "simplifies" it.
   */
  it('penalises coaching-centre course adverts, including free ones', () => {
    const peer = connectionScore({ ...base, title: 'Bangalore Go Meetup', category: ['Meetup'] });

    for (const title of [
      'Free DevOps Demo Class in Electronic City Bangalore',
      'Free Gen AI & Agentic AI Demo at eMexo',
      'Enrollment open — Full Stack Trial Class',
      'Best Software Testing Coaching Center Electronic City',
      // Both of these were on the live feed's first page, the same paid course listed twice.
      '25% OFF: 2 Hours to Freedom: Build a Job Hunt AI Agent',
      '50% off Early Access — Agentic AI Masterclass',
    ]) {
      expect(connectionScore({ ...base, title }), title).toBeLessThan(peer);
    }
  });

  it('does not read a legitimate conference price signal as a funnel', () => {
    // "early bird" is normal conference pricing and says nothing about audience-vs-room, so it
    // must NOT be penalised. Guards the `\d+%\s*off` addition from being widened into pricing
    // language generally.
    const plain = connectionScore({ ...base, title: 'Some Event' });
    expect(connectionScore({ ...base, title: 'Early bird tickets — Bengaluru Rust Meetup' }))
      .toBeGreaterThanOrEqual(plain);
  });

  it('does NOT penalise demo nights, demos or demo days — those are peer events', () => {
    const plain = connectionScore({ ...base, title: 'Some Event' });

    // "demo night" additionally earns the PEER_PATTERN bonus, so it must come out ahead.
    expect(connectionScore({ ...base, title: 'Bengaluru Demo Night' })).toBeGreaterThan(plain);
    // The plural is community show-and-tell, and must not be caught by the singular rule.
    expect(connectionScore({ ...base, title: 'Show and Tell: Demos from the community' }))
      .toBeGreaterThanOrEqual(plain);
    // Startup demo days are networking-dense; unpenalised, matching the pre-existing behaviour.
    expect(connectionScore({ ...base, title: 'Accel Demo Day' })).toBeGreaterThanOrEqual(plain);
  });

  it('scales attendees logarithmically, so 20 -> 40 matters more than 200 -> 220', () => {
    const at = (n: number) => connectionScore({ ...base, attendeeCount: n });
    const smallJump = at(40) - at(20);
    const largeJump = at(220) - at(200);
    expect(smallJump).toBeGreaterThan(largeJump);
  });

  it('rewards food, a named company host, and being free', () => {
    expect(connectionScore({ ...base, hasFood: 'yes' })).toBeGreaterThan(
      connectionScore({ ...base, hasFood: 'no' })
    );
    expect(connectionScore({ ...base, companies: ['Razorpay'] })).toBeGreaterThan(
      connectionScore({ ...base, companies: [] })
    );
    expect(connectionScore({ ...base, isFree: true })).toBeGreaterThan(
      connectionScore({ ...base, isFree: false })
    );
  });

  it('treats a missing attendee count as absent, not as zero attendees', () => {
    // 90% of the corpus has no attendee count, so this must not be a penalty.
    expect(connectionScore({ ...base, attendeeCount: undefined })).toBe(
      connectionScore({ ...base })
    );
  });

  it('is deterministic — the same event always ranks the same', () => {
    const input = { ...base, attendeeCount: 42, hasFood: 'yes' as const, category: ['Meetup'] };
    const runs = new Set(Array.from({ length: 20 }, () => connectionScore(input)));
    expect(runs.size).toBe(1);
  });
});

describe('connectionTier', () => {
  it('maps to the three bands the meter renders', () => {
    expect(connectionTier(95)).toBe('high');
    expect(connectionTier(70)).toBe('high');
    expect(connectionTier(69)).toBe('medium');
    expect(connectionTier(50)).toBe('medium');
    expect(connectionTier(49)).toBe('low');
    expect(connectionTier(0)).toBe('low');
  });
});
