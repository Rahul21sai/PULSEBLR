#!/usr/bin/env tsx
/**
 * Mint a VAPID key pair for web push, and print the three lines to paste into `.env.local`.
 *
 *   npx tsx scripts/generate-vapid-keys.ts
 *   npx tsx scripts/generate-vapid-keys.ts --subject=mailto:you@example.com
 *
 * ── ROTATING THESE KEYS INVALIDATES EVERY EXISTING SUBSCRIPTION. READ THIS FIRST. ─────────────
 *
 * A browser binds a subscription to the `applicationServerKey` it was created with — the endpoint it
 * returns is derived from that pair. Change the key and every stored endpoint keeps 200-ing at the
 * push service while the browser silently drops the message, or answers 403 `VapidPkHashMismatch`.
 * There is no migration and no dual-key period in the protocol. Rotation means:
 *
 *   1. every row in `pushSubscriptions` is dead and must be deleted, and
 *   2. every user has to visit Settings and turn notifications on again — which needs no new OS
 *      permission grant (that is per-origin, not per-key) but does need a deliberate visit.
 *
 * So generate ONCE, store the private key like a signing secret, and treat rotation as an incident
 * response rather than hygiene. That is also why this script refuses to overwrite anything: it prints
 * to stdout and never touches `.env.local`.
 *
 * ── WHY THERE IS NO DEPENDENCY HERE, WHEN THE SEND PATH USES `web-push`. ─────────────────────
 *
 * Generation is one `crypto.generateKeyPairSync` and two base64url encodings — Node's own crypto does
 * it, and `webpush.generateVAPIDKeys()` is a thin wrapper over exactly this. SENDING is the opposite
 * case and is why `web-push` is a dependency at all: the aes128gcm content encoding is an ECDH
 * agreement plus two HKDF derivations with distinct info strings plus AES-128-GCM plus a binary
 * header, and it FAILS SILENTLY — a wrong salt or a mis-ordered header produces a payload the push
 * service accepts with a 201 and the browser discards with no error anywhere. Hand-rolling the part
 * that cannot be debugged is the mistake; hand-rolling the part that either works or throws is not.
 */

import crypto from 'crypto';

function value(name: string): string | undefined {
  const hit = process.argv.find(arg => arg.startsWith(`--${name}=`));
  return hit?.split('=').slice(1).join('=') || undefined;
}

/**
 * P-256, which VAPID (RFC 8292) mandates. `prime256v1` is OpenSSL's name for the same curve as
 * `secp256r1` / NIST P-256 — the aliases are the same thing and Node accepts this one.
 */
function generate(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });

  /*
   * THE ENCODING IS THE PART THAT GOES WRONG, so it is spelled out.
   *
   * VAPID wants the RAW values, base64url and unpadded — not DER, not PEM, not JWK:
   *
   *   public  — the 65-byte UNCOMPRESSED point: 0x04 ‖ X(32) ‖ Y(32). `jwk.x`/`jwk.y` are already
   *             base64url 32-byte halves, so concatenating the decoded bytes behind a 0x04 gives
   *             exactly what a browser's `applicationServerKey` expects. Exporting `spki` instead
   *             yields 91 bytes of DER wrapper around the same point, which every push service
   *             rejects — and rejects with a generic 400, so the cause is not obvious.
   *   private — the 32-byte scalar `jwk.d`, verbatim.
   *
   * Base64url with no `=` padding, because that is what the `applicationServerKey` conversion in the
   * browser and the JWT header in `web-push` both assume.
   */
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const x = Buffer.from(jwk.x, 'base64url');
  const y = Buffer.from(jwk.y, 'base64url');
  if (x.length !== 32 || y.length !== 32) {
    throw new Error(`Unexpected P-256 coordinate lengths: x=${x.length} y=${y.length}`);
  }
  const point = Buffer.concat([Buffer.from([0x04]), x, y]);

  const priv = privateKey.export({ format: 'jwk' }) as { d: string };
  const d = Buffer.from(priv.d, 'base64url');
  if (d.length !== 32) throw new Error(`Unexpected P-256 private scalar length: ${d.length}`);

  return { publicKey: point.toString('base64url'), privateKey: d.toString('base64url') };
}

function main(): void {
  const subject = value('subject') || 'mailto:you@example.com';
  const { publicKey, privateKey } = generate();

  // Assert what the send path and the validator will assume, here, where the failure is one line of
  // output rather than a 400 from a push service at 8 AM.
  if (Buffer.from(publicKey, 'base64url').length !== 65) throw new Error('public key is not 65 bytes');
  if (Buffer.from(privateKey, 'base64url').length !== 32) throw new Error('private key is not 32 bytes');

  console.log('='.repeat(74));
  console.log('VAPID keys for PulseBLR web push — generated once, then stored, never rotated');
  console.log('='.repeat(74));
  console.log('');
  console.log('Paste into .env.local (and into the Vercel project, and the Actions secrets):');
  console.log('');
  console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
  console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
  console.log(`VAPID_SUBJECT=${subject}`);
  console.log(`NEXT_PUBLIC_VAPID_PUBLIC_KEY=${publicKey}`);
  console.log('');
  console.log('NEXT_PUBLIC_VAPID_PUBLIC_KEY is the SAME value as VAPID_PUBLIC_KEY. It is duplicated');
  console.log('because it has to be readable in the browser, and only a NEXT_PUBLIC_ variable is —');
  console.log('and it is INLINED AT BUILD TIME, so setting it after a deploy changes nothing until');
  console.log('the next build. A public key is public by construction; it is the applicationServerKey');
  console.log('every subscribing browser sends to the push service.');
  console.log('');
  console.log('VAPID_PRIVATE_KEY is a signing secret. It never reaches the browser, never goes in a');
  console.log('NEXT_PUBLIC_ variable, and never gets committed.');
  console.log('');
  console.log('VAPID_SUBJECT must be a mailto: or https: URL identifying whoever runs this deployment.');
  console.log("It is REQUIRED, not decorative: Mozilla's push service rejects a JWT with no `sub`");
  console.log('claim, so omitting it means Firefox silently receives nothing while Chrome works.');
  console.log('');
  console.log('ROTATING THESE INVALIDATES EVERY EXISTING SUBSCRIPTION — every row in');
  console.log('pushSubscriptions becomes undeliverable and every user must re-enable notifications');
  console.log('in Settings. See the header of this script before you do it.');
}

main();
