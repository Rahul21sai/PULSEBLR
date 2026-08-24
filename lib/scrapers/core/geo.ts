// Bengaluru geography: is this event actually in Bengaluru, and which area?
//
// Three jobs, all important:
//
//  1. isBengaluru() — the city gate. Several sources are national or global
//     (Devfolio, Unstop, Bevy/GDG, Eventbrite) so a precise gate is what keeps
//     PulseBLR a *Bengaluru* product. Coordinates are trusted first because they
//     cannot be fooled; free text is matched only with a Karnataka/negative-state
//     guard, which is what rejects real false positives found during recon (a
//     Tamil Nadu hackathon whose address contains "Bengaluru - Chennai Highway").
//
//  2. resolveArea() — map a venue/address string to a canonical neighbourhood so
//     the UI can offer an "area" filter that matches how people in Bengaluru
//     actually think about location.
//
//  3. offCityReason() — the INVERSE of job 1, and the reason it exists separately
//     is at the bottom of this file: job 1 answers "is there evidence FOR
//     Bengaluru", and returns null when there is none. Most adapters let null
//     through, so an event with no location fields is only ever judged by its
//     title — which job 1 never reads. Job 3 reads the title and rejects on
//     evidence of ANOTHER city.

/** Rough bounding box for Bengaluru urban + peripheral areas. */
const BLR_BOUNDS = { minLat: 12.6, maxLat: 13.3, minLng: 77.2, maxLng: 78.0 };

/** Indian states/cities that commonly appear as false positives. */
const OTHER_STATE_HINTS =
  /\b(tamil\s*nadu|kerala|telangana|andhra|maharashtra|gujarat|rajasthan|punjab|haryana|delhi|noida|gurgaon|gurugram|mumbai|pune|chennai|hyderabad|kolkata|ahmedabad|jaipur|lucknow|indore|bhopal|coimbatore|kochi|thiruvananthapuram|vizag|visakhapatnam|nagpur|surat|vadodara|chandigarh)\b/i;

const BLR_NAME = /\b(bengaluru|bangalore|blr|bangaluru)\b/i;
// Case-sensitive "KA" on purpose: the two-letter form only means Karnataka when
// it appears as a state code (Luma's `region_short`). Matching it case-insensitively
// would let any word containing "ka" satisfy the guard.
const KARNATAKA = /karnataka/i;
const KARNATAKA_CODE = /\bKA\b/;

function namesKarnataka(text: string): boolean {
  return KARNATAKA.test(text) || KARNATAKA_CODE.test(text);
}

/**
 * Canonical Bengaluru areas with the aliases that appear in real venue strings.
 * Order matters: more specific entries first so "Electronic City Phase 1"
 * resolves to Electronic City rather than falling through.
 */
