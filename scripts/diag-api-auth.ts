#!/usr/bin/env tsx
/**
 * Hit every mutating endpoint WITHOUT credentials and assert it refuses.
 *
 * This is the regression test for the session's highest-severity finding: six endpoints
 * accepted unauthenticated writes because proxy.ts's matcher excludes `api`, so the
 * proxy never runs for an API route and each handler was the only possible guard.
 *
 * Payloads are chosen so that a FAILURE here cannot itself damage data — non-existent
 * ObjectIds and empty bodies. What matters is the status code: 401/403/503 means the
 * guard ran, while 400/404/200 means the request reached the handler body.
 *
 * Needs a dev server on http://localhost:3000. No database writes if the guards work.
 *
 * Run: npx tsx scripts/diag-api-auth.ts
 */
const BASE = process.env.PULSEBLR_BASE_URL || 'http://localhost:3000';

/** An id that is valid ObjectId syntax but cannot exist. */
const GHOST = '000000000000000000000000';

interface Case {
  method: string;
  path: string;
  body?: unknown;
  why: string;
}

const MUST_REFUSE: Case[] = [
  { method: 'POST', path: '/api/events', body: {}, why: 'create a global event (renders applyLink into an href)' },
  { method: 'PUT', path: `/api/events/${GHOST}`, body: { title: 'x' }, why: 'rewrite any event' },
  { method: 'DELETE', path: `/api/events/${GHOST}`, why: 'delete any event — ids come from the public feed' },
  { method: 'POST', path: '/api/sources', body: { kind: 'meetup-group', handle: 'x' }, why: 'inject a handle the next scrape will fetch' },
  { method: 'PUT', path: `/api/sources/${GHOST}`, body: { enabled: false }, why: 'disable a source, silently shrinking the feed' },
  { method: 'DELETE', path: `/api/sources/${GHOST}`, why: 'destroy persisted discovery state' },
  { method: 'POST', path: '/api/scrape', body: { fast: true }, why: '~700 upstream requests + LLM spend + prune deleteMany' },
  { method: 'POST', path: '/api/scrape-url', body: { url: 'http://169.254.169.254/' }, why: 'SSRF to cloud metadata' },
  { method: 'POST', path: '/api/notifications/send-digest', why: 'drain the Resend quota' },
  { method: 'GET', path: '/api/notifications/send-digest', why: "read EVERY user's contacts and private notes" },
];

/** Endpoints that are public on purpose — a regression the other way matters too. */
const MUST_ALLOW: Case[] = [
  { method: 'GET', path: '/api/events?limit=1', why: 'the feed is public' },
  { method: 'GET', path: '/api/events/facets', why: 'filter counts are public' },
  { method: 'GET', path: '/api/companies', why: 'the companies directory is public' },
];

const REFUSING = new Set([401, 403, 503]);

async function hit(c: Case) {
  const res = await fetch(BASE + c.path, {
    method: c.method,
    headers: c.body ? { 'Content-Type': 'application/json' } : {},
    body: c.body ? JSON.stringify(c.body) : undefined,
    redirect: 'manual',
    signal: AbortSignal.timeout(30000),
  });
  let detail = '';
  try {
    const text = await res.text();
    detail = text.slice(0, 90).replace(/\s+/g, ' ');
  } catch { /* body may be empty */ }
  return { status: res.status, detail };
}

async function main() {
  console.log(`Probing ${BASE} with NO credentials\n`);
  let failures = 0;

  console.log('MUST REFUSE (401 / 403 / 503)\n');
  for (const c of MUST_REFUSE) {
    try {
      const { status, detail } = await hit(c);
      const ok = REFUSING.has(status);
      if (!ok) failures++;
      console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${status}  ${c.method.padEnd(6)} ${c.path.padEnd(42)} ${c.why}`);
      if (!ok) console.log(`         body: ${detail}`);
    } catch (err) {
      failures++;
      console.log(`  FAIL  ERR  ${c.method} ${c.path} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log('\nMUST STAY PUBLIC (200)\n');
  for (const c of MUST_ALLOW) {
    try {
      const { status } = await hit(c);
      const ok = status === 200;
      if (!ok) failures++;
      console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${status}  ${c.method.padEnd(6)} ${c.path.padEnd(42)} ${c.why}`);
    } catch (err) {
      failures++;
      console.log(`  FAIL  ERR  ${c.method} ${c.path} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
