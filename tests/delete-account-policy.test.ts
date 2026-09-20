import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import DeleteAccountPage from '../app/delete-account/page';
import { publicSupportEmail } from '../lib/public-support';

afterEach(() => delete process.env.PULSEBLR_SUPPORT_EMAIL);

describe('public account-deletion policy', () => {
  it('publishes the signed-out deletion path, deleted categories, retention boundary, and contact', async () => {
    process.env.PULSEBLR_SUPPORT_EMAIL = 'support@example.test';
    const node = await DeleteAccountPage({ searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(node);
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

    expect(html).toContain('href="/login');
    expect(html).toContain('href="/settings');
    expect(text).toMatch(/contacts|people/i);
    expect(text).toMatch(/saved|tracked events/i);
    expect(text).toMatch(/private notes/i);
    expect(text).toMatch(/calendar|email copies/i);
    expect(html).toContain('mailto:support@example.test');
  });

  it('shows a completion acknowledgement without claiming external copies were recalled', async () => {
    process.env.PULSEBLR_SUPPORT_EMAIL = 'support@example.test';
    const node = await DeleteAccountPage({ searchParams: Promise.resolve({ complete: '1' }) });
    const html = renderToStaticMarkup(node);

    expect(html).toMatch(/account.*deleted/i);
    expect(html).toMatch(/cannot recall/i);
  });
});

describe('publicSupportEmail', () => {
  it('normalizes a configured public address', () => {
    expect(publicSupportEmail({ PULSEBLR_SUPPORT_EMAIL: ' Support@Example.COM ' })).toBe(
      'support@example.com'
    );
  });

  it.each(['', 'not-an-email', 'name@example'])(
    'rejects invalid production contact %j',
    value => {
      expect(() => publicSupportEmail({ PULSEBLR_SUPPORT_EMAIL: value })).toThrow(
        /PULSEBLR_SUPPORT_EMAIL/
      );
    }
  );
});