const AREAS: Array<{ area: string; patterns: RegExp }> = [
  { area: 'Koramangala', patterns: /koramangala|\bkora\b|forum mall/i },
  { area: 'Indiranagar', patterns: /indiranagar|indira nagar|\b100\s*ft\s*road\b/i },
  { area: 'Whitefield', patterns: /whitefield|itpl|kadugodi|hoodi|brookefield|varthur/i },
  { area: 'HSR Layout', patterns: /\bhsr\b|hsr layout|agara/i },
  { area: 'Electronic City', patterns: /electronic(s)?\s*city|\bec\s*phase|hosur road|neeladri/i },
  { area: 'MG Road', patterns: /\bm\.?g\.?\s*road\b|brigade road|church street|trinity|cubbon|shivajinagar|vittal mallya/i },
  { area: 'Marathahalli', patterns: /marathahalli|kundalahalli|\baecs\b|thubarahalli/i },
  { area: 'Jayanagar', patterns: /jayanagar|jaya nagar|south end circle/i },
  { area: 'BTM Layout', patterns: /\bbtm\b|btm layout|tavarekere/i },
  { area: 'Bannerghatta Road', patterns: /bannerghatta|arekere|hulimavu|gottigere/i },
  { area: 'Sarjapur Road', patterns: /sarjapur|bellandur|haralur|kaikondrahalli|kasavanahalli/i },
  { area: 'Outer Ring Road', patterns: /outer ring road|\borr\b|devarabisanahalli|kadubeesanahalli|ecospace|embassy tech|prestige tech/i },
  { area: 'Hebbal', patterns: /hebbal|manyata|manyata tech|nagawara|thanisandra/i },
  { area: 'Yelahanka', patterns: /yelahanka|jakkur|kogilu|attur/i },
  { area: 'JP Nagar', patterns: /\bjp\s*nagar\b|j\.?p\.?\s*nagar|puttenahalli/i },
  { area: 'Domlur', patterns: /domlur|old airport road|\bhal\b\s*(2nd|second)?|embassy golf/i },
  { area: 'Rajajinagar', patterns: /rajajinagar|rajaji nagar|malleshwaram|malleswaram|yeshwanthpur|yeshwantpur/i },
  { area: 'Basavanagudi', patterns: /basavanagudi|gandhi bazaar|\bvv\s*puram\b|chamarajpet/i },
  { area: 'Banashankari', patterns: /banashankari|\bbsk\b|padmanabhanagar|kathriguppe/i },
  { area: 'Kalyan Nagar', patterns: /kalyan\s*nagar|kammanahalli|\bcv\s*raman\s*nagar\b|banaswadi|\bhrbr\b/i },
  { area: 'Rajarajeshwari Nagar', patterns: /rajarajeshwari|\brr\s*nagar\b|kengeri|uttarahalli/i },
  { area: 'Peenya', patterns: /peenya|jalahalli|nagasandra|dasarahalli/i },
  { area: 'Bommanahalli', patterns: /bommanahalli|singasandra|begur|kudlu/i },
  { area: 'Kanakapura Road', patterns: /kanakapura|konanakunte|thalaghattapura|vajarahalli/i },
  { area: 'Devanahalli', patterns: /devanahalli|\bkia\b|kempegowda international|airport road north/i },
  { area: 'Ulsoor', patterns: /ulsoor|halasuru|richmond town|langford|frazer town|\bcooke town\b/i },
  { area: 'Bengaluru Central', patterns: /majestic|k\.?r\.?\s*market|city market|chickpet|gandhinagar|seshadripuram|race course/i },
];

/** Canonical list, exported so the Event schema enum and UI filters stay in sync. */
export const BENGALURU_AREAS: string[] = [...AREAS.map(a => a.area), 'Other'];

export interface GeoInput {
  venue?: string;
  address?: string;
  city?: string;
  lat?: number;
  lng?: number;
  /** Extra free text (description) — used ONLY as a weak last resort. */
  text?: string;
}

/**
 * Decide whether an event is in Bengaluru.
 *
 * Returns `true`/`false` decisively when there is evidence, and `null` when
 * there is genuinely nothing to judge on — callers choose whether "unknown"
 * passes (city-scoped feeds like luma.com/bengaluru) or fails (national feeds).
 */
export function isBengaluru(input: GeoInput): boolean | null {
  const { lat, lng } = input;

  // Coordinates are authoritative when present.
  if (typeof lat === 'number' && typeof lng === 'number' && (lat !== 0 || lng !== 0)) {
    return (
      lat >= BLR_BOUNDS.minLat &&
      lat <= BLR_BOUNDS.maxLat &&
      lng >= BLR_BOUNDS.minLng &&
      lng <= BLR_BOUNDS.maxLng
    );
  }

  // Structured city field next.
  if (input.city && BLR_NAME.test(input.city)) return true;

  const location = [input.venue, input.address].filter(Boolean).join(', ');
  if (location) {
    const namesBlr = BLR_NAME.test(location);
    const namesOther = OTHER_STATE_HINTS.test(location);

    // "Bengaluru" AND another state named: an ambiguous string such as a highway
    // called "Bengaluru - Chennai Highway". Require Karnataka to accept it.
    if (namesBlr && namesOther) return namesKarnataka(location);
    if (namesBlr) return true;
    // A recognisable Bengaluru neighbourhood is as good as naming the city.
    if (matchArea(location)) return true;
    if (namesOther) return false;
  }

  // Weakest signal: the description mentions the city and nothing contradicts it.
  if (input.text && BLR_NAME.test(input.text) && !OTHER_STATE_HINTS.test(input.text)) return true;

  return null;
}

