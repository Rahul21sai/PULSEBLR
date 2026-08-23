#!/usr/bin/env tsx
/**
 * Is this deployable RIGHT NOW, and what exactly is missing?
 *
 * Every failure this checks for is invisible in development and fatal in production. That is the
 * whole reason it exists — "works on localhost" is not evidence about a deploy.
 *
 * The one that has actually bitten this project (documented in CLAUDE.md and reproduced with
 * `next start` under NODE_ENV=production): Auth.js v5 auto-trusts only Vercel, so on any other
 * host with `NEXTAUTH_URL` unset, `/api/auth/providers`, `/api/auth/csrf` and the Google callback
 * ALL return 500 with `UntrustedHost: Host must be trusted`. Sign-in becomes impossible. Dev mode
 * trusts localhost, so nothing warns you until users cannot log in.
 *
 * Checks are grouped by consequence, and each says what breaks rather than just naming a variable:
 *   FATAL   — the deploy will not work at all
 *   DEGRADED— it will run with a feature silently off
 *   SECURITY— it will run, insecurely
 *
 * Reads env and files only. No network, no DB, no writes. Safe to run in CI.
 *
 * Run: npx tsx scripts/diag-deploy-readiness.ts
 */
import './load-env';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

type Level = 'FATAL' | 'DEGRADED' | 'SECURITY' | 'OK';
interface Check {
  level: Level;
  label: string;
  ok: boolean;
  /** What breaks, in the user's terms, when this is not satisfied. */
  consequence: string;
  hint?: string;
  /** True when failing this is EXPECTED and correct in a local dev environment. */
  devExempt?: boolean;
}

const checks: Check[] = [];
const has = (name: string) => Boolean(process.env[name]?.trim());

/**
 * Is this a local development environment rather than a loaded production one?
 *
 * This distinction is not cosmetic, it decides whether the output is honest. Locally,
 * `DEV_LOGIN=true` and `NEXTAUTH_URL=http://localhost:3000` are CORRECT — they are what makes
 * the dev-only sign-in and `scripts/diag-tracker-flow.ts` work. A first version of this script
 * reported both as SECURITY failures on every local run, which is how a checklist teaches people
 * to ignore it. So in a dev environment those two are reported as "would fail in production"
 * rather than as current defects, and they stop gating the exit code.
 */
const LOCAL_DEV =
  process.env.NODE_ENV !== 'production' &&
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test((process.env.NEXTAUTH_URL || '').trim());

function check(
  level: Level,
  label: string,
  ok: boolean,
  consequence: string,
  hint?: string,
  devExempt?: boolean
) {
  checks.push({ level, label, ok, consequence, hint, devExempt });
}

// ── FATAL: the app will not function ────────────────────────────────────────
check(
  'FATAL',
  'MONGODB_URI',
  has('MONGODB_URI'),
  'Every page that lists events returns an error; the corpus is unreachable.',
  'An Atlas SRV string. Whitelist the host or use 0.0.0.0/0 for serverless.'
);
check(
  'FATAL',
  'NEXTAUTH_SECRET',
  has('NEXTAUTH_SECRET'),
  'JWT sessions cannot be signed or verified — nobody stays signed in.',
  'openssl rand -base64 32'
);
check(
  'FATAL',
  'NEXTAUTH_URL',
  has('NEXTAUTH_URL'),
  'THE documented production failure: Auth.js v5 auto-trusts only Vercel, so elsewhere every ' +
    '/api/auth/* route returns 500 (UntrustedHost) and sign-in is impossible. Invisible in dev, ' +
    'which trusts localhost.',
  'The full deployed origin, e.g. https://pulseblr.vercel.app — no trailing slash.'
);
check(
  'FATAL',
  'GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET',
  has('GOOGLE_CLIENT_ID') && has('GOOGLE_CLIENT_SECRET'),
  'The only real sign-in method is gone, so the tracker, dashboard and settings are unreachable.',
  'Authorised redirect URI must be <NEXTAUTH_URL>/api/auth/callback/google — exactly.'
);

// ── SECURITY: it runs, but wrongly ──────────────────────────────────────────
check(
  'SECURITY',
  'ADMIN_EMAILS',
  has('ADMIN_EMAILS'),
  'requireAdmin() FAILS CLOSED, so every admin route returns 503 and /admin is unusable. Not ' +
    'insecure — but a 503 from /api/scrape is then a config problem, not a bug. Google sign-in ' +
    'is open to anyone, so this allowlist is the only thing separating an operator from a stranger.',
  'Comma-separated Google account emails.'
);
check(
  'SECURITY',
  'DEV_LOGIN must be unset or false',
  !has('DEV_LOGIN') || process.env.DEV_LOGIN !== 'true',
  'The dev-only credentials provider would let anyone sign in as any user. lib/dev-login.ts also ' +
    'requires NODE_ENV !== production, so it cannot actually activate on a real deploy — but two ' +
    'guards are the point.',
  'Delete it from the production environment entirely.',
  true // correct to have DEV_LOGIN=true locally; it is what diag-tracker-flow.ts needs
);
if (has('NEXTAUTH_URL')) {
  const url = process.env.NEXTAUTH_URL!.trim();
  check(
    'SECURITY',
    'NEXTAUTH_URL is https and has no trailing slash',
    /^https:\/\//.test(url) && !url.endsWith('/'),
    'auth.ts sets trustHost: true, which without a correctly pinned origin lets a spoofed Host ' +
      'header into generated links. A trailing slash produces double-slash callback URLs that ' +
      'will not match the Google console entry.',
    `currently: ${url}`,
    true // http://localhost:3000 is the correct value for local development
  );
}

