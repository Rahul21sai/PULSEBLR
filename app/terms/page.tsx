import type { Metadata } from 'next';
import Link from 'next/link';
import { publicSupportEmail } from '@/lib/public-support';
import { Items, LegalShell, linkClass, type LegalSection } from '../privacy/legal-shell';

export const metadata: Metadata = {
  title: 'Terms of use | PulseBLR',
  description: 'The terms for using PulseBLR, a free Bengaluru tech-events and contacts service.',
};

/*
 * Written to what the product actually does, not to a template: a free service, run by one
 * person, that lists events it gathered from public platforms, lets signed-in people track events
 * and keep the contacts they meet, and accepts user-added events behind admin review. It sells
 * nothing, so the refund section says so rather than inventing a refund process.
 *
 * Nothing here names a company, registration number, postal address or grievance-officer name:
 * those are facts only the owner can supply, and a made-up one is worse than a missing one.
 */

function sections(supportEmail: string): LegalSection[] {
  const mail = (
    <a href={`mailto:${supportEmail}`} className={linkClass}>
      {supportEmail}
    </a>
  );

  return [
    {
      id: 'agreement',
      title: 'These terms',
      body: (
        <>
          <p>
            These terms apply when you use PulseBLR on the web or as an installed app. PulseBLR is a
            free service run by an independent developer based in Bengaluru, Karnataka, India
            (&ldquo;we&rdquo;). By signing in, you agree to these terms and to the{' '}
            <Link href="/privacy" className={linkClass}>
              privacy policy
            </Link>
            . If you do not agree, do not sign in; you can still browse events.
          </p>
        </>
      ),
    },
    {
      id: 'service',
      title: 'What PulseBLR is',
      body: (
        <p>
          PulseBLR lists Bengaluru tech events gathered from public event platforms, and lets
          signed-in people save and track events, add their own, and keep a private record of the
          people they meet. It is provided free of charge and may change as it develops.
        </p>
      ),
    },
    {
      id: 'eligibility',
      title: 'Who can use it',
      body: (
        <p>
          You must be at least 18 to create an account. You sign in with your own Google account,
          and you are responsible for what happens under it, including any calendar links, card
          links, sign-up links and assistant (MCP) tokens you create. Keep those private and revoke
          any that are exposed.
        </p>
      ),
    },
    {
      id: 'listings',
      title: 'Event listings and images',
      body: (
        <>
          <p>
            Listings are collected automatically from public sources such as event platforms and
            organiser pages, and each links to where it came from. Organisers change, move and
            cancel events, and automated collection makes mistakes, so PulseBLR does not guarantee
            that any listing is accurate, current, complete or genuinely in Bengaluru. Check the
            original page before you register, pay or travel. Rankings such as &ldquo;best for
            connections&rdquo; are automatic estimates, not endorsements, and PulseBLR is not the
            organiser of any listed event.
          </p>
          <p>
            Event titles, descriptions, cover images, logos and host photos belong to their owners.
            PulseBLR shows them to identify the event and point you to its source, and loads images
            from where they were published rather than copying them. If you own content shown here
            and want it corrected or removed, email {mail} with the page link, and we will act on it
            promptly.
          </p>
        </>
      ),
    },
    {
      id: 'user-events',
      title: 'Events you add',
      body: (
        <p>
          An event you add is private to you unless you submit it for the shared feed. If you
          submit one, you confirm that it is a real event, that the details are accurate, and that
          you may share them. An administrator reviews submissions and may publish, decline or later
          remove one; editing a published event sends it back for review. By submitting, you let us
          show that event to everyone using PulseBLR for as long as it is listed.
        </p>
      ),
    },
    {
      id: 'your-content',
      title: 'Your content',
      body: (
        <p>
          You own what you put into PulseBLR: your notes, contacts, folders and events. You give us
          permission to store and process it only to run the service for you, as the privacy policy
          describes. You can delete it, or your whole account, at any time.
        </p>
      ),
    },
    {
      id: 'contacts',
      title: 'People you save',
      body: (
        <p>
          You are responsible for the personal details you save about other people, whether you
          scan them, type them in or collect them through a sign-up link. Save only details people
          chose to share with you, use them only to stay in touch, and delete a person&apos;s record if
          they ask.
        </p>
      ),
    },
    {
      id: 'acceptable-use',
      title: 'Acceptable use',
      body: (
        <>
          <p>When you use PulseBLR, do not:</p>
          <Items>
            <li>
              scrape, crawl or bulk-download PulseBLR, or overload it, other than through the
              assistant (MCP) connection within its intended use;
            </li>
            <li>
              send spam, false entries or anyone else&apos;s details through a folder sign-up link;
            </li>
            <li>impersonate another person or organisation, or submit fake events;</li>
            <li>
              post content that is unlawful, defamatory, obscene, hateful, harassing, misleading,
              infringing someone else&apos;s rights, or harmful to children;
            </li>
            <li>
              try to reach other people&apos;s data, get around sign-in or access controls, probe for
              security weaknesses without permission, or upload malicious code;
            </li>
            <li>use the service in a way that breaks any law that applies to you.</li>
          </Items>
          <p>Found a security problem? Please email {mail} rather than testing it further.</p>
        </>
      ),
    },
    {
      id: 'payments',
      title: 'Payments and refunds',
      body: (
        <p>
          PulseBLR is free. It sells nothing, has no subscriptions or in-app purchases, and takes no
          payments, so there is nothing to refund. Tickets for listed events are sold by the event
          organiser or the platform the listing links to; their prices, refund and cancellation
          terms apply, and any refund must be requested from them.
        </p>
      ),
    },
    {
      id: 'third-party',
      title: 'Other services',
      body: (
        <p>
          PulseBLR links to event platforms, maps, ticketing sites and profiles, and relies on
          services such as Google sign-in. Those services are run by others under their own terms,
          and we are not responsible for them.
        </p>
      ),
    },
    {
      id: 'termination',
      title: 'Suspension and ending',
      body: (
        <>
          <p>
            You can stop using PulseBLR and{' '}
            <Link href="/delete-account" className={linkClass}>
              delete your account
            </Link>{' '}
            at any time. We may remove content, or suspend or close an account, that breaks these
            terms or the law, or to protect other users. We may also change or stop the service;
            if we stop it, we will try to give reasonable notice so you can export your contacts.
          </p>
        </>
      ),
    },
    {
      id: 'disclaimer',
      title: 'No warranty',
      body: (
        <p>
          PulseBLR is provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo;. We work to keep it
          running and your data safe, but we do not promise it will always be available, error-free
          or that offline captures will always upload. Keep your own copy of anything you cannot
          afford to lose; your contacts can be exported as CSV.
        </p>
      ),
    },
    {
      id: 'liability',
      title: 'Limitation of liability',
      body: (
        <p>
          To the extent the law allows, we are not liable for indirect or consequential loss, or for
          loss arising from inaccurate listings, events that change or are cancelled, other
          services, or your use of the contacts you save. Nothing in these terms limits a liability
          that cannot be limited under Indian law.
        </p>
      ),
    },
    {
      id: 'law',
      title: 'Governing law',
      body: (
        <p>
          These terms are governed by the laws of India. Courts in Bengaluru, Karnataka have
          jurisdiction over any dispute about them.
        </p>
      ),
    },
    {
      id: 'grievances',
      title: 'Complaints and contact',
      body: (
        <p>
          For a complaint about content on PulseBLR, a request to remove something, or any question
          about these terms, email {mail}. We aim to acknowledge a complaint within 24 hours and
          resolve it within 15 days.
        </p>
      ),
    },
  ];
}

export default function TermsPage() {
  const supportEmail = publicSupportEmail();

  return (
    <LegalShell
      route="terms"
      effective="28 September 2026"
      title="Terms of use"
      intro={<p>The rules for using PulseBLR, in plain language.</p>}
      sections={sections(supportEmail)}
      footer={
        <>
          <p>
            We may update these terms as the service changes. The effective date above will change
            with them, and continuing to use PulseBLR after a change means you accept the new terms.
          </p>
          <p>
            Question about these terms? Email{' '}
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
