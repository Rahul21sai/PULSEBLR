import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';
import Credentials from 'next-auth/providers/credentials';
import connectDB from '@/lib/mongodb';
import User from '@/lib/models/User';
import { isAdminEmail } from '@/lib/admin';
import { devLoginEnabled, devUserId } from '@/lib/dev-login';
import { ensureUser } from '@/lib/user-record';

/**
 * `trustHost: true` below is only safe when the canonical origin is pinned, so refuse to
 * start quietly without it. A production deploy missing NEXTAUTH_URL would let a spoofed
 * Host header into generated links; failing loudly at boot beats discovering that later.
 */
if (process.env.NODE_ENV === 'production' && !process.env.NEXTAUTH_URL && !process.env.AUTH_URL) {
  console.error(
    '[auth] NEXTAUTH_URL is not set in production. Set it to the deployment origin ' +
      '(e.g. https://pulseblr.example.com) — trustHost is enabled, so without a pinned ' +
      'origin Auth.js will infer URLs from the request Host header.'
  );
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),

    /**
     * DEV ONLY. Spread so the array simply does not contain it in production —
     * the provider is absent rather than present-but-refusing, which means there is
     * no endpoint to probe and no code path to get wrong.
     *
     * See lib/dev-login.ts for the two gates. `next build` sets NODE_ENV=production,
     * so a production bundle cannot include this even with DEV_LOGIN=true.
     */
    ...(devLoginEnabled()
      ? [
          Credentials({
            id: 'dev-login',
            name: 'Dev login (local only)',
            credentials: { email: { label: 'Email', type: 'email' } },
            async authorize(credentials) {
              const email = String(credentials?.email || '').trim().toLowerCase();
              // A bare shape check, not authentication. There is nothing to
              // authenticate against — that is the point, and why it cannot ship.
              if (!email || !email.includes('@')) return null;
              console.warn(
                `[dev-login] issuing a session for ${email} WITHOUT verification. ` +
                  'This provider is only registered because NODE_ENV is not production ' +
                  'and DEV_LOGIN=true.'
              );
              return {
                id: devUserId(email),
                email,
                name: email.split('@')[0],
                image: null,
              };
            },
          }),
        ]
      : []),
  ],

  /**
   * REQUIRED to deploy anywhere except Vercel.
   *
   * Auth.js v5 refuses to construct callback URLs from an untrusted Host header, and it
   * auto-trusts only Vercel. Everywhere else — Render, Railway, Fly, Docker, a VPS —
   * every single auth route returns 500 with:
   *
   *   [auth][error] UntrustedHost: Host must be trusted. URL was: <origin>/api/auth/...
   *
   * Reproduced by running `next start` with NODE_ENV=production: /api/auth/providers,
   * /api/auth/csrf and the Google callback all failed, so sign-in was impossible. It is
   * invisible in development because dev mode trusts localhost.
   *
   * SAFETY: `trustHost: true` means Auth.js will believe the Host / X-Forwarded-Host
   * header, which a client can set. That only becomes dangerous if Auth.js has to INFER
   * its base URL, because a spoofed host could then appear in a callback or email link.
   * Setting NEXTAUTH_URL to the canonical origin removes the inference — the explicit
   * value wins — which is why the check below treats a missing NEXTAUTH_URL in
   * production as a real misconfiguration and says so loudly rather than failing quietly.
   */
  trustHost: true,

  session: { strategy: 'jwt' },

  callbacks: {
    // Persist the Google sub + email into the JWT so API routes can use it
    async jwt({ token, account, profile, user }) {
      // Dev-login path: no OIDC `profile`, so take the identity from `user` and upsert
      // the same User document shape the Google path creates.
      if (account?.provider === 'dev-login' && user?.email) {
        token.sub = String(user.id ?? devUserId(user.email));
        token.email = user.email;
        token.name = user.name ?? user.email.split('@')[0];
        token.picture = undefined;
        try {
          await connectDB();
          /**
           * `ensureUser`, not a bare upsert.
           *
           * `User.email` is UNIQUE, and a dev-login googleId is `devlogin:<email>` rather than the
           * Google `sub`. So on an account that has ALSO signed in with real Google,
           * `findOneAndUpdate({ googleId }, { email }, { upsert: true })` throws E11000 every
           * single time — and the old catch here swallowed it, leaving NO user row and a log line
           * nobody reads. Measured: it silently broke `/api/me/card` for the whole session.
           */
          await ensureUser(token.sub, token.email, token.name);
        } catch (err) {
          console.error('Error ensuring dev-login user:', err);
        }
      }

      if (account && profile) {
        token.sub = profile.sub ?? token.sub;
        token.email = profile.email ?? token.email;
        token.name = profile.name ?? token.name;
        token.picture = (profile as { picture?: string }).picture ?? token.picture;

        // Upsert user in MongoDB on first sign-in
        try {
          await connectDB();
          await User.findOneAndUpdate(
            { googleId: token.sub! },
            {
              name: token.name!,
              email: token.email!,
              image: token.picture as string | undefined,
              googleId: token.sub!,
            },
            { upsert: true, new: true }
          );
        } catch (err) {
          console.error('Error upserting user:', err);
        }
      }
      // Recomputed on EVERY call, not just at sign-in, so changing ADMIN_EMAILS takes
      // effect on the next request instead of requiring everyone to sign out. The JWT is
      // long-lived, so a value written once at sign-in would be stale for weeks — and
      // stale in the dangerous direction if an admin is removed from the allowlist.
      token.isAdmin = isAdminEmail(token.email);

      return token;
    },

    // Expose sub, email, image in the client session
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.sub!;
        session.user.email = token.email!;
        session.user.name = token.name ?? '';
        session.user.image = (token.picture as string) ?? '';
        // For hiding admin UI only. Server routes never trust this.
        session.user.isAdmin = token.isAdmin === true;
      }
      return session;
    },
  },

  pages: {
    signIn: '/login',
    error: '/login',
  },
});
