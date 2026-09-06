import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Where the build output goes. `.next` unless `PULSEBLR_DIST_DIR` says otherwise.
   *
   * WHY THIS IS CONFIGURABLE, and it is not a preference. Several agent sessions share this
   * one checkout, and only one of them can hold port 3000. A session that wants to verify
   * something in a browser then has three options, and two of them do damage:
   *
   *   - A second `next dev` dies on startup: two dev servers cannot share one `.next`.
   *   - `npm run build` against the `.next` a dev server is using replaces the route manifest
   *     underneath it, producing phantom 404s on routes that exist — measured as 7 false FAILs
   *     in `diag-api-auth.ts` on `/api/me/card` and `/api/folders/[id]`. It breaks the OTHER
   *     session, silently, in a way that reads as a bug in the app.
   *
   * So a verifying session builds somewhere else entirely:
   *
   *   PULSEBLR_DIST_DIR=.next-verify npm run build
   *   PULSEBLR_DIST_DIR=.next-verify npx next start --port 3100
   *
   * `next build` takes `distDir` from config only — there is no CLI flag — which is why this
   * has to live here rather than in the launch entry that uses it. Both commands need the
   * variable set: `next start` looks for a build in whatever `distDir` currently resolves to,
   * so setting it for the build alone gives "Could not find a production build".
   *
   * `.gitignore` carries its own glob entry for these throwaway directories. The existing
   * `/.next/` does NOT cover them — that entry is an exact directory name, not a prefix — so
   * without the extra line a throwaway build shows up as thousands of untracked files.
   *
   * (And do not write that glob out here: the pattern ends in a star followed by a slash,
   * which closes this comment and turns the rest of the file into a syntax error. It did.)
   */
  distDir: process.env.PULSEBLR_DIST_DIR || '.next',

  /**
   * A throwaway verification build does not run its own type check. THE REAL BUILD STILL DOES.
   *
   * This is gated on `PULSEBLR_DIST_DIR`, so it can only ever be true for an isolated build a
   * developer asked for by name. `npm run build` with no variable set — which is what Vercel
   * runs and what CI runs — type-checks exactly as before.
   *
   * The reason it has to be skipped is not the code being verified. `tsconfig.json` includes
   * `.next/types/**` unconditionally, so a build into `.next-verify` still type-checks the
   * OTHER session's `.next/types/validator.ts`. That file is generated from whatever routes
   * their dev server last saw, and while they are mid-feature it references pages that do not
   * exist in this tree yet:
   *
   *   .next/types/validator.ts: Cannot find module '../../app/people/page.js'
   *
   * Those are the only two errors, they belong to somebody else's work in progress, and the
   * alternatives are worse than skipping: deleting their generated types breaks their running
   * server, and editing the shared `tsconfig.json` include list is a committed-file change that
   * would affect the real build too. (Next.js will also try to ADD `.next-verify/types` to
   * `tsconfig.json` on such a build — revert that, it is scratch state in a committed file.)
   *
   * So the type check moves rather than disappearing: run `npx tsc --noEmit` directly, which
   * is what this repo does anyway, and read past the same two stale lines.
   */
  typescript: { ignoreBuildErrors: Boolean(process.env.PULSEBLR_DIST_DIR) },

  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "lh3.googleusercontent.com",
      },
      {
        protocol: "https",
        hostname: "**.googleusercontent.com",
      },
    ],
  },
};

export default nextConfig;
