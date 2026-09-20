import type { Metadata } from 'next';
import Link from 'next/link';
import { publicSupportEmail } from '@/lib/public-support';

export const metadata: Metadata = {
  title: 'Delete your PulseBLR account',
  description: 'Delete your PulseBLR account and associated private data.',
};

export default async function DeleteAccountPage({
  searchParams,
}: {
  searchParams: Promise<{ complete?: string }>;
}) {
  const { complete } = await searchParams;
  const supportEmail = publicSupportEmail();
  const completed = complete === '1';

  return (
    <main className="mx-auto min-h-screen max-w-[900px] px-5 py-10 text-[var(--ink)] md:px-8 md:py-16" data-pulseblr-route="delete-account">
      <p className="ty-meta">PulseBLR account controls</p>
      <h1 className="t-display mt-2">
        {completed ? 'Your account was deleted' : 'Delete your account'}
      </h1>
      <p className="ty-body mt-4 text-[var(--ink-2)]">
        {completed
          ? 'PulseBLR removed the account and private data stored for it.'
          : 'Sign in, open Settings, and use Delete account. You will type DELETE before anything is removed.'}
      </p>

      <h2 className="ty-section mt-8">What is removed</h2>
      <p className="mt-3 text-[14px] leading-7 text-[var(--ink-2)]">
        Your profile, preferences, saved and tracked events, submitted events, contacts, people,
        private notes, folders, QR/card and calendar tokens, MCP tokens, push subscriptions,
        reminder records, and digest records are permanently deleted.
      </p>

      <h2 className="ty-section mt-8">What PulseBLR cannot recall</h2>
      <p className="mt-3 text-[14px] leading-7 text-[var(--ink-2)]">
        PulseBLR cannot recall email already delivered to an inbox or calendar copies already
        imported by another provider. Those copies are controlled by those providers; delete them
        there.
      </p>

      <div className="mt-8 flex flex-wrap gap-3">
        {!completed && (
          <Link
            href="/login?callbackUrl=/settings"
            className="rounded-full bg-[var(--ink)] px-5 py-3 text-[13px] font-semibold text-[var(--accent-ink)]"
          >
            Sign in to delete
          </Link>
        )}
        <Link
          href="/settings"
          className="rounded-full border border-[var(--rule)] px-5 py-3 text-[13px] font-semibold"
        >
          Open Settings
        </Link>
      </div>

      <p className="mt-10 text-[13px] text-[var(--ink-2)]">
        Cannot sign in? Email{' '}
        <a
          className="font-semibold text-[var(--accent)]"
          href={`mailto:${supportEmail}`}
        >
          {supportEmail}
        </a>{' '}
        from the Google account you used for PulseBLR.
      </p>
    </main>
  );
}
