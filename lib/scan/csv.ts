/**
 * CSV generation for the per-folder "sheet" export.
 *
 * Two things here are security, not formatting:
 *
 * 1. FORMULA INJECTION. Every cell in this file comes from a QR code someone else
 *    generated, or from free text. A cell beginning `=`, `+`, `-`, `@`, tab or CR is
 *    interpreted by Excel, Sheets and LibreOffice as a FORMULA — so a scanned "name" of
 *    `=HYPERLINK("http://evil","Click")` or `=cmd|'/c calc'!A0` executes on open. The
 *    fix is a leading apostrophe, which spreadsheets consume as an explicit text marker
 *    and do not display. This also happens to be why `+919876543210` needs it: Excel
 *    reads a leading `+` as a formula and shows an error instead of the number.
 *
 * 2. QUOTING. RFC 4180: wrap in double quotes when the value contains a comma, a quote
 *    or a newline, and double any embedded quote. A "how we met" note with a comma in it
 *    would otherwise shift every later column by one.
 *
 * The file is also prefixed with a UTF-8 BOM. Excel on Windows assumes the system
 * codepage without it, which mangles every non-ASCII name — and this is an app for
 * Bengaluru, so that is most of them.
 *
 * The route that serves this must send `Cache-Control: no-store`. Do NOT copy the ICS
 * route's `public, max-age=3600`: that is a shared calendar, this is one person's
 * private contact list.
 */

/** Characters that make a spreadsheet treat a cell as a formula rather than text. */
const FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'];

export interface CsvColumn<T> {
  /** Header text, written as-is. */
  label: string;
  /** Pull the cell value out of a row. Return null/undefined for an empty cell. */
  value: (row: T) => string | number | null | undefined;
}

/** Escape one value into a CSV field. Safe for untrusted input. */
export function csvCell(input: string | number | null | undefined): string {
  if (input === null || input === undefined) return '';

  let value = String(input);
  if (!value) return '';

  // Neutralise the formula, before quoting decides anything.
  if (FORMULA_PREFIXES.some(p => value.startsWith(p))) value = `'${value}`;

  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/** Build a full CSV document, BOM included, CRLF line endings per RFC 4180. */
export function toCsv<T>(rows: readonly T[], columns: readonly CsvColumn<T>[]): string {
  const lines: string[] = [columns.map(c => csvCell(c.label)).join(',')];
  for (const row of rows) {
    lines.push(columns.map(c => csvCell(c.value(row))).join(','));
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

/**
 * A filename safe for a `Content-Disposition` header and for every filesystem.
 *
 * Folder names are user-supplied, so a name containing a quote, a newline or a slash
 * would otherwise break the header or escape the intended directory.
 */
export function exportFilename(folderName: string, extension: string): string {
  const safe = folderName
    .normalize('NFKD')
    // Replaced with a separator, NOT deleted. Deleting runs words together: "I/O Connect"
    // — the archetypal folder name for this feature — became "io-connect".
    .replace(/[^\w\s-]/g, '-')
    .replace(/[\s-]+/g, '-')
    // Trimmed AFTER the slice, so a cut landing on a separator does not leave one dangling.
    .slice(0, 60)
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return `${safe || 'contacts'}.${extension}`;
}
