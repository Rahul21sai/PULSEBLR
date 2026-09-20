import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LoginPage from '../app/login/page';
import PrivacyPage from '../app/privacy/page';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('next-auth/react', () => ({
  signIn: vi.fn(),
  useSession: () => ({ data: null, status: 'unauthenticated', update: vi.fn() }),
}));

afterEach(() => delete process.env.PULSEBLR_SUPPORT_EMAIL);

describe('privacy policy', () => {
  it('publishes the disclosures a PulseBLR user needs before signing in', () => {
    process.env.PULSEBLR_SUPPORT_EMAIL = 'support@example.test';
    const html = renderToStaticMarkup(createElement(PrivacyPage));
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

    expect(text).toMatch(/Google sign-in/i);
    expect(text).toMatch(/name, email address, and profile (photo|picture)/i);
    expect(text).toMatch(/events you (save|track)/i);
    expect(text).toMatch(/contacts? you (scan|add)/i);
    expect(text).toMatch(/private notes?/i);
    expect(text).toMatch(/does not.*(scrape|fetch).*LinkedIn/i);
    expect(text).toMatch(/email digest/i);
    expect(text).toMatch(/push notifications?/i);
    expect(text).toMatch(/calendar subscription/i);
    expect(text).toMatch(/public event sources?/i);
    expect(text).toMatch(/delete your account/i);
    expect(html).toContain('href="/delete-account"');
    expect(html).toContain('mailto:support@example.test');
    expect(text).toMatch(/NVIDIA NIM/i);
    expect(text).toMatch(/Google/i);
    expect(text).toMatch(/Vercel/i);
    expect(text).toMatch(/MongoDB Atlas/i);
    expect(text).toMatch(/Resend/i);
    expect(text).toMatch(/browser.*push/i);
    expect(text).toMatch(/calendar provider/i);
    expect(text).toMatch(/immediately/i);
    expect(text).toMatch(/audit.*(redact|de-?identif)/i);
    expect(text).toMatch(/email.*delivered|calendar.*imported/i);
  });

  it('links the sign-in legal copy to privacy and public account deletion', () => {
    const html = renderToStaticMarkup(createElement(LoginPage));

    expect(html).toContain('href="/privacy"');
    expect(html).toContain('href="/delete-account"');
  });
});
