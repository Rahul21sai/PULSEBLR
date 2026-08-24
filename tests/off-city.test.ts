import { describe, it, expect } from 'vitest';
import { offCityReason, namesOtherCity } from '@/lib/scrapers/core/geo';
import type { RawEvent } from '@/lib/scrapers/core/types';

/**
 * The ingest-time off-city gate.
 *
 * PulseBLR is a Bengaluru product, but off-city events reach the corpus because the existing
 * `isBengaluru()` gate never reads the TITLE and most adapters accept its `null` ("nothing to
 * judge on") verdict. Measured 2026-08-24: 6 upcoming events flagged isTechEvent named another
 * city in their own title — "Chennai - Build Your First AI Agent", "Anthropic - Code - Coffee :
 * Chennai Edition" — and appeared in the DEFAULT tech feed.
 *
 * `city` cannot be the gate: 522 of 1212 upcoming events have no city at all, and the home
 * city's own spelling is spread across six casings plus suburb names (Hebbagodi, Madavara,
 * Doddathoguru). Requiring a positive Bengaluru match would delete most of the corpus. So this
 * rejects only on a POSITIVE signal of another city, and anything unknown passes.
 *
 * THE NEGATIVE HALF IS THE IMPORTANT HALF. A false positive here does not mis-tag an event, it
 * DELETES it before it is ever stored, and nothing downstream can recover it — the corpus just
 * silently shrinks. CLAUDE.md records what a loose matcher costs (`\bpm\b` matching the "PM" in
 * "6 PM" tagged a fifth of the corpus Product/Design; a bare substring match reported "SAP" 157
 * times). Every case below that must NOT be rejected is a real phrase or a real Bengaluru venue.
 */
describe('offCityReason — rejects on a positive signal of another city', () => {
  /** The measured leaks, plus one per field so no field is left unguarded. */
  const MUST_REJECT: Array<[string, Parameters<typeof offCityReason>[0], string]> = [
    [
      'Chennai',
      { title: 'Chennai - Build Your First AI Agent - No Code, Just Execution' },
      'live leak: in the default tech feed on 2026-08-24',
    ],
    ['Chennai', { title: 'Anthropic - Code - Coffee : Chennai Edition' }, 'live leak'],
    ['Coimbatore', { title: 'Anthropic - Code - Coffee : Coimbatore Edition' }, 'live leak'],
    ['Pune', { title: 'Pune DevOps Meetup #14' }, 'a title is enough on its own'],
    ['Mumbai', { city: 'Mumbai' }, 'the structured city field'],
    ['New York', { city: 'New York' }, 'foreign city, measured in the corpus'],
    ['Hyderabad', { address: 'Cyber Towers, Madhapur, Hyderabad, Telangana' }, 'address'],
    ['Bali', { venue: 'Beach Resort', city: 'Bali' }, 'measured in the corpus'],
    ['Mysuru', { city: 'Mysuru' }, 'Karnataka, but not this city — scope is Bengaluru only'],
    ['Kochi', { city: 'Ernakulam' }, 'alias resolves to its canonical city'],
    ['Goa', { city: 'Goa' }, 'an ambiguous name still counts in the structured city field'],
    [
      'Prayagraj',
      { city: 'Allahabad' },
      'a touring Luma calendar (JumpStart Bharat) is seeded specifically because it visits ' +
        'Bengaluru between other cities, and this is one of them',
    ],
  ];

  for (const [city, input, why] of MUST_REJECT) {
    it(`rejects ${city} — ${why}`, () => {
      const verdict = offCityReason(input);
      expect(verdict, JSON.stringify(input)).toBeDefined();
      expect(verdict!.city).toBe(city);
    });
  }

  it('names the field it judged on, so a log line is actionable', () => {
    expect(offCityReason({ title: 'Chennai AI Meetup' })!.field).toBe('title');
    expect(offCityReason({ city: 'Chennai' })!.field).toBe('city');
    expect(offCityReason({ address: '12 Anna Salai, Chennai' })!.field).toBe('address');
  });
});

