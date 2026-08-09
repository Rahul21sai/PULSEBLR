// Bengaluru geography: is this event actually in Bengaluru, and which area?
//
// Two jobs, both important:
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
