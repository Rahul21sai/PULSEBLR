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

const MATCHERS: Array<{ company: Company; pattern: RegExp }> = COMPANIES.map(company => ({
  company,
  pattern: buildMatcher(company),
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

  // Score by where the match landed, so the strongest attribution sorts first.
  const scored: Array<{ name: string; score: number }> = [];

  for (const { company, pattern } of MATCHERS) {
    let score = 0;

    if (organizer && pattern.test(organizer)) score = 100;
    else if (tags && pattern.test(tags)) score = 60;
    // A title naming a company is a real claim of involvement
    // ("Razorpay x Cartesia x TPF Presents…").
    else if (company.strength === 'distinctive' && title && pattern.test(title)) score = 50;
    // Ambiguous names stop at organiser/tags: no title matching.

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
