#!/usr/bin/env tsx
/**
 * Does the provider circuit breaker actually have the scope its log line claims?
 *
 * The breaker state used to live inside tagEvents(), so it reset on every call while
 * the message said the provider was "disabled for this run". `npm run scrape` hid it
 * — pipeline.ts calls tagEvents() exactly once with the whole corpus, so per-call and
 * per-run coincide. Two callers where they do not:
 *
 *   - scripts/retag-events.ts chunks by 40, so `--all` over ~1000 events is 25 calls.
 *   - the Next.js server tags one event per call on the manual add-event path.
 *
 * In both, a dead provider was re-probed TRIP_AFTER times per call, forever.
 *
 * This asserts two things the fix has to deliver:
 *   A. A 401/403 retires the provider on the FIRST rejection, not the third — a
 *      credential is not transient, so it is the provider-level analogue of the
 *      404 -> DEAD_MODELS rule that already exists for models.
 *   B. Strikes from transient failures survive across tagEvents() calls, so the
 *      second call spends zero requests instead of another TRIP_AFTER.
 *   C. The Anthropic tier gets the same auth guard. It goes through the SDK rather
 *      than callOpenAICompatible, so it is easy to fix the other two and leave this
 *      one retrying a rejected credential TRIP_AFTER times per call.
 *
 * No DB, no LLM credentials, no outbound network: both providers are pointed at a
 * local stub server that counts requests and answers with the status under test.
 * Provider env vars are cleared first so a real key can never be contacted.
 *
 * Run: npx tsx scripts/diag-breaker-scope.ts
 */
import * as http from 'http';
import type { AddressInfo } from 'net';

// Hermetic: never read .env.local, and drop anything inherited from the shell.
for (const key of [
  'ICA_API_KEY', 'ICA_BASE_URL', 'ICA_MODEL',
  'NVIDIA_API_KEY', 'NVIDIA_BASE_URL', 'NVIDIA_MODEL',
  'ANTHROPIC_API_KEY', 'PULSEBLR_SKIP_LLM',
]) {
  delete process.env[key];
}

/** Status the stub returns, and how many requests it has served since the last reset. */
let stubStatus = 401;
let requests = 0;

function makeInputs(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    title: `Bangalore Kubernetes Meetup #${i + 1}`,
    description: 'Cluster autoscaling and eBPF observability. Pizza afterwards.',
    venue: 'Ecospace, Outer Ring Road',
  }));
}

/** Capture the tagger's own log lines so we can assert what they SAY, not just do. */
const warnings: string[] = [];
const realWarn = console.warn;
const realLog = console.log;
function captureLogs(): void {
  console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(' '));
  console.log = () => {};
}
function restoreLogs(): void {
  console.warn = realWarn;
  console.log = realLog;
}

