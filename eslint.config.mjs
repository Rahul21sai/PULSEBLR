import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // Plain Node maintenance scripts (not part of the bundle) legitimately use
    // CommonJS — they're run directly with `node`, not compiled.
    files: ["scripts/**/*.js"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Agent worktrees (`git worktree` checkouts under `.claude/worktrees/`) are a second
    // copy of this same repo, so linting them is duplicate work — and it FAILS: the
    // `scripts/**/*.js` override above is anchored at the repo root, so the nested
    // `…/worktrees/<id>/scripts/generate-icons.js` misses it and reports two
    // `no-require-imports` errors. That made `npm run lint` exit non-zero purely because a
    // parallel session happened to have a worktree open, on files that `.git/info/exclude`
    // means can never be committed from here anyway.
    ".claude/**",
  ]),
]);

export default eslintConfig;
