#!/usr/bin/env tsx
/**
 * Integrity check for the seed lists and the company registry.
 *
 * Cheap invariants that are easy to break by hand-editing three files: duplicate
 * company names would double-count in every /api/companies aggregation, a duplicate
 * seed handle wastes a request every run, and an over-confident `strength` on a short
 * name is the one documented way to do real damage to attribution.
 *
 * Read-only. No DB, no network.
 *
 * Run: npx tsx scripts/diag-seed-integrity.ts
 */
import { COMPANIES, COMPANY_SECTORS } from '../lib/companies/registry';
import { LUMA_SEED_CALENDARS } from '../lib/scrapers/adapters/luma';
import { SEED_MEETUP_GROUPS, MEETUP_KEYWORDS } from '../lib/scrapers/adapters/meetup';

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
}

function dupes<T>(items: T[], key: (t: T) => string): string[] {
  const seen = new Set<string>();
  const out = new Set<string>();
  for (const i of items) {
    const k = key(i);
    if (seen.has(k)) out.add(k);
    seen.add(k);
  }
  return [...out];
}

console.log('Registry');
console.log(`  ${COMPANIES.length} companies across ${COMPANY_SECTORS.length} sectors`);

const nameDupes = dupes(COMPANIES, c => c.name.toLowerCase());
check('no duplicate company names', nameDupes.length === 0, nameDupes.join(', '));

const badSector = COMPANIES.filter(c => !COMPANY_SECTORS.includes(c.sector));
check('every company sector is in COMPANY_SECTORS', badSector.length === 0,
  badSector.map(c => `${c.name}:${c.sector}`).join(', '));

// Aliases collide across companies -> an event gets attributed to the wrong one.
const aliasOwners = new Map<string, string[]>();
for (const c of COMPANIES) {
  for (const a of [c.name, ...(c.aliases || [])]) {
    const k = a.toLowerCase();
    aliasOwners.set(k, [...(aliasOwners.get(k) || []), c.name]);
  }
}
const collisions = [...aliasOwners.entries()].filter(([, owners]) => owners.length > 1);
check('no name/alias collisions between companies', collisions.length === 0,
  collisions.map(([k, o]) => `"${k}" -> ${o.join(' & ')}`).join('; '));

/**
 * The documented failure mode is not "short name" but "name that is also a common
 * word or a fragment of one": Intel matched *intel*ligence 37 times, CRED matched
 * *cred*entials 31, SAP 157. Pure acronyms of the same length (IBM, TCS, CNCF) never
 * showed that problem, so testing length alone flags the wrong entries.
 *
 * So the check is: does the name appear INSIDE a longer common English word? If it
 * does and it is still marked 'distinctive', description matching will misfire.
 */
const COMMON_WORDS = [
  'intelligence', 'credentials', 'incredible', 'metadata', 'metaverse', 'target',
  'apple', 'application', 'docker', 'redistribute', 'alarm', 'armed', 'harm', 'charm',
  'warmup', 'sapling', 'basic', 'campus', 'startup', 'partner', 'platform', 'normal',
  'informal', 'performance', 'transform', 'garment', 'farming',
];
const risky = COMPANIES.filter(c => {
  if (c.strength !== 'distinctive') return false;
  const n = c.name.toLowerCase();
  if (n.length > 6) return false; // long names are effectively unique
  return COMMON_WORDS.some(w => w !== n && w.includes(n));
});
check('no "distinctive" name hides inside a common English word', risky.length === 0,
  risky.map(c => `${c.name} (in a common word)`).join(', '));

const hardware = COMPANIES.filter(c => c.sector === 'Hardware & Semiconductor');
console.log(`  hardware & semiconductor: ${hardware.length} — ${hardware.map(c => c.name).join(', ')}`);

console.log('\nSeed lists');
console.log(`  ${LUMA_SEED_CALENDARS.length} Luma calendars, ${SEED_MEETUP_GROUPS.length} Meetup groups, ${MEETUP_KEYWORDS.length} keywords`);

const lumaDupes = dupes(LUMA_SEED_CALENDARS, c => c.handle);
check('no duplicate Luma calendar handles', lumaDupes.length === 0, lumaDupes.join(', '));

const badHandles = LUMA_SEED_CALENDARS.filter(c => !/^cal-[A-Za-z0-9]{8,}$/.test(c.handle));
check('every Luma handle looks like a calendar api_id', badHandles.length === 0,
  badHandles.map(c => c.handle).join(', '));

const meetupDupes = dupes(SEED_MEETUP_GROUPS, g => g.toLowerCase());
check('no duplicate Meetup slugs', meetupDupes.length === 0, meetupDupes.join(', '));

const badSlugs = SEED_MEETUP_GROUPS.filter(g => !/^[a-z0-9][a-z0-9-]{2,60}$/i.test(g));
check('every Meetup slug is URL-shaped', badSlugs.length === 0, badSlugs.join(', '));

const kwDupes = dupes(MEETUP_KEYWORDS, k => k.toLowerCase());
check('no duplicate Meetup keywords', kwDupes.length === 0, kwDupes.join(', '));

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
