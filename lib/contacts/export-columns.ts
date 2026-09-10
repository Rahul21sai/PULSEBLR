import { fullDateIST, timeIST } from '../format';
import type { CsvColumn } from '../scan/csv';
import type { IContact } from '../models/Contact';

/**
 * The CSV column set for exporting people, shared by the per-folder and cross-folder exports.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A LIB MODULE AND NOT AN EXPORT FROM THE ROUTE THAT USED IT FIRST.
 *
 * It briefly was: `/api/contacts/export` imported `COLUMNS` from
 * `app/api/folders/[id]/export/route.ts`. That is legal TypeScript and it broke the app — every
 * `/api/*` path started answering 404, including `/api/auth/csrf`, which has nothing to do with
 * either file. A route file is a framework ENTRY POINT, not a module to import from; importing one
 * from another puts it into a second module graph and the router's view of what exists stops
 * matching reality. The symptom is indistinguishable from the phantom-404s CLAUDE.md §9 records
 * for building into a `.next` a dev server is using, which is exactly why it is worth writing down:
 * both present as "routes that exist return 404" and the causes are unrelated.
 *
 * WHAT A SECOND COPY OF THIS LIST WOULD BREAK, which is the reason it is shared at all: `Tags` and
 * `Known companies` are two SEPARATE columns on purpose. One is what the user typed, the other is
 * what the registry could justify — and that distinction is the whole point of the People feature.
 * A hand-rolled duplicate would eventually merge them into one cell, or lose the formula escaping
 * `lib/scan/csv.ts` applies. The escaping is not optional here: both of those fields originate in
 * free text and QR codes somebody else generated, and a cell beginning `=`, `+`, `-` or `@` is
 * executed as a formula by Excel and Sheets.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

/** Dates are formatted in IST via lib/format.ts — never the ambient locale. */
function scannedAtLabel(contact: IContact): string {
  return `${fullDateIST(contact.scannedAt)} ${timeIST(contact.scannedAt)}`;
}

export const CONTACT_CSV_COLUMNS: CsvColumn<IContact>[] = [
  { label: 'Name', value: c => c.name },
  { label: 'Headline', value: c => c.headline },
  { label: 'Role', value: c => c.role },
  { label: 'Company', value: c => c.company },
  { label: 'LinkedIn', value: c => c.linkedin },
  { label: 'Phone', value: c => c.phone },
  { label: 'Email', value: c => c.email },
  { label: 'X', value: c => c.x },
  { label: 'GitHub', value: c => c.github },
  { label: 'Website', value: c => c.website },
  { label: 'How we met', value: c => c.note },
  // The user's own labels. Kept apart from `Known companies` below — see the header.
  { label: 'Tags', value: c => c.tags?.join(', ') },
  { label: 'Follow up', value: c => (c.followUpAt ? fullDateIST(c.followUpAt) : '') },
  { label: 'Followed up', value: c => (c.followedUp ? 'yes' : 'no') },
  { label: 'Target company', value: c => (c.isTargetCompany ? 'yes' : '') },
  // Registry-resolved. What the app could justify, as distinct from what somebody typed.
  { label: 'Known companies', value: c => c.companies?.join(', ') },
  { label: 'Captured via', value: c => c.capturedVia },
  { label: 'Scanned at (IST)', value: c => scannedAtLabel(c) },
];

