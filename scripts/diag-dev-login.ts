#!/usr/bin/env tsx
/**
 * Assert the dev-only sign-in CANNOT be active in production.
 *
 * lib/dev-login.ts registers an unauthenticated NextAuth Credentials provider so the
 * tracker can be exercised without Google OAuth. That is an authentication bypass by
 * construction, and it is only acceptable because it is impossible to enable in a
 * production build. "Impossible" needs a test, not a comment.
 *
 * The truth table below is the whole safety argument: the provider is active only when
 * NODE_ENV is not 'production' AND DEV_LOGIN is exactly 'true'. `next build` sets
 * NODE_ENV=production, so a shipped bundle fails the first condition regardless of the
 * second.
 *
 * No network, no database.
 *
 * Run: npx tsx scripts/diag-dev-login.ts
 */
import { devLoginEnabled, devUserId } from '../lib/dev-login';

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
}

/** Evaluate devLoginEnabled() under a specific env, then restore. */
function under(nodeEnv: string | undefined, devLogin: string | undefined): boolean {
  const prevNode = process.env.NODE_ENV;
  const prevFlag = process.env.DEV_LOGIN;
  try {
    // NODE_ENV is readonly in the Node types but writable at runtime, which is exactly
    // what has to be exercised here.
    (process.env as Record<string, string | undefined>).NODE_ENV = nodeEnv;
    (process.env as Record<string, string | undefined>).DEV_LOGIN = devLogin;
    return devLoginEnabled();
  } finally {
    (process.env as Record<string, string | undefined>).NODE_ENV = prevNode;
    (process.env as Record<string, string | undefined>).DEV_LOGIN = prevFlag;
  }
}

console.log('Dev-login gate — truth table\n');

// The one and only combination that may enable it.
check("development + DEV_LOGIN=true  -> ENABLED", under('development', 'true') === true);

// Everything else must be off.
check("PRODUCTION + DEV_LOGIN=true   -> disabled", under('production', 'true') === false,
  'the case that matters: a deployed build with the flag set');
check("PRODUCTION + DEV_LOGIN unset  -> disabled", under('production', undefined) === false);
check("PRODUCTION + DEV_LOGIN=false  -> disabled", under('production', 'false') === false);
check("development + DEV_LOGIN unset -> disabled", under('development', undefined) === false,
  'absent from .env.example, so this is the default for any fresh clone');
check("development + DEV_LOGIN=false -> disabled", under('development', 'false') === false);
check("development + DEV_LOGIN=TRUE  -> disabled", under('development', 'TRUE') === false,
  'exact string match only — no truthy coercion');
check("development + DEV_LOGIN=1     -> disabled", under('development', '1') === false);
check("test + DEV_LOGIN=true         -> enabled", under('test', 'true') === true,
  'CI may legitimately need it; still never production');

console.log('\nSynthetic ids are unmistakable\n');
const id = devUserId('Someone@Example.COM');
check('dev ids are prefixed', id.startsWith('devlogin:'), id);
check('dev ids are lower-cased', id === 'devlogin:someone@example.com', id);
check(
  'a dev id can never collide with a Google sub',
  !/^\d+$/.test(id),
  'Google subs are all digits, so a prefixed id cannot be mistaken for one'
);

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