// ── DEGRADED: runs with a feature silently off ──────────────────────────────
check(
  'DEGRADED',
  'RESEND_API_KEY',
  has('RESEND_API_KEY'),
  'The daily digest generates but is never emailed. The in-app view still works.',
  'Optional. Leave unset if you do not want email.'
);
const llm = ['ICA_API_KEY', 'NVIDIA_API_KEY', 'ANTHROPIC_API_KEY'].filter(has);
check(
  'DEGRADED',
  'at least one LLM provider',
  llm.length > 0,
  'Tagging falls back to the keyword floor for every event. The pipeline still runs and nothing ' +
    'is dropped, but isTechEvent and categories get noticeably coarser.',
  llm.length > 0 ? `configured: ${llm.join(', ')}` : 'ICA_API_KEY / NVIDIA_API_KEY / ANTHROPIC_API_KEY'
);

// ── Repo-level readiness, not env ───────────────────────────────────────────
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  scripts?: Record<string, string>;
};
check(
  'FATAL',
  'a build script exists',
  Boolean(pkg.scripts?.build),
  'No host can build the app.'
);
check(
  'DEGRADED',
  'CI workflow present',
  existsSync(join(ROOT, '.github/workflows/ci.yml')),
  'Nothing stops a broken commit from being deployed.'
);
check(
  'DEGRADED',
  'a test suite exists and is wired to npm test',
  Boolean(pkg.scripts?.test) && existsSync(join(ROOT, 'tests')),
  'Regressions in scoring, dedup keys, the SSRF guard and the taxonomy would ship silently.'
);
check(
  'DEGRADED',
  'host config committed (vercel.json or Dockerfile)',
  existsSync(join(ROOT, 'vercel.json')) || existsSync(join(ROOT, 'Dockerfile')),
  'Region, framework and build settings are then whatever the host guesses. For this app the ' +
    'region matters: users, the Atlas cluster and every date format are India-region.'
);
check(
  'SECURITY',
  '.env.local is gitignored',
  readFileSync(join(ROOT, '.gitignore'), 'utf8').includes('.env'),
  'Real credentials would be committed.'
);
check(
  'SECURITY',
  'DEV_LOGIN absent from .env.example',
  !existsSync(join(ROOT, '.env.example')) ||
    !readFileSync(join(ROOT, '.env.example'), 'utf8').includes('DEV_LOGIN'),
  'Documenting the dev-only bypass in the example file invites someone to copy it into production.'
);

// ── Report ──────────────────────────────────────────────────────────────────
const order: Level[] = ['FATAL', 'SECURITY', 'DEGRADED'];
console.log('\nDEPLOY READINESS\n' + '─'.repeat(78));
console.log(
  LOCAL_DEV
    ? 'Reading a LOCAL DEVELOPMENT environment, so this is a CHECKLIST for the host, not a\n' +
        'verdict on it. Two items are deliberately exempt here — DEV_LOGIN and a localhost\n' +
        'NEXTAUTH_URL are CORRECT locally and are what the dev-only sign-in needs.'
    : 'Reading a PRODUCTION-shaped environment. Everything below is a verdict.'
);

let fatal = 0;
let security = 0;
let degraded = 0;
let deferred = 0;

for (const level of order) {
  const group = checks.filter(c => c.level === level);
  if (group.length === 0) continue;
  console.log(`\n${level}`);
  for (const c of group) {
    const exempt = !c.ok && c.devExempt && LOCAL_DEV;
    const mark = c.ok ? 'ok  ' : exempt ? 'prod' : 'MISS';
    console.log(`  ${mark}  ${c.label}`);
    if (exempt) {
      console.log(`        correct locally — SET THIS ON THE HOST: ${c.hint ?? ''}`);
      deferred++;
      continue;
    }
    if (!c.ok) {
      console.log(`        breaks: ${c.consequence}`);
      if (c.hint) console.log(`        fix:    ${c.hint}`);
      if (level === 'FATAL') fatal++;
      else if (level === 'SECURITY') security++;
      else degraded++;
    } else if (c.hint && /currently|configured/.test(c.hint)) {
      console.log(`        ${c.hint}`);
    }
  }
}

console.log('\n' + '─'.repeat(78));
console.log(`FATAL ${fatal}   SECURITY ${security}   DEGRADED ${degraded}   deferred-to-host ${deferred}`);

if (fatal === 0 && security === 0) {
  console.log(
    LOCAL_DEV
      ? `\nRepo is deploy-ready. ${deferred} item(s) must be set on the host — they cannot be\n` +
          'satisfied from here, and the app WILL break in production if they are not:\n' +
          '  · NEXTAUTH_URL = the real https origin (else every /api/auth/* returns 500)\n' +
          '  · DEV_LOGIN    = absent\n' +
          'Re-run this with production values loaded to get an actual verdict.'
      : '\nDeployable. Degraded items are optional features, not blockers.'
  );
} else {
  console.log('\nNOT deployable as configured — resolve FATAL and SECURITY first.');
}

// A local run must not fail CI for having a correct local config. Only real problems gate.
process.exit(fatal + security === 0 ? 0 : 1);