describe('offCityReason — the negative half', () => {
  /**
   * Each of these must survive ingest. The `why` is the reason it would plausibly be rejected
   * by a naive matcher, i.e. what the case is actually protecting.
   */
  const MUST_NOT_REJECT: Array<[string, Parameters<typeof offCityReason>[0], string]> = [
    [
      'a Bengaluru meetup that merely MENTIONS other cities in its description',
      {
        title: 'Bangalore Kubernetes Meetup #12',
        venue: 'Razorpay HQ, Koramangala',
        description:
          'Speakers are flying in from Chennai, Mumbai and Hyderabad. Later editions are ' +
          'planned for Pune, Delhi and Singapore — tell us where you want the next one.',
      },
      'the description is the single biggest false-positive surface, so it is never matched',
    ],
    [
      'an online event whose description lists every other city',
      { title: 'Building AI Agents with Microsoft Foundry', description: 'Chennai · Pune · Delhi' },
      'no venue, no city, no coordinates — unknown must pass, not fail',
    ],
    [
      'a Bengaluru screening of a match against another city',
      { title: 'RCB vs Chennai Super Kings — Live Screening at Prost Brewpub' },
      'an IPL team is not a location, and District is the concerts-and-sport source',
    ],
    [
      'the documented highway false positive',
      { venue: 'Toll plaza, Bengaluru - Chennai Highway' },
      'geo.ts already records this exact string as a real false positive',
    ],
    [
      'a Bengaluru tech park on a road named after where it leads',
      { venue: 'Global Village Tech Park, Mysore Road' },
      'Mysore Road is in Bengaluru; Mysuru is not',
    ],
    [
      'a Bengaluru school chain named after the capital',
      { venue: 'Delhi Public School, Bannerghatta Road' },
      'a proper noun containing a city name is not that city',
    ],
    [
      'a dessert workshop',
      { title: 'New York Cheesecake Baking Workshop' },
      'same reason — the phrase names a recipe, not a place',
    ],
    [
      'a logistics company whose name starts with a city',
      { title: 'Delhivery engineering: scaling our routing service' },
      'word boundaries — a substring match would report Delhi',
    ],
    [
      'a food festival',
      { title: 'Goan Food Festival at Church Street' },
      'word boundaries again — "Goan" is not "Goa"',
    ],
    [
      'a Goa trance night in a Bengaluru club',
      { title: 'Goa Trance Night — Sunset Session' },
      'Goa names a music genre as often as a place, so ambiguous names are read ONLY from the ' +
        'structured city field, per the registry.ts strength rule',
    ],
    [
      'an event naming Bengaluru AND another city',
      { title: 'Bengaluru ↔ Singapore Founders Mixer' },
      'Bengaluru evidence wins; a cross-city event we can attend here is still ours',
    ],
    [
      'coordinates inside Bengaluru, whatever the title says',
      { title: 'Chennai Edition Watch Party', lat: 12.9352, lng: 77.6245 },
      'coordinates cannot be fooled and outrank free text',
    ],
    [
      'a state as the city value',
      { city: 'Karnataka' },
      '15 upcoming events are stored this way; Karnataka is not another city',
    ],
    [
      'a Bengaluru suburb as the city value',
      { city: 'Hebbagodi' },
      'six suburb spellings exist in the corpus and none is in any gazetteer',
    ],
    [
      'one of the six casings of the home city',
      { city: 'BENGALURU' },
      'casing normalisation is a separate concern and must not be reinvented here',
    ],
    ['nothing at all', {}, '522 of 1212 upcoming events have no city; they must all pass'],
  ];

  for (const [label, input, why] of MUST_NOT_REJECT) {
    it(`keeps ${label}`, () => {
      const verdict = offCityReason(input);
      expect(verdict, `${why} — but got ${verdict?.city} from ${verdict?.field}`).toBeUndefined();
    });
  }

  /**
   * The description is accepted by the input type on purpose — so this assertion is real
   * rather than vacuous. If anyone ever folds description into the matched text, this fails.
   */
  it('ignores the description even when it is the ONLY off-city signal', () => {
    const description = 'Chennai Mumbai Hyderabad Pune Delhi Kolkata Singapore Dubai';
    expect(offCityReason({ title: 'Weekly standup', description })).toBeUndefined();
  });
});

/**
 * The seam. `lib/scrapers/pipeline.ts` hands a RawEvent straight to the gate, and every field
 * the gate reads is OPTIONAL — so if RawEvent ever renames one, the call still compiles and the
 * gate silently stops matching on it. Nothing else in the suite would notice: the feed would
 * just start carrying Chennai events again.
 *
 * Each case is typed as a RawEvent on purpose. That makes the field name a compile error rather
 * than a silent miss, and the assertion proves the gate actually reads it.
 */
describe('the RawEvent → gate contract', () => {
  const base: RawEvent = {
    title: 'Weekly Social Circle',
    description: '',
    sourceUrl: 'https://www.meetup.com/example/events/1/',
    source: 'meetup',
    startDateTime: new Date('2026-09-05T18:30:00+05:30'),
  };

  it('reads city, venue, address and title off a RawEvent under those exact names', () => {
    expect(offCityReason({ ...base, city: 'Chennai' })?.field).toBe('city');
    expect(offCityReason({ ...base, venue: 'Semmozhi Poonga, Chennai' })?.field).toBe('venue');
    expect(offCityReason({ ...base, address: '12 Anna Salai, Chennai' })?.field).toBe('address');
    expect(offCityReason({ ...base, title: 'Chennai Freelancers Club' })?.field).toBe('title');
  });

  it('reads coordinates off a RawEvent, so a Bengaluru event with a foreign title survives', () => {
    const raw: RawEvent = { ...base, title: 'Chennai Edition Watch Party', lat: 12.9352, lng: 77.6245 };
    expect(offCityReason(raw)).toBeUndefined();
  });
});

describe('namesOtherCity', () => {
  it('canonicalises aliases so the report groups them', () => {
    expect(namesOtherCity('gurgaon')).toBe('Gurugram');
    expect(namesOtherCity('Cochin')).toBe('Kochi');
    expect(namesOtherCity('vizag')).toBe('Visakhapatnam');
    expect(namesOtherCity('Mysore')).toBe('Mysuru');
  });

  it('is case-insensitive, matching how sources actually spell things', () => {
    for (const spelling of ['CHENNAI', 'chennai', 'Chennai']) {
      expect(namesOtherCity(spelling), spelling).toBe('Chennai');
    }
  });

  it('returns undefined for the home city, its aliases and empty input', () => {
    for (const text of ['Bengaluru', 'Bangalore', 'BLR', 'Karnataka', '', undefined, null]) {
      expect(namesOtherCity(text), String(text)).toBeUndefined();
    }
  });
});
