import PersonDetailClient from './PersonDetailClient';

/**
 * One person's page.
 *
 * A thin SERVER shell whose only job is to await `params` — a Promise in this Next version — and hand
 * the id to the client component that owns the fetching and the editing.
 *
 * NO USER DATA IS READ HERE, and that is why the shell can be a server component at all. `/people` and
 * everything under it is in `PROTECTED_PATHS`, so `ProtectedRouteGate` (mounted in the root layout,
 * reading the same `useSession()` the API routes see) is what gates the page; every byte of person
 * data arrives from `GET /api/people/[id]`, which runs `requireUser()` and scopes by `userId`. So an
 * anonymous request for this URL gets a shell with an id in it and nothing else — which is the same
 * arrangement `diag-api-auth.ts` asserts for the other client-gated pages, and why a 200 on them is
 * correct.
 */
export default async function PersonPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PersonDetailClient id={id} />;
}
