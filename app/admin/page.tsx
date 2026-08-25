import { redirect } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@/auth';
import { isAdminConfigured, isAdminEmail } from '@/lib/admin';
import AdminDashboard from './AdminDashboard';

/**
 * /admin — the operator's side of PulseBLR.
 *
 * This is a SERVER component on purpose. proxy.ts can only check that a session cookie
 * exists — it cannot know whether that session belongs to an admin, because the
 * allowlist lives on the server and the proxy runs before any DB/session decode we
 * control. So the real check happens here, before any admin markup is generated, and a
 * non-admin never receives the HTML at all.
 *
 * Every action the dashboard offers is ALSO gated by requireAdmin() in its API route.
 * This page is the "don't show it" layer; the route is the boundary.
 */
export const metadata = {
  title: 'Admin · PulseBLR',
  description: 'Scraper, sources and event administration.',
};

export default async function AdminPage() {
  const session = await auth();

  // Not signed in at all → the normal login flow, returning here afterwards.
  if (!session?.user?.email) redirect('/login?callbackUrl=%2Fadmin');

  // Signed in but not an admin → send them to the product, not to a 403 page. A regular
  // user has no reason to know this route exists.
  if (!isAdminEmail(session.user.email)) redirect('/');

  return (
    <AdminDashboard
      adminEmail={session.user.email}
      adminName={session.user.name || session.user.email}
      configured={isAdminConfigured()}
    />
  );
}

/** Shown by AdminDashboard when a fetch fails; kept here so the import stays server-side. */
export function AdminUnavailable() {
  return (
    <div className="min-h-screen ambient-above flex items-center justify-center p-6">
      <div className="bg-white rounded-2xl card-shadow p-6 max-w-md text-center">
        <h1 className="text-[18px] font-bold text-[#1D1D1F]">Admin is unavailable</h1>
        <p className="text-[13.5px] text-[#6E6E73] mt-1">
          Set <code className="font-mono">ADMIN_EMAILS</code> to enable it.
        </p>
        <Link
          href="/"
          className="inline-block mt-4 px-4 py-2 rounded-full bg-[#0071E3] text-white text-[13px] font-semibold"
        >
          Back to events
        </Link>
      </div>
    </div>
  );
}
