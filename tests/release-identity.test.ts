import { afterEach, describe, expect, it } from 'vitest';
import { GET } from '../app/api/release-identity/route';

const originalPulseBlrRelease = process.env.PULSEBLR_RELEASE_COMMIT_SHA;
const originalVercelRelease = process.env.VERCEL_GIT_COMMIT_SHA;

afterEach(() => {
  if (originalPulseBlrRelease === undefined) delete process.env.PULSEBLR_RELEASE_COMMIT_SHA;
  else process.env.PULSEBLR_RELEASE_COMMIT_SHA = originalPulseBlrRelease;
  if (originalVercelRelease === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA;
  else process.env.VERCEL_GIT_COMMIT_SHA = originalVercelRelease;
});

describe('deployed release identity endpoint', () => {
  it('prefers the provider-injected same-build SHA over a manually configured fallback', async () => {
    process.env.PULSEBLR_RELEASE_COMMIT_SHA = '0123456789ABCDEF0123456789ABCDEF01234567';
    process.env.VERCEL_GIT_COMMIT_SHA = 'ffffffffffffffffffffffffffffffffffffffff';

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      commitSha: 'ffffffffffffffffffffffffffffffffffffffff',
    });
  });

  it.each([
    ['missing', undefined],
    ['short', '01234567'],
    ['non-hex', 'z'.repeat(40)],
  ])('fails closed when the deployed commit SHA is %s', async (_label, value) => {
    if (value === undefined) delete process.env.PULSEBLR_RELEASE_COMMIT_SHA;
    else process.env.PULSEBLR_RELEASE_COMMIT_SHA = value;
    delete process.env.VERCEL_GIT_COMMIT_SHA;

    const response = await GET();

    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({ error: 'release identity unavailable' });
  });
});
