import type { Metadata } from 'next';
import Link from 'next/link';
import { publicSupportEmail } from '@/lib/public-support';
import { LegalShell, linkClass, type LegalSection } from '../privacy/legal-shell';
import { COOKIES, DEVICE_STORAGE, type StorageItem } from './inventory';

export const metadata: Metadata = {
  title: 'Cookies and on-device storage | PulseBLR',
  description: 'Every cookie and piece of on-device storage PulseBLR uses, and why.',
};

function StorageList({ items }: { items: StorageItem[] }) {
  return (
    <dl className="divide-y divide-[var(--rule)] border-y border-[var(--rule)]">
      {items.map(item => (
        <div key={item.name} className="py-3">
          <dt className="break-all font-mono text-[12.5px] font-semibold text-[var(--ink)]">{item.name}</dt>
          <dd className="mt-1">
            <span className="ty-meta">
              {item.kind} · {item.set} · Lasts: {item.lasts}
            </span>
            <span className="mt-1 block">{item.purpose}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

const sections: LegalSection[] = [
  {
    id: 'summary',
    title: 'In short',
    body: (
      <>
        <p>
          PulseBLR uses only what it needs to work: cookies that keep you signed in and protect the
          sign-in flow, and storage on your device that keeps unsent scans safe and makes the app
          open quickly.
        </p>
        <p>
          There are no analytics, advertising or cross-site tracking cookies, and PulseBLR does not
          build a profile of you from your browsing. Because everything listed here is strictly
          necessary for a feature you are using, PulseBLR does not show a cookie consent banner.
          If that ever changes, we will ask before setting anything that is not necessary.
        </p>
      </>
    ),
  },
  {
    id: 'cookies',
    title: 'Cookies',
    body: (
      <>
        <p>
          Set by Auth.js, the sign-in library PulseBLR uses, only on PulseBLR&apos;s own domain. They
          are marked secure and HTTP-only, so page scripts cannot read them. Browsing events without
          signing in does not need any of them.
        </p>
        <StorageList items={COOKIES} />
      </>
    ),
  },
  {
    id: 'device-storage',
    title: 'Storage on your device',
    body: (
      <>
        <p>These stay in your browser or installed app. They are not cookies and are not sent to our server with each request.</p>
        <StorageList items={DEVICE_STORAGE} />
      </>
    ),
  },
  {
    id: 'third-parties',
    title: 'Other websites your browser contacts',
    body: (
      <>
        <p>
          Some pages load content from other services, which receive your IP address and browser
          details as part of any web request, under their own policies. PulseBLR does not add
          tracking to these requests. The{' '}
          <Link href="/privacy#third-party-content" className={linkClass}>
            privacy policy
          </Link>{' '}
          lists them: Google Fonts for the icon font, event cover images and host photos from the
          event platforms that published them, your Google profile picture, Google&apos;s sign-in
          page, and your browser&apos;s push service if you turn on notifications.
        </p>
      </>
    ),
  },
  {
    id: 'control',
    title: 'Your control',
    body: (
      <>
        <p>
          Signing out removes the session cookie and clears the app&apos;s cached pages. You can also
          clear PulseBLR&apos;s site data in your browser settings at any time; if you do, any scan
          that has not uploaded yet is lost, so open Scan or your folders online first. Blocking
          cookies entirely means you cannot sign in, but you can still browse events.
        </p>
      </>
    ),
  },
];

export default function CookiesPage() {
  const supportEmail = publicSupportEmail();

  return (
    <LegalShell
      route="cookies"
      effective="28 September 2026"
      title="Cookies and on-device storage"
      intro={<p>Every cookie and piece of on-device storage PulseBLR uses, what it is for, and how long it lasts.</p>}
      sections={sections}
      footer={
        <p>
          Question about this page? Email{' '}
          <a href={`mailto:${supportEmail}`} className={linkClass}>
            {supportEmail}
          </a>
          .
        </p>
      }
    />
  );
}
