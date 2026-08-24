/**
 * The QR payload cascade: one decoded string in, a `ParsedScan` out.
 *
 * Shaped like `lib/scrapers/adapters/universal.ts` on purpose — most structured format
 * first, fall through to progressively looser ones, never throw, and always keep the
 * raw input so a payload we do not understand today can be re-parsed tomorrow from the
 * documents already stored.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * WHY "RECOGNISED, BUT NOT A PERSON" IS A FIRST-CLASS RESULT
 *
 * Conference badge and ticket QRs carry NO contact data. Verified per platform during
 * research:
 *
 *   HasGeek   exactly 16 chars — two random 8-char URL-safe base64 tokens (puk + key)
 *   Meetup    opaque per-RSVP token, organiser app only, valid 1 h before → 24 h after
 *   KonfHub   an id their server resolves; they sell that lookup to sponsors
 *   Luma      an opaque `check_in_qr_code` string
 *   Bevy      undocumented, resolved by their Organizer App
 *   FOSS Utd  a URL carrying a ticket id
 *
 * None of them let a third party recover who the attendee is. So scanning a badge and
 * saving a contact is not a thing that can work, on any platform — and the worst
 * possible behaviour is to save a person named `aB3xK9pQmZ2vL7wR`. The same applies to
 * the UPI payment codes that are everywhere in India, and to Wi-Fi codes.
 *
 * Hence `isPerson: false` plus a `reason` written as a sentence the UI shows verbatim.
 * ─────────────────────────────────────────────────────────────────────────────────
 *
 * `confidence` means one specific thing: did the payload hand us a DURABLE IDENTITY
 * KEY — a LinkedIn slug, an email, or a phone number, the three things `contactKey`
 * can key on? A name alone is not one, because names collide and get retyped.
 */
import type { ParsedScan, ParsedPerson } from './types';
import { parseLinkedInUrl, guessNameFromSlug } from './linkedin';
import { looksLikeVCard, parseVCard } from './vcard';
import { looksLikeMeCard, parseMeCard, meCardUrls } from './mecard';
import { classifyUrlInto, hostOf, handleFromUrl, isBioLinkHost } from './urls';

/**
 * Hosts that ticket Indian tech events. A URL here is only called a ticket when it also
 * carries an explicit ticket parameter — their plain event pages are ordinary links and
 * misclassifying those would be worse than not detecting a ticket at all.
 */
const TICKETING_HOSTS = new Set([
  'fossunited.org',
  'fossunited.com',
  'fossunited.in',
  'konfhub.com',
  'townscript.com',
  'hasgeek.com',
  'explara.com',
]);

const TICKET_PARAMS = ['ticket_id', 'ticket', 'attendee', 'order', 'registration'];

