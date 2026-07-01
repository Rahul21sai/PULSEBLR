import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';
import connectDB from '@/lib/mongodb';
import User from '@/lib/models/User';

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
  ],

  session: { strategy: 'jwt' },

  callbacks: {
    // Persist the Google sub + email into the JWT so API routes can use it
    async jwt({ token, account, profile }) {
      if (account && profile) {
        token.sub = profile.sub ?? token.sub;
        token.email = profile.email ?? token.email;
        token.name = profile.name ?? token.name;
        token.picture = (profile as any).picture ?? token.picture;

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
      return token;
    },

    // Expose sub, email, image in the client session
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.sub!;
        session.user.email = token.email!;
        session.user.name = token.name ?? '';
        session.user.image = (token.picture as string) ?? '';
      }
      return session;
    },
  },

  pages: {
    signIn: '/login',
    error: '/login',
  },
});
