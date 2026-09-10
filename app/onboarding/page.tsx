import { Suspense } from 'react';
import type { Metadata } from 'next';
import OnboardingFlow from './OnboardingFlow';

/**
 * `/onboarding` — the three preference cards, and also the editor `/settings` links to.
 *
 * ── WHY THE SUSPENSE BOUNDARY IS NOT OPTIONAL. ───────────────────────────────────────────────
 * `OnboardingFlow` calls `useSearchParams()` to read `?from=settings`. In the App Router that
 * opts the subtree into client-side rendering during prerender, and without a boundary the whole
 * ROUTE deopts — the build reports it and the page renders nothing until the client bundle lands.
 * The fallback here is what the reader sees for that moment, so it is shaped like the real thing
 * (progress bar, heading block, a card of chips) rather than a spinner: `.skeleton` already exists
 * and globals.css's rule is skeletons, never spinners.
 *
 * ── THE SIGNED-IN GATE IS `ProtectedRouteGate`, VIA `lib/protected-routes.ts`. ───────────────
 * `/onboarding` is listed there, so an anonymous visitor gets the shared "Sign in to continue"
 * panel rather than a form whose every save would 401. It is not gated here in a server component
 * the way `/admin` is, because there is nothing privileged in the MARKUP — the preferences arrive
 * from `GET /api/me/preferences`, which enforces `requireUser()` itself. That is the real boundary;
 * this decides what to draw.
 */
export const metadata: Metadata = {
  title: 'Set up your feed · PulseBLR',
  description:
    'Tell PulseBLR which topics, areas and evenings work for you, and the feed ranks Bengaluru tech events accordingly.',
  // Nothing here is worth indexing and it is per-user by definition.
  robots: { index: false, follow: false },
};

export default function OnboardingPage() {
  return (
    <div className="min-h-screen bg-[#F5F5F7]">
      <Suspense fallback={<OnboardingSkeleton />}>
        <OnboardingFlow />
      </Suspense>
    </div>
  );
}

function OnboardingSkeleton() {
  return (
    <div className="mx-auto max-w-[640px] px-4 pb-28 pt-6 md:pt-10">
      <div className="flex items-center gap-1.5" aria-hidden="true">
        {[0, 1, 2].map(i => (
          <span
            key={i}
            className={`h-[3px] flex-1 rounded-full ${
              i === 0 ? 'bg-[#1D1D1F]' : 'bg-[color:var(--hairline-strong)]'
            }`}
          />
        ))}
      </div>
      <div className="skeleton mt-5 h-3 w-20 rounded" />
      <div className="skeleton mt-3 h-8 w-3/4 rounded" />
      <div className="skeleton mt-3 h-4 w-full rounded" />
      <div className="skeleton mt-1.5 h-4 w-2/3 rounded" />
      <div className="mt-6 rounded-[18px] bg-white card-shadow p-5">
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: 10 }, (_, i) => (
            <span key={i} className="skeleton h-9 w-24 rounded-full" />
          ))}
        </div>
      </div>
    </div>
  );
}