/** Payload prefixes that are unambiguously not a person, with what to tell the user. */
const NOT_A_PERSON: Array<[RegExp, string]> = [
  [/^WIFI:/i, "That's a Wi-Fi network code, not a contact."],
  [/^upi:\/\//i, "That's a UPI payment code, not a contact."],
  [/^(?:BEGIN:VEVENT|BEGIN:VCALENDAR)/i, "That's a calendar invite, not a contact."],
  [/^geo:/i, "That's a location pin, not a contact."],
  [/^bitcoin:/i, "That's a payment address, not a contact."],
];

export function parseScanPayload(raw: string): ParsedScan {
  const input = typeof raw === 'string' ? raw : '';
  const trimmed = input.trim();

  if (!trimmed) {
    return base('empty', input, { isPerson: false, reason: 'Nothing was decoded.' });
  }

  /* ── Structured contact formats first: they are the richest ─────────────── */
  if (looksLikeVCard(trimmed)) {
    const person = parseVCard(trimmed);
    if (person) return personResult('vcard', input, person);
    return base('vcard', input, {
      isPerson: false,
      reason: 'That contact card had no readable details.',
    });
  }

  if (looksLikeMeCard(trimmed)) {
    const person = parseMeCard(trimmed);
    if (person) {
      // MECARD keeps URLs in a repeatable field; classify each so a LinkedIn link in a
      // MECARD lands in `linkedin` rather than `website`.
      for (const url of meCardUrls(trimmed)) classifyUrlInto(url, person);
      return personResult('mecard', input, person);
    }
    return base('mecard', input, {
      isPerson: false,
      reason: 'That contact card had no readable details.',
    });
  }

  /* ── Recognised, and definitely not a person ────────────────────────────── */
  for (const [pattern, reason] of NOT_A_PERSON) {
    if (pattern.test(trimmed)) return base('not-a-person', input, { isPerson: false, reason });
  }

  /* ── Single-field contact schemes ───────────────────────────────────────── */
  const email = extractEmail(trimmed);
  if (email) return personResult('email', input, { email });

  const phone = extractPhone(trimmed);
  if (phone) return personResult('tel', input, { phone });

  /* ── Tickets ────────────────────────────────────────────────────────────── */
  if (looksLikeHasGeekTicket(trimmed)) {
    return base('ticket', input, {
      isPerson: false,
      reason:
        "That's an event ticket, not a contact — badge codes are opaque ids that only " +
        'the organiser can resolve. Ask for their LinkedIn QR instead.',
    });
  }

  /* ── URLs ───────────────────────────────────────────────────────────────── */
  const host = hostOf(trimmed);
  if (host) {
    const li = parseLinkedInUrl(trimmed);
    if (li) {
      const person: ParsedPerson = { linkedin: li.url, linkedinSlug: li.slug };
      if (li.slug) {
        const guess = guessNameFromSlug(li.slug);
        if (guess) {
          person.name = guess;
          person.nameIsGuess = true;
        }
        return personResult('linkedin', input, person);
      }
      // A LinkedIn URL that is not /in/<slug>: a company page, a post, a shortlink.
      return personResult('linkedin', input, person, {
        reason: "That's a LinkedIn link but not a personal profile — add their name.",
      });
    }

    if (host === 'x.com' || host === 'twitter.com') {
      return personResult('x', input, { x: handleFromUrl(trimmed) });
    }
    if (host === 'github.com') {
      return personResult('github', input, { github: handleFromUrl(trimmed) });
    }

    if (isTicketUrl(trimmed, host)) {
      return base('ticket', input, {
        isPerson: false,
        reason:
          "That's an event ticket, not a contact. Ask for their LinkedIn QR instead.",
      });
    }

    const person: ParsedPerson = {};
    classifyUrlInto(trimmed, person);
    return personResult('url', input, person, {
      reason: isBioLinkHost(trimmed)
        ? "That's a link-in-bio page — add their name, and their LinkedIn if it's listed."
        : 'No profile was recognised in that link — add their name.',
    });
  }

  /* ── Plain text ─────────────────────────────────────────────────────────── */
  return base('text', input, {
    isPerson: true,
    person: { note: trimmed.slice(0, 500) },
    reason: "That wasn't a profile code. It's saved as a note — add their name.",
  });
}

/* ────────────────────────────── helpers ────────────────────────────── */

function base(
  kind: ParsedScan['kind'],
  raw: string,
  over: Partial<ParsedScan> = {}
): ParsedScan {
  return {
    kind,
    isPerson: false,
    person: {},
    confidence: 'low',
    raw,
    ...over,
  };
}

/**
 * Build a person result, deriving `confidence` from whether we got a durable identity
 * key and `actionUrl` from the best profile link available.
 */
function personResult(
  kind: ParsedScan['kind'],
  raw: string,
  person: ParsedPerson,
  over: Partial<ParsedScan> = {}
): ParsedScan {
  const hasIdentity = Boolean(person.linkedinSlug || person.email || person.phone);

  let actionUrl: string | undefined;
  let actionLabel: string | undefined;
  if (person.linkedin) {
    actionUrl = person.linkedin;
    actionLabel = 'Connect on LinkedIn';
  } else if (person.x) {
    actionUrl = `https://x.com/${person.x}`;
    actionLabel = 'Open on X';
  } else if (person.github) {
    actionUrl = `https://github.com/${person.github}`;
    actionLabel = 'Open on GitHub';
  } else if (person.website) {
    actionUrl = person.website;
    actionLabel = 'Open link';
  }

  return {
    kind,
    isPerson: true,
    person,
    actionUrl,
    actionLabel,
    confidence: hasIdentity ? 'high' : 'low',
    raw,
    ...over,
  };
}

/** `mailto:`, the legacy `MATMSG:` form, or a bare address. */
function extractEmail(value: string): string | undefined {
  const mailto = /^mailto:([^?\s]+)/i.exec(value);
  if (mailto) return safeDecode(mailto[1]);

  const matmsg = /^MATMSG:TO:([^;]+);/i.exec(value);
  if (matmsg) return matmsg[1].trim();

  if (/^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(value)) return value;
  return undefined;
}

/** `tel:`, `sms:` or `SMSTO:`. */
function extractPhone(value: string): string | undefined {
  const tel = /^tel:([+\d][\d\s\-.()]*)/i.exec(value);
  if (tel) return tel[1].trim();

  const sms = /^(?:sms|smsto):(\+?[\d\s\-.()]+)/i.exec(value);
  if (sms) return sms[1].trim();

  return undefined;
}

/**
 * HasGeek's badge payload: exactly 16 characters with no delimiters, being an 8-char
 * `puk` concatenated with an 8-char `key`, both URL-safe base64.
 *
 * The extra "looks random" test matters — a plain 16-letter English word would otherwise
 * be called a ticket. Requiring a digit or mixed case is what separates `aB3xK9pQmZ2vL7wR`
 * from `understanding` (13) or `characteristics` (15).
 */
function looksLikeHasGeekTicket(value: string): boolean {
  if (!/^[A-Za-z0-9_-]{16}$/.test(value)) return false;
  const hasDigit = /\d/.test(value);
  const mixedCase = /[a-z]/.test(value) && /[A-Z]/.test(value);
  return hasDigit || mixedCase;
}

function isTicketUrl(value: string, host: string): boolean {
  if (!TICKETING_HOSTS.has(host)) return false;
  try {
    const params = new URL(value).searchParams;
    return TICKET_PARAMS.some(p => params.has(p));
  } catch {
    return false;
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value.trim());
  } catch {
    return value.trim();
  }
}
