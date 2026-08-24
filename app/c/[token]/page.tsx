import Link from 'next/link';
import type { Metadata } from 'next';
import connectDB from '@/lib/mongodb';
import User from '@/lib/models/User';
import { auth } from '@/auth';
import SaveToFolder from './SaveToFolder';
import type { PublicCardDTO } from '@/lib/contacts/types';

/**
 * PUBLIC — somebody's card, reached by scanning their QR.
 *
 * A SERVER component on purpose, for three reasons:
 *   1. It must render for a visitor with no session and no app. That is the whole point: the
 *      QR encodes a plain https URL so a stock phone camera can open it.
 *   2. It needs `metadata`, which a client component cannot export — this link gets shared.
 *   3. It reads the card directly, so there is no client round trip before the name appears.
 *
 * It is NOT under any path listed in `proxy.ts`'s `PROTECTED`, which is what keeps it public;
 * `scripts/diag-api-auth.ts` asserts that its data endpoint stays reachable signed-out, so
 * accidentally locking it would be caught.
 */

async function loadCard(token: string): Promise<PublicCardDTO | null> {
  if (!token || token.length < 16) return null;

  await connectDB();
  const user = await User.findOne({ 'card.token': token }).select('name card').lean();
  // Same nothing for a wrong token as for a card switched off: which of the two it is would
  // itself say something about somebody.
  if (!user?.card?.enabled) return null;

  const card = user.card;
  return {
    displayName: card.displayName || user.name || 'PulseBLR user',
    headline: card.headline ?? null,
    company: card.company ?? null,
    role: card.role ?? null,
    linkedin: card.linkedin ?? null,
    x: card.x ?? null,
    github: card.github ?? null,
    website: card.website ?? null,
    email: card.email ?? null,
    // Opt-in only. It is the one field people regret publishing.
    phone: card.revealPhone ? card.phone ?? null : null,
  };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const { token } = await params;
  const card = await loadCard(token);
  if (!card) return { title: 'Card not found · PulseBLR', robots: { index: false } };

  return {
    title: `${card.displayName} · PulseBLR`,
    description: [card.role, card.company].filter(Boolean).join(' at ') || 'Contact card',
    // Never indexed. A shareable link to a person's contact details has no business in a
    // search engine, and the token would then be permanently public.
    robots: { index: false, follow: false },
  };
}

export default async function PublicCardPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const card = await loadCard(token);
  const session = await auth();

  if (!card) {
    return (
      <main className="grid min-h-screen place-items-center bg-[#F5F5F7] px-6">
        <div className="max-w-[360px] text-center">
          <span className="material-symbols-outlined text-[40px] text-[#8E8E93]">link_off</span>
          <h1 className="t-title mt-3 text-[#1D1D1F]">That card is not available</h1>
          <p className="mt-2 text-[13.5px] leading-relaxed text-[#6E6E73]">
            The link may have been replaced, or its owner turned the card off. Ask them to show
            you their code again.
          </p>
          <Link
            href="/"
            className="mt-5 inline-flex h-10 items-center rounded-full bg-[#1D1D1F] px-5 text-[13.5px] font-semibold text-white"
          >
            About PulseBLR
          </Link>
        </div>
      </main>
    );
  }

  const links = [
    card.linkedin && { href: card.linkedin, icon: 'work', label: 'LinkedIn', external: true },
    card.phone && { href: `tel:${card.phone}`, icon: 'call', label: card.phone, external: false },
    card.email && { href: `mailto:${card.email}`, icon: 'mail', label: card.email, external: false },
    card.x && { href: `https://x.com/${card.x}`, icon: 'alternate_email', label: `@${card.x}`, external: true },
    card.github && {
      href: `https://github.com/${card.github}`,
      icon: 'code',
      label: card.github,
      external: true,
    },
    card.website && { href: card.website, icon: 'language', label: 'Website', external: true },
  ].filter(Boolean) as Array<{ href: string; icon: string; label: string; external: boolean }>;

  return (
    <main className="min-h-screen bg-[#F5F5F7] px-4 py-10">
      <div className="mx-auto max-w-[420px]">
        <section className="rounded-[22px] bg-white p-6 text-center card-shadow">
          <h1
            className="text-[28px] font-bold leading-tight tracking-[-0.032em] text-[#1D1D1F]"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            {card.displayName}
          </h1>
          {(card.role || card.company) && (
            <p className="mt-1.5 text-[14.5px] text-[#3a3a3c]">
              {[card.role, card.company].filter(Boolean).join(' · ')}
            </p>
          )}
          {card.headline && (
            <p className="mt-2 text-[13.5px] leading-relaxed text-[#6E6E73]">{card.headline}</p>
          )}

          {links.length > 0 && (
            <div className="mt-5 flex flex-col gap-2">
              {links.map(link => (
                <a
                  key={link.label}
                  href={link.href}
                  target={link.external ? '_blank' : undefined}
                  rel={link.external ? 'noopener noreferrer' : undefined}
                  className="flex items-center gap-3 rounded-xl bg-[#F7F7F9] px-4 py-3 text-left text-[13.5px] font-medium text-[#1D1D1F] hover:bg-[#EEEEF0] pressable"
                >
                  <span className="material-symbols-outlined text-[19px] text-[#6E6E73]">
                    {link.icon}
                  </span>
                  <span className="min-w-0 truncate">{link.label}</span>
                </a>
              ))}
            </div>
          )}

          {/**
           * The path for a visitor WITHOUT the app, which is most of them. A .vcf goes straight
           * into the phone's address book.
           */}
          <a
            href={`/api/card/${token}?format=vcf`}
            className="mt-4 inline-flex h-11 w-full items-center justify-center gap-2 rounded-full bg-[#1D1D1F] text-[14px] font-semibold text-white hover:bg-black pressable"
          >
            <span className="material-symbols-outlined text-[18px]">person_add</span>
            Save to contacts
          </a>
        </section>

        {/**
         * THE SWAP. If the visitor also uses PulseBLR they can file this person into one of
         * their own folders, and then show their own code back.
         *
         * Note what this does NOT do: it never writes into the card owner's data. The visitor's
         * save is the visitor's own row, and the "show them my code" button just opens the
         * visitor's own card screen. Both writes are self-owned, so there is no cross-user
         * write and no consent model to get wrong.
         */}
        {session?.user?.id ? (
          <SaveToFolder card={card} />
        ) : (
          <section className="mt-4 rounded-[22px] bg-white p-5 text-center card-shadow">
            <p className="text-[13px] leading-relaxed text-[#6E6E73]">
              PulseBLR finds Bengaluru engineering events worth going to, and keeps track of who
              you met at them.
            </p>
            <Link
              href="/"
              className="mt-3 inline-flex h-10 items-center rounded-full bg-[#F5F5F7] px-5 text-[13px] font-semibold text-[#1D1D1F] hover:bg-[#EEEEF0]"
            >
              Have a look
            </Link>
          </section>
        )}
      </div>
    </main>
  );
}
