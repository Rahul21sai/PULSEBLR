import { describe, it, expect } from 'vitest';
import { isBengaluru, resolveArea } from '@/lib/scrapers/core/geo';

/**
 * `isBengaluru` decides whether an event belongs in a Bengaluru-only product, so both of its
 * failure modes are expensive and opposite: reject too much and real events vanish from the feed
 * with no trace, accept too much and a user is shown an event in Chennai.
 *
 * It is TRISTATE, and that is the part most likely to be broken by a later edit:
 *   true  — evidence says Bengaluru
 *   false — evidence says somewhere else
 *   null  — nothing to judge on, and the CALLER decides whether that passes
 *
 * These tests exist because a real guard was written against the wrong state. `meetup.ts` had
 * `isBengaluru({ text: description }) === false`, which can never be satisfied — the only
 * text-driven `false` sits behind `if (location)`, built from venue + address, which a Meetup ICS
 * row never has. It read as a working filter for months and let 23 events naming other cities in.
 * The `null`-vs-`false` distinction is therefore pinned explicitly below.
 */
describe('isBengaluru — the tristate contract', () => {
  it('returns null, never false, when only free text is given', () => {
    // THE regression that motivated this file. A caller comparing `=== false` on a text-only
    // input is writing dead code, and the type system cannot see it.
    expect(isBengaluru({ text: 'Join us in Chennai for a workshop.' })).toBeNull();
    expect(isBengaluru({ text: 'Meetup at our San Francisco office.' })).toBeNull();
    expect(isBengaluru({ text: 'A talk about distributed systems.' })).toBeNull();
    // Text CAN produce a positive, which is the asymmetry that made the bug plausible.
    expect(isBengaluru({ text: 'Our Bengaluru chapter meets in Indiranagar.' })).toBe(true);
  });

  it('returns null when there is nothing at all to judge on', () => {
    expect(isBengaluru({})).toBeNull();
    // An online event has no venue. Callers must treat null as "attendable", not as "reject".
    expect(isBengaluru({ venue: undefined, address: undefined })).toBeNull();
  });

  it('treats coordinates as authoritative, over any text', () => {
    // Bengaluru, roughly MG Road.
    expect(isBengaluru({ lat: 12.9716, lng: 77.5946 })).toBe(true);
    // Chennai coordinates with a venue that SAYS Bengaluru — coordinates must win.
    expect(isBengaluru({ lat: 13.0827, lng: 80.2707, venue: 'Bengaluru Convention Centre' })).toBe(false);
    // 0,0 is the "no data" sentinel many feeds emit and must not be read as a real place.
    expect(isBengaluru({ lat: 0, lng: 0 })).toBeNull();
  });

  it('rejects other INDIAN cities named in venue or address', () => {
    for (const place of [
      'Chennai Trade Centre',
      'Hitech City, Hyderabad',
      'Powai, Mumbai',
      'Coimbatore',
      'Kochi, Kerala',
      'Sector 62, Noida',
    ]) {
      expect(isBengaluru({ venue: place }), place).toBe(false);
    }
  });

  it('does NOT yet reject non-Indian cities — documenting a real gap, not asserting a fix', () => {
    // OTHER_STATE_HINTS lists Indian places only, so a foreign venue produces `null`, not `false`.
    // These four reached the live corpus because of it — "KONG API + AI Summit 2026" (Los Angeles)
    // and "FounderX Silicon Valley" (San Francisco) into the DEFAULT tech feed
    // (scripts/diag-meetup-geo-leak.ts).
    //
    // Pinned as `null` rather than left untested so that whoever adds foreign-city rejection sees
    // this test fail and updates it DELIBERATELY, instead of the gap staying invisible. Flip these
    // to `false` when that lands.
    for (const place of [
      'Los Angeles Convention Center',
      'San Francisco, CA',
      'Central Park, New York',
      'Marina Bay, Singapore',
    ]) {
      expect(isBengaluru({ venue: place }), place).toBeNull();
    }
  });

  it('accepts Bengaluru by name, by area, and by Karnataka disambiguation', () => {
    expect(isBengaluru({ venue: 'Bengaluru' })).toBe(true);
    expect(isBengaluru({ venue: 'Bangalore' })).toBe(true);
    // A recognised neighbourhood is as good as the city name.
    expect(isBengaluru({ venue: 'Indiranagar' })).toBe(true);
    expect(isBengaluru({ venue: 'Koramangala, 5th Block' })).toBe(true);
    // Names BOTH: ambiguous, so Karnataka must settle it. This is the "Bengaluru - Chennai
    // Highway" case the implementation calls out.
    expect(isBengaluru({ venue: 'Bengaluru - Chennai Highway' })).toBe(false);
    expect(isBengaluru({ venue: 'Bengaluru - Chennai Highway, Karnataka' })).toBe(true);
  });

  it('does NOT over-match a Bengaluru event that merely mentions elsewhere in its body', () => {
    // The whole reason the non-India list is matched against venue/address ONLY. If this ever
    // starts returning false, the tagger's `\bpm\b` mistake has been repeated in geo.
    expect(
      isBengaluru({ venue: 'Indiranagar', text: 'Lessons from our London and Singapore rollouts.' })
    ).toBe(true);
    expect(isBengaluru({ text: 'Lessons from our London rollout.' })).toBeNull();
  });

  it('does not treat a person-like name as a city', () => {
    // `austin` is deliberately not in the pattern as a bare word — it is a common given name.
    // Only the explicit "Austin, TX" form is a city here.
    expect(isBengaluru({ venue: 'Austin Hall, Indiranagar' })).toBe(true);
  });
});

describe('resolveArea', () => {
  it('maps known Bengaluru neighbourhoods', () => {
    expect(resolveArea({ venue: 'Koramangala 5th Block' })).toBeTruthy();
    expect(resolveArea({ venue: 'Indiranagar' })).toBeTruthy();
  });

  it('returns undefined when there is no location at all, not a wrong guess', () => {
    // Online events must not be given a physical area.
    expect(resolveArea({})).toBeUndefined();
  });
});
