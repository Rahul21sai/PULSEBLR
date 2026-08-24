import { describe, it, expect, beforeAll } from 'vitest';
import { toDataURL } from 'qrcode';
import { readBarcodes } from 'zxing-wasm/reader';
import { parseScanPayload } from '@/lib/scan/parse-payload';

/**
 * THE WHOLE PIPELINE, on real QR IMAGES: encode → decode → parse.
 *
 * `tests/scan-payload.test.ts` covers the parser as a pure function, feeding it strings. That
 * leaves the two most failure-prone links untested: whether the wasm decoder actually reads a
 * physical code, and whether what it hands back is byte-identical to what was encoded. A payload
 * that round-trips through a real encoder and a real decoder is the only thing that proves the
 * scanner works — everything else is an assumption about the middle of the chain.
 *
 * This is deliberately still in `tests/` rather than a diag script: it touches no database, no
 * server and no network. `zxing-wasm` resolves its `.wasm` from the installed package on disk, and
 * `qrcode` generates in-process, so the whole file is local and deterministic.
 *
 * It is also the regression guard for the version pin: if `zxing-wasm` ever ships a build whose
 * `.wasm` cannot load, every test here fails loudly instead of the scanner silently finding nothing
 * on a phone at an event.
 */

/** Encode text as a PNG, exactly as `app/components/QrCode.tsx` configures it. */
async function encode(text: string, width = 400): Promise<Blob> {
  const dataUrl = await toDataURL(text, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width,
    color: { dark: '#000000', light: '#FFFFFF' },
  });
  const base64 = dataUrl.split(',')[1];
  return new Blob([Buffer.from(base64, 'base64')], { type: 'image/png' });
}

/** Decode with the accuracy-first options the still-image path in decoder.ts uses. */
async function decode(blob: Blob): Promise<string | null> {
  const results = await readBarcodes(blob, {
    formats: ['QRCode'],
    maxNumberOfSymbols: 1,
    tryHarder: true,
    tryInvert: true,
    tryRotate: true,
  });
  return results[0]?.text ?? null;
}

/** encode → decode → parse, the way a scan actually happens. */
async function scan(text: string, width?: number) {
  const decoded = await decode(await encode(text, width));
  expect(decoded, 'the decoder must read the code back').toBe(text);
  return parseScanPayload(decoded!);
}

beforeAll(async () => {
  // Warm the wasm module once; instantiation is far slower than any single decode.
  await decode(await encode('warmup'));
}, 60_000);

/* ─────────────── The primary path: a person's LinkedIn QR ─────────────── */

describe('a LinkedIn profile QR, end to end', () => {
  it(
    'decodes and identifies the person from the real payload shape',
    async () => {
      // The exact string a LinkedIn QR contains — verified first-hand off a real device on
      // 2026-08-23, and matching all 19 published samples from 2018 to 2026.
      const result = await scan('https://www.linkedin.com/in/naga-sai-rahul-vudumula-93419524b?fromQR=1');

      expect(result.kind).toBe('linkedin');
      expect(result.isPerson).toBe(true);
      expect(result.person.linkedinSlug).toBe('naga-sai-rahul-vudumula-93419524b');
      expect(result.person.linkedin).toBe(
        'https://www.linkedin.com/in/naga-sai-rahul-vudumula-93419524b'
      );
      // The trailing random discriminator is dropped, and the guess is flagged as a guess.
      expect(result.person.name).toBe('Naga Sai Rahul Vudumula');
      expect(result.person.nameIsGuess).toBe(true);
      expect(result.confidence).toBe('high');
      expect(result.actionUrl).toMatch(/^https:\/\/www\.linkedin\.com\/in\//);
      expect(result.raw).toContain('?fromQR=1');
    },
    30_000
  );

  it('survives a small, dense code — the realistic case of a phone screen at arm’s length', async () => {
    // 200px for a version-4-ish payload is about what a camera sees across a table.
    const result = await scan('https://www.linkedin.com/in/priya-sharma-3f21?fromQR=1', 200);
    expect(result.person.linkedinSlug).toBe('priya-sharma-3f21');
  });

  it('handles a slug with no name in it, without inventing one', async () => {
    const result = await scan('https://www.linkedin.com/in/ebusinesstutor?fromQR=1');
    expect(result.person.linkedinSlug).toBe('ebusinesstutor');
    expect(result.person.name).toBeUndefined();
  });
});

/* ─────────────── Event badges and tickets: recognised, refused ─────────────── */

describe('event badge and ticket QRs', () => {
  /**
   * This is the case people most expect to work and which CANNOT work. Verified per platform:
   * HasGeek encodes two random 8-char tokens, Meetup an opaque per-RSVP token, KonfHub and Luma
   * server-side ids. None of them lets a third party recover who the attendee is.
   *
   * So the only correct behaviour is to recognise it and say so. The failure mode being guarded
   * against is saving a contact literally named `aB3xK9pQmZ2vL7wR`.
   */
  it('detects a HasGeek badge (exactly 16 chars: an 8-char puk + 8-char key)', async () => {
    const result = await scan('aB3xK9pQmZ2vL7wR');
    expect(result.kind).toBe('ticket');
    expect(result.isPerson).toBe(false);
    expect(result.person.name).toBeUndefined();
    expect(result.reason).toMatch(/ticket/i);
    // And it must tell the user what WILL work.
    expect(result.reason).toMatch(/linkedin/i);
  });

  it('detects a FOSS United style ticket URL', async () => {
    const result = await scan('https://fossunited.org/checkin?ticket_id=abc123def456');
    expect(result.kind).toBe('ticket');
    expect(result.isPerson).toBe(false);
  });

  it('does NOT mistake a plain event page on a ticketing host for a ticket', async () => {
    // Misclassifying real event links would be worse than missing a ticket.
    const result = await scan('https://fossunited.org/indiafoss/2026');
    expect(result.kind).toBe('url');
  });

  it('does not mistake a 16-character word for a badge token', async () => {
    const result = await scan('abcdefghijklmnop');
    expect(result.kind).not.toBe('ticket');
  });
});

/* ─────────────── Contact-card formats ─────────────── */

describe('vCard and MECARD codes', () => {
  it('reads a full vCard from a real code', async () => {
    const vcard = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'N:Sharma;Priya;;;',
      'FN:Priya Sharma',
      'ORG:Razorpay;Payments',
      'TITLE:Staff Engineer',
      'TEL;TYPE=CELL:+91 98765 43210',
      'EMAIL;TYPE=INTERNET:priya@example.com',
      'URL:https://www.linkedin.com/in/priya-sharma-3f21',
      'END:VCARD',
    ].join('\r\n');

    // A vCard is a large payload, so it needs a physically bigger code to stay readable.
    const result = await scan(vcard, 600);

    expect(result.kind).toBe('vcard');
    expect(result.person.name).toBe('Priya Sharma');
    expect(result.person.company).toBe('Razorpay'); // component 0 of ORG only
    expect(result.person.role).toBe('Staff Engineer');
    expect(result.person.phone).toBe('+91 98765 43210');
    expect(result.person.email).toBe('priya@example.com');
    expect(result.person.linkedinSlug).toBe('priya-sharma-3f21');
    expect(result.confidence).toBe('high');
  }, 30_000);

  it('reads a MECARD and swaps last,first', async () => {
    const result = await scan('MECARD:N:Mehta,Arjun;TEL:9876543210;EMAIL:arjun@example.com;;');
    expect(result.kind).toBe('mecard');
    expect(result.person.name).toBe('Arjun Mehta');
    expect(result.person.phone).toBe('9876543210');
  });
});

