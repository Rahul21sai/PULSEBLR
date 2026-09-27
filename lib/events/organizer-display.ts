/**
 * HOW A HOST NAME IS SHOWN — display only. The stored `organizer` is never rewritten: the company
 * resolver matches against it (`lib/companies/resolve.ts`, where `strength` decides what may match
 * the organiser field), and a cosmetic change must not move an attribution.
 *
 * WHAT IT FIXES, MEASURED 2026-09-27 over the default feed: 34 of 102 distinct organisers were
 * all-lowercase, and EVERY one came from `meetup`. They are group URL slugs with the hyphens turned
 * into spaces — "iasa india software architecture meetup", "ai blr", "lfdt bengaluru" — because the
 * per-group ICS feed carries no display name. One more was a Meetup calendar title,
 * "Events - BangPypers - Bangalore Python Users Group".
 *
 * TWO RULES, both conservative:
 *   1. A leading "Events -" wrapper is removed and the FIRST remaining segment kept — the group's
 *      own name; the tail is a description the row has no room for.
 *   2. ONLY an all-lowercase name is re-cased. Anything with a capital letter was written by a
 *      person ("BagOfAI Meetups", "flutterCon India 2026", "gRPConf India") and is left exactly as
 *      written; re-casing it would be wrong more often than right.
 *
 * Joined slugs ("indiamongodb", "bengaluruwordpress") cannot be split without guessing, so they are
 * only capitalised. A known-acronym list is applied word by word; a word not on it gets an initial
 * capital, which is right for ordinary words and merely unremarkable for an unknown acronym.
 */

const ACRONYMS = new Map<string, string>(
  [
    'AI', 'ML', 'BLR', 'IASA', 'CMMI', 'LFDT', 'KSUG', 'FME', 'AWS', 'GCP', 'GDG', 'API', 'UI', 'UX',
    'IOT', 'SRE', 'QA', 'HR', 'IPO', 'CNCF', 'JUG', 'SBG', 'PDY', 'IIT', 'IISC', 'IIIT', 'NLP', 'LLM',
    'SQL', 'VLSI', 'FPGA', 'AR', 'VR', 'XR', 'IBM', 'SAP', 'HTMD', 'PM', 'CTO', 'B2B', 'SAAS', 'OWASP',
  ].map(a => [a.toLowerCase(), a === 'IOT' ? 'IoT' : a === 'SAAS' ? 'SaaS' : a === 'IISC' ? 'IISc' : a])
);

const PROPER = new Map<string, string>([
  ['devops', 'DevOps'],
  ['dataops', 'DataOps'],
  ['mlops', 'MLOps'],
  ['mongodb', 'MongoDB'],
  ['wordpress', 'WordPress'],
  ['javascript', 'JavaScript'],
  ['typescript', 'TypeScript'],
  ['github', 'GitHub'],
  ['postgresql', 'PostgreSQL'],
]);

const SMALL = new Set(['and', 'or', 'of', 'in', 'on', 'at', 'for', 'the', 'to', 'a', 'an', 'by', 'with']);

function caseWord(word: string, first: boolean): string {
  if (!word) return word;
  const acronym = ACRONYMS.get(word);
  if (acronym) return acronym;
  const proper = PROPER.get(word);
  if (proper) return proper;
  if (!first && SMALL.has(word)) return word;
  return word[0].toUpperCase() + word.slice(1);
}

export function displayOrganizer(raw: string | null | undefined): string {
  let name = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (!name) return '';

  const wrapped = name.match(/^events?\s*[-–—]\s*(.+)$/i);
  if (wrapped) name = wrapped[1].split(/\s[-–—]\s/)[0].trim() || name;

  if (name !== name.toLowerCase() || !/[a-z]/.test(name)) return name;
  return name
    .split(' ')
    .map((word, i) => caseWord(word, i === 0))
    .join(' ');
}