function matchArea(text: string): string | undefined {
  for (const { area, patterns } of AREAS) {
    if (patterns.test(text)) return area;
  }
  return undefined;
}

/**
 * Resolve a canonical area from venue/address text, or coordinates as a fallback.
 * Returns 'Other' for a Bengaluru event we can't place, undefined when there is
 * no location information at all (e.g. an online event).
 */
export function resolveArea(input: GeoInput): string | undefined {
  const location = [input.venue, input.address, input.city].filter(Boolean).join(', ');
  if (location) {
    const matched = matchArea(location);
    if (matched) return matched;
  }
  if (typeof input.lat === 'number' && typeof input.lng === 'number') {
    const nearest = nearestAreaByCoords(input.lat, input.lng);
    if (nearest) return nearest;
  }
  return location ? 'Other' : undefined;
}

/** Approximate centroids for coordinate-only events (Luma often obfuscates addresses). */
const AREA_CENTROIDS: Array<{ area: string; lat: number; lng: number }> = [
  { area: 'Koramangala', lat: 12.9352, lng: 77.6245 },
  { area: 'Indiranagar', lat: 12.9719, lng: 77.6412 },
  { area: 'Whitefield', lat: 12.9698, lng: 77.7500 },
  { area: 'HSR Layout', lat: 12.9116, lng: 77.6389 },
  { area: 'Electronic City', lat: 12.8452, lng: 77.6602 },
  { area: 'MG Road', lat: 12.9756, lng: 77.6068 },
  { area: 'Marathahalli', lat: 12.9591, lng: 77.6974 },
  { area: 'Jayanagar', lat: 12.9250, lng: 77.5938 },
  { area: 'BTM Layout', lat: 12.9166, lng: 77.6101 },
  { area: 'Bannerghatta Road', lat: 12.8823, lng: 77.5975 },
  { area: 'Sarjapur Road', lat: 12.9010, lng: 77.6874 },
  { area: 'Outer Ring Road', lat: 12.9352, lng: 77.6900 },
  { area: 'Hebbal', lat: 13.0358, lng: 77.5970 },
  { area: 'Yelahanka', lat: 13.1007, lng: 77.5963 },
  { area: 'JP Nagar', lat: 12.9077, lng: 77.5851 },
  { area: 'Domlur', lat: 12.9609, lng: 77.6387 },
  { area: 'Rajajinagar', lat: 12.9911, lng: 77.5546 },
  { area: 'Basavanagudi', lat: 12.9422, lng: 77.5737 },
  { area: 'Banashankari', lat: 12.9255, lng: 77.5468 },
  { area: 'Kalyan Nagar', lat: 13.0207, lng: 77.6417 },
  { area: 'Rajarajeshwari Nagar', lat: 12.9257, lng: 77.5182 },
  { area: 'Peenya', lat: 13.0288, lng: 77.5188 },
  { area: 'Bommanahalli', lat: 12.8994, lng: 77.6183 },
  { area: 'Kanakapura Road', lat: 12.8901, lng: 77.5580 },
  { area: 'Devanahalli', lat: 13.2437, lng: 77.7128 },
  { area: 'Ulsoor', lat: 12.9829, lng: 77.6215 },
  { area: 'Bengaluru Central', lat: 12.9767, lng: 77.5713 },
];