/* ══════════════════════════════════════════════════════════════════════════════════════════════
   PEOPLE (`Person`) — one row per HUMAN, not one per capture
   ══════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * The row the `/people` export writes, and it is a DIFFERENT SHAPE from `CONTACT_CSV_COLUMNS`.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THE CONTACT COLUMNS COULD NOT SIMPLY BE REUSED. They describe a CAPTURE: `Captured via`,
 * `Scanned at`, and one `Follow up` date, keyed to the folder it was scanned into. `/people` lists
 * PEOPLE, so the same human met three times is one row — and on that row `Scanned at` has three
 * answers, `Follow up` has three, and the count of encounters (the thing the reader actually wants)
 * has no column at all.
 *
 * So this set replaces the per-capture columns with the per-person ones the spine finally makes
 * available: `Events met at`, `Captures`, `Last contact`, `Next action`. Those first two are the
 * numbers no competitor's product records at any price, and `Last contact` did not exist in this
 * schema at all until `Interaction` did — `completeContactFollowUp()` flipped a boolean and stored
 * no timestamp, so "when did I last talk to her" was unanswerable.
 *
 * WHAT IS DELIBERATELY KEPT FROM THE CONTACT SET: `Tags` and `Known companies` stay TWO SEPARATE
 * COLUMNS. One is what the user typed, the other is what the registry could justify, and collapsing
 * them destroys the distinction the whole People feature rests on. Contact tags were once fed into
 * the company resolver and filed a hardware engineer tagged `arm` under the company Arm; a CSV that
 * merges the columns is the document version of the same mistake.
 *
 * `Events met at` COUNTS DISTINCT EVENTS — not captures and not folders. `detectRepeatConnections`
 * carries that bug's scar: it keyed on the folder, so two folders for one event counted as two.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * Flat and plain on purpose: no mongoose, no DTO import. The route assembles it, which is what lets
 * the reach fields (`email`, `phone`, …) be derived from the person's captures — `Person` stores none
 * of them, because they belong to an encounter rather than to the human.
 */
export interface PersonCsvRow {
  displayName: string;
  headline?: string | null;
  role?: string | null;
  company?: string | null;
  linkedin?: string | null;
  email?: string | null;
  phone?: string | null;
  x?: string | null;
  github?: string | null;
  website?: string | null;
  /** The user's own labels. NEVER merged with `companies` — see the header. */
  tags: string[];
  /** Registry-resolved. What the app could justify, as distinct from what somebody typed. */
  companies: string[];
  isTargetCompany: boolean;
  /** DISTINCT events. */
  eventCount: number;
  interactionCount: number;
  /** How many times they were captured — the number the contact export produced as separate ROWS. */
  captureCount: number;
  /** ISO strings: these arrive from a DTO, and `fullDateIST` takes a string as happily as a Date. */
  lastInteractionAt?: string | null;
  nextActionAt?: string | null;
  /** Where you met them, resolved to titles. Truncated by the route — see `MAX_EVENT_TITLES`. */
  events?: string[];
}

export const PERSON_CSV_COLUMNS: CsvColumn<PersonCsvRow>[] = [
  { label: 'Name', value: p => p.displayName },
  { label: 'Headline', value: p => p.headline },
  { label: 'Role', value: p => p.role },
  { label: 'Company', value: p => p.company },
  { label: 'LinkedIn', value: p => p.linkedin },
  { label: 'Phone', value: p => p.phone },
  { label: 'Email', value: p => p.email },
  { label: 'X', value: p => p.x },
  { label: 'GitHub', value: p => p.github },
  { label: 'Website', value: p => p.website },
  { label: 'Tags', value: p => p.tags?.join(', ') },
  { label: 'Known companies', value: p => p.companies?.join(', ') },
  { label: 'Target company', value: p => (p.isTargetCompany ? 'yes' : '') },
  { label: 'Events met at', value: p => p.eventCount },
  { label: 'Where you met', value: p => p.events?.join(', ') },
  { label: 'Captures', value: p => p.captureCount },
  { label: 'Timeline entries', value: p => p.interactionCount },
  // Blank rather than a placeholder when there is none: an empty cell in a date column reads as
  // "nothing recorded", which is exactly what it means.
  { label: 'Last contact (IST)', value: p => (p.lastInteractionAt ? fullDateIST(p.lastInteractionAt) : '') },
  { label: 'Next action (IST)', value: p => (p.nextActionAt ? fullDateIST(p.nextActionAt) : '') },
];
