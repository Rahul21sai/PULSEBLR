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
