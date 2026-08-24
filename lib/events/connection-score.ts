// How useful is this event for meeting people?
//
// The product's purpose is narrow: find Bengaluru SOFTWARE and HARDWARE tech events
// that lead to good professional connections. "Is it tech" and "is it worth going to
// meet people" are different questions, and the second one is not something the LLM
// needs to guess — it follows from fields we already scrape.
//
// So this is a deterministic score over observable signals. Deterministic matters:
// the same event always ranks the same, the reasoning is auditable, and it costs no
// tokens. Every weight below is justified by how networking actually works.

export interface ConnectionScoreInput {
  format?: string | null;
  hasFood?: string | null;
  attendeeCount?: number | null;
  capacity?: number | null;
  category?: string[] | null;
  companies?: string[] | null;
  organizer?: string | null;
  title?: string | null;
  isFree?: boolean | null;
  price?: number | null;
}

/** Formats that put you in a room with people. */
const IN_PERSON_BONUS = 34;
const HYBRID_BONUS = 12;

/**
 * Categories where mingling is the point, not a side effect.
 * A conference or meetup has hallway time; a "training" does not.
 */
const SOCIAL_CATEGORIES = new Set([
  'Meetup',
  'Conference',
  'Hackathon',
  'Startup/Founders',
  'Community/Social',
  'Career/Hiring',
]);

/**
 * Titles that signal a COMMERCIAL FUNNEL rather than a peer gathering.
 *
 * These are the events that look technical but put you in an audience, not a room:
 * paid certification cohorts, sales webinars, "masterclasses" that end in an upsell.
 * The corpus is full of them — "Get Google AI Certified — AI Professionals July 2026
 * Cohort [6 of 8]" is a recurring series, and it is worthless for making peers.
 */
/*
 * The coaching-centre variants were added after two of them reached the top of the feed:
 * "Free DevOps Demo Class in Electronic City Bangalore" scored 58 and "Free Gen AI & Agentic AI
 * Demo at eMexo" scored 70 (diag-coaching-leak.ts). Both are lead generation for paid courses,
 * and the word "free" is what let them past a list built around "paid certification".
 *
 * `demo` is guarded rather than listed bare, because three uses of the word mean the opposite
 * thing:
 *   · "Demo Night" and "Demos" — community show-and-tell, among the BEST events for connections,
 *     and "demo night" already earns +10 from PEER_PATTERN. The `s\b` branch of the lookahead is
 *     what spares the plural.
 *   · "Demo Day" — startup demo days are networking-dense, so they stay unpenalised, matching the
 *     pre-existing `demo day for` entry.
 *   · "… Demo at <institute>" / "Demo Class" — a sales session. This is the one to penalise.
 * Alternation is ordered, so the explicit `demo class` / `demo lecture` / `demo day for` branches
 * are tried before the guarded bare `demo`.
 *
 * `\d+%\s*off` was added after reading the actual first page of the default feed, which carried
 * BOTH "2 Hours to Freedom: Build a Fleet of AI Agents" and "25% OFF: 2 Hours to Freedom: Build a
 * Job Hunt AI Agent" — the same paid course, listed twice, once with the discount in the title.
 * A percentage discount in an event title is about as unambiguous as this list gets: community
 * meetups, conferences and user groups do not mark themselves down, because they are free or
 * priced at cost. Early-bird pricing is deliberately NOT matched — legitimate conferences use it,
 * and "early bird" says nothing about whether you end up in a room or an audience.
 */
const FUNNEL_PATTERN =
  /\b(certifi\w*|cohort|bootcamp|training|masterclass|course|webinar|free workshop|crash course|placement|internship drive|batch \d|enroll\w*|trial class|coaching cent(?:re|er)|\d+%\s*off|demo class|demo lecture|demo day for|demo(?!\s*(?:day|night|s\b)))\b/i;

/** Titles that signal genuine practitioner gatherings. */
const PEER_PATTERN =
  /\b(meetup|meet ?up|conference|summit|hackathon|unconference|community|user group|devfest|hack ?night|open house|mixer|roundtable|panel|demo night|show ?and ?tell|lightning talks?)\b/i;

/**
 * Score from 0-100. Higher means a better chance of leaving with useful contacts.
 *
 * Not a probability — a ranking signal. It exists so "sort by best for connections"
 * can put a 60-person in-person Kubernetes meetup with food above a paid online
 * certification cohort, which chronological sorting cannot do.
 */
export function connectionScore(input: ConnectionScoreInput): number {
  let score = 20; // baseline: any real event beats no event
  const title = input.title || '';
  const categories = input.category || [];

  // ── Being physically present is the single biggest factor ──────────────────
  if (input.format === 'offline') score += IN_PERSON_BONUS;
  else if (input.format === 'hybrid') score += HYBRID_BONUS;
  else score -= 12; // online-only: you watch, you don't meet

  // ── Social proof: people actually coming ──────────────────────────────────
  // Log-scaled, because 20→40 attendees matters far more than 200→220, and a
  // 2000-person expo is not 50× better for connections than a 40-person meetup.
  const going = input.attendeeCount ?? 0;
  if (going > 0) score += Math.min(20, Math.round(7 * Math.log10(going + 1) * 1.6));

  // ── Format of the gathering ───────────────────────────────────────────────
  if (categories.some(c => SOCIAL_CATEGORIES.has(c))) score += 12;
  if (PEER_PATTERN.test(title)) score += 10;
  // Commercial funnels are penalised hard: they are the main source of
  // technical-looking events that waste an evening.
  if (FUNNEL_PATTERN.test(title)) score -= 30;

  // ── Food keeps people in the room after the talks ─────────────────────────
  if (input.hasFood === 'yes') score += 8;

  // ── A named company or community host means accountable, repeatable events ─
  if ((input.companies || []).length > 0) score += 8;
  else if (input.organizer) score += 3;

  // ── Price ─────────────────────────────────────────────────────────────────
  // Free community events draw practitioners; a steep ticket usually means a
  // corporate conference (still useful) or a course (already penalised above).
  if (input.isFree) score += 4;
  else if ((input.price ?? 0) > 5000) score -= 6;

  return Math.max(0, Math.min(100, score));
}

/** Coarse bucket for UI labelling. */
export function connectionTier(score: number): 'high' | 'medium' | 'low' {
  if (score >= 70) return 'high';
  if (score >= 50) return 'medium';
  return 'low';
}