/** Nearest area centroid within ~4 km, else undefined. */
function nearestAreaByCoords(lat: number, lng: number): string | undefined {
  let best: { area: string; dist: number } | undefined;
  for (const centroid of AREA_CENTROIDS) {
    // Equirectangular approximation is plenty at city scale.
    const dLat = (lat - centroid.lat) * 111;
    const dLng = (lng - centroid.lng) * 111 * Math.cos((lat * Math.PI) / 180);
    const dist = Math.sqrt(dLat * dLat + dLng * dLng);
    if (!best || dist < best.dist) best = { area: centroid.area, dist };
  }
  return best && best.dist <= 4 ? best.area : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Off-city rejection
//
// WHY A SECOND GATE. isBengaluru() asks "is there evidence FOR Bengaluru" and
// returns null when there is none, and null is accepted by almost every adapter
// because it has to be — Meetup's ICS carries no LOCATION at all, so a strict
// gate would delete the largest source in the corpus. It also never reads the
// title. Measured 2026-08-24: 6 upcoming events flagged isTechEvent named
// another city in their own title ("Chennai - Build Your First AI Agent",
// "Anthropic - Code - Coffee : Coimbatore Edition") and were showing in the
// DEFAULT tech feed.
//
// WHY NOT FILTER ON `city`. It is not a usable gate. Of 1212 upcoming events,
// 522 have no city at all; the home city's own spelling spans six casings plus
// six suburb values (Hebbagodi, Madavara, Doddathoguru, …) that appear in no
// gazetteer. `city === 'Bengaluru'` would delete most of the corpus.
//
// So this rejects only on a POSITIVE signal of another city, and every unknown
// passes. A false positive here does not mis-tag an event — it deletes it before
// it is ever stored, and no re-scrape recovers it, because merging only ever
// fills gaps. That asymmetry is why the guards below exist and why anything
// doubtful is `ambiguous`.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cities that are not this one.
 *
 * `strength` copies the rule `lib/companies/registry.ts` arrived at the hard way (a naive
 * substring match reported "Intel" 37 times, "SAP" 157):
 *
 *  - `distinctive` — the token means the city almost everywhere it appears, so it may be read
 *    from a title, venue or address.
 *  - `ambiguous` — the token doubles as a genre, a surname, an acronym or a region, so it is
 *    read ONLY from the structured `city` field, where a bare mention really is a location.
 *    "Goa Trance Night" is a Bengaluru club night; PISA is an OECD assessment.
 *
 * Deliberately absent, and each for the same reason — the word is a brand or a dish at least as
 * often as a place, and the modern name is already listed: `bombay` (Bombay Shaving Company,
 * Bombay Bicycle Club), `madras` (Madras Cafe, madras curry), `calcutta`, `salem`. Also absent:
 * Paris, Berlin, Tokyo, Amsterdam and the rest of the world's tech capitals, because none has
 * ever appeared in this corpus and each reads as a TOPIC as often as a location in a Bengaluru
 * feed ("what we learned at KubeCon Paris"). The foreign entries below are the ones actually
 * measured, plus the three destinations an Indian feed genuinely lists. Extending this is one
 * line, and `scripts/diag-offcity.ts` names the rows that would justify it.
 */
const OTHER_CITIES: Array<{ city: string; aliases: string[]; strength: 'distinctive' | 'ambiguous' }> = [
  // ── India: every metro the product is NOT about ──
  { city: 'Chennai', aliases: ['chennai'], strength: 'distinctive' },
  { city: 'Mumbai', aliases: ['mumbai'], strength: 'distinctive' },
  { city: 'Hyderabad', aliases: ['hyderabad', 'secunderabad'], strength: 'distinctive' },
  { city: 'Delhi', aliases: ['delhi'], strength: 'distinctive' },
  { city: 'Noida', aliases: ['noida'], strength: 'distinctive' },
  { city: 'Gurugram', aliases: ['gurugram', 'gurgaon'], strength: 'distinctive' },
  { city: 'Pune', aliases: ['pune'], strength: 'distinctive' },
  { city: 'Kolkata', aliases: ['kolkata'], strength: 'distinctive' },
  { city: 'Ahmedabad', aliases: ['ahmedabad'], strength: 'distinctive' },
  { city: 'Jaipur', aliases: ['jaipur'], strength: 'distinctive' },
  { city: 'Lucknow', aliases: ['lucknow'], strength: 'distinctive' },
  { city: 'Indore', aliases: ['indore'], strength: 'distinctive' },
  { city: 'Bhopal', aliases: ['bhopal'], strength: 'distinctive' },
  { city: 'Coimbatore', aliases: ['coimbatore'], strength: 'distinctive' },
  { city: 'Kochi', aliases: ['kochi', 'cochin', 'ernakulam'], strength: 'distinctive' },
  { city: 'Thiruvananthapuram', aliases: ['thiruvananthapuram', 'trivandrum'], strength: 'distinctive' },
  { city: 'Visakhapatnam', aliases: ['visakhapatnam', 'vizag'], strength: 'distinctive' },
  { city: 'Nagpur', aliases: ['nagpur'], strength: 'distinctive' },
  { city: 'Surat', aliases: ['surat'], strength: 'distinctive' },
  { city: 'Vadodara', aliases: ['vadodara'], strength: 'distinctive' },
  { city: 'Chandigarh', aliases: ['chandigarh'], strength: 'distinctive' },
  { city: 'Bhubaneswar', aliases: ['bhubaneswar'], strength: 'distinctive' },
  { city: 'Guwahati', aliases: ['guwahati'], strength: 'distinctive' },
  { city: 'Madurai', aliases: ['madurai'], strength: 'distinctive' },
  { city: 'Nashik', aliases: ['nashik'], strength: 'distinctive' },
  { city: 'Vijayawada', aliases: ['vijayawada'], strength: 'distinctive' },
  // Added on evidence, not speculation: the JumpStart Bharat Luma calendar is seeded precisely
  // because it TOURS through Bengaluru, and Kolkata / Guwahati / Lucknow / Prayagraj are the
  // other stops on it. The first three were already listed; this one was the gap.
  { city: 'Prayagraj', aliases: ['prayagraj', 'allahabad'], strength: 'distinctive' },
  { city: 'Tiruchirappalli', aliases: ['tiruchirappalli', 'trichy'], strength: 'distinctive' },
  // ── Karnataka, but still not Bengaluru. The scope is one city, not one state ──
  { city: 'Mysuru', aliases: ['mysuru', 'mysore'], strength: 'distinctive' },
  { city: 'Mangaluru', aliases: ['mangaluru', 'mangalore'], strength: 'distinctive' },
  { city: 'Hubballi', aliases: ['hubballi', 'hubli'], strength: 'distinctive' },
  { city: 'Belagavi', aliases: ['belagavi', 'belgaum'], strength: 'distinctive' },
  // ── Abroad: measured in the corpus, plus London/Singapore/Dubai ──
  { city: 'New York', aliases: ['new york', 'nyc'], strength: 'distinctive' },
  { city: 'San Francisco', aliases: ['san francisco'], strength: 'distinctive' },
  { city: 'Los Angeles', aliases: ['los angeles'], strength: 'distinctive' },
  { city: 'London', aliases: ['london'], strength: 'distinctive' },
  { city: 'Singapore', aliases: ['singapore'], strength: 'distinctive' },
  { city: 'Dubai', aliases: ['dubai', 'abu dhabi'], strength: 'distinctive' },
  // ── Ambiguous: structured `city` field only ──
  { city: 'Goa', aliases: ['goa', 'panaji'], strength: 'ambiguous' },
  { city: 'Bali', aliases: ['bali', 'denpasar'], strength: 'ambiguous' },
  { city: 'Pisa', aliases: ['pisa'], strength: 'ambiguous' },
  { city: 'Andalusia', aliases: ['andalusia'], strength: 'ambiguous' },
];

/**
 * Phrases where a city name is part of something that is not a location, stripped before
 * matching. Every entry is a real class of event this corpus carries.
 */
const NOT_A_LOCATION: RegExp[] = [
  // IPL and ISL team names. District is the concerts-and-sport source, and a Bengaluru pub
  // screening RCB vs CSK is a Bengaluru event — arguably the most Bengaluru event there is.
  /\b(?:chennai super kings|mumbai indians|delhi capitals|punjab kings|kolkata knight riders|gujarat titans|lucknow super giants|rajasthan royals|mumbai city fc|hyderabad fc)\b/gi,
  // A school chain, not the capital. There are branches on Bannerghatta and Mysore Road.
  /\bdelhi public school\b/gi,
  // A newspaper and a dessert.
  /\bnew york (?:times|cheesecake|style)\b/gi,
];

/**
 * A road named after where it leads is still a road HERE. `geo.ts` already records
 * "Bengaluru - Chennai Highway" as a real false positive found during recon, and the same
 * shape covers Mysore Road, Hosur Road and Tumkur Road — all Bengaluru arterials.
 */
const LEADS_ELSEWHERE = String.raw`(?!\s*(?:road|rd\b|highway|hwy|expressway|flyover|circle|junction))`;

const CITY_PATTERNS: Array<{ city: string; strength: 'distinctive' | 'ambiguous'; pattern: RegExp }> =
  OTHER_CITIES.map(entry => ({
    city: entry.city,
    strength: entry.strength,
    // Non-global on purpose: a /g regex carries lastIndex between .test() calls and would
    // start skipping matches.
    pattern: new RegExp(String.raw`\b(?:${entry.aliases.join('|')})\b${LEADS_ELSEWHERE}`, 'i'),
  }));

/**
 * The other city this text names, or undefined. Reads the FULL gazetteer including the
 * ambiguous entries, so it answers "what city is this string?" — which is what a stored
 * `city` value is, and what `scripts/diag-offcity.ts` reports on.
 */
export function namesOtherCity(text: string | undefined | null): string | undefined {
  if (!text) return undefined;
  let scrubbed = String(text);
  for (const guard of NOT_A_LOCATION) scrubbed = scrubbed.replace(guard, ' ');
  for (const entry of CITY_PATTERNS) {
    if (entry.pattern.test(scrubbed)) return entry.city;
  }
  return undefined;
}

export interface OffCityInput {
  title?: string;
  venue?: string;
  address?: string;
  city?: string;
  lat?: number;
  lng?: number;
  /**
   * Accepted and DELIBERATELY NEVER MATCHED. A Bengaluru meetup routinely says "speakers
   * flying in from Chennai" or "next edition in Pune", and a description is long enough that
   * some other city is named in a large share of the corpus. It is in the signature so the
   * omission is visible at the call site rather than looking like an oversight, and so
   * `tests/off-city.test.ts` can assert the omission holds.
   */
  description?: string;
}

export interface OffCityVerdict {
  /** Canonical name of the city this event appears to be in. */
  city: string;
  /** Which field gave it away — logged so a rejection can be argued with. */
  field: 'city' | 'venue' | 'address' | 'title';
}

/** Is there evidence this event IS in Bengaluru? Any at all outranks an off-city signal. */
function hasBengaluruEvidence(input: OffCityInput): boolean {
  const { lat, lng } = input;
  if (
    typeof lat === 'number' &&
    typeof lng === 'number' &&
    (lat !== 0 || lng !== 0) &&
    lat >= BLR_BOUNDS.minLat &&
    lat <= BLR_BOUNDS.maxLat &&
    lng >= BLR_BOUNDS.minLng &&
    lng <= BLR_BOUNDS.maxLng
  ) {
    return true;
  }

  // Coordinates OUTSIDE the box are not consulted here. They are a strong signal, but they are
  // isBengaluru()'s to act on at the adapter, where the source knows whether it publishes
  // reliable coordinates. Acting on them twice would reject on a signal this function's callers
  // never agreed to.
  const text = [input.title, input.venue, input.address, input.city].filter(Boolean).join(', ');
  if (!text) return false;
  return BLR_NAME.test(text) || matchArea(text) !== undefined;
}

/**
 * Should this event be rejected as belonging to another city? Returns the reason, or undefined
 * to keep it.
 *
 * Pure: no I/O, no clock, no database. Called at ingest (`lib/scrapers/pipeline.ts`) BEFORE
 * tagging, so a Chennai listing also costs no LLM call.
 */
export function offCityReason(input: OffCityInput): OffCityVerdict | undefined {
  if (hasBengaluruEvidence(input)) return undefined;

  // Strongest field first, so the reported reason is the most defensible one available.
  const fields: Array<OffCityVerdict['field']> = ['city', 'venue', 'address', 'title'];
  for (const field of fields) {
    const value = input[field];
    if (!value) continue;
    let scrubbed = String(value);
    for (const guard of NOT_A_LOCATION) scrubbed = scrubbed.replace(guard, ' ');
    for (const entry of CITY_PATTERNS) {
      // Ambiguous names are only trustworthy in the structured city field.
      if (entry.strength === 'ambiguous' && field !== 'city') continue;
      if (entry.pattern.test(scrubbed)) return { city: entry.city, field };
    }
  }
  return undefined;
}
