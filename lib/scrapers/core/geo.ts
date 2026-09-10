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
 *
 * ── HOW TO WIDEN THIS SAFELY, AND WHY THE TWO DIRECTIONS ARE NOT SYMMETRIC ──────────────────
 *
 * `matchArea` has three callers and only one of them is the area filter:
 *
 *   1. `resolveArea()`   — the UI's area facet. A wrong match here mislabels one event's
 *                          neighbourhood. Recoverable, and visible to anyone who reads the card.
 *   2. `isBengaluru()`   — "a recognisable Bengaluru neighbourhood is as good as naming the city".
 *                          A wrong match here ADMITS an off-city event at a `geoPolicy: 'require'`
 *                          adapter. This is the direction that costs precision.
 *   3. `hasBengaluruEvidence()` in the off-city gate — where an area match is an unconditional
 *                          VETO of rejection. A wrong match here SPARES an off-city event.
 *
 * So a loose pattern here can never delete an event: (3) only ever keeps more. That is the whole
 * reason this file's gazetteer may be widened on ordinary corpus evidence while `OTHER_CITIES`
 * below may not. What a loose pattern CAN do is let another city in through (2), so every token
 * added must be one that names a Bengaluru locality and nothing else anywhere in India.
 *
 * Three tokens were rejected on exactly that test while widening this list on 2026-09-10:
 *
 *   `phoenix marketcity`  — there are Phoenix Marketcity malls in Mumbai, Pune and Chennai, so it
 *                           would have spared a Pune event at the off-city gate. Replaced with
 *                           `mahadevapura` / `krishnarajapuram` / `devasandra`, which are the
 *                           Bengaluru localities that actual venue string also carries.
 *   `city junction`       — Mysuru, Chennai and half of India have one. Narrowed to
 *                           `bengaluru|bangalore city junction` and `ksr` qualified by the city.
 *   `lal bagh`            — Lal Bagh Palace is in INDORE. Qualified to require
 *                           `road|rd|botanical|garden`, which is how the Bengaluru one is written.
 *
 * ── WHAT WAS ADDED, AND FROM WHAT ────────────────────────────────────────────────────────────
 *
 * Every token below came from a `distinct` over the venue/address/city strings of the 204 upcoming
 * events stored `area: 'Other'` (2026-09-10, 58 distinct strings). Not from a map, and not from
 * guessing which localities exist — from the strings sources actually publish, which is why so
 * many of them are MISSPELLINGS of tokens already in this list. Four patterns were failing purely
 * on spelling and each cost real rows:
 *
 *     `Kormangala`   → `kora?mangala`        5 rows   (Koramangala, one letter short)
 *     `Kanakpura`    → `kanaka?pura`         8 rows   (Kanakapura Road, one letter short)
 *     `Penya`        → `\bpenya\b`           8 rows   (Peenya, one letter short)
 *     `Church St`    → `church\s*st\b`      10 rows   (the pattern demanded the word "street")
 *     `Manayata` / `Nagavara` → both spellings (Hebbal already had `manyata` / `nagawara`)
 *
 * `scripts/diag-area-coverage.ts` re-measures this: it replays `resolveArea` over the stored corpus
 * and prints the venue strings of the rows on both sides. Run it after touching this list — a
 * rising resolved count is not evidence on its own, because the failure mode of a widened
 * gazetteer is putting events in the WRONG area, which no aggregate reveals.
 *
 * ── WORD BOUNDARIES ARE NOT OPTIONAL HERE. Two shipped tokens lacked them. ────────────────────
 *
 * Measured 2026-09-10. `agara` and `majestic` were both written unbounded, and both matched
 * inside longer words — the same failure as the tagger's bare `\bpm\b` matching the "PM" in
 * "6 PM", and it produced a WRONG area rather than a missing one, which is worse:
 * `lib/events/relevance.ts` scores `areaMatch: +22` and `areaUnknown: 0`, so a mislabelled row
 * is ranked UP for a neighbourhood the reader cannot actually reach, while an unresolved row is
 * merely neutral. **A wrong area is strictly worse than no area in that model.**
 *
 *   `agara`     matched "Thi**agara**jar College" (Madurai) and "Sampangi Rama Na**gara**".
 *               HSR Layout sits at index 3 and MG Road at index 5, so a Cubbon Park event whose
 *               address carries "Sampangi Rama Nagara" resolved to HSR LAYOUT, beating the
 *               `cubbon` token that should have owned it. Also matched "Na**gara** fort" in trek
 *               copy. Now `\bagara\b` — Agara is a real HSR-adjacent locality; the substring was
 *               the bug.
 *   `majestic`  matched "majestically". 0 rows in the gate fields today, so bounding it changes
 *               nothing in the corpus, but it is one "Hotel Majestic, Chennai" away from
 *               admitting another city through `isBengaluru`.
 *               **Bounding does NOT fix "majestic mountains", and claiming it did would be
 *               wrong** — there the token is its own word, and Majestic (the Kempegowda bus
 *               station) has to keep matching. What keeps trek copy out is that `resolveArea`
 *               never reads the description; see its docblock. Two separate defences.
 *
 * **TIGHTENING A PATTERN HERE TOUCHES THE DELETE PATH, and in the dangerous direction.** The
 * three-callers note above says a LOOSE pattern can never delete an event because
 * `hasBengaluruEvidence` only ever keeps more. The converse is the part that needs care: a
 * TIGHTER pattern removes a veto, so a row that was spared can become rejectable. Bounding
 * `agara` did exactly that to exactly one row, named here because it is the only behaviour
 * change in the gate:
 *
 *     "CLOUD COMPUTING UNPLUGGED" — Thiagarajar College, Kamarajar Salai, Madurai,
 *     Tamil Nadu 625009, `city: 'Madurai'`
 *
 * It is a Madurai event by every field it has — and it was stored `area: 'HSR Layout'`, in the
 * Bengaluru area facet — so rejecting it is the gate doing its job: the unbounded token had been
 * vetoing a TRUE positive.
 *
 * **`scripts/diag-offcity.ts` still reports 0 rejects, before AND after, and that is not a
 * contradiction — it counts UPCOMING rows only and this event is past.** Over the whole corpus
 * the count went 0 → 1. Worth stating because the two numbers look like they disagree, and
 * because it means that diagnostic could not have caught this class of change at all: verify a
 * future tightening by naming the rows that LOSE their veto over the full corpus and checking
 * each is genuinely off-city, not by watching the upcoming reject count.
 *
 * ── THREE MORE SPELLINGS, from one Amazon/Bagmane venue string ────────────────────────────────
 *
 *     `Mahadevpura`            → `mahadeva?pura`            (Mahadevapura, one letter short)
 *     `K.R. PuramMarathalli`   → `\bk\.?\s*r\.?\s*puram`    (dotted, and NO trailing \b — the
 *                                                            string runs "PuramMarathalli" with
 *                                                            no separator, so a trailing
 *                                                            boundary cannot match)
 *     `Marathalli`             → `maratha(?:ha)?lli`        (Marathahalli, missing a syllable)
 *
 * ── WHAT WAS REFUSED, AND WHY. The refusals are the load-bearing half. ────────────────────────
 *
 *   `draper startup house`  4 rows, all "384, 1st A Main Rd, Bengaluru". Draper Startup House is
 *                           a GLOBAL chain (Bali, Lisbon, San Francisco, Singapore), so it fails
 *                           the header's own test and would veto an off-city rejection for the
 *                           Bali one. The address carries no locality token to use instead.
 *   `nice ground`           3 rows, ONE venue name, and the corpus stores it THREE different ways
 *                           — `Other`, `MG Road` (from the generic 12.9716,77.5946 city-centre
 *                           placeholder coordinate) and `Hebbal` (its address says "Madavara,
 *                           Nagawara Area", two tokens owned by different entries). The corpus
 *                           itself does not agree where this venue is, so picking one would be
 *                           inventing an answer.
 *   `atta galatta`          1 row. Genuinely Bengaluru-only, but the stored string is "178, 5th
 *                           Main Rd" with no locality, so the area would come from memory rather
 *                           than from an observed string. One row is not worth a guessed label.
 *   `jrc palladio`,         1 row each, no locality token and no corroborating area. JRC Palladio
 *   `aurbis`, office        even has coordinates (12.8319, 77.7738) and `nearestAreaByCoords`
 *   names (HackerRank,      already declined them as >4 km from every centroid, which is the
 *   Rippling, Uber)         right answer for a peripheral venue.
 *   PIN-code prefixes       Only 2 rows carry one, and both already resolve by other tokens.
 *                           `\b56\d{4}\b` would also match a price ("56000"), and mapping a PIN
 *                           to an AREA needs a table this corpus cannot justify.
 *   `skandagiri`,           4 and 2 rows. Deliberately left at 'Other': Skandagiri
 *   `sakleshpur`            (Chikkaballapur) and Sakleshpura (Hassan) are day-trip destinations
 *                           OUTSIDE the city. Adding them would label an out-of-town trek as a
 *                           Bengaluru neighbourhood and hand it a +22 relevance bonus.
 */
const AREAS: Array<{ area: string; patterns: RegExp }> = [
  { area: 'Koramangala', patterns: /kora?mangala|\bkora\b|forum mall|national games village|\bngv\s*park\b/i },
  { area: 'Indiranagar', patterns: /indiranagar|indira nagar|\b100\s*ft\s*road\b/i },
  // KR Puram / Mahadevapura / Devasandra sit on the Whitefield corridor and are how the venue
  // strings for the Mahadevapura mall complex are actually written. `phoenix marketcity` is NOT
  // here — see the header: that brand exists in three other Indian cities.
  { area: 'Whitefield', patterns: /whitefield|itpl|kadugodi|hoodi|brookefield|varthur|mahadeva?pura|krishnarajapuram|\bk\.?\s*r\.?\s*puram|devasandra/i },
  // `agara` IS bounded, and the boundaries are the whole point — see the WORD BOUNDARIES note
  // in the header. Unbounded, it matched inside "Thiagarajar College" and "Sampangi Rama Nagara".
  { area: 'HSR Layout', patterns: /\bhsr\b|hsr layout|\bagara\b/i },
  // Chandapura / Anekal / Attibele / Bommasandra / Huskur are the Hosur Road tail past EC, which
  // is already represented here by `hosur road`. Bommasandra is a different place from
  // Bommanahalli below and neither pattern can match the other.
  { area: 'Electronic City', patterns: /electronic(s)?\s*city|\bec\s*phase|hosur road|neeladri|bommasandra|chandapura|anekal|attibele|huskur/i },
  { area: 'MG Road', patterns: /\bm\.?g\.?\s*road\b|brigade road|church\s*st(?:reet)?\b|st\.?\s*mark'?s?\s*road|residency\s*(?:road|rd)\b|lavelle\s*(?:road|rd)\b|trinity|cubbon|shivajinagar|vittal mallya/i },
  { area: 'Marathahalli', patterns: /maratha(?:ha)?lli|kundalahalli|\baecs\b|thubarahalli|chinnappanahalli|garudachar/i },
  // Leading `\b` and NO trailing one: unbounded, `jayanagar` matched inside "San**jayanagar**a"
  // (an RMV 2nd Stage club, ~12 km north of Jayanagar). Omitting the trailing boundary keeps the
  // Kannada "Jayanagara" spelling matching.
  { area: 'Jayanagar', patterns: /\bjaya\s*nagar|south end circle/i },
  { area: 'BTM Layout', patterns: /\bbtm\b|btm layout|tavarekere|silk\s*board/i },
  // `\barekere\b`: unbounded it matched inside "Tav**arekere** Main Road", which is a BTM Layout
  // token. Harmless only because BTM sits earlier in this array — i.e. correct by accident, and
  // a reorder away from wrong. Bounded, it no longer depends on the ordering.
  { area: 'Bannerghatta Road', patterns: /bannerghatta|\barekere\b|hulimavu|gottigere/i },
  { area: 'Sarjapur Road', patterns: /sarjapur|bellandur|haralur|kaikondrahalli|kasavanahalli|dommasandra|carmelaram/i },
  { area: 'Outer Ring Road', patterns: /outer ring road|\borr\b|devarabisanahalli|kadubeesanahalli|ecospace|embassy tech|prestige tech/i },
  { area: 'Hebbal', patterns: /hebbal|man[ay]{1,2}ata|nagawara|nagavara|thanisandra|hegde\s*nagar|bhartiya\s*city/i },
  { area: 'Yelahanka', patterns: /yelahanka|jakkur|kogilu|attur|vidyaranyapura|sahakar\s*a?nagar/i },
  { area: 'JP Nagar', patterns: /\bjp\s*nagar\b|j\.?p\.?\s*nagar|puttenahalli/i },
  // EGL is Embassy Golf Links, already here under its long name. Jeevan Bima Nagar and NAL Colony
  // are the Old Airport Road pocket, which this entry already owns.
  { area: 'Domlur', patterns: /domlur|old airport road|\bhal\b\s*(2nd|second)?|embassy golf|\begl\b|jeevan\s*bima\s*nagar|\bnal\s*colony\b/i },
  { area: 'Rajajinagar', patterns: /rajajinagar|rajaji nagar|malleshwaram|malleswaram|yeshwanthpur|yeshwantpur|mathikere/i },
  // `lal bagh` requires a road/garden word: Lal Bagh Palace is in Indore.
  { area: 'Basavanagudi', patterns: /basavanagudi|gandhi bazaar|\bvv\s*puram\b|chamarajpet|lalbagh|lal\s*bagh\s*(?:road|rd\b|botanical|garden)/i },
  { area: 'Banashankari', patterns: /banashankari|\bbsk\b|padmanabhanagar|kathriguppe/i },
  { area: 'Kalyan Nagar', patterns: /kalyan\s*nagar|kammanahalli|kamnahalli|kothanur|hennur|\bcv\s*raman\s*nagar\b|banaswadi|\bhrbr\b/i },
  { area: 'Rajarajeshwari Nagar', patterns: /rajarajeshwari|\brr\s*nagar\b|kengeri|uttarahalli/i },
  // The Tumkur Road industrial corridor, which this entry already reaches as far as Dasarahalli.
  // BIEC (Bangalore International Exhibition Centre) is out at Madavara on the same road and is a
  // high-volume venue — five of the strings in the 'Other' bucket are its variant spellings.
  // `tumkur road` follows the precedent of `hosur road` above and `mysore road` under RR Nagar: a
  // road named after where it leads is still a road HERE.
  { area: 'Peenya', patterns: /p[e]?enya|jalahalli|nagasandra|dasarahalli|tumkur\s*(?:road|rd)\b|nelamangala|madavara|madanayakanahalli|totadaguddadahalli|\bbiec\b|(?:bangalore|bengaluru)\s*international\s*exhibition/i },
  { area: 'Bommanahalli', patterns: /bommanahalli|singasandra|begur|kudlu/i },
  { area: 'Kanakapura Road', patterns: /kanaka?pura|konanakunte|thalaghattapura|vajarahalli|thataguni/i },
  { area: 'Devanahalli', patterns: /devanahalli|\bkia\b|kempegowda international|airport road north/i },
  { area: 'Ulsoor', patterns: /ulsoor|halasuru|richmond town|langford|frazer town|\bcooke town\b/i },
  // `\bmajestic\b` is bounded so it cannot reach "majestically" / "majestic mountains" — see the
  // header. The bus station is written "Majestic" or "Majestic Bus Stand", never as a suffix.
  { area: 'Bengaluru Central', patterns: /\bmajestic\b|k\.?r\.?\s*market|city market|chickpet|gandhinagar|seshadripuram|race course|(?:bengaluru|bangalore)\s*city\s*(?:junction|railway)|\bksr\s*(?:bengaluru|bangalore|city)|kempegowda\s*bus/i },
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
 *
 * **`input.text` IS DELIBERATELY NOT READ, and the measurement says keep it that way.**
 * `GeoInput.text` is documented as "a weak last resort", `lib/scrapers/normalizer.ts` never
 * passes it, and this function never consults it — so the field reads like an oversight. It is
 * not. Measured over the live corpus on 2026-09-10: matching the gazetteer against the
 * DESCRIPTION would resolve 29 of the 283 unplaced upcoming rows (63.7% → 67.4%), and **7 of
 * those 29 are flatly wrong** — every `Bengaluru Central` hit came from the word "majestic"
 * ("majestic mountains" in Bhutan, Morocco and Coorg trip copy) and every `HSR Layout` hit from
 * "Nagara fort" in trek copy. Bounding those two tokens removes that particular pair, but the
 * class of error does not go away: a description is long enough to name a neighbourhood the
 * event is not in ("our old Koramangala office", "easy from Whitefield").
 *
 * The cost is asymmetric in the same direction as the boundary note above — `areaUnknown` is 0
 * and `areaMatch` is +22, so buying 3.7 points of coverage at a ~24% error rate makes the
 * ranking worse, not better. This is the same judgement `cleanup-non-bengaluru.ts` records for
 * never reading the description, arrived at independently.
 */
export function resolveArea(input: GeoInput): string | undefined {
  const fields = [input.venue, input.address, input.city];
  const location = fields.filter(Boolean).join(', ');
  if (location) {
    // MOST SPECIFIC FIELD FIRST. Matching the joined string let an ADDRESS token beat a VENUE
    // token purely on this table's array order, which is not a precedence rule anybody chose.
    // Measured over the live corpus (2026-09-10): 9 upcoming rows changed area under this, and
    // every one improved — `IBM EGL D Block` is the clearest, where the venue names Embassy Golf
    // Links (Domlur) and the address is "Off Indira Nagar-Koramangala Intermediate Ring Road", so
    // Koramangala won on a road named after the two places it CONNECTS. That is the same
    // "a road named after where it leads is still a road HERE" trap `LEADS_ELSEWHERE` handles
    // for the city gate, one level down. Also fixed: venue "Bommanahalli" losing to address
    // "approx 3kms from Silkboard junction", and Manyata Tech Park (Hebbal) losing to the ORR.
    for (const field of fields) {
      if (!field?.trim()) continue;
      const matched = matchArea(field);
      if (matched) return matched;
    }
    // Then the joined string, so a token straddling a field boundary is still found and this
    // change can only ever resolve MORE than before, never less. Measured: 0 rows rely on it
    // today, which is why it is cheap insurance rather than dead code.
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
//
// ── WHAT THIS GATE CANNOT DO. Read before trusting it. ──
//
// It is a PRECISION instrument with no recall guarantee. "No off-city events in
// the feed" is not something it can deliver, and five specific gaps are known:
//
//  1. IT CANNOT REACH STORED ROWS. It filters the incoming batch and never
//     queries the collection. Measured 2026-08-24: 29 upcoming rows were already
//     stored, 10 flagged isTechEvent. Worse, rejecting a re-sighting stops
//     `lastSeenAt` being refreshed, so each of those rows is now FROZEN — it will
//     not be corrected or cancelled either — and only becomes eligible for
//     `pruneStale()` once its own start date has passed by a week. They drain
//     over weeks, i.e. AFTER being shown. A cleanup is required, not optional.
//
//  2. NOTHING TO GO ON IS THE COMMON CASE. 523 of 1233 upcoming events name no
//     city in any field. Any of them may be elsewhere; this says nothing about
//     them, by design.
//
//  3. IT IS COUPLED TO THE ENRICHMENT BUDGET, which is the non-obvious one.
//     Meetup's ICS carries no LOCATION, so `enrichMeetupEvents` is what fills
//     venue/address/city/coords — and it takes candidates SORTED BY START DATE
//     then slices to `meetupEnrichBudget` (800, against ~931 Meetup events per
//     DEFAULTS). The overflow is therefore the FURTHEST-FUTURE events, and they
//     reach this gate with only a title to judge. Raising or lowering that budget
//     silently changes this gate's recall on the largest source in the corpus.
//
//  4. BENGALURU EVIDENCE IS AN UNCONDITIONAL VETO, including when the city value
//     is the ORGANISER's home rather than the event's location. Three upcoming
//     travel-group listings ("Get on the backroads of Bali", "Cycling Trip from
//     Pisa to Florence") carry `city: 'Bangalore'` from the Meetup group and are
//     kept. Overriding a positive city value with a venue string is a precedence
//     rule no measurement here justifies, so it is left alone deliberately.
//
//  5. COORDINATES OUTSIDE THE CITY ARE NOT ACTED ON HERE — see
//     hasBengaluruEvidence — and the gazetteer is a list, so a city absent from
//     it passes. Prayagraj was absent until a touring Luma calendar was seeded.
//     `scripts/diag-offcity.ts`'s UNRECOGNISED bucket is the only place the next
//     one becomes visible; read it rather than trusting the reject count.
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
