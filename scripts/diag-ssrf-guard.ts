#!/usr/bin/env tsx
/**
 * Does the SSRF guard actually block the vectors it claims to?
 *
 * POST /api/scrape-url makes the SERVER fetch a URL the caller chooses. Before the fix
 * it was `fetch(url)` with no validation and no auth — a general-purpose proxy inside
 * the deployment's network. The guard is only worth anything if it stops the real
 * bypasses, so each one is asserted here rather than assumed.
 *
 * Does a little DNS (for the hostname cases) but issues no HTTP requests and touches
 * no database.
 *
 * Run: npx tsx scripts/diag-ssrf-guard.ts
 */
import { assertSafeUrl, isBlockedAddress, UnsafeUrlError } from '../lib/security/safe-fetch';

let failures = 0;

function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
}

console.log('isBlockedAddress — must block\n');
const MUST_BLOCK = [
  ['169.254.169.254', 'AWS/GCP/Azure instance metadata — hands out credentials'],
  ['127.0.0.1', 'loopback'],
  ['127.1.2.3', 'anywhere in 127/8'],
  ['0.0.0.0', 'this network'],
  ['10.0.0.5', 'private'],
  ['172.16.0.1', 'private lower bound'],
  ['172.31.255.254', 'private upper bound'],
  ['192.168.1.1', 'private'],
  ['100.64.0.1', 'CGNAT'],
  ['192.0.0.1', 'protocol assignments'],
  ['198.18.0.1', 'benchmarking'],
  ['224.0.0.1', 'multicast'],
  ['255.255.255.255', 'broadcast'],
  ['::1', 'IPv6 loopback'],
  ['::', 'IPv6 unspecified'],
  ['fe80::1', 'IPv6 link-local'],
  ['fd00::1', 'IPv6 unique-local'],
  ['ff02::1', 'IPv6 multicast'],
  ['::ffff:127.0.0.1', 'v4-mapped loopback — the classic bypass'],
  ['::ffff:169.254.169.254', 'v4-mapped metadata'],
  ['not-an-ip', 'refuse anything unparseable'],
];
for (const [ip, why] of MUST_BLOCK) check(`block ${ip.padEnd(22)} (${why})`, isBlockedAddress(ip));

console.log('\nisBlockedAddress — must allow\n');
const MUST_ALLOW = [
  ['1.1.1.1', 'Cloudflare DNS'],
  ['8.8.8.8', 'Google DNS'],
  ['172.15.0.1', 'just below the private range'],
  ['172.32.0.1', 'just above the private range'],
  ['192.167.0.1', 'just below 192.168/16'],
  ['2606:4700::1111', 'public IPv6'],
];
for (const [ip, why] of MUST_ALLOW) check(`allow ${ip.padEnd(22)} (${why})`, !isBlockedAddress(ip));

async function rejects(url: string): Promise<string | null> {
  try {
    await assertSafeUrl(url);
    return null; // accepted — for a MUST-REJECT case that is a failure
  } catch (err) {
    return err instanceof UnsafeUrlError ? err.message : `unexpected: ${String(err)}`;
  }
}

async function main() {
  console.log('\nassertSafeUrl — must reject\n');
  const REJECT = [
    ['file:///etc/passwd', 'file scheme'],
    ['gopher://example.com/', 'gopher scheme'],
    ['ftp://example.com/x', 'ftp scheme'],
    ['http://169.254.169.254/latest/meta-data/', 'metadata by literal IP'],
    ['http://127.0.0.1:3000/api/events', 'our own server'],
    ['http://localhost:3000/', 'localhost by name'],
    ['http://[::1]:3000/', 'IPv6 loopback literal'],
    ['http://10.0.0.1/', 'private literal'],
    ['http://user:pass@example.com/', 'embedded credentials'],
    ['http://2130706433/', 'decimal-encoded 127.0.0.1'],
    ['not a url at all', 'unparseable'],
    ['http://metadata/', 'single-label internal hostname'],
  ];
  for (const [url, why] of REJECT) {
    const msg = await rejects(url);
    check(`reject ${url.slice(0, 42).padEnd(42)} (${why})`, msg !== null, msg ? `“${msg}”` : 'WAS ACCEPTED');
  }

  console.log('\nassertSafeUrl — must accept (real event hosts)\n');
  for (const url of [
    'https://lu.ma/some-event',
    'https://www.meetup.com/bangpypers/events/123456/',
    'https://hasgeek.com/fifthelephant/2026/',
  ]) {
    const msg = await rejects(url);
    check(`accept ${url.slice(0, 46).padEnd(46)}`, msg === null, msg ? `rejected: ${msg}` : '');
  }

  console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
