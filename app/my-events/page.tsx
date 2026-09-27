import type { Metadata } from 'next';
import MyEventsClient from './MyEventsClient';

/**
 * `/my-events` — the events you added by hand, with their review status and Edit / Delete.
 *
 * A server shell only so it can carry metadata; the list is client-fetched from `GET /api/me/events`
 * (`requireUser()`), and `ProtectedRouteGate` draws the sign-in wall — `/my-events` is in
 * `PROTECTED_PATHS`. No user data is in this HTML, so the page is safe for the service worker's
 * navigation cache; the data path is network-only (`/api/me/` is in `sw.js`'s `PRIVATE_API`).
 */
export const metadata: Metadata = {
  title: 'My events · PulseBLR',
  robots: { index: false, follow: false },
};

export default function MyEventsPage() {
  return <MyEventsClient />;
}
