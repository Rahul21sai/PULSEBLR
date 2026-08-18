// Module augmentation for NextAuth v5.
//
// `isAdmin` is surfaced on the session so client components can hide controls the user
// cannot use. It is NOT the security boundary — every admin action is gated server-side
// by requireAdmin() in lib/api-auth.ts, and /admin re-checks on the server. A client
// flag is trivially editable in devtools; treating it as authorisation would be a hole.

import type { DefaultSession } from 'next-auth';

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      isAdmin: boolean;
    } & DefaultSession['user'];
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    isAdmin?: boolean;
  }
}
