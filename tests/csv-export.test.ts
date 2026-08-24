import { describe, it, expect } from 'vitest';
import { csvCell, toCsv, exportFilename } from '@/lib/scan/csv';

/**
 * The contacts CSV is built entirely from text somebody else supplied — a QR code they
 * generated, or a note typed in a hurry. Two of the rules here are security rather than
 * formatting, which is why they get a test rather than a comment.
 */

describe('csvCell — formula injection', () => {
  /**
   * A cell beginning `=`, `+`, `-`, `@`, tab or CR is executed as a FORMULA by Excel,
   * Sheets and LibreOffice when the file is opened. A leading apostrophe is the fix:
   * spreadsheets consume it as an explicit text marker and do not display it.
   */
  it.each([
    ['=HYPERLINK("http://evil.example","Click me")'],
    ['=cmd|\'/c calc\'!A0'],
    ['+919876543210'],
    ['-1+1'],
    ['@SUM(A1:A9)'],
    ['\tleading tab'],
    ['\rleading carriage return'],
  ])('neutralises %s', value => {
    expect(csvCell(value).replace(/^"/, '').startsWith("'")).toBe(true);
  });

  it('leaves ordinary values untouched', () => {
    expect(csvCell('Priya Sharma')).toBe('Priya Sharma');
    expect(csvCell('IBM')).toBe('IBM');
    expect(csvCell('https://www.linkedin.com/in/rahul')).toBe(
      'https://www.linkedin.com/in/rahul'
    );
  });

  it('neutralises a phone number written with a leading +', () => {
    // Not hypothetical: Excel reads `+91…` as a formula and shows an error instead of
    // the number, so this is a correctness fix as much as a safety one.
    expect(csvCell('+919876543210')).toBe("'+919876543210");
  });
});

describe('csvCell — RFC 4180 quoting', () => {
  it('quotes a value containing a comma', () => {
    // Without this every later column shifts by one.
    expect(csvCell('Met at the AI meetup, near gate 2')).toBe(
      '"Met at the AI meetup, near gate 2"'
    );
  });

  it('doubles an embedded quote and wraps the value', () => {
    expect(csvCell('He said "hello"')).toBe('"He said ""hello"""');
  });

  it.each([
    ['line one\nline two'],
    ['line one\r\nline two'],
  ])('quotes a value containing a newline', value => {
    expect(csvCell(value).startsWith('"')).toBe(true);
    expect(csvCell(value).endsWith('"')).toBe(true);
  });

  it('renders empty and nullish values as an empty field', () => {
    expect(csvCell('')).toBe('');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('renders numbers, including zero', () => {
    expect(csvCell(0)).toBe('0');
    expect(csvCell(42)).toBe('42');
  });

  it('quotes AND neutralises a value that needs both', () => {
    const out = csvCell('=1,2');
    expect(out).toBe('"\'=1,2"');
  });
});

describe('toCsv', () => {
  interface Row {
    name: string;
    company: string | null;
    note?: string;
  }

  const columns = [
    { label: 'Name', value: (r: Row) => r.name },
    { label: 'Company', value: (r: Row) => r.company },
    { label: 'Note', value: (r: Row) => r.note },
  ];

  it('writes a header, a BOM and CRLF line endings', () => {
    const csv = toCsv<Row>([{ name: 'Priya Sharma', company: 'IBM', note: 'Met at GDG' }], columns);

    // Excel on Windows assumes the system codepage without a BOM, which mangles every
    // non-ASCII name — and this is an app for Bengaluru.
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toContain('Name,Company,Note');
    expect(csv).toContain('\r\n');
    expect(csv.trimEnd().endsWith('Priya Sharma,IBM,Met at GDG')).toBe(true);
  });

  it('emits a header-only document for no rows', () => {
    const csv = toCsv<Row>([], columns);
    expect(csv).toBe('﻿Name,Company,Note\r\n');
  });

  it('keeps columns aligned when a cell contains a comma', () => {
    const csv = toCsv<Row>(
      [{ name: 'Sharma, Priya', company: null, note: 'Met, briefly' }],
      columns
    );
    const dataLine = csv.split('\r\n')[1];
    expect(dataLine).toBe('"Sharma, Priya",,"Met, briefly"');
  });

  it('neutralises a formula coming from a scanned field', () => {
    const csv = toCsv<Row>([{ name: '=cmd|\'/c calc\'!A0', company: 'IBM' }], columns);
    expect(csv).toContain("'=cmd");
  });
});

describe('exportFilename', () => {
  it.each([
    ['I/O Connect', 'i-o-connect.csv'],
    ['GDG DevFest 2026', 'gdg-devfest-2026.csv'],
    ['  Spaces   Everywhere  ', 'spaces-everywhere.csv'],
  ])('turns %s into %s', (name, expected) => {
    expect(exportFilename(name, 'csv')).toBe(expected);
  });

  it('strips characters that would break a Content-Disposition header', () => {
    // Folder names are user-supplied; a quote, newline or slash would otherwise break the
    // header or escape the intended directory.
    const out = exportFilename('../../etc/pa"ss\nwd', 'csv');
    expect(out).not.toContain('..');
    expect(out).not.toContain('/');
    expect(out).not.toContain('"');
    expect(out).not.toContain('\n');
  });

  it('falls back to a usable name when nothing survives sanitising', () => {
    expect(exportFilename('•••', 'csv')).toBe('contacts.csv');
    expect(exportFilename('', 'vcf')).toBe('contacts.vcf');
  });

  it('caps the length', () => {
    expect(exportFilename('a'.repeat(200), 'csv').length).toBeLessThanOrEqual(65);
  });
});
