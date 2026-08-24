import { describe, it, expect } from 'vitest';
import { parseScanPayload } from '@/lib/scan/parse-payload';
import {
  parseLinkedInUrl,
  guessNameFromSlug,
  coerceLinkedInInput,
} from '@/lib/scan/linkedin';

/**
 * The scanner stands between you and a person you are talking to. Two failure modes
 * matter more than accuracy:
 *
 *   - Throwing. A crash mid-conversation loses the contact and there is no second chance.
 *   - Confidently wrong. Saving a person named `aB3xK9pQmZ2vL7wR` from a badge code, or
 *     presenting a slug-derived name as fact, quietly fills the database with rubbish
 *     that is worse than an empty field because nobody goes back to check it.
 *
 * So these assert the invariants first (never throws, `raw` always survives) and then the
 * per-format details, using payloads shaped like the ones research actually decoded.
 */

/* ────────────────────────── LinkedIn: the primary path ────────────────────── */

describe('LinkedIn QR payloads', () => {
  /**
   * The measured payload shape. 19 published "My code" screenshots were decoded during
   * research, spanning Jun 2018 → Mar 2026, iOS and Android, six locales — every one was
   * `https://www.linkedin.com/in/<slug>?fromQR=1` with no structural variation. These
   * slugs are taken from those samples.
   */
  it.each([
    ['https://www.linkedin.com/in/alina-kalinina-27o6?fromQR=1', 'alina-kalinina-27o6'],
    ['https://www.linkedin.com/in/hanna-lebedeva-0852331a6?fromQR=1', 'hanna-lebedeva-0852331a6'],
    ['https://www.linkedin.com/in/cristian-bustos-6396786b?fromQR=1', 'cristian-bustos-6396786b'],
    ['https://www.linkedin.com/in/ebusinesstutor?fromQR=1', 'ebusinesstutor'],
    ['https://www.linkedin.com/in/paulalosullivan?fromQR=1', 'paulalosullivan'],
  ])('extracts the slug from %s', (payload, slug) => {
    const result = parseScanPayload(payload);
    expect(result.kind).toBe('linkedin');
    expect(result.isPerson).toBe(true);
    expect(result.person.linkedinSlug).toBe(slug);
    // A slug is a durable identity, so this is the one case that earns high confidence.
    expect(result.confidence).toBe('high');
  });

  it('canonicalises the URL and discards every query param', () => {
    const result = parseScanPayload('https://www.linkedin.com/in/Rahul-Vudumula/?fromQR=1');
    expect(result.person.linkedin).toBe('https://www.linkedin.com/in/rahul-vudumula');
    expect(result.person.linkedinSlug).toBe('rahul-vudumula');
    // `?fromQR=1` is LinkedIn's own provenance flag and carries nothing we want. One
    // canonical form is what makes the slug dependable as a key.
    expect(result.person.linkedin).not.toContain('fromQR');
  });

  it('tolerates the stray time/uuid params research saw on related links', () => {
    const result = parseScanPayload(
      'https://www.linkedin.com/in/rahul?fromQR=1&time=1756000000000&uuid=abc-def'
    );
    expect(result.person.linkedin).toBe('https://www.linkedin.com/in/rahul');
  });

  it.each([
    ['https://in.linkedin.com/in/rahul', 'regional subdomain'],
    ['https://m.linkedin.com/in/rahul', 'mobile subdomain'],
    ['https://linkedin.com/in/rahul', 'bare domain'],
    ['https://www.linkedin.com/mwlite/in/rahul', 'mwlite surface'],
    ['https://www.linkedin.com/comm/in/rahul', 'comm surface'],
    ['http://www.linkedin.com/in/rahul', 'plain http'],
  ])('recognises %s (%s)', payload => {
    const result = parseScanPayload(payload);
    expect(result.kind).toBe('linkedin');
    expect(result.person.linkedinSlug).toBe('rahul');
  });

  /**
   * The hostname is checked with `URL`, not a regex, specifically so this cannot pass.
   * A loosely-anchored pattern treats it as LinkedIn and hands an attacker a trusted
   * "Connect on LinkedIn" button pointing at their own domain.
   */
  it('refuses a lookalike host', () => {
    expect(parseLinkedInUrl('https://linkedin.com.evil.example/in/rahul')).toBeNull();
    const result = parseScanPayload('https://linkedin.com.evil.example/in/rahul');
    expect(result.kind).not.toBe('linkedin');
  });

  it('keeps a non-profile LinkedIn URL but claims no identity', () => {
    const result = parseScanPayload('https://www.linkedin.com/company/ibm');
    expect(result.kind).toBe('linkedin');
    expect(result.person.linkedinSlug).toBeUndefined();
    expect(result.confidence).toBe('low');
    // The UI has to say something, because there is a link but no person.
    expect(result.reason).toBeTruthy();
  });

  it('points the action at an https URL, never a linkedin:// scheme', () => {
    // iOS universal links (AASA lists /in/*) and Android App Links both open the native
    // app for an https URL. The linkedin:// forms are all from 2013-2015 and unverifiable.
    const result = parseScanPayload('https://www.linkedin.com/in/rahul?fromQR=1');
    expect(result.actionUrl).toBe('https://www.linkedin.com/in/rahul');
    expect(result.actionUrl).toMatch(/^https:\/\//);
  });
});

describe('guessNameFromSlug', () => {
  /**
   * A LinkedIn QR carries NO name. Of the 19 real slugs decoded, only ~5 were hyphenated
   * enough to recover a name from and ~4 contained no name at all. So this must decline
   * far more often than it fires, and whatever it returns must be marked as a guess.
   */
  it.each([
    ['alina-kalinina-27o6', 'Alina Kalinina'],
    ['hanna-lebedeva-0852331a6', 'Hanna Lebedeva'],
    ['cristian-bustos-6396786b', 'Cristian Bustos'],
    ['hilarey-wojtowicz', 'Hilarey Wojtowicz'],
    ['rob-osborne', 'Rob Osborne'],
  ])('guesses %s → %s', (slug, expected) => {
    expect(guessNameFromSlug(slug)).toBe(expected);
  });

  it.each([
    ['ebusinesstutor', 'no hyphen, and not a name'],
    ['paulalosullivan', 'concatenated vanity — cannot be split reliably'],
    ['iraklizv', 'no hyphen'],
    ['sai-21', 'one token survives digit-stripping, so it is as likely a handle'],
    ['a-b-c-d-e-f', 'too many tokens to be a name'],
  ])('declines to guess from %s (%s)', slug => {
    expect(guessNameFromSlug(slug)).toBeUndefined();
  });

  it('marks a guessed name as a guess on the parsed result', () => {
    const guessed = parseScanPayload('https://www.linkedin.com/in/rob-osborne?fromQR=1');
    expect(guessed.person.name).toBe('Rob Osborne');
    expect(guessed.person.nameIsGuess).toBe(true);

    const notGuessed = parseScanPayload('https://www.linkedin.com/in/ebusinesstutor?fromQR=1');
    expect(notGuessed.person.name).toBeUndefined();
  });
});

describe('coerceLinkedInInput (manual entry)', () => {
  it.each([
    ['https://www.linkedin.com/in/rahul', 'rahul'],
    ['linkedin.com/in/rahul', 'rahul'], // scheme dropped when copied from an address bar
    ['www.linkedin.com/in/rahul-vudumula', 'rahul-vudumula'],
    ['rahul-vudumula', 'rahul-vudumula'],
    ['@rahul', 'rahul'],
    ['in/rahul', 'rahul'],
    ['/in/rahul/', 'rahul'],
    ['RAHUL-Vudumula', 'rahul-vudumula'], // slugs are compared lowercased
  ])('accepts %s → %s', (input, slug) => {
    const ref = coerceLinkedInInput(input);
    expect(ref).not.toBeNull();
    expect(ref!.slug).toBe(slug);
    expect(ref!.url).toBe(`https://www.linkedin.com/in/${slug}`);
  });

  it.each([
    ['', 'empty'],
    ['   ', 'whitespace'],
    ['not a slug at all', 'spaces are not valid in a slug'],
  ])('returns null for %s (%s)', input => {
    expect(coerceLinkedInInput(input)).toBeNull();
  });
});

/* ────────────────────────────── vCard ────────────────────────────── */

describe('vCard payloads', () => {
  it('reads a plain 3.0 card', () => {
    const result = parseScanPayload(
      [
        'BEGIN:VCARD',
        'VERSION:3.0',
        'N:Vudumula;Naga Sai Rahul;;Mr.;',
        'FN:Naga Sai Rahul Vudumula',
        'ORG:IBM;Squad_Sitewide',
        'TITLE:Application Developer',
        'TEL;TYPE=CELL,VOICE:+91 98765 43210',
        'EMAIL;TYPE=INTERNET,WORK:rahul@example.com',
        'URL:https://www.linkedin.com/in/rahul-vudumula',
        'END:VCARD',
      ].join('\r\n')
    );

    expect(result.kind).toBe('vcard');
    expect(result.isPerson).toBe(true);
    expect(result.person.name).toBe('Naga Sai Rahul Vudumula');
    // ORG is semicolon-separated; only component 0 is the company.
    expect(result.person.company).toBe('IBM');
    expect(result.person.role).toBe('Application Developer');
    expect(result.person.phone).toBe('+91 98765 43210');
    expect(result.person.email).toBe('rahul@example.com');
    expect(result.person.linkedinSlug).toBe('rahul-vudumula');
    expect(result.confidence).toBe('high');
  });

  it('builds a name from N when FN is absent (vCard 2.1)', () => {
    const result = parseScanPayload(
      ['BEGIN:VCARD', 'VERSION:2.1', 'N:Sharma;Priya;;;', 'END:VCARD'].join('\n')
    );
    // Prefixes and suffixes are dropped — "Mr."/"Esq." are noise in a contact list.
    expect(result.person.name).toBe('Priya Sharma');
  });

  /** Trap 1: a line beginning with whitespace continues the previous one. */
  it('unfolds a folded line', () => {
    const result = parseScanPayload(
      ['BEGIN:VCARD', 'VERSION:3.0', 'FN:Naga Sai Rahul Vudum', ' ula', 'END:VCARD'].join(
        '\r\n'
      )
    );
    expect(result.person.name).toBe('Naga Sai Rahul Vudumula');
  });

  it('unfolds with bare \\n line endings and multiple leading spaces (2.1 permits both)', () => {
    const result = parseScanPayload(
      ['BEGIN:VCARD', 'VERSION:2.1', 'FN:Priya Shar', '   ma', 'END:VCARD'].join('\n')
    );
    expect(result.person.name).toBe('Priya Sharma');
  });

  /**
   * Trap 2, the one that silently truncates: in QUOTED-PRINTABLE a trailing `=` is a
   * SOFT LINE BREAK. Unfolding on whitespace alone drops everything after the first wrap.
   */
  it('joins a QUOTED-PRINTABLE soft line break and decodes the escapes', () => {
    const result = parseScanPayload(
      [
        'BEGIN:VCARD',
        'VERSION:2.1',
        'FN:Priya Sharma',
        'NOTE;ENCODING=QUOTED-PRINTABLE:Met at the AI=20meetup=',
        '=20in Koramangala',
        'END:VCARD',
      ].join('\r\n')
    );
    expect(result.person.note).toBe('Met at the AI meetup in Koramangala');
  });

  /** Trap 6: decode QP bytes with the declared charset. */
  it('decodes UTF-8 bytes from a QUOTED-PRINTABLE value', () => {
    const result = parseScanPayload(
      [
        'BEGIN:VCARD',
        'VERSION:2.1',
        'FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Jos=C3=A9 =C3=81lvarez',
        'END:VCARD',
      ].join('\r\n')
    );
    expect(result.person.name).toBe('José Álvarez');
  });

  it('falls back to UTF-8 when the charset is unknown rather than throwing', () => {
    const result = parseScanPayload(
      [
        'BEGIN:VCARD',
        'VERSION:2.1',
        'FN;CHARSET=NOT-A-REAL-CHARSET;ENCODING=QUOTED-PRINTABLE:Jos=C3=A9',
        'END:VCARD',
      ].join('\r\n')
    );
    expect(result.person.name).toBe('José');
  });

  /** Trap 3: split compound values on UNESCAPED semicolons only. */
  it('does not mangle an escaped comma or semicolon in ORG', () => {
    const result = parseScanPayload(
      ['BEGIN:VCARD', 'VERSION:3.0', 'FN:X', 'ORG:Acme\\, Inc.;Platform Team', 'END:VCARD'].join(
        '\r\n'
      )
    );
    expect(result.person.company).toBe('Acme, Inc.');
  });

  /** Trap 4: Apple emits `item1.URL` paired with `item1.X-ABLabel`. */
  it('reads an Apple grouped URL property', () => {
    const result = parseScanPayload(
      [
        'BEGIN:VCARD',
        'VERSION:3.0',
        'FN:Priya Sharma',
        'item1.URL:https://www.linkedin.com/in/priya-sharma-3f21?fromQR=1',
        'item1.X-ABLabel:LinkedIn',
        'END:VCARD',
      ].join('\r\n')
    );
    expect(result.person.linkedinSlug).toBe('priya-sharma-3f21');
    expect(result.person.linkedin).toBe('https://www.linkedin.com/in/priya-sharma-3f21');
  });

  it('uses an Apple label only when the host cannot classify the link', () => {
    const result = parseScanPayload(
      [
        'BEGIN:VCARD',
        'VERSION:3.0',
        'FN:Priya Sharma',
        'item1.URL:https://qrs.ly/abc123',
        'item1.X-ABLabel:LinkedIn',
        'END:VCARD',
      ].join('\r\n')
    );
    expect(result.person.linkedin).toBe('https://qrs.ly/abc123');
    expect(result.person.linkedinSlug).toBeUndefined();
  });

  /** Trap 5: property and parameter names are case-insensitive. */
  it('is case-insensitive about property and parameter names', () => {
    const result = parseScanPayload(
      ['begin:vcard', 'version:3.0', 'fn:Priya Sharma', 'email;type=WORK:p@e.com', 'end:vcard'].join(
        '\r\n'
      )
    );
    expect(result.person.name).toBe('Priya Sharma');
    expect(result.person.email).toBe('p@e.com');
  });

  it('tolerates a BOM and leading whitespace before BEGIN', () => {
    const result = parseScanPayload('\uFEFF  BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Priya\r\nEND:VCARD');
    expect(result.kind).toBe('vcard');
    expect(result.person.name).toBe('Priya');
  });

  it('prefers a CELL number over a WORK landline', () => {
    const result = parseScanPayload(
      [
        'BEGIN:VCARD',
        'VERSION:3.0',
        'FN:X',
        'TEL;TYPE=WORK:+91 80 1234 5678',
        'TEL;TYPE=CELL:+91 98765 43210',
        'END:VCARD',
      ].join('\r\n')
    );
    expect(result.person.phone).toBe('+91 98765 43210');
  });

  it('honours an explicit PREF over a type preference', () => {
    const result = parseScanPayload(
      [
        'BEGIN:VCARD',
        'VERSION:3.0',
        'FN:X',
        'TEL;TYPE=CELL:+91 98765 43210',
        'TEL;TYPE=WORK;PREF=1:+91 80 1234 5678',
        'END:VCARD',
      ].join('\r\n')
    );
    expect(result.person.phone).toBe('+91 80 1234 5678');
  });

  it('understands vCard 2.1 nameless parameters', () => {
    // `TEL;WORK;VOICE:` means TYPE=WORK,VOICE — forbidden in 3.0, normal in 2.1.
    const result = parseScanPayload(
      [
        'BEGIN:VCARD',
        'VERSION:2.1',
        'FN:X',
        'TEL;WORK;VOICE:+91 80 1234 5678',
        'TEL;CELL:+91 98765 43210',
        'END:VCARD',
      ].join('\r\n')
    );
    expect(result.person.phone).toBe('+91 98765 43210');
  });

  it('classifies X and GitHub URLs into their own fields', () => {
    const result = parseScanPayload(
      [
        'BEGIN:VCARD',
        'VERSION:4.0',
        'FN:Rahul',
        'URL:https://x.com/rahul21sai',
        'URL:https://github.com/Rahul21sai',
        'URL:https://portfolio-website-rosy-nu.vercel.app',
        'END:VCARD',
      ].join('\r\n')
    );
    expect(result.person.x).toBe('rahul21sai');
    expect(result.person.github).toBe('Rahul21sai');
    expect(result.person.website).toBe('https://portfolio-website-rosy-nu.vercel.app');
  });

  it('reports a contentless card rather than saving an empty contact', () => {
    const result = parseScanPayload('BEGIN:VCARD\r\nVERSION:3.0\r\nEND:VCARD');
    expect(result.kind).toBe('vcard');
    expect(result.isPerson).toBe(false);
    expect(result.reason).toBeTruthy();
  });
});

/* ────────────────────────────── MECARD ────────────────────────────── */

describe('MECARD payloads', () => {
  it('parses the canonical ZXing example and swaps last,first', () => {
    const result = parseScanPayload(
      'MECARD:N:Doe,John;TEL:13035551212;EMAIL:john.doe@example.com;;'
    );
    expect(result.kind).toBe('mecard');
    expect(result.person.name).toBe('John Doe');
    expect(result.person.phone).toBe('13035551212');
    expect(result.person.email).toBe('john.doe@example.com');
  });

  it('uses the value as-is when N has no comma', () => {
    const result = parseScanPayload('MECARD:N:Priya Sharma;TEL:9876543210;;');
    expect(result.person.name).toBe('Priya Sharma');
  });

  it('never rejects a payload for a missing ;; terminator', () => {
    // There is no MECARD specification — no RFC, no ISO — so leniency is correct.
    const result = parseScanPayload('MECARD:N:Sharma,Priya;TEL:9876543210');
    expect(result.person.name).toBe('Priya Sharma');
  });

  it('classifies a LinkedIn URL held in a MECARD URL field', () => {
    const result = parseScanPayload(
      'MECARD:N:Sharma,Priya;URL:https://www.linkedin.com/in/priya-sharma-3f21;;'
    );
    expect(result.person.linkedinSlug).toBe('priya-sharma-3f21');
  });

  it('handles backslash-escaped delimiters', () => {
    const result = parseScanPayload('MECARD:N:Sharma,Priya;NOTE:Met at 6\\;30 near gate 2;;');
    expect(result.person.note).toBe('Met at 6;30 near gate 2');
  });
});

/* ──────────────── Tickets: recognised, and NOT a person ──────────────── */

describe('conference tickets', () => {
  /**
   * Badge and ticket QRs carry NO contact data on any platform checked — HasGeek is two
   * random 8-char tokens, Meetup an opaque per-RSVP token, KonfHub and Luma server-side
   * ids. Saving a person named `aB3xK9pQmZ2vL7wR` is the worst available outcome, so
   * detection exists purely to say "ask for their LinkedIn instead".
   */
  it('detects a HasGeek badge code (exactly 16 chars: puk + key)', () => {
    const result = parseScanPayload('aB3xK9pQmZ2vL7wR');
    expect(result.kind).toBe('ticket');
    expect(result.isPerson).toBe(false);
    expect(result.reason).toMatch(/ticket/i);
  });

  it.each([
    ['abcdefghijklmnop', '16 lowercase letters — a word, not a token'],
    ['characteristics', '15 chars'],
    ['aB3xK9pQmZ2vL7wRx', '17 chars'],
  ])('does not call %s a ticket (%s)', payload => {
    expect(parseScanPayload(payload).kind).not.toBe('ticket');
  });

  it('detects a ticketing URL that carries a ticket id', () => {
    const result = parseScanPayload('https://fossunited.org/checkin?ticket_id=abc123def');
    expect(result.kind).toBe('ticket');
    expect(result.isPerson).toBe(false);
  });

  it('leaves a plain event page on a ticketing host as an ordinary link', () => {
    // Misclassifying event pages would be worse than missing a ticket.
    const result = parseScanPayload('https://fossunited.org/indiafoss/2026');
    expect(result.kind).toBe('url');
  });
});

/* ──────────────── Recognised, and definitely not a person ──────────────── */

describe('payloads that are not people', () => {
  it.each([
    ['WIFI:T:WPA;S:VenueGuest;P:hunter2;;', /wi-fi/i],
    ['upi://pay?pa=someone@okhdfcbank&pn=Someone&am=100', /upi|payment/i],
    ['geo:12.9716,77.5946', /location/i],
    ['BEGIN:VEVENT\r\nSUMMARY:Standup\r\nEND:VEVENT', /calendar/i],
    ['bitcoin:1BoatSLRHtKNngkdXEeobR76b53LETtpyT', /payment/i],
  ])('refuses %s with an explanation', (payload, reasonPattern) => {
    const result = parseScanPayload(payload);
    expect(result.isPerson).toBe(false);
    expect(result.reason).toMatch(reasonPattern);
  });

  it('checks UPI before treating the embedded VPA as an email address', () => {
    // `pa=someone@okhdfcbank` looks like an address; order in the cascade is what
    // prevents a payment code becoming a contact.
    const result = parseScanPayload('upi://pay?pa=someone@okhdfcbank');
    expect(result.kind).toBe('not-a-person');
  });
});

/* ────────────────────── Single-field contact schemes ────────────────────── */

describe('single-field schemes', () => {
  it('reads mailto:', () => {
    const result = parseScanPayload('mailto:priya@example.com?subject=Hi');
    expect(result.kind).toBe('email');
    expect(result.person.email).toBe('priya@example.com');
    // An email is a durable identity key, so confidence is high even with no name.
    expect(result.confidence).toBe('high');
  });

  it('reads the legacy MATMSG form', () => {
    const result = parseScanPayload('MATMSG:TO:priya@example.com;SUB:Hi;BODY:Hello;;');
    expect(result.kind).toBe('email');
    expect(result.person.email).toBe('priya@example.com');
  });

  it('reads a bare address', () => {
    expect(parseScanPayload('priya@example.com').person.email).toBe('priya@example.com');
  });

  it.each([
    ['tel:+91 98765 43210', '+91 98765 43210'],
    ['tel:+1-212-555-1212', '+1-212-555-1212'],
    ['sms:+18005551212', '+18005551212'],
    ['SMSTO:9876543210:See you there', '9876543210'],
  ])('reads %s', (payload, phone) => {
    const result = parseScanPayload(payload);
    expect(result.kind).toBe('tel');
    expect(result.person.phone).toBe(phone);
  });
});

/* ────────────────────────── Bare profile URLs ────────────────────────── */

describe('other profile URLs', () => {
  it('reads an X profile', () => {
    const result = parseScanPayload('https://x.com/rahul21sai');
    expect(result.kind).toBe('x');
    expect(result.person.x).toBe('rahul21sai');
    expect(result.actionUrl).toBe('https://x.com/rahul21sai');
    // A handle is not a key `deriveContactKey` can use, so confidence stays low.
    expect(result.confidence).toBe('low');
  });

  it('reads a twitter.com profile as X', () => {
    expect(parseScanPayload('https://twitter.com/rahul21sai').person.x).toBe('rahul21sai');
  });

  it('reads a GitHub profile', () => {
    const result = parseScanPayload('https://github.com/Rahul21sai');
    expect(result.kind).toBe('github');
    expect(result.person.github).toBe('Rahul21sai');
  });

  it('handles a third-party QR-generator shortlink without following it', () => {
    // Research decoded qrs.ly / qrcd.ee / q.me-qr.com links from "LinkedIn QR generator"
    // marketing images. Resolving these server-side would be an SSRF and, for LinkedIn,
    // a terms breach — so they stay an opaque link plus a prompt for the name.
    const result = parseScanPayload('https://qrs.ly/mog2j0x');
    expect(result.kind).toBe('url');
    expect(result.person.website).toBe('https://qrs.ly/mog2j0x');
    expect(result.reason).toBeTruthy();
  });

  it('flags a link-in-bio page as such', () => {
    const result = parseScanPayload('https://linktr.ee/someone');
    expect(result.kind).toBe('url');
    expect(result.reason).toMatch(/link-in-bio/i);
  });
});

/* ────────────────────────── Invariants ────────────────────────── */

describe('invariants that must hold for every payload', () => {
  const EVERY_FIXTURE = [
    '',
    '   ',
    'https://www.linkedin.com/in/rahul?fromQR=1',
    'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:X\r\nEND:VCARD',
    'MECARD:N:Doe,John;;',
    'WIFI:T:WPA;S:x;P:y;;',
    'upi://pay?pa=a@b',
    'aB3xK9pQmZ2vL7wR',
    'mailto:a@b.com',
    'tel:+919876543210',
    'https://x.com/foo',
    'https://example.com/',
    'just some text nobody expected',
    // Deliberately malformed: unterminated vCard, bad escapes, control characters.
    'BEGIN:VCARD',
    'BEGIN:VCARD\nFN;ENCODING=QUOTED-PRINTABLE:=ZZ=',
    'MECARD:',
    'N:\\',
    '\u0000\u0001\u0002',
    '=',
    ';;;;',
    'https://',
    '%%%%',
    'x'.repeat(5000),
  ];

  it.each(EVERY_FIXTURE.map(f => [f.slice(0, 40) || '(empty)', f]))(
    'never throws on %s',
    (_label, payload) => {
      expect(() => parseScanPayload(payload)).not.toThrow();
    }
  );

  it.each(EVERY_FIXTURE.map(f => [f.slice(0, 40) || '(empty)', f]))(
    'preserves raw for %s',
    (_label, payload) => {
      // The whole re-parse-later story depends on this. A payload shape we do not
      // understand today must still be recoverable from the stored document.
      expect(parseScanPayload(payload).raw).toBe(payload);
    }
  );

  it('reports empty input as empty rather than guessing', () => {
    expect(parseScanPayload('').kind).toBe('empty');
    expect(parseScanPayload('   ').kind).toBe('empty');
    expect(parseScanPayload('').isPerson).toBe(false);
  });

  it('tolerates a non-string argument', () => {
    // The decoder is third-party wasm; defend the boundary rather than trusting it.
    expect(() => parseScanPayload(undefined as unknown as string)).not.toThrow();
    expect(parseScanPayload(null as unknown as string).kind).toBe('empty');
  });
});
