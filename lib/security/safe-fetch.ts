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

  /*
   * IPv6 IS DECIDED ON THE EXPANDED ADDRESS, NEVER ON ITS SPELLING.
   *
   * This used to delegate v4-mapped forms with `/^::ffff:(\d+\.\d+\.\d+\.\d+)$/` — a check
   * against the DOTTED spelling. `new URL()` normalises an IPv6 literal to compressed hex,
   * so `http://[::ffff:169.254.169.254]/` arrives here as `::ffff:a9fe:a9fe`, matched
   * nothing, fell through to the prefix checks below, and was ALLOWED. Cloud metadata and
   * loopback were both reachable through POST /api/scrape-url by any signed-in user.
   *
   * The dotted spelling is the one spelling a URL can never produce, so the old check was
   * unreachable from the attack path while looking thorough — and the suite agreed with it,
   * because it asserted `isBlockedAddress('::ffff:127.0.0.1')` directly and never sent a
   * bracketed URL through `assertSafeUrl`. Both forms are now covered, and the tests assert
   * through the entry point the route actually calls.
   *
   * One code path, on 16 bytes, is what makes that class of bug impossible rather than
   * merely fixed: there is no longer a spelling to get wrong.
   */
  const groups = expandIpv6(ip);
  if (!groups) return true; // net.isIP said v6 but we cannot expand it — refuse rather than guess

  const embeddedV4 = (hi: number, lo: number) =>
    `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  const zeros = (from: number, to: number) => groups.slice(from, to).every(g => g === 0);

  // ::ffff:0:0/96 v4-mapped, and ::/96 v4-compatible (which also covers :: and ::1).
  if (zeros(0, 5) && (groups[5] === 0xffff || groups[5] === 0)) {
    return isBlockedAddress(embeddedV4(groups[6], groups[7]));
  }
  // ::ffff:0:0/96 IPv4-TRANSLATED (RFC 2765 SIIT), spelled `::ffff:0:a.b.c.d`. Note the
  // 0xffff sits in group 4 here, not group 5 as in the mapped form above — that is the
  // whole difference between the two, and getting it backwards silently allows loopback.
  if (zeros(0, 4) && groups[4] === 0xffff && groups[5] === 0) {
    return isBlockedAddress(embeddedV4(groups[6], groups[7]));
  }
  // 64:ff9b::/96 NAT64, and 64:ff9b:1::/48 local-use NAT64.
  if (groups[0] === 0x64 && groups[1] === 0xff9b) {
    return isBlockedAddress(embeddedV4(groups[6], groups[7]));
  }
  // 2002::/16 6to4 embeds the v4 address in the next 32 bits.
  if (groups[0] === 0x2002) {
    return isBlockedAddress(embeddedV4(groups[1], groups[2]));
  }
  // 2001:0::/32 Teredo. The embedded client address is obfuscated (XOR 0xffffffff) and the
  // server address is only half the story, so the prefix is refused outright.
  if (groups[0] === 0x2001 && groups[1] === 0) return true;

  if (groups[0] >= 0xfe80 && groups[0] <= 0xfebf) return true; // fe80::/10 link-local
  if (groups[0] >= 0xfec0 && groups[0] <= 0xfeff) return true; // fec0::/10 site-local (deprecated)
  if (groups[0] >= 0xfc00 && groups[0] <= 0xfdff) return true; // fc00::/7 unique-local
  if (groups[0] >= 0xff00) return true; // ff00::/8 multicast
  return false;
}

/**
 * Expand an IPv6 string to its eight 16-bit groups, or null if it cannot be parsed.
 *
 * Handles `::` compression, an embedded trailing dotted quad (`::ffff:1.2.3.4`) and a zone
 * index (`fe80::1%eth0`). Exported for the tests: the whole SSRF fix rests on this being
 * right, so it is asserted directly rather than only through its callers.
 */
export function expandIpv6(ip: string): number[] | null {
  let s = ip.toLowerCase().split('%')[0];

  // A trailing dotted quad occupies the last two groups.
  const quad = s.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (quad) {
    const o = quad[1].split('.').map(Number);
    if (o.some(x => !Number.isInteger(x) || x < 0 || x > 255)) return null;
    const hi = ((o[0] << 8) | o[1]).toString(16);
    const lo = ((o[2] << 8) | o[3]).toString(16);
    s = s.slice(0, quad.index) + hi + ':' + lo;
  }

  const halves = s.split('::');
  if (halves.length > 2) return null;

  const split = (part: string) => (part === '' ? [] : part.split(':'));
  const head = split(halves[0]);
  const tail = halves.length === 2 ? split(halves[1]) : [];
  if ([...head, ...tail].some(g => g === '' || !/^[0-9a-f]{1,4}$/.test(g))) return null;

  let out: string[];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    out = head;
  } else {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null; // "::" must stand for at least one zero group
    out = [...head, ...Array(fill).fill('0'), ...tail];
  }

  const groups = out.map(g => parseInt(g, 16));
  if (groups.length !== 8 || groups.some(g => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
  return groups;
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
