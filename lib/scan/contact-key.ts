/**
 * `contactKey` — cross-folder identity for a person you met.
 *
 * WHY THIS EXISTS. Person identity in this codebase is currently a free-text name, used
 * two incompatible ways:
 *
 *   - `detectRepeatConnections()` keys on `name.toLowerCase().trim()`, so two different
 *     people called Rahul at one event collapse into one, and the same person entered
 *     twice with different spellings becomes two.
 *   - `markFollowUpComplete()` matches `c.name === connectionName` — exact, case
 *     sensitive, first match wins — so the "Done" button silently no-ops forever on the
 *     second Rahul.
 *
 * A scanned LinkedIn slug is a globally unique identifier for a human being, and we now
 * capture it. That turns "have I met this person before?" from a fuzzy name comparison
 * into an index lookup.
 *
 * PRECEDENCE, strongest first. Each tier is a different kind of promise:
 *
 *   li:  LinkedIn slug — globally unique, and exactly what a LinkedIn QR gives us
 *   em:  email         — unique in practice
 *   ph:  phone         — unique, but typo-prone and shared landlines exist
 *   nm:  name          — the weak fallback, and the one that was previously the ONLY tier
 *
 * A key is prefixed with its tier so two tiers can never collide: an email that happens
 * to read like a slug cannot be mistaken for one.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * IMPORTANT, AND DIFFERENT FROM `Event.clusterKey`: this key is RECOMPUTED when a source
 * field changes, rather than being set once and frozen. An event's identity is fixed at
 * ingest; a person's sharpens as you learn more about them. You meet someone, type their
 * name (`nm:priya sharma`), and add their LinkedIn a week later — at that point the key
 * must become `li:priya-sharma-3f21` so the next scan of their QR matches. `Contact`'s
 * `pre('validate')` hook watches the source fields for exactly this reason.
 * ─────────────────────────────────────────────────────────────────────────────────
 */
import { normalizeLinkedInSlug } from './linkedin';

export interface ContactKeyInput {
  linkedinSlug?: string | null;
  email?: string | null;
  phone?: string | null;
  name?: string | null;
}

/**
 * Derive the key. Returns '' when there is nothing usable at all, so the caller can let
 * a `required` validator produce a clean message rather than storing a meaningless key.
 */
export function deriveContactKey(input: ContactKeyInput): string {
  const slug = input.linkedinSlug ? normalizeLinkedInSlug(input.linkedinSlug) : '';
  if (slug) return `li:${slug}`;

  const email = normalizeEmail(input.email);
  if (email) return `em:${email}`;

  const phone = normalizePhone(input.phone);
  if (phone) return `ph:${phone}`;

  const name = normalizeName(input.name);
  if (name) return `nm:${name}`;

  return '';
}

/** Which tier a stored key came from — useful for showing how confident a match is. */
export function contactKeyTier(key: string): 'linkedin' | 'email' | 'phone' | 'name' | 'unknown' {
  if (key.startsWith('li:')) return 'linkedin';
  if (key.startsWith('em:')) return 'email';
  if (key.startsWith('ph:')) return 'phone';
  if (key.startsWith('nm:')) return 'name';
  return 'unknown';
}

export function normalizeEmail(email?: string | null): string {
  const value = (email ?? '').trim().toLowerCase();
  // Must look like an address; a stray word in the field must not become an identity.
  return /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(value) ? value : '';
}

/**
 * Last 10 digits, which is what makes the Indian forms of one number agree:
 * `9876543210`, `+919876543210`, `09876543210` and `+91 98765 43210` all reduce to
 * `9876543210`.
 *
 * Fewer than 10 digits is refused rather than padded — a 5-digit extension is not an
 * identity, and treating it as one would merge unrelated people.
 */
export function normalizePhone(phone?: string | null): string {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (digits.length < 10) return '';
  return digits.slice(-10);
}

/**
 * Lowercased, accent-folded, punctuation-stripped, whitespace-collapsed.
 *
 * Deliberately does NOT reorder or drop name parts: "Priya Sharma" and "Sharma Priya"
 * stay distinct. Guessing at name order across cultures produces false merges, and a
 * false merge silently loses a person from your contacts.
 */
export function normalizeName(name?: string | null): string {
  const value = (name ?? '')
    .toLowerCase()
    .normalize('NFKD')
    // Combining diacritical marks, so "José" and "Jose" agree.
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return value.slice(0, 120);
}
