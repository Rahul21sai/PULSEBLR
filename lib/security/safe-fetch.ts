// SSRF-safe outbound fetch for URLs a USER supplied.
//
// The hole this closes: POST /api/scrape-url took an arbitrary `url` from the request
// body and did `fetch(url)` server-side, then returned the parsed result to the caller.
// There was no scheme check, no host allowlist and no private-address check, so it was
// a general-purpose proxy running inside the deployment's network. On a cloud host that
// reaches the instance metadata service (169.254.169.254 on AWS/GCP/Azure, which hands
// out temporary credentials), anything on localhost, and anything in the VPC.
//
// Blocking by hostname string is not enough, for three reasons this module handles:
//   1. A hostname can RESOLVE to a private address (`localtest.me` -> 127.0.0.1, or an
//      attacker-controlled DNS record pointing at 169.254.169.254). So every resolved
//      address is checked, not just literal IPs in the URL.
//   2. A public URL can REDIRECT to a private one. So redirects are followed manually,
//      one hop at a time, re-validating each Location.
//   3. Decimal, octal and IPv6-mapped forms of the same address exist
//      (2130706433, 0177.0.0.1, ::ffff:127.0.0.1). Node's dns resolver normalises to
//      real addresses, which is why validation happens after resolution rather than on
//      the raw string.
//
// DNS rebinding (a record that answers differently between our check and the fetch) is
// NOT fully solved here — that needs pinning the connection to the validated IP via a
// custom agent. It is called out rather than papered over; the practical exposure is
// small because the response body is only parsed for event metadata, never executed,
// and the route now requires a signed-in user.

import dns from 'node:dns/promises';
import net from 'node:net';

export const MAX_REDIRECTS = 3;
export const MAX_BYTES = 2_000_000; // an event page that needs 2 MB of HTML is not one we can parse

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

/**
 * Is this IP in a range that must never be reachable from a user-supplied URL?
 * Covers loopback, private, link-local (incl. cloud metadata), CGNAT, and the IPv6
 * equivalents including v4-mapped addresses.
 */
export function isBlockedAddress(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 0) return true; // not an IP at all — refuse rather than guess

  if (version === 4) {
    const octets = ip.split('.').map(Number);
    const [a, b] = octets;
    if (octets.some(o => !Number.isInteger(o) || o < 0 || o > 255)) return true;
    if (a === 0) return true; // 0.0.0.0/8 "this network"
    if (a === 10) return true; // private
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local — cloud metadata lives here
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 192 && b === 0) return true; // 192.0.0.0/24 protocol assignments
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a >= 224) return true; // multicast + reserved + broadcast
    return false;
  }

  const lower = ip.toLowerCase();
  // v4-mapped and v4-compatible forms delegate to the v4 rules above.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/) || lower.match(/^::(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedAddress(mapped[1]);

  if (lower === '::' || lower === '::1') return true; // unspecified, loopback
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
    return true; // fe80::/10 link-local
  }
  if (/^f[cd]/.test(lower)) return true; // fc00::/7 unique-local
  if (lower.startsWith('ff')) return true; // multicast
  return false;
}

/** Throw unless `raw` is an http(s) URL whose host resolves only to public addresses. */
export async function assertSafeUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError('Not a valid URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    // Blocks file:, ftp:, gopher:, data: and the rest.
    throw new UnsafeUrlError(`Unsupported scheme "${url.protocol.replace(':', '')}" — only http and https are allowed`);
  }
  // Credentials in a URL are never needed here and can be used to confuse parsers.
  if (url.username || url.password) throw new UnsafeUrlError('URLs with embedded credentials are not allowed');

  const host = url.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets

  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw new UnsafeUrlError('Destination address is not publicly routable');
    return url;
  }

  // A bare hostname with no dot (e.g. "localhost", or an internal service name) is
  // never a public event site.
  if (!host.includes('.')) throw new UnsafeUrlError('Destination host is not publicly routable');

  let addresses: string[];
  try {
    const resolved = await dns.lookup(host, { all: true, verbatim: true });
    addresses = resolved.map(r => r.address);
  } catch {
    throw new UnsafeUrlError('Destination host could not be resolved');
  }
  if (addresses.length === 0) throw new UnsafeUrlError('Destination host could not be resolved');

  // EVERY address must be public: one private answer is enough to abuse.
  const blocked = addresses.filter(isBlockedAddress);
  if (blocked.length > 0) throw new UnsafeUrlError('Destination resolves to a non-public address');

  return url;
}

export interface SafeFetchResult {
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
  truncated: boolean;
}

/**
 * Fetch a user-supplied URL with every hop validated and the body size capped.
 *
 * Redirects are handled manually (`redirect: 'manual'`) because `redirect: 'follow'`
 * would let a public URL bounce to 127.0.0.1 or the metadata endpoint without us ever
 * seeing the intermediate Location.
 */
export async function safeFetch(
  raw: string,
  opts: { timeoutMs?: number; accept?: string } = {}
): Promise<SafeFetchResult> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  let current = await assertSafeUrl(raw);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(current.toString(), {
      redirect: 'manual',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PulseBLR-bot/1.0)',
        Accept: opts.accept ?? 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new UnsafeUrlError('Redirect without a Location header');
      // Resolve relative redirects against the current URL, then re-validate.
      current = await assertSafeUrl(new URL(location, current).toString());
      continue;
    }

    const contentType = (res.headers.get('content-type') || '').split(';')[0].trim();

    // Read with a hard byte cap so a huge or endless response cannot exhaust memory.
    const reader = res.body?.getReader();
    let body = '';
    let truncated = false;
    if (reader) {
      const decoder = new TextDecoder();
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BYTES) {
          truncated = true;
          await reader.cancel();
          break;
        }
        body += decoder.decode(value, { stream: true });
      }
    }

    return { finalUrl: current.toString(), status: res.status, contentType, body, truncated };
  }

  throw new UnsafeUrlError(`Too many redirects (limit ${MAX_REDIRECTS})`);
}
