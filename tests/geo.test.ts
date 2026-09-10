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

/**
 * ── THE NEGATIVE HALF, AND IT IS THE IMPORTANT HALF ──────────────────────────────────────────
 *
 * A widened gazetteer does not fail by resolving fewer events. It fails by putting events in the
 * WRONG area, and no aggregate coverage number can reveal that — the resolved count goes UP
 * either way. `lib/events/relevance.ts` scores `areaMatch: +22` and `areaUnknown: 0`, so a
 * mislabelled row is ranked UP for a neighbourhood the reader cannot reach while an unresolved
 * row is merely neutral: **a wrong area is strictly worse than no area.** Hence every case below
 * asserts a REFUSAL.
 *
 * Three of them are regressions that were live in the shipped table, all the same shape as the
 * tagger's bare `\bpm\b` matching the "PM" in "6 PM" — a locality name appearing INSIDE a longer
 * word. They were found by replaying the real patterns over the live corpus
 * (`scripts/diag-area-coverage.ts`, `scripts/backfill-area.ts` dry run), not by inspection.
 */
describe('resolveArea — the tokens it must REFUSE to match', () => {
  it('does not read a locality out of the middle of a longer word', () => {
    // `agara` (HSR Layout), unbounded, matched "Thi<agara>jar College" — in MADURAI. That match
    // was also vetoing the off-city gate's rejection of it, so bounding the token is what lets
    // the gate do its job. See the note in geo.ts's AREAS header.
    expect(resolveArea({ venue: 'Thiagarajar College, Madurai' })).toBe('Other');
    // Same token inside "Sampangi Rama Nagara". HSR Layout sits EARLIER in the table than MG
    // Road, so this Cubbon Park address resolved to HSR Layout and beat `cubbon`.
    expect(
      resolveArea({
        venue: 'Cubbon Park',
        address: 'Kasturba Road, Behind High Court of Karnataka, Sampangi Rama Nagara, Bengaluru',
      })
    ).toBe('MG Road');
    // `jayanagar`, unbounded, matched "San<jayanagar>a" — an RMV 2nd Stage club roughly 12 km
    // north of Jayanagar, i.e. the wrong side of the city.
    expect(
      resolveArea({ venue: 'ZOZO THE CLUB', address: 'Raj Mahal Vilas 2nd Stage, Sanjayanagara, Bengaluru' })
    ).not.toBe('Jayanagar');
    // `majestic` (Bengaluru Central), unbounded, matched "majestically".
    expect(resolveArea({ venue: 'The temple stands majestically above the valley' })).toBe('Other');
  });

  it('CANNOT save "majestic mountains" — the boundary is not what protects that', () => {
    // Stated as a limit rather than left as a surprise. `\bmajestic\b` fixes "majestically" and
    // nothing more: in "majestic mountains" the token genuinely IS its own word, so it matches,
    // and Majestic (the Kempegowda bus station) is a real Bengaluru place name that has to keep
    // matching. What actually keeps trip copy out of the area facet is that `resolveArea` never
    // reads the description — 5 of 5 Bengaluru Central hits on that path came from this exact
    // phrase in Bhutan, Morocco and Coorg listings. The two defences are not interchangeable.
    expect(resolveArea({ venue: 'majestic mountains of the Western Ghats' })).toBe('Bengaluru Central');
    // The description is not consulted, which is the defence that does the work here.
    expect(resolveArea({ text: 'Trek through the majestic mountains of Coorg.' })).toBeUndefined();
  });

  it('still matches those localities when they stand as their own word', () => {
    // Bounding a token is only correct if it does not cost the true positives it was there for.
    expect(resolveArea({ venue: 'Agara Lake, Bangalore' })).toBe('HSR Layout');
    expect(resolveArea({ venue: 'Jayanagar 4th Block' })).toBe('Jayanagar');
    // The Kannada spelling, which is why the trailing boundary is deliberately absent.
    expect(resolveArea({ venue: 'Jayanagara, Bengaluru' })).toBe('Jayanagar');
    expect(resolveArea({ venue: 'Majestic Bus Stand' })).toBe('Bengaluru Central');
    expect(resolveArea({ venue: 'Arekere Mico Layout' })).toBe('Bannerghatta Road');
  });

  it('refuses day-trip destinations OUTSIDE the city rather than labelling them a neighbourhood', () => {
    // Both are real, recurring rows in this corpus: Skandagiri is in Chikkaballapur and
    // Sakleshpura is in Hassan. They are advertised to a Bengaluru audience and leave from here,
    // which is exactly why a gazetteer is tempted to place them. 'Other' is the honest answer —
    // labelling them would hand an out-of-town trek the +22 area bonus.
    expect(resolveArea({ venue: 'Skandagiri Hills', city: 'Karnataka' })).toBe('Other');
    expect(resolveArea({ venue: 'Sakleshpur', address: 'Hassan, Karnataka' })).toBe('Other');
  });

  it('refuses a venue brand that exists in other cities, even at the cost of coverage', () => {
    // 4 rows in the corpus, all "Draper Startup House for Entrepreneurs, 384, 1st A Main Rd".
    // Deliberately unmatched: the chain has houses in Bali, Lisbon, San Francisco and Singapore,
    // and `matchArea` is ALSO what vetoes an off-city rejection — so a token that matched this
    // would spare the Bali one. The stored address carries no locality to use instead.
    expect(resolveArea({ venue: 'Draper Startup House for Entrepreneurs', address: '384, 1st A Main Rd' })).toBe(
      'Other'
    );
  });

  it('prefers the VENUE field over the ADDRESS, so a connecting road cannot win', () => {
    // The address names the two neighbourhoods the road CONNECTS; the venue names where the
    // event is. Embassy Golf Links is in Domlur. Matching the joined string gave Koramangala.
    expect(
      resolveArea({
        venue: 'IBM EGL D Block',
        address: 'D Block, Embassy Golf Links, Off Indira Nagar-Koramangala Intermediate Ring Road',
      })
    ).toBe('Domlur');
    // A vague address must not override a named venue.
    expect(
      resolveArea({ venue: 'Bommanahalli', address: 'approx 3kms from Silkboard junction., Bangalore' })
    ).toBe('Bommanahalli');
    // Precedence must not COST a resolution: with no venue, the address still decides.
    expect(resolveArea({ address: 'approx 3kms from Silkboard junction., Bangalore' })).toBe('BTM Layout');
  });

  it('reads the spellings sources actually publish, not the correct ones', () => {
    // One real venue string, three defects in it: "Mahadevpura" is a letter short of
    // Mahadevapura, "K.R. Puram" is dotted, and it runs straight into "Marathalli" with no
    // separator — so a trailing \b on the KR Puram token could never match.
    expect(
      resolveArea({
        venue:
          'Amazon Development Centre India Pvt. Ltd, Taurus-1 Bagmane Constellation Business Park, K.R. PuramMarathalli Ring Road, Mahadevpura,Bengaluru - 560037',
      })
    ).toBe('Whitefield');
    // Marathalli on its own, without the Whitefield-owned tokens beside it.
    expect(resolveArea({ venue: 'Marathalli Ring Road' })).toBe('Marathahalli');
  });

  it('leaves a Bengaluru event we cannot place at Other, and an online one at undefined', () => {
    // 41 upcoming rows are stored exactly like this — the city is known and no neighbourhood is
    // named anywhere. 'Other' is the correct answer and no gazetteer can improve on it, which is
    // why area coverage has a ceiling well below 100%.
    expect(resolveArea({ address: 'Bangalore', city: 'Bangalore' })).toBe('Other');
    expect(resolveArea({ venue: 'To Be Announced, Bangalore, Bangalore, Bangalore' })).toBe('Other');
  });
});
