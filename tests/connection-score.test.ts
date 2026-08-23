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
