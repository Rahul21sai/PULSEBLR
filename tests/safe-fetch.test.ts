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
