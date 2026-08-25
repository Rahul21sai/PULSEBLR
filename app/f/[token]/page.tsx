import Link from 'next/link';
import type { Metadata } from 'next';
import connectDB from '@/lib/mongodb';
import Folder from '@/lib/models/Folder';
import IntakeForm from './IntakeForm';

/**
 * PUBLIC — "add yourself to this folder".
 *
 * The folder-QR mode: you show one code, several people scan it at once, each types three
 * fields, and everyone lands in the right folder without you typing anything.
 *
 * A server component so it renders for somebody with no session and no app, and so the folder
 * name appears immediately rather than after a client fetch.
 *
 * DELIBERATELY MINIMAL DISCLOSURE. The page shows the folder's NAME and nothing else — not who
 * owns it, not who else has signed up, not how many. The token grants exactly one capability:
 * append one row.
 */

interface ResolvedFolder {
  name: string;
  venue?: string | null;
}

async function loadFolder(token: string): Promise<ResolvedFolder | null> {
  if (!token || token.length < 16) return null;

  await connectDB();
  const folder = await Folder.findOne({ intakeToken: token }).select('name venue intakeEnabled intakeExpiresAt').lean();
  if (!folder?.intakeEnabled) return null;
  // Expiry is checked here as well as in the POST handler, so an expired link explains itself
  // instead of failing only after somebody has typed their details in.
  if (folder.intakeExpiresAt && new Date(folder.intakeExpiresAt).getTime() < Date.now()) return null;

  return { name: folder.name, venue: folder.venue ?? null };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const { token } = await params;
  const folder = await loadFolder(token);
  return {
    title: folder ? `Add yourself · ${folder.name}` : 'Link not active · PulseBLR',
    // Never indexed: it is a write capability with a token in the URL.
    robots: { index: false, follow: false },
  };
}

export default async function IntakePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const folder = await loadFolder(token);

  if (!folder) {
    return (
      <main className="grid min-h-screen place-items-center ambient-above px-6">
        <div className="max-w-[360px] text-center">
          <span aria-hidden="true" className="material-symbols-outlined text-[40px] text-[#8E8E93]">link_off</span>
          <h1 className="t-title mt-3 text-[#1D1D1F]">This link is not active</h1>
          <p className="mt-2 text-[13.5px] leading-relaxed text-[#6E6E73]">
            Sign-up links expire after the event, and can be switched off at any time. Ask for a
            fresh code, or just swap LinkedIn details the usual way.
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

  return (
    <main className="min-h-screen ambient-above px-4 py-10">
      <div className="mx-auto max-w-[420px]">
        <div className="mb-5 text-center">
          <p className="t-label text-[#8E8E93]">You&apos;re adding yourself to</p>
          <h1
            className="mt-1.5 text-[26px] font-bold leading-tight tracking-[-0.03em] text-[#1D1D1F]"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            {folder.name}
          </h1>
          {folder.venue && <p className="mt-1 text-[13px] text-[#6E6E73]">{folder.venue}</p>}
        </div>

        <IntakeForm token={token} folderName={folder.name} />

        <p className="mt-4 px-2 text-center text-[11.5px] leading-relaxed text-[#8E8E93]">
          What you enter goes to the person who showed you this code, so they remember who they
          met. It is not published anywhere and nobody else can read this folder.
        </p>
      </div>
    </main>
  );
}