/* ─────────────── Things at an Indian tech event that are not people ─────────────── */

describe('codes that must not become contacts', () => {
  it.each([
    ['upi://pay?pa=someone@okhdfcbank&pn=Someone&am=200', /upi|payment/i, 'UPI codes are everywhere here'],
    ['WIFI:T:WPA;S:VenueGuest;P:hunter2;;', /wi-fi/i, 'the venue wifi poster'],
    ['geo:12.9716,77.5946', /location/i, 'a location pin'],
  ])('refuses %s and explains why', async (payload, reasonPattern) => {
    const result = await scan(payload);
    expect(result.isPerson).toBe(false);
    expect(result.reason).toMatch(reasonPattern);
    // Nothing must be half-captured from a non-person code.
    expect(result.person.name).toBeUndefined();
    expect(result.person.linkedinSlug).toBeUndefined();
  });

  it('checks UPI before the embedded VPA can be read as an email', async () => {
    const result = await scan('upi://pay?pa=someone@okhdfcbank');
    expect(result.kind).toBe('not-a-person');
  });
});

/* ─────────────── Other real payloads ─────────────── */

describe('other profile and contact codes', () => {
  it('reads an X profile', async () => {
    const result = await scan('https://x.com/rahul21sai');
    expect(result.kind).toBe('x');
    expect(result.person.x).toBe('rahul21sai');
  });

  it('reads a GitHub profile', async () => {
    const result = await scan('https://github.com/Rahul21sai');
    expect(result.kind).toBe('github');
    expect(result.person.github).toBe('Rahul21sai');
  });

  it('reads mailto: and tel:', async () => {
    expect((await scan('mailto:priya@example.com')).person.email).toBe('priya@example.com');
    expect((await scan('tel:+919876543210')).person.phone).toBe('+919876543210');
  });

  it('keeps an unrecognised code as a note rather than dropping it', async () => {
    const text = 'Booth 42 — ask for Ananya';
    const result = await scan(text);
    expect(result.raw).toBe(text);
    expect(result.person.note).toBe(text);
  });
});

/* ─────────────── The card this app generates must be scannable ─────────────── */

describe('our own generated card code', () => {
  it('round-trips a PulseBLR card URL', async () => {
    // The exact shape /card renders, and what another person's camera has to read.
    const url = 'http://localhost:3000/c/CPfjVQhcTny05qjHuhq09A';
    const decoded = await decode(await encode(url, 288));
    expect(decoded).toBe(url);
  });

  it('round-trips a folder sign-up URL', async () => {
    const url = 'https://pulseblr.example.com/f/Ae0MqRtl6j1ywIVG87dO0w';
    expect(await decode(await encode(url, 240))).toBe(url);
  });

  it('round-trips a vCard of our own making, so "Save to contacts" is scannable too', async () => {
    const { buildVCard } = await import('@/lib/contacts/vcf');
    const vcf = buildVCard({
      name: 'Naga Sai Rahul Vudumula',
      company: 'IBM',
      role: 'Application Developer',
      urls: ['https://www.linkedin.com/in/naga-sai-rahul-vudumula-93419524b'],
    });
    expect(await decode(await encode(vcf, 600))).toBe(vcf);
  }, 30_000);
});
