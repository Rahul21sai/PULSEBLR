/**
 * Payloads that are RECOGNISABLY not a person, beyond the scheme prefixes in
 * `parse-payload.ts` (Wi-Fi, UPI, calendar, geo, bitcoin).
 *
 * Everything here is a code people genuinely hold up at Bengaluru tech events and that the
 * cascade used to hand to its generic URL / text branches, which answer `isPerson: true`.
 * The UI then opens the capture sheet and the obvious next tap files a contact whose only
 * field is the link. That is the "person named aB3xK9pQmZ2vL7wR" failure in another form.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * QUICK SHARE IS THE CASE THAT PROMPTED THIS, AND IT IS WORSE THAN JUNK.
 *
 * Android's "Share using QR code" (Quick Share sending to an iPhone, or to an Android with
 * no Quick Share nearby) encodes, as decoded off a real device on 2026-09-27:
 *
 *   https://quickshare.google/qrcode?r=<4 chars>#key=<47-char URL-safe base64>
 *
 * The files are end-to-end encrypted and parked on Google's servers for 24 hours, and the
 * `#key=` fragment IS the decryption key — it is in the fragment precisely so it never
 * reaches a server. Filing that as `Contact.website` would have copied a live key to
 * somebody's file transfer into MongoDB, the CSV export and every device that syncs it.
 * Refusing it keeps it in memory only: a `isPerson: false` result is toasted and dropped
 * by the scan page, never queued.
 * ─────────────────────────────────────────────────────────────────────────────────
 *
 * Matching is by HOST plus the path shape each product actually uses, never by a loose
 * substring — `https://www.google.com/search?q=quickshare` must stay an ordinary link, and
 * so must a Telegram USERNAME (which may well be the person in front of you) as opposed to
 * a Telegram group INVITE. When a host is ambiguous between "a person" and "a thing", it is
 * left to the URL branch, which at least asks for a name.
 */

interface UrlRule {
  test: (host: string, url: URL) => boolean;
  reason: string;
}

const URL_RULES: UrlRule[] = [
  {
    // The whole host is dedicated to Quick Share; there is no person-shaped page on it.
    test: host => host === 'quickshare.google',
    reason: "That's a Quick Share file link, not a contact — someone is sending you files.",
  },
  {
    // chat.whatsapp.com/<invite code> is only ever a group invite.
    test: (host, url) => host === 'chat.whatsapp.com' && url.pathname.length > 1,
    reason: "That's a WhatsApp group invite, not a contact.",
  },
  {
    // t.me/+<code> and t.me/joinchat/<code> are group/channel invites. A bare
    // t.me/<username> may be a person and is deliberately NOT matched.
    test: (host, url) =>
      (host === 't.me' || host === 'telegram.me') && /^\/(?:\+|joinchat\/)/i.test(url.pathname),
    reason: "That's a Telegram group invite, not a contact.",
  },
  {
    // Meet codes are always xxx-xxxx-xxx.
    test: (host, url) =>
      host === 'meet.google.com' && /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}(?:\/|$)/i.test(url.pathname),
    reason: "That's a video-call link, not a contact.",
  },
  {
    // zoom.us/j/<meeting id> and vanity subdomains (acme.zoom.us/j/...). /my/<name> is a
    // personal room and is left as a link.
    test: (host, url) =>
      (host === 'zoom.us' || host.endsWith('.zoom.us')) && /^\/[jw]\/\d/i.test(url.pathname),
    reason: "That's a video-call link, not a contact.",
  },
  {
    test: (host, url) =>
      (host === 'teams.microsoft.com' && /^\/l\/meetup-join\//i.test(url.pathname)) ||
      (host === 'teams.live.com' && /^\/meet\//i.test(url.pathname)),
    reason: "That's a video-call link, not a contact.",
  },
  {
    // Feedback and sign-up forms are on every event table.
    test: (host, url) =>
      (host === 'forms.gle' && url.pathname.length > 1) ||
      (host === 'docs.google.com' && /^\/forms\//i.test(url.pathname)),
    reason: "That's a form, not a contact. Open it from your camera app if you want to fill it in.",
  },
  {
    test: (host, url) =>
      (host === 'play.google.com' && /^\/store\/apps\//i.test(url.pathname)) ||
      (host === 'apps.apple.com' && /\/app\//i.test(url.pathname)),
    reason: "That's an app store link, not a contact.",
  },
];

/**
 * The reason to show when `value` is recognisably not a person, else `undefined`.
 * Never throws.
 */
export function notAPersonReason(value: string): string | undefined {
  if (looksLikeAadhaar(value)) {
    return (
      "That looks like an Aadhaar QR — it carries government ID data, not a contact. " +
      'Nothing was kept.'
    );
  }
  if (looksLikeEmvcoPayment(value)) {
    return "That's a Bharat QR payment code, not a contact.";
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  for (const rule of URL_RULES) {
    if (rule.test(host, url)) return rule.reason;
  }
  return undefined;
}

/**
 * EMVCo merchant-presented QR, the format Bharat QR (and many Paytm / PhonePe / bank POS
 * standees) use instead of a `upi://` URL: a TLV string that must open with the payload
 * format indicator `000201` and close with the CRC tag `6304` plus four hex digits. Both
 * ends are required so that an arbitrary number beginning 000201 is not called a payment.
 */
function looksLikeEmvcoPayment(value: string): boolean {
  return /^000201/.test(value) && /6304[0-9A-Fa-f]{4}$/.test(value);
}

/**
 * Aadhaar QRs carry the holder's name, date of birth, address and (legacy form) the
 * Aadhaar number itself. The legacy card is an XML `PrintLetterBarcodeData` element; the
 * Secure QR is a single enormous decimal integer (compressed, signed data). Without this,
 * the legacy XML fell through to the text branch and was offered for saving as a NOTE —
 * government ID data sitting in somebody's contact list.
 *
 * 200 digits is far below a real Secure QR and far above any phone, PIN or ticket number.
 */
function looksLikeAadhaar(value: string): boolean {
  return /<PrintLetterBarcodeData\b/i.test(value) || /^\d{200,}$/.test(value);
}

/**
 * A WhatsApp click-to-chat link carries the person's PHONE NUMBER, which is a durable
 * identity key — so this is a person hint, not a refusal. Returns `+<digits>` or undefined.
 *
 *   https://wa.me/919876543210
 *   https://api.whatsapp.com/send?phone=919876543210
 *
 * `wa.me/qr/<code>` and `wa.me/message/<code>` are opaque and yield nothing here; they stay
 * ordinary links.
 */
export function whatsAppPhone(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  let digits: string | undefined;
  if (host === 'wa.me') {
    digits = /^\/\+?(\d{10,15})\/?$/.exec(url.pathname)?.[1];
  } else if (host === 'api.whatsapp.com' && /^\/send\/?$/i.test(url.pathname)) {
    digits = /^\+?(\d{10,15})$/.exec(url.searchParams.get('phone') ?? '')?.[1];
  }
  return digits ? `+${digits}` : undefined;
}
