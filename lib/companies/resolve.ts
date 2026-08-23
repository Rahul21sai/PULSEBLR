// Resolve free text to canonical company names.
//
// This is the counterpart to the registry's `strength` field. The rules encode
// what the live corpus taught us:
//
//  · Word boundaries are mandatory. A plain substring match reported "Intel" 37
//    times because it matched *intel*ligence, and "CRED" 31 times from
//    *cred*entials / in*cred*ible.
//  · Field matters more than frequency. The ORGANISER field is a strong claim —
//    if the host string says "Intel", Intel is hosting. A description mentioning
//    "intel" is worth nothing. So ambiguous names are only ever matched against
//    organiser (and calendar/host text), never description.
//  · Distinctive names may be matched in the title and description too, because
//    "Razorpay x Cartesia x TPF" in a title genuinely means Razorpay is involved.

import { COMPANIES, Company } from './registry';

/** Fields available for matching, in descending order of trustworthiness. */
export interface CompanyResolveInput {
  /** Host / organiser / calendar name. Strongest signal. */
  organizer?: string | null;
  /** Event title. Strong for distinctive names ("Razorpay x Cartesia x TPF"). */
  title?: string | null;
  /**
   * Body copy. Accepted for API compatibility but DELIBERATELY NOT MATCHED —
   * see the note on description matching below.
   */
  description?: string | null;
  /** Organiser-supplied topic tags. */
  tags?: string[] | null;
  /**
   * Where it is being held. A company's office in this field means that company is
   * involved — see the scoring note in resolveCompanies. Distinctive names only.
   */
  venue?: string | null;
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a word-boundary matcher for every alias of a company.
 *
 * `\b` alone is not enough for names containing punctuation or spaces, so we use
 * explicit non-word lookarounds. Compiled once per company at module load; there
 * are ~100 companies and this runs over every scraped event, so rebuilding the
 * regexes per call would be wasteful.
 */
function buildMatcher(company: Company): RegExp {
  const terms = [company.name, ...(company.aliases || [])]
    .map(escapeRegex)
    // Longer aliases first so "Google Cloud" wins over "Google" when both match.
    .sort((a, b) => b.length - a.length);
  return new RegExp(`(?<![A-Za-z0-9])(?:${terms.join('|')})(?![A-Za-z0-9])`, 'i');
}

/**
 * Venue matching uses the COMPANY NAME ONLY, never its aliases.
 *
 * A building is named after the company, not after its products. Offices are called
 * "HashiCorp Bengaluru", never "Terraform" — and the difference is not academic: the alias
 * matcher attributed three Bengaluru CONCERTS to HashiCorp, including a Gorillaz show and
 * an orchestral Qawwali project, because the venue is literally called
 * "District Arena @ Terraform". Measured by scripts/diag-venue-attribution.ts, which exists
 * to make exactly this visible before it ships.
 *
 * Dropping aliases here keeps the seven correct attributions (Scaler's campus, Nokia's
 * office hosting an AWS user-group day, Google RMZ Infinity, Microsoft Reactor, Cisco's
 * business park) and removes all three wrong ones.
 */
function buildNameOnlyMatcher(company: Company): RegExp {
  return new RegExp(`(?<![A-Za-z0-9])${escapeRegex(company.name)}(?![A-Za-z0-9])`, 'i');
}

const MATCHERS: Array<{ company: Company; pattern: RegExp; venuePattern: RegExp }> =
  COMPANIES.map(company => ({
    company,
    pattern: buildMatcher(company),
    venuePattern: buildNameOnlyMatcher(company),
  }));

/**
 * Canonical company names mentioned by this event.
 *
 * Returns at most `limit` names, ordered by the strength of the evidence
 * (organiser hit first). An empty array means "we could not attribute this event
 * to a known company" — which is the honest answer for the many community events
 * that no company runs, and must not be filled in with a guess.
 */
export function resolveCompanies(input: CompanyResolveInput, limit = 4): string[] {
  const organizer = (input.organizer || '').trim();
  const title = (input.title || '').trim();
  const tags = (input.tags || []).join(' ');
  const venue = (input.venue || '').trim();

  // Score by where the match landed, so the strongest attribution sorts first.
  const scored: Array<{ name: string; score: number }> = [];

  for (const { company, pattern, venuePattern } of MATCHERS) {
    let score = 0;

    if (organizer && pattern.test(organizer)) score = 100;
    // THE VENUE IS A COMPANY'S OFFICE far more often than it is a coincidence.
    //
    // Real venues from the live corpus: "InMobi Technologies", "Freshworks Bengaluru",
    // "Google Ananta", "UiPath PE Onyx", "Contentstack India", "Sahaj Software,
    // Koramangala", "Microsoft, Bengaluru". A company lending its office to an event is
    // involved in it — that is the ordinary meaning of hosting — and it is exactly the
    // relationship the product is asked to surface ("every company in Bangalore that runs
    // events").
    //
    // Scored ABOVE tags and title but below organiser: the organiser field is an explicit
    // claim, while a venue is strong circumstantial evidence.
    //
    // DISTINCTIVE names only, for the same reason the title rule is restricted. An
    // ambiguous name against a venue string invites exactly the errors the registry exists
    // to prevent — "Target" or "Apple" appearing in a mall or address would attribute an
    // unrelated event to a company that has nothing to do with it.
    else if (company.strength === 'distinctive' && venue && venuePattern.test(venue)) score = 70;
    else if (tags && pattern.test(tags)) score = 60;
    // A title naming a company is a real claim of involvement
    // ("Razorpay x Cartesia x TPF Presents…").
    else if (company.strength === 'distinctive' && title && pattern.test(title)) score = 50;
    // Ambiguous names stop at organiser/tags: no venue or title matching.

    // DESCRIPTIONS ARE NOT MATCHED, ON PURPOSE.
    //
    // It was tried and measured: allowing description matches attributed a
    // "LeetCode Patterns" meetup and a "Central Bangalore BoardGames" night to
    // Google, because their descriptions said "Google Form" and "Google Maps link".
    // Big-tech names double as everyday tooling references — Google Meet/Forms/Maps,
    // Microsoft Teams, Amazon vouchers, Zoom — so a body-text mention carries no
    // information about who is HOSTING. A companies directory that claims Google
    // runs a boardgames night is worse than one that lists fewer events, so
    // precision wins over recall here.

    if (score > 0) scored.push({ name: company.name, score });
  }

  return scored
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map(entry => entry.name);
}

/** True when the text names this specific company, using the same rules. */
export function textMentionsCompany(text: string, companyName: string): boolean {
  const entry = MATCHERS.find(m => m.company.name === companyName);
  return entry ? entry.pattern.test(text) : false;
}
