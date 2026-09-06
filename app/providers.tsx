'use client';

import { SessionProvider } from 'next-auth/react';
import OutboxOwner from './components/OutboxOwner';

export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      {/*
        Renders nothing. It stamps every offline capture with the account that made it, so
        switching Google accounts on one device cannot upload — or display — the previous
        account's people. See the header of OutboxOwner.tsx.
      */}
      <OutboxOwner />
      {children}
    </SessionProvider>
  );
}
