import { describe, it, expect, beforeEach } from 'vitest';
import { rateLimit, clientKey, resetRateLimits } from '@/lib/security/rate-limit';

/**
 * `POST /api/intake/[token]` is the app's first and only UNAUTHENTICATED write endpoint — the
 * public form behind a folder QR. Before it, the repo had no throttle of any kind outside the
 * scraper's own concurrency pool.
 *
 * A limiter that is off by one, or that never refills, either lets a stranger fill a folder with
 * thousands of rows or locks out the fifth person at a real booth. Both matter, so both are
 * tested. `now` is injected rather than slept on.
 */

beforeEach(() => {
  resetRateLimits();
});

describe('rateLimit', () => {
  const options = { limit: 3, windowMs: 60_000 };

  it('allows exactly `limit` requests in a burst, then refuses', () => {
    expect(rateLimit('a', options, 0).ok).toBe(true);
    expect(rateLimit('a', options, 0).ok).toBe(true);
    expect(rateLimit('a', options, 0).ok).toBe(true);
    expect(rateLimit('a', options, 0).ok).toBe(false);
  });

  it('reports how many are left', () => {
    expect(rateLimit('a', options, 0).remaining).toBe(2);
    expect(rateLimit('a', options, 0).remaining).toBe(1);
    expect(rateLimit('a', options, 0).remaining).toBe(0);
  });

  it('tells a refused caller when to come back', () => {
    for (let i = 0; i < 3; i++) rateLimit('a', options, 0);
    const refused = rateLimit('a', options, 0);
    expect(refused.ok).toBe(false);
    // One token refills every windowMs/limit = 20s.
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(20);
  });

  it('refills over time rather than resetting in a block', () => {
    for (let i = 0; i < 3; i++) rateLimit('a', options, 0);
    expect(rateLimit('a', options, 0).ok).toBe(false);

    // A third of the window has passed, so one token is back.
    expect(rateLimit('a', options, 20_000).ok).toBe(true);
    expect(rateLimit('a', options, 20_000).ok).toBe(false);

    // A full window later the bucket is full again.
    expect(rateLimit('a', options, 100_000).ok).toBe(true);
    expect(rateLimit('a', options, 100_000).ok).toBe(true);
    expect(rateLimit('a', options, 100_000).ok).toBe(true);
    expect(rateLimit('a', options, 100_000).ok).toBe(false);
  });

  it('never exceeds capacity however long it has been idle', () => {
    rateLimit('a', options, 0);
    // A year later the bucket must be full, not enormous.
    let allowed = 0;
    for (let i = 0; i < 10; i++) {
      if (rateLimit('a', options, 31_536_000_000).ok) allowed++;
    }
    expect(allowed).toBe(3);
  });

  it('keeps buckets separate per key', () => {
    for (let i = 0; i < 3; i++) rateLimit('a', options, 0);
    expect(rateLimit('a', options, 0).ok).toBe(false);
    // One noisy client must not lock out everybody else at the same event.
    expect(rateLimit('b', options, 0).ok).toBe(true);
  });
});

describe('clientKey', () => {
  /**
   * THIS TEST USED TO PIN THE DEFECT, and that is worth recording rather than quietly rewriting.
   *
   * It asserted the LEFTMOST `x-forwarded-for` entry on the reasoning that "behind a proxy the
   * left-hand entry is the real client". True of a well-behaved proxy — and irrelevant, because the
   * leftmost entry is whatever the CALLER sent. A client rotating that header minted a fresh bucket
   * per request, so the limiter counted to one over and over and never refused anybody.
   *
   * The rightmost entry is the address the nearest trusted proxy actually observed, which is the one
   * value in the chain a client cannot choose. Measured after the fix: three rotated spoofed values
   * collapse to one bucket, where they previously produced three.
   *
   * A test can encode a bug as confidently as it encodes a requirement. This one did, for the same
   * reason the SSRF suite stayed green over a live bypass: it asserted the shape someone expected
   * rather than the property that mattered.
   */
  it('ignores a client-supplied leftmost x-forwarded-for entry', () => {
    const request = new Request('https://example.com', {
      headers: { 'x-forwarded-for': '203.0.113.5, 10.0.0.1, 10.0.0.2' },
    });
    expect(clientKey(request)).toBe('10.0.0.2');
  });

  it('cannot be split into separate buckets by rotating the spoofable entry', () => {
    const spoof = (left: string) =>
      clientKey(
        new Request('https://example.com', {
          headers: { 'x-forwarded-for': `${left}, 10.0.0.1, 10.0.0.2` },
        })
      );
    // The whole point: three different caller-chosen values, one bucket.
    expect(new Set([spoof('1.1.1.1'), spoof('2.2.2.2'), spoof('3.3.3.3')]).size).toBe(1);
  });

  it('prefers a platform-set header over x-forwarded-for entirely', () => {
    const request = new Request('https://example.com', {
      headers: { 'x-forwarded-for': '9.9.9.9', 'x-real-ip': '198.51.100.7' },
    });
    expect(clientKey(request)).toBe('198.51.100.7');
  });

  it('falls back to x-real-ip, then to a constant', () => {
    expect(clientKey(new Request('https://example.com', { headers: { 'x-real-ip': '198.51.100.7' } }))).toBe(
      '198.51.100.7'
    );
    expect(clientKey(new Request('https://example.com'))).toBe('unknown');
  });

  it('namespaces by prefix so two endpoints do not share a bucket', () => {
    const request = new Request('https://example.com', { headers: { 'x-real-ip': '198.51.100.7' } });
    expect(clientKey(request, 'intake')).toBe('intake:198.51.100.7');
    expect(clientKey(request, 'card')).not.toBe(clientKey(request, 'intake'));
  });
});
