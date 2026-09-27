import type { Metadata } from 'next';
import Link from 'next/link';
import { publicSupportEmail } from '@/lib/public-support';
import { Items, LegalShell, linkClass, type LegalSection } from './legal-shell';

export const metadata: Metadata = {
  title: 'Privacy policy | PulseBLR',
  description: 'How PulseBLR collects, uses, and protects your information.',
};

/*
 * WHAT THIS PAGE HAS TO BE. The notice India's DPDP Act 2023 and its 2025 Rules (Rule 3) ask for:
 * an ITEMISED list of the personal data, the purpose of each, and how to withdraw consent, use your
 * rights and complain, in plain language. And Google Play's User Data policy: developer
 * information and a privacy contact, every party that receives the data, security, and retention
 * and deletion. Every claim below was checked against the code on 2026-09-28; when a feature
 * changes what it stores or who it sends it to, this page is part of that change.
 */

function sections(supportEmail: string): LegalSection[] {
  const mail = (
    <a href={`mailto:${supportEmail}`} className={linkClass}>
      {supportEmail}
    </a>
  );

  return [
    {
      id: 'who',
      title: 'Who runs PulseBLR',
      body: (
        <p>
          PulseBLR is a free service run by an independent developer based in Bengaluru,
          Karnataka, India. For anything on this page, including privacy requests and complaints,
          email {mail}. That address is also our grievance contact (see{' '}
          <a href="#rights" className={linkClass}>
            your rights
          </a>
          ).
        </p>
      ),
    },
    {
      id: 'collect',
      title: 'Information you choose to give us',
      body: (
        <>
          <p>
            Google sign-in gives PulseBLR your name, email address, and profile picture, plus the
            Google account identifier needed to recognise the same account later. We do not receive
            your Google password. You can browse events without signing in; everything below except
            technical data applies only once you do.
          </p>
          <p>
            When you use the product, we store the events you save or track, your feed preferences,
            the contacts you scan or add, and any private notes, follow-up dates, application links,
            or folder names you enter. Itemised:
          </p>
          <Items>
            <li>
              <strong>Account:</strong> name, email address, profile picture and Google account
              identifier.
            </li>
            <li>
              <strong>Your card</strong> (only if you set it up): the name, headline, company, role,
              LinkedIn, X, GitHub, website, email and phone you choose to show, and whether your
              phone is visible.
            </li>
            <li>
              <strong>Preferences:</strong> topics, areas, event format and times you prefer, digest
              and reminder settings, target companies and your own contact tags.
            </li>
            <li>
              <strong>Events:</strong> events you save or track, with status, notes, dates and
              application links; events you add yourself and whether you submitted them for the
              shared feed.
            </li>
            <li>
              <strong>People you meet:</strong> for each contact, the name, headline, role, company,
              LinkedIn, X, GitHub, website, email and phone you save, your notes, tags, follow-up
              dates, the folder and event, how it was captured, and the text the QR code contained.
            </li>
            <li>
              <strong>Folders:</strong> name, event date, venue, note, and the settings of any
              sign-up link you share.
            </li>
            <li>
              <strong>Notifications:</strong> if you turn on push, your device&apos;s push address and
              keys and your browser&apos;s user-agent string; if you turn on email, a record of each
              email sent (address, events included, time).
            </li>
            <li>
              <strong>Access links and tokens:</strong> your private calendar link, your card link,
              and any assistant (MCP) tokens you create, which are stored only as a one-way hash with
              a short hint and the time last used.
            </li>
            <li>
              <strong>Technical data:</strong> our hosting provider records ordinary request logs,
              including IP address and browser details. The public sign-up form holds your IP address
              in memory briefly to limit abuse; it is not stored with your data.
            </li>
          </Items>
          <p>
            QR images are decoded in your browser; PulseBLR stores the contact details you choose to
            save, not a continuous camera recording or the camera image.
          </p>
          <p>
            If a saved contact includes a LinkedIn URL, PulseBLR stores that URL as part of your
            private record. PulseBLR does not sign in to, scrape, or fetch information from LinkedIn.
          </p>
        </>
      ),
    },
    {
      id: 'use',
      title: 'How we use it',
      body: (
        <>
          <p>
            We use this information to run your event tracker, organise the people you met, rank the
            feed to your preferences, and deliver features you turn on. Those optional features can
            include an email digest, saved-event reminders, push notifications, a public card page,
            and a private calendar subscription URL.
          </p>
          <p>
            If push notifications are on, they are used for two things: a reminder before an event you
            saved, and, the morning after an event where you saved people you have not yet followed up
            with, one notification saying how many. That notification names the event or folder and
            gives a count; it never includes anyone&apos;s name or your notes. You can switch the
            follow-up notification off on its own in Settings.
          </p>
          <p>
            If you ask PulseBLR to draft a follow-up, the contact details and notes needed for that
            draft may be sent to IBM ICA: the contact&apos;s name, company, role and headline, the
            event and date you met, and your notes about them. The feature runs only when you request
            it; PulseBLR does not publish the draft or send it to the contact for you.
          </p>
          <p>
            We process your data because you asked for the service by signing in and turning features
            on. You can withdraw that at any time, as easily as you gave it: turn a feature off in
            Settings, delete a record, or delete your account. PulseBLR does not use your data for
            advertising, does not sell it, and does not use it to train AI models.
          </p>
        </>
      ),
    },
    {
      id: 'contacts',
      title: 'People you add',
      body: (
        <>
          <p>
            The contacts you scan, type in or collect through a folder sign-up link are yours to
            manage. You decide whom to save and why; PulseBLR stores and organises them for you and
            shows them to no other PulseBLR user. Please save only people who shared their details
            with you, let them know you are keeping them, and delete a contact if they ask.
          </p>
          <p>
            Someone who adds themselves through your sign-up link is told that their details go to
            you. If they cannot reach you, they can email {mail} and we will remove what they
            submitted.
          </p>
        </>
      ),
    },
    {
      id: 'events',
      title: 'Event information',
      body: (
        <>
          <p>
            PulseBLR collects event listings from public event sources and links back to the original
            organiser or ticket page. Public listing data is separate from your private tracker data.
            Public event listings may be sent to IBM ICA for extraction and to IBM ICA and/or NVIDIA
            NIM, as configured, for classification and tagging, with Anthropic as a further fallback
            when configured. The title and description of an event you add may be classified the
            same way.
          </p>
          <p>
            An event you add for yourself stays private unless you explicitly submit it for review
            and an administrator publishes it. A published event does not show who added it.
          </p>
        </>
      ),
    },
    {
      id: 'processors',
      title: 'Services that help operate PulseBLR',
      body: (
        <>
          <p>
            PulseBLR uses Google for sign-in, Vercel to host the application, MongoDB Atlas to store
            application data, and IBM ICA for follow-up drafts you request and public listing
            processing. NVIDIA NIM may process configured public listing classification and tagging.
            If you enable email, Resend processes the message and delivery address. If you enable
            push, browser push providers process a device endpoint and the notification. Calendar
            providers receive the events exposed through the secret subscription URL you add to them.
          </p>
          <p>
            If you create an assistant (MCP) token and connect it to an AI assistant such as Claude,
            Cursor or Copilot, that assistant can read the people and events the token allows, and
            its provider handles that under its own terms. You choose whether to do this, and you can
            revoke a token at any time.
          </p>
          <p>
            These providers receive only the information needed to supply their part of the service.
            Some of them may process data outside India. PulseBLR does not sell personal information
            or share your scanned contacts with other PulseBLR users.
          </p>
        </>
      ),
    },
    {
      id: 'third-party-content',
      title: 'Content loaded from other websites',
      body: (
        <>
          <p>
            Some pages make your browser fetch content directly from other services, which receive
            your IP address and browser details, as with any web request:
          </p>
          <Items>
            <li>Google Fonts (fonts.googleapis.com and fonts.gstatic.com), for the icon font.</li>
            <li>
              Event cover images and host photos, loaded from the event platform or organiser that
              published them. PulseBLR links to these images; it does not copy them to its servers.
            </li>
            <li>Your Google profile picture, from Google.</li>
            <li>Google&apos;s sign-in page, when you choose to sign in.</li>
          </Items>
          <p>
            Links to maps, registration and ticket pages open those sites, whose own policies apply.
            PulseBLR embeds no ads, social widgets, videos or analytics.
          </p>
        </>
      ),
    },
    {
      id: 'cookies',
      title: 'Cookies and on-device storage',
      body: (
        <p>
          PulseBLR uses only strictly necessary cookies, to keep you signed in and protect sign-in,
          and on-device storage that keeps unsent scans safe and helps the app load. There are no
          analytics or advertising cookies. The{' '}
          <Link href="/cookies" className={linkClass}>
            cookie and storage list
          </Link>{' '}
          names each one.
        </p>
      ),
    },
    {
      id: 'security',
      title: 'Security, retention, and your choices',
      body: (
        <>
          <p>
            Private tracker, contact, and preference records are scoped to your signed-in account.
            Data travels over encrypted connections. Calendar links and push endpoints are
            capability-like credentials: keep a calendar URL private, rotate it if it is exposed, and
            remove notification access from Settings or your device at any time. Your card link and
            folder sign-up links work for anyone who has them, so share them only as you intend; you
            can switch either off.
          </p>
          <p>
            We keep your data while your account exists, so your tracker and contacts are there when
            you come back. Nothing expires automatically. You can delete individual records at any
            time.
          </p>
          <p>
            You can delete your account immediately through Settings. The self-service deletion
            removes your account and associated private data in one transaction. Read the{' '}
            <Link href="/delete-account" className={linkClass}>
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
    {
      id: 'rights',
      title: 'Your rights',
      body: (
        <>
          <p>Under India&apos;s Digital Personal Data Protection Act, 2023, you can:</p>
          <Items>
            <li>
              <strong>See your data:</strong> everything you have saved is in the app, and your
              contacts can be exported as CSV. For a summary of what we hold, email us.
            </li>
            <li>
              <strong>Correct it:</strong> edit your card, contacts, events and preferences in the
              app, or ask us.
            </li>
            <li>
              <strong>Erase it:</strong> delete records in the app, or delete your account.
            </li>
            <li>
              <strong>Withdraw consent:</strong> turn features off, or delete your account.
            </li>
            <li>
              <strong>Nominate someone</strong> to act for you if you die or cannot act yourself, by
              telling us who.
            </li>
            <li>
              <strong>Complain:</strong> email {mail} from the Google account you use with PulseBLR,
              so we can find your records. We aim to acknowledge a complaint within 24 hours and
              resolve it within 15 days. If you are not satisfied, you can complain to the Data
              Protection Board of India.
            </li>
          </Items>
        </>
      ),
    },
    {
      id: 'children',
      title: 'Children',
      body: (
        <p>
          PulseBLR is for adults going to professional events and is not meant for anyone under 18.
          It does not ask for or check your age. If you believe a child has created an account,
          email {mail} and we will delete it.
        </p>
      ),
    },
  ];
}

export default function PrivacyPage() {
  const supportEmail = publicSupportEmail();

  return (
    <LegalShell
      route="privacy"
      effective="28 September 2026"
      title="Privacy policy"
      intro={
        <p>
          PulseBLR helps people discover Bengaluru tech events and remember the people they meet.
          This page explains what the service handles and the choices available to you. Using
          PulseBLR is also covered by the{' '}
          <Link href="/terms" className={linkClass}>
            terms of use
          </Link>
          .
        </p>
      }
      sections={sections(supportEmail)}
      footer={
        <>
          <p>
            We may update this policy when the product or its service providers change. The
            effective date above will change with it.
          </p>
          <p>
            Privacy or account-deletion question? Email{' '}
            <a href={`mailto:${supportEmail}`} className={linkClass}>
              {supportEmail}
            </a>
            .
          </p>
        </>
      }
    />
  );
}
