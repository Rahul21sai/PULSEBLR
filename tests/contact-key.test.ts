import { describe, it, expect } from 'vitest';
import {
  deriveContactKey,
  contactKeyTier,
  normalizeEmail,
  normalizePhone,
  normalizeName,
} from '@/lib/scan/contact-key';

/**
 * `contactKey` replaces the free-text name that person identity currently rests on.
 * Today `detectRepeatConnections()` keys on `name.toLowerCase().trim()`, so two people
 * called Rahul at one event are one person, and `markFollowUpComplete()` matches
 * `c.name === connectionName` so its Done button silently no-ops on the second one.
 *
 * A wrong key here is worse than no key: a false merge makes a person disappear from your
 * contacts. So the tiers are tested for both what they merge and what they keep apart.
 */

describe('deriveContactKey precedence', () => {
  const everything = {
    linkedinSlug: 'priya-sharma-3f21',
    email: 'priya@example.com',
    phone: '+91 98765 43210',
    name: 'Priya Sharma',
  };

  it('prefers the LinkedIn slug above everything', () => {
    expect(deriveContactKey(everything)).toBe('li:priya-sharma-3f21');
  });

  it('falls back to email, then phone, then name', () => {
    expect(deriveContactKey({ ...everything, linkedinSlug: undefined })).toBe(
      'em:priya@example.com'
    );
    expect(
      deriveContactKey({ ...everything, linkedinSlug: undefined, email: undefined })
    ).toBe('ph:9876543210');
    expect(
      deriveContactKey({
        ...everything,
        linkedinSlug: undefined,
        email: undefined,
        phone: undefined,
      })
    ).toBe('nm:priya sharma');
  });

  it('returns an empty string when there is nothing usable', () => {
    // The model leaves `contactKey` unset in this case so the required-field validator
    // reports something legible rather than storing a meaningless identity.
    expect(deriveContactKey({})).toBe('');
    expect(deriveContactKey({ name: '   ' })).toBe('');
    expect(deriveContactKey({ name: null, email: null, phone: null, linkedinSlug: null })).toBe('');
  });

  it('prefixes each tier so two tiers can never collide', () => {
    // An email that reads like a slug must not be mistaken for one.
    expect(deriveContactKey({ email: 'priya-sharma-3f21@example.com' })).toBe(
      'em:priya-sharma-3f21@example.com'
    );
    expect(deriveContactKey({ linkedinSlug: 'priya-sharma-3f21' })).not.toBe(
      deriveContactKey({ email: 'priya-sharma-3f21@example.com' })
    );
  });

  /**
   * The reason the key is recomputed rather than frozen: you meet someone, type their
   * name, and add their LinkedIn a week later. At that point the key MUST become `li:` so
   * the next scan of their QR matches the person you already have.
   */
  it('upgrades when a stronger identifier arrives later', () => {
    const before = deriveContactKey({ name: 'Priya Sharma' });
    const after = deriveContactKey({ name: 'Priya Sharma', linkedinSlug: 'priya-sharma-3f21' });
    expect(before).toBe('nm:priya sharma');
    expect(after).toBe('li:priya-sharma-3f21');
    expect(after).not.toBe(before);
  });

  it('is stable for the same person scanned twice', () => {
    expect(deriveContactKey({ linkedinSlug: 'Priya-Sharma-3F21' })).toBe(
      deriveContactKey({ linkedinSlug: 'priya-sharma-3f21' })
    );
  });
});

describe('contactKeyTier', () => {
  it.each([
    ['li:priya-sharma', 'linkedin'],
    ['em:a@b.com', 'email'],
    ['ph:9876543210', 'phone'],
    ['nm:priya sharma', 'name'],
    ['', 'unknown'],
    ['garbage', 'unknown'],
  ])('reads %s as %s', (key, tier) => {
    expect(contactKeyTier(key)).toBe(tier);
  });
});

describe('normalizePhone', () => {
  /**
   * Last 10 digits, which is what makes the Indian forms of one number agree. Without
   * this, the same person saved from a vCard and from a typed number becomes two people.
   */
  it.each([
    ['9876543210', '9876543210'],
    ['+919876543210', '9876543210'],
    ['09876543210', '9876543210'],
    ['+91 98765 43210', '9876543210'],
    ['+91-98765-43210', '9876543210'],
    ['(+91) 98765 43210', '9876543210'],
    ['tel:+919876543210', '9876543210'],
  ])('reduces %s to %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it.each([
    ['12345', 'a 5-digit extension is not an identity'],
    ['', 'empty'],
    ['not a phone', 'no digits'],
    ['123456789', '9 digits — one short, and padding would merge unrelated people'],
  ])('refuses %s (%s)', input => {
    expect(normalizePhone(input)).toBe('');
  });

  it('keeps two genuinely different numbers apart', () => {
    expect(normalizePhone('+919876543210')).not.toBe(normalizePhone('+919876543211'));
  });
});

describe('normalizeEmail', () => {
  it('lowercases and trims', () => {
    expect(normalizeEmail('  Priya@Example.COM ')).toBe('priya@example.com');
  });

  it.each([
    ['notanemail', 'no @'],
    ['a@b', 'no dot in the domain'],
    ['a b@c.com', 'contains a space'],
    ['', 'empty'],
  ])('refuses %s (%s)', input => {
    // A stray word left in the email field must not become somebody's identity.
    expect(normalizeEmail(input)).toBe('');
  });
});

describe('normalizeName', () => {
  it('folds accents so José and Jose agree', () => {
    expect(normalizeName('José Álvarez')).toBe(normalizeName('Jose Alvarez'));
  });

  it('strips punctuation and collapses whitespace', () => {
    expect(normalizeName('  Dr.   Priya   Sharma!  ')).toBe('dr priya sharma');
  });

  it('keeps non-Latin scripts rather than reducing them to nothing', () => {
    // \p{L} rather than [a-z]: a Devanagari-only name must still produce a key, or the
    // unique index would collapse every such person into one.
    expect(normalizeName('प्रिया शर्मा')).not.toBe('');
  });

  it('does NOT reorder name parts', () => {
    // Guessing name order across cultures produces false merges, and a false merge
    // silently loses a person.
    expect(normalizeName('Priya Sharma')).not.toBe(normalizeName('Sharma Priya'));
  });

  it('caps length so a pasted paragraph cannot become a key', () => {
    expect(normalizeName('a'.repeat(500)).length).toBeLessThanOrEqual(120);
  });
});
