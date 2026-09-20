import type { Metadata } from 'next';
import Link from 'next/link';
import { publicSupportEmail } from '@/lib/public-support';

export const metadata: Metadata = {
  title: 'Privacy policy | PulseBLR',
  description: 'How PulseBLR collects, uses, and protects your information.',
};

const sections = [
  {
    title: 'Information you choose to give us',
    body: (
      <>
        <p>
          Google sign-in gives PulseBLR your name, email address, and profile picture, plus the
          Google account identifier needed to recognise the same account later. We do not receive
          your Google password.
        </p>
        <p>
          When you use the product, we store the events you save or track, your feed preferences,
          the contacts you scan or add, and any private notes, follow-up dates, application links,
          or folder names you enter. QR images are decoded in your browser; PulseBLR stores the
          contact details you choose to save, not a continuous camera recording.
        </p>
        <p>
          If a saved contact includes a LinkedIn URL, PulseBLR stores that URL as part of your
          private record. PulseBLR does not sign in to, scrape, or fetch information from LinkedIn.
        </p>
      </>
    ),
  },
  {
    title: 'How we use it',
    body: (
      <>
        <p>
          We use this information to run your event tracker, organise the people you met, rank the
          feed to your preferences, and deliver features you turn on. Those optional features can
          include an email digest, saved-event reminders, push notifications, and a private
          calendar subscription URL.
        </p>
        <p>
          If you ask PulseBLR to draft a follow-up, the contact details and notes needed for that
          draft may be sent to NVIDIA NIM, the configured AI provider. The feature runs only when
          you request it; PulseBLR does not publish the draft or send it to the contact for you.
        </p>
      </>
    ),
  },
  {
    title: 'Event information',
    body: (
      <p>
        PulseBLR collects event listings from public event sources and links back to the original
        organiser or ticket page. Public listing data is separate from your private tracker data.
        An event you add for yourself stays private unless you explicitly submit it for review and
        an administrator publishes it.
      </p>
    ),
  },
  {
    title: 'Services that help operate PulseBLR',
    body: (
      <>
        <p>
          PulseBLR uses Google for sign-in, Vercel to host the application, MongoDB Atlas to store
          application data, and NVIDIA NIM for follow-up drafts you request. If you enable email,
          Resend processes the message and delivery address. If you enable push, browser push
          providers process a device endpoint and the notification. Calendar providers receive
          the events exposed through the secret subscription URL you add to them.
        </p>
        <p>
          These providers receive only the information needed to supply their part of the service.
          PulseBLR does not sell personal information or share your scanned contacts with other
          PulseBLR users.
        </p>
      </>
    ),
  },
  {
    title: 'Security, retention, and your choices',
    body: (
      <>
        <p>
          Private tracker, contact, and preference records are scoped to your signed-in account.
          Calendar links and push endpoints are capability-like credentials: keep a calendar URL
          private, rotate it if it is exposed, and remove notification access from Settings or your
          device at any time.
        </p>
        <p>
          You can delete your account immediately through Settings. The self-service deletion
          removes your account and associated private data in one transaction. Read the{' '}
          <Link href="/delete-account" className="font-semibold text-[var(--accent)] hover:underline">
            account-deletion policy
          </Link>{' '}
          before deleting.
        </p>
        <p>
          Operational audit history that must remain is de-identified: the account identifier and
          email are redacted. PulseBLR cannot recall email already delivered or calendar copies
          already imported by another provider; delete those copies with that provider.
        </p>
      </>
    ),
  },
];

export default function PrivacyPage() {
  const supportEmail = publicSupportEmail();

  return (
    <div className="min-h-screen bg-[var(--paper)] text-[var(--ink)]">
      <header className="rule-b">
        <div className="mx-auto flex h-14 max-w-[900px] items-center justify-between px-5 md:px-8">
          <Link href="/" className="text-[15px] font-bold tracking-[-0.02em] text-[var(--ink)]">
            PulseBLR
          </Link>
          <Link href="/" className="text-[13px] font-semibold text-[var(--accent)] hover:underline">
            Back to events
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-[900px] px-5 py-10 md:px-8 md:py-16">
        <div className="rule-b pb-[var(--s-6)]">
          <p className="ty-meta">Effective 20 September 2026</p>
          <h1 className="t-display mt-[var(--s-2)] text-[var(--ink)]">Privacy policy</h1>
          <p className="ty-body mt-[var(--s-3)] max-w-[66ch] text-[var(--ink-2)]">
            PulseBLR helps people discover Bengaluru tech events and remember the people they meet.
            This page explains what the service handles and the choices available to you.
          </p>
        </div>

        <article className="divide-y divide-[var(--rule)]">
          {sections.map(section => (
            <section key={section.title} className="grid gap-3 py-7 md:grid-cols-[220px_1fr] md:gap-10">
              <h2 className="ty-section text-[var(--ink)]">{section.title}</h2>
              <div className="space-y-3 text-[14px] leading-7 text-[var(--ink-2)]">{section.body}</div>
            </section>
          ))}
        </article>

        <div className="rule-t pt-6 text-[12.5px] leading-relaxed text-[var(--ink-2)]">
          <p>
            We may update this policy when the product or its service providers change. The
            effective date above will change with it.
          </p>
          <p className="mt-2">
            Privacy or account-deletion question? Email{' '}
            <a href={`mailto:${supportEmail}`} className="font-semibold text-[var(--accent)] hover:underline">
              {supportEmail}
            </a>
            .
          </p>
        </div>
      </main>
    </div>
  );
}
