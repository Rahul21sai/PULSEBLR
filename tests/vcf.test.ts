import { describe, it, expect } from 'vitest';
import { buildVCard, buildVCardFile } from '@/lib/contacts/vcf';
import { parseVCard } from '@/lib/scan/vcard';

/**
 * The vCard we GENERATE is what a stranger gets when they tap "Save to contacts" on a card page,
 * and what a folder export produces. If a name containing a comma corrupts the card, the contact
 * silently imports wrong — or not at all — and nobody finds out.
 *
 * The strongest test available is a ROUND TRIP through the parser written for the other
 * direction: anything the generator emits must be readable back with the same values.
 */

describe('buildVCard', () => {
  it('emits a well-formed 3.0 card', () => {
    const vcf = buildVCard({ name: 'Priya Sharma', company: 'IBM', role: 'Engineer' });
    expect(vcf.startsWith('BEGIN:VCARD\r\nVERSION:3.0')).toBe(true);
    expect(vcf.trimEnd().endsWith('END:VCARD')).toBe(true);
    // CRLF, per RFC 2426.
    expect(vcf).toContain('\r\n');
  });

  it('emits both N and FN, which 3.0 requires', () => {
    const vcf = buildVCard({ name: 'Priya Sharma' });
    expect(vcf).toContain('FN:Priya Sharma');
    expect(vcf).toContain('N:Sharma;Priya;;;');
  });

  it('treats a single-word name as the given name', () => {
    const vcf = buildVCard({ name: 'Priya' });
    expect(vcf).toContain('N:;Priya;;;');
  });

  it.each([
    ['Sharma, Priya', 'a comma'],
    ['Priya; Sharma', 'a semicolon'],
    ['Priya \\ Sharma', 'a backslash'],
  ])('escapes %s in a value (%s)', name => {
    const vcf = buildVCard({ name });
    // Whatever escaping was applied, the parser must read the original back.
    expect(parseVCard(vcf)?.name).toBe(name.replace(/\s+/g, ' '));
  });

  it('escapes a newline in a note rather than breaking the card', () => {
    const vcf = buildVCard({ name: 'Priya', note: 'line one\nline two' });
    // A raw newline would make "line two" look like a new property.
    expect(vcf).not.toMatch(/NOTE:line one\r?\nline two/);
    expect(vcf).toContain('\\n');
  });

  it('omits absent fields instead of writing empty ones', () => {
    const vcf = buildVCard({ name: 'Priya' });
    expect(vcf).not.toContain('ORG:');
    expect(vcf).not.toContain('TEL');
    expect(vcf).not.toContain('EMAIL');
    expect(vcf).not.toContain('URL:');
  });

  it('drops nullish URLs from the list', () => {
    const vcf = buildVCard({
      name: 'Priya',
      urls: ['https://example.com', undefined, null, '', '  '],
    });
    expect(vcf.match(/URL:/g)?.length).toBe(1);
  });

  it('folds a long line without splitting a multi-byte character', () => {
    // A 200-character name in Devanagari: naive slicing at 75 BYTES lands mid-sequence and
    // produces a corrupt card.
    const name = 'प्रिया'.repeat(30);
    const vcf = buildVCard({ name });
    for (const line of vcf.split('\r\n')) {
      expect(Buffer.from(line, 'utf8').length).toBeLessThanOrEqual(76);
    }
    // And it must still read back intact.
    expect(parseVCard(vcf)?.name).toBe(name);
  });
});

describe('round trip through the parser', () => {
  it('preserves every field', () => {
    const input = {
      name: 'Naga Sai Rahul Vudumula',
      company: 'IBM',
      role: 'Application Developer',
      email: 'rahul@example.com',
      phone: '+91 98765 43210',
      urls: ['https://www.linkedin.com/in/rahul-vudumula', 'https://x.com/rahul21sai'],
      note: 'Met at IndiaFOSS',
    };
    const parsed = parseVCard(buildVCard(input));

    expect(parsed?.name).toBe(input.name);
    expect(parsed?.company).toBe(input.company);
    expect(parsed?.role).toBe(input.role);
    expect(parsed?.email).toBe(input.email);
    expect(parsed?.phone).toBe(input.phone);
    expect(parsed?.note).toBe(input.note);
    // The generator writes plain URL lines; the parser classifies them by host.
    expect(parsed?.linkedinSlug).toBe('rahul-vudumula');
    expect(parsed?.x).toBe('rahul21sai');
  });

  it('survives an accented name', () => {
    expect(parseVCard(buildVCard({ name: 'José Álvarez' }))?.name).toBe('José Álvarez');
  });
});

describe('buildVCardFile', () => {
  it('concatenates cards into one importable file', () => {
    const file = buildVCardFile([{ name: 'A Person' }, { name: 'B Person' }, { name: 'C Person' }]);
    expect(file.match(/BEGIN:VCARD/g)?.length).toBe(3);
    expect(file.match(/END:VCARD/g)?.length).toBe(3);
    // No stray content between cards.
    expect(file).toContain('END:VCARD\r\nBEGIN:VCARD');
  });

  it('produces an empty string for no contacts', () => {
    expect(buildVCardFile([])).toBe('');
  });
});
