import { describe, it, expect } from 'vitest';
import { isBlockedAddress, assertSafeUrl, UnsafeUrlError } from '@/lib/security/safe-fetch';

/**
 * POST /api/scrape-url makes the SERVER fetch a URL the caller chooses. Before it was
 * guarded it was a general-purpose proxy inside the deployment's network, reaching the
 * cloud metadata service (169.254.169.254, which hands out temporary credentials),
 * localhost, and anything in the VPC.
 *
 * scripts/diag-ssrf-guard.ts already asserts this, but that only runs when someone
 * remembers to run it. These are the same assertions in the suite that runs on every
 * change, because an SSRF regression is not the kind that should wait for a manual check.
 */
describe('isBlockedAddress', () => {
  it.each([
    ['169.254.169.254', 'cloud metadata — hands out credentials'],
    ['127.0.0.1', 'loopback'],
    ['127.1.2.3', 'anywhere in 127/8'],
    ['0.0.0.0', 'this network'],
    ['10.0.0.5', 'private'],
    ['172.16.0.1', 'private lower bound'],
    ['172.31.255.254', 'private upper bound'],
    ['192.168.1.1', 'private'],
    ['100.64.0.1', 'CGNAT'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'broadcast'],
    ['::1', 'IPv6 loopback'],
    ['fe80::1', 'IPv6 link-local'],
    ['fd00::1', 'IPv6 unique-local'],
    ['::ffff:127.0.0.1', 'v4-mapped loopback — the classic bypass'],
    ['::ffff:169.254.169.254', 'v4-mapped metadata'],
    ['not-an-ip', 'unparseable input must be refused, not guessed at'],

    /*
     * THE HEX FORMS ARE THE ONES THAT MATTER, and the two dotted cases above are why that
     * was missed. `new URL()` NORMALISES an IPv6 literal to compressed hex — a bracketed
     * `[::ffff:169.254.169.254]` comes out of `url.hostname` as `[::ffff:a9fe:a9fe]` — so
     * the dotted spelling is the one spelling that never reaches this function from a URL.
     * A check written against it passes every real attack while looking tested.
     */
    ['::ffff:a9fe:a9fe', 'v4-mapped metadata, as new URL() actually spells it'],
    ['::ffff:7f00:1', 'v4-mapped loopback, as new URL() actually spells it'],
    ['::7f00:1', 'v4-compatible loopback'],
    ['::ffff:0:7f00:1', 'v4-mapped via ::ffff:0:0/96'],
    ['64:ff9b::7f00:1', 'NAT64 loopback'],
    ['64:ff9b::a9fe:a9fe', 'NAT64 metadata'],
    ['2002:7f00:1::', '6to4 loopback'],
    ['2002:a9fe:a9fe::', '6to4 metadata'],
    ['2002:c0a8:101::', '6to4 private'],
    ['fec0::1', 'fec0::/10 site-local'],
    ['2001:0:1234::5678', 'Teredo'],
    ['::', 'unspecified'],
  ])('blocks %s (%s)', ip => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each([
    ['1.1.1.1'],
    ['8.8.8.8'],
    ['172.15.0.1'], // just below the private range
    ['172.32.0.1'], // just above it
    ['192.167.0.1'], // just below 192.168/16
    ['2606:4700::1111'],
    // The transitional prefixes must be judged on the address they EMBED, not blocked
    // wholesale — 6to4 and NAT64 wrapping a public v4 address are public.
    ['2002:808:808::'], // 6to4 wrapping 8.8.8.8
    ['64:ff9b::808:808'], // NAT64 wrapping 8.8.8.8
  ])('allows the public address %s', ip => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe('assertSafeUrl', () => {
  it.each([
    ['file:///etc/passwd', 'file scheme'],
    ['gopher://example.com/', 'gopher scheme'],
    ['ftp://example.com/x', 'ftp scheme'],
    ['http://169.254.169.254/latest/meta-data/', 'metadata by literal IP'],
    ['http://127.0.0.1:3000/api/events', 'our own server'],
    ['http://[::1]:3000/', 'IPv6 loopback literal'],
    ['http://10.0.0.1/', 'private literal'],
    ['http://user:pass@example.com/', 'embedded credentials'],
    ['http://2130706433/', 'decimal-encoded 127.0.0.1'],
    ['not a url at all', 'unparseable'],
    ['http://metadata/', 'single-label internal hostname'],

    /*
     * BRACKETED LITERALS, THROUGH THE REAL ENTRY POINT. Everything above this block was
     * already covered; these were not, and that gap is the whole reason the v4-mapped
     * bypass shipped with a green suite. `isBlockedAddress` was asserted directly with a
     * hand-written dotted string, so the normalisation `new URL()` performs — the step that
     * actually defeats the check — never happened in a test.
     *
     * Assert through `assertSafeUrl`, which is what `/api/scrape-url` calls.
     */
    ['http://[::ffff:169.254.169.254]/latest/meta-data/', 'v4-mapped metadata literal'],
    ['http://[::ffff:127.0.0.1]:3000/', 'v4-mapped loopback literal'],
    ['http://[::7f00:1]/', 'v4-compatible loopback literal'],
    ['http://[64:ff9b::a9fe:a9fe]/', 'NAT64 metadata literal'],
    ['http://[2002:a9fe:a9fe::]/', '6to4 metadata literal'],
    ['http://[fec0::1]/', 'site-local literal'],
    ['http://[::]/', 'unspecified literal'],
  ])('rejects %s (%s)', async url => {
    await expect(assertSafeUrl(url)).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('accepts the public event hosts the feature exists for', async () => {
    // These resolve over real DNS, which is the point: the guard checks the RESOLVED
    // address, so a test that stubbed DNS would not exercise the thing that matters.
    for (const url of [
      'https://lu.ma/some-event',
      'https://www.meetup.com/bangpypers/events/123456/',
      'https://hasgeek.com/fifthelephant/2026/',
    ]) {
      await expect(assertSafeUrl(url)).resolves.toBeInstanceOf(URL);
    }
  });
});
