import { describe, it, expect } from 'vitest';
import { parseScanPayload } from '@/lib/scan/parse-payload';

/**
 * Codes people hold up at events that are recognisably NOT a person — see
 * `lib/scan/not-a-person.ts`. Every positive case here used to fall through to the URL or text
 * branch and answer `isPerson: true`, which opens the capture sheet.
 *
 * The Quick Share token below is SYNTHETIC. The real payload this was built from is somebody's
 * live file-transfer link with its decryption key in the fragment, and must never be committed.
 */
const SYNTHETIC_KEY = 'AAACsynthTESTkey_0123456789-abcdefghijKLMNOPQRS'; // 47 chars, like the real one
const QUICK_SHARE = `https://quickshare.google/qrcode?r=zZ9q#key=${SYNTHETIC_KEY}`;

describe('Android Quick Share "Share using QR code"', () => {
  it('is refused as a file link, not saved as a contact', () => {
    expect(SYNTHETIC_KEY).toHaveLength(47);
    const result = parseScanPayload(QUICK_SHARE);
    expect(result.kind).toBe('not-a-person');
    expect(result.isPerson).toBe(false);
    expect(result.reason).toMatch(/quick share file link, not a contact/i);
  });

  it('does not copy the decryption key into any person field or action', () => {
    const result = parseScanPayload(QUICK_SHARE);
    expect(result.person).toEqual({});
    expect(result.actionUrl).toBeUndefined();
    // `raw` is still the literal payload — the parser invariant — but it only lives in memory,
    // because the scan page drops every isPerson:false result.
    expect(result.raw).toBe(QUICK_SHARE);
  });

  it.each([
    'https://quickshare.google/qrcode?retry=true#key=' + SYNTHETIC_KEY,
    'HTTPS://QUICKSHARE.GOOGLE/qrcode?r=zZ9q#key=' + SYNTHETIC_KEY,
    '  ' + QUICK_SHARE + '\n',
  ])('recognises the variant %s', payload => {
    expect(parseScanPayload(payload).kind).toBe('not-a-person');
  });
});

describe('other codes that are not people', () => {
  it.each([
    ['https://chat.whatsapp.com/AbCdEfGhIjKlMnOpQrStUv', /whatsapp group invite/i],
    ['https://t.me/+AbCdEfGhIjK12345', /telegram group invite/i],
    ['https://t.me/joinchat/AbCdEfGhIjK12345', /telegram group invite/i],
    ['https://meet.google.com/abc-defg-hij', /video-call/i],
    ['https://us06web.zoom.us/j/81234567890?pwd=abc', /video-call/i],
    ['https://zoom.us/j/81234567890', /video-call/i],
    ['https://teams.microsoft.com/l/meetup-join/19%3ameeting_x/0', /video-call/i],
    ['https://forms.gle/AbCdEf123', /form, not a contact/i],
    ['https://docs.google.com/forms/d/e/1FAIpQLSf/viewform', /form, not a contact/i],
    ['https://play.google.com/store/apps/details?id=com.example.app', /app store/i],
    ['https://apps.apple.com/in/app/example/id123456789', /app store/i],
    [
      '00020101021126360010A0000005240118merchant@okaxis5204541153033565802IN5910Some Store6009Bengaluru63041A2B',
      /bharat qr payment/i,
    ],
    [
      '<?xml version="1.0" encoding="UTF-8"?><PrintLetterBarcodeData uid="000000000000" name="Test Person"/>',
      /aadhaar/i,
    ],
    ['1'.repeat(1200), /aadhaar/i],
  ])('refuses %s', (payload, reason) => {
    const result = parseScanPayload(payload);
    expect(result.kind).toBe('not-a-person');
    expect(result.isPerson).toBe(false);
    expect(result.reason).toMatch(reason);
    expect(result.person).toEqual({});
  });
});

describe('near-misses that must stay ordinary links or text', () => {
  it.each([
    'https://www.google.com/search?q=quickshare',
    'https://google.com/',
    'https://quickshare.google.example.com/qrcode?r=zZ9q',
    'https://chat.whatsapp.com/',
    'https://t.me/rahul_codes', // a Telegram USERNAME may be the person in front of you
    'https://meet.google.com/',
    'https://zoom.us/my/rahul', // a personal room names a person
    'https://docs.google.com/document/d/abc/edit',
    'https://play.google.com/store/books/details?id=x',
    'https://apps.apple.com/in/developer/example/id1',
    'https://wa.me/qr/ABCDEFGHIJ1234', // opaque WhatsApp QR: no number to recover
    'https://wa.me/12345', // too short to be a phone number
  ])('%s stays a plain URL', payload => {
    const result = parseScanPayload(payload);
    expect(result.kind).toBe('url');
    expect(result.isPerson).toBe(true);
  });

  it.each([
    ['199 digits', '1'.repeat(199)], // below the Aadhaar Secure QR floor
    ['EMVCo prefix, no CRC tail', '000201 is just how this note starts'],
  ])('%s stays text', (_label, payload) => {
    expect(parseScanPayload(payload).kind).toBe('text');
  });
});

describe('WhatsApp click-to-chat links carry a phone number', () => {
  it.each([
    ['https://wa.me/919876543210', '+919876543210'],
    ['https://wa.me/+919876543210/', '+919876543210'],
    ['https://api.whatsapp.com/send?phone=919876543210&text=hi', '+919876543210'],
  ])('%s becomes a person keyed on the number', (payload, phone) => {
    const result = parseScanPayload(payload);
    expect(result.kind).toBe('tel');
    expect(result.isPerson).toBe(true);
    expect(result.person.phone).toBe(phone);
    expect(result.confidence).toBe('high');
    expect(result.reason).toMatch(/whatsapp/i);
  });
});
