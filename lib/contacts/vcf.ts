/**
 * vCard 3.0 GENERATION — the other direction from `lib/scan/vcard.ts`.
 *
 * Used for two things:
 *   1. Exporting a folder as a `.vcf` you can import into a phone's address book.
 *   2. The "Save contact" button on a public card page, so somebody WITHOUT this app can
 *      still keep your details after scanning your code.
 *
 * Version 3.0 rather than 4.0 deliberately: 3.0 is what Android and iOS both import
 * without complaint, while 4.0 support in address-book apps is still uneven. `N` and `FN`
 * are both emitted because 3.0 requires both.
 *
 * Escaping is not optional here. A name containing a comma, or a note containing a
 * newline, corrupts the whole card if written raw — the parser reads the rest of the value
 * as a new property.
 */

export interface VCardInput {
  name: string;
  role?: string;
  company?: string;
  email?: string;
  phone?: string;
  /** Profile and site links; each becomes a `URL` line. */
  urls?: Array<string | undefined | null>;
  note?: string;
}

/** Escape a text value per RFC 2426: backslash, semicolon, comma and newline. */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Fold a content line to 75 octets, continuing with CRLF + a single space.
 *
 * Measured in UTF-8 BYTES, not characters, and never splitting a multi-byte sequence —
 * cutting one in half produces a corrupt card, which is the failure mode a naive
 * `slice(0, 75)` gives you for any name outside ASCII.
 */
function foldLine(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;

  const parts: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    // First chunk gets 75 octets; continuations get 74, since the leading space counts.
    let end = Math.min(bytes.length, start + (parts.length === 0 ? 75 : 74));
    // Back off until `end` is not inside a UTF-8 continuation byte (0b10xxxxxx).
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    parts.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
  }
  return parts.join('\r\n ');
}

/** One vCard. Ends with CRLF, so cards concatenate into a valid multi-card file. */
export function buildVCard(input: VCardInput): string {
  const lines: string[] = ['BEGIN:VCARD', 'VERSION:3.0'];

  const name = input.name?.trim() || 'Unknown';
  lines.push(`FN:${escapeText(name)}`);

  // N is family;given;additional;prefixes;suffixes. We only ever know a display name, so
  // the last whitespace-separated token is treated as the family name — a convention, not
  // a fact, which is why FN (the display form) carries the authoritative value.
  const parts = name.split(/\s+/);
  const family = parts.length > 1 ? parts[parts.length - 1] : '';
  const given = parts.length > 1 ? parts.slice(0, -1).join(' ') : name;
  lines.push(`N:${escapeText(family)};${escapeText(given)};;;`);

  if (input.company) lines.push(`ORG:${escapeText(input.company)}`);
  if (input.role) lines.push(`TITLE:${escapeText(input.role)}`);
  if (input.phone) lines.push(`TEL;TYPE=CELL,VOICE:${escapeText(input.phone)}`);
  if (input.email) lines.push(`EMAIL;TYPE=INTERNET:${escapeText(input.email)}`);

  for (const url of input.urls ?? []) {
    const trimmed = url?.trim();
    if (trimmed) lines.push(`URL:${escapeText(trimmed)}`);
  }

  if (input.note) lines.push(`NOTE:${escapeText(input.note)}`);

  lines.push('END:VCARD');
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}

/** Many vCards in one importable file. */
export function buildVCardFile(inputs: readonly VCardInput[]): string {
  return inputs.map(buildVCard).join('');
}
