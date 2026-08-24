/**
 * The shape a decoded QR payload turns into.
 *
 * `kind` describes the FORMAT that was recognised, not the outcome — a vCard and a
 * LinkedIn URL both produce a person, while a Wi-Fi code and a conference ticket
 * recognisably do not. `isPerson` is the outcome, and the UI branches on it.
 *
 * Two invariants the parser must never break:
 *
 *   1. `raw` is always the literal decoded string. An unrecognised payload is stored,
 *      never dropped, so a format we learn about later can be re-parsed from the
 *      documents already in the database.
 *   2. Nothing throws. A scanner that crashes on a malformed code is worse than one
 *      that says "I don't know what that was" — you are standing in front of a person.
 */

export type ScanKind =
  | 'linkedin'
  | 'vcard'
  | 'mecard'
  | 'x'
  | 'github'
  | 'url'
  | 'email'
  | 'tel'
  | 'ticket'
  | 'not-a-person'
  | 'text'
  | 'empty';

/** Fields good enough to prefill the capture card. Every one is optional. */
export interface ParsedPerson {
  name?: string;
  /**
   * True when `name` was GUESSED from a LinkedIn slug rather than stated by the payload.
   *
   * This matters and must reach the UI. A LinkedIn QR carries no name at all: of 19
   * real payloads decoded during research, only 5 had a slug hyphenated enough to
   * recover a name from and ~4 carried no name whatsoever (`iraklizv`,
   * `ebusinesstutor`). Presenting a slug-derived name as fact would quietly fill the
   * database with wrong names.
   */
  nameIsGuess?: boolean;
  headline?: string;
  role?: string;
  company?: string;
  linkedin?: string;
  linkedinSlug?: string;
  x?: string;
  github?: string;
  website?: string;
  email?: string;
  phone?: string;
  note?: string;
}

export interface ParsedScan {
  kind: ScanKind;
  /** Can this become a Contact? False for tickets, Wi-Fi codes, UPI codes and junk. */
  isPerson: boolean;
  person: ParsedPerson;
  /** Where a "Connect" button should go. Always an https URL, never a custom scheme. */
  actionUrl?: string;
  actionLabel?: string;
  /**
   * `high` only when the payload handed us a DURABLE IDENTITY KEY — a LinkedIn slug, an
   * email or a phone number, the three things `deriveContactKey` can key on. A name
   * alone is not one, because names collide and get retyped.
   */
  confidence: 'high' | 'low';
  /**
   * A sentence shown to the user verbatim: why this is not a person, or what is still
   * missing. Write it as prose, not a code.
   */
  reason?: string;
  /** The literal decoded string. ALWAYS set. */
  raw: string;
}

/** How a Contact came to exist. Mirrors `Contact.capturedVia`. */
export type CapturedVia =
  | 'qr-linkedin'
  | 'qr-vcard'
  | 'qr-mecard'
  | 'qr-url'
  | 'manual'
  | 'card-page';

/** The `capturedVia` value a given payload kind should be stored as. */
export function capturedViaFor(kind: ScanKind): CapturedVia {
  switch (kind) {
    case 'linkedin':
      return 'qr-linkedin';
    case 'vcard':
      return 'qr-vcard';
    case 'mecard':
      return 'qr-mecard';
    default:
      return 'qr-url';
  }
}