async function main() {
  // A breaker bug looks like "lots of requests", and a stub bug looks like a hang.
  // Fail loudly instead of sitting there, since stdout is buffered when piped.
  const watchdog = setTimeout(() => {
    restoreLogs();
    console.error(`\nTIMED OUT after 60s with ${requests} stub request(s) served.`);
    process.exit(1);
  }, 60_000);
  watchdog.unref();

  const server = http.createServer((req, res) => {
    requests++;
    // Drain the request before replying. A batch prompt is ~15 KB, which is larger
    // than the socket buffer: if the stub answers without reading, undici blocks
    // writing the body while the server never reads it and the whole script hangs
    // with no output. Cost an easy 3 minutes to diagnose the first time.
    req.resume();
    req.on('end', () => {
      res.writeHead(stubStatus, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `stub ${stubStatus}` }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}/v1`;

  const { tagEvents } = await import('../lib/llm/tagger');
  const failures: string[] = [];

  function check(label: string, actual: number, expected: number, wasBefore: number): void {
    const ok = actual === expected;
    if (!ok) failures.push(`${label}: expected ${expected} request(s), got ${actual}`);
    console.log(
      `  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(46)} ${String(actual).padStart(2)} request(s)` +
        `  (expected ${expected}, was ${wasBefore} before the fix)`
    );
  }

  // ── A. 401 retires the provider on the first rejection ────────────────────
  // 45 events at ICA's batch size of 15 is 3 batches, so the old code had room to
  // spend all 3 strikes inside a single call.
  console.log('\nA. Auth rejection (HTTP 401) — ICA, 45 events = 3 batches/call\n');
  stubStatus = 401;
  requests = 0;
  process.env.ICA_API_KEY = 'sk-stub-not-a-real-key';
  process.env.ICA_BASE_URL = base;
  process.env.ICA_MODEL = 'stub-model';

  captureLogs();
  const first = await tagEvents(makeInputs(45));
  const afterCall1 = requests;
  const second = await tagEvents(makeInputs(45));
  const afterCall2 = requests - afterCall1;
  restoreLogs();

  check('call 1 — one 401 is enough to retire it', afterCall1, 1, 3);
  check('call 2 — provider still known dead', afterCall2, 0, 3);

  const authLine = warnings.find(w => w.includes('credentials rejected'));
  const scopeOk = Boolean(authLine?.includes('for this process'));
  const namesVar = Boolean(authLine?.includes('ICA_API_KEY'));
  if (!scopeOk) failures.push('auth disable line does not state the process scope');
  if (!namesVar) failures.push('auth disable line does not name the env var to fix');
  console.log(`  ${scopeOk ? 'PASS' : 'FAIL'}  log states its real scope`);
  console.log(`  ${namesVar ? 'PASS' : 'FAIL'}  log names the env var to fix`);
  console.log(`        ${authLine ?? '(no credentials-rejected line logged)'}`);

  // The documented floor must still hold: no event loses its classification.
  const floorHeld = [...first, ...second].every(r => r.categories.length > 0);
  if (!floorHeld) failures.push('keyword floor did not hold — an event got zero categories');
  console.log(`  ${floorHeld ? 'PASS' : 'FAIL'}  keyword floor held for all 90 results`);

  // ── B. Transient failures trip once, not once per call ────────────────────
  // A different provider name, because ICA is now permanently retired in-process.
  // 45 events at NVIDIA's batch size of 5 is 9 batches, so there is ample room to
  // spend more than TRIP_AFTER requests if the breaker forgets.
  console.log('\nB. Transient failure (HTTP 500) — NVIDIA, 45 events = 9 batches/call\n');
  stubStatus = 500;
  requests = 0;
  delete process.env.ICA_API_KEY;
  process.env.NVIDIA_API_KEY = 'nvapi-stub';
  process.env.NVIDIA_BASE_URL = base;
  process.env.NVIDIA_MODEL = 'stub-model';

  captureLogs();
  await tagEvents(makeInputs(45));
  const bCall1 = requests;
  await tagEvents(makeInputs(45));
  const bCall2 = requests - bCall1;
  restoreLogs();

  check('call 1 — trips after 3 strikes', bCall1, 3, 3);
  check('call 2 — strikes are remembered', bCall2, 0, 3);

  // ── C. The Anthropic tier gets the same auth guard ─────────────────────────
  // Anthropic goes through the SDK, not callOpenAICompatible, so it needs its own
  // hook into the breaker. Without one it is the last tier where a bad credential
  // is still retried TRIP_AFTER times per call. The SDK honours ANTHROPIC_BASE_URL,
  // which is what lets the stub stand in for api.anthropic.com. The SDK does not
  // retry a 401 internally (it retries 408/409/429/5xx), so one call is one request.
  console.log('\nC. Auth rejection (HTTP 401) — Anthropic SDK path, 45 events = 3 batches/call\n');
  stubStatus = 401;
  requests = 0;
  delete process.env.NVIDIA_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-stub';
  process.env.ANTHROPIC_BASE_URL = base.replace(/\/v1$/, '');

  captureLogs();
  await tagEvents(makeInputs(45));
  const cCall1 = requests;
  await tagEvents(makeInputs(45));
  const cCall2 = requests - cCall1;
  restoreLogs();

  check('call 1 — one 401 is enough to retire it', cCall1, 1, 3);
  check('call 2 — provider still known dead', cCall2, 0, 3);

  server.close();

  const total = afterCall1 + afterCall2 + bCall1 + bCall2 + cCall1 + cCall2;
  console.log(`\ntotal doomed requests across all six calls: ${total} (was 18 before the fix)`);

  if (failures.length) {
    console.log('\nFAILURES:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch(err => {
  restoreLogs();
  console.error(err);
  process.exit(1);
});
