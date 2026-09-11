#!/usr/bin/env tsx
/**
 * READ-ONLY probe: can a company event MICROSITE be read at all, and by what?
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THIS ANSWERS, AND WHY IT RUNS BEFORE THE ADAPTER SHIPS ENABLED.
 *
 * `lib/scrapers/adapters/microsite.ts` has a three-step cascade — JSON-LD, then platform
 * detection, then a frontier model on rendered text — and only the third step can be wrong in a
 * way nobody notices. So this prints, per page: which step answered, how much text a render
 * produced, what the model returned, and WHAT WAS REFUSED and why. The refusals are the number
 * that decides whether this ships enabled: an extraction path whose rejections are invisible is
 * indistinguishable from one that hallucinates.
 *
 * Every row is meant to be judged BY EYE. An aggregate precision figure over five pages is not a
 * measurement, and this is the one place in the pipeline where a confident wrong answer costs a
 * human's time rather than a log line.
 *
 * WRITES NOTHING. No database connection is opened, and `--audit` writes the rendered text and
 * the verbatim model response to a local directory so a bad parse can be re-read afterwards.
 *
 * Run:
 *   npx tsx scripts/probe-microsite-llm.ts                 # cheap paths only, no browser, no LLM
 *   npx tsx scripts/probe-microsite-llm.ts --render        # + headless Chromium, no LLM
 *   npx tsx scripts/probe-microsite-llm.ts --render --llm  # the full cascade (costs ICA calls)
 *   npx tsx scripts/probe-microsite-llm.ts --render --llm --audit=./_probe
 *   npx tsx scripts/probe-microsite-llm.ts --url=https://…  # one page, repeatable
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
import './load-env';
import * as fs from 'fs';
import * as path from 'path';
import {
  scrapeMicrosites,
  MICROSITE_WATCHLIST,
  type MicrositeEntry,
  type MicrositeCandidate,
  type MicrositePageReport,
} from '../lib/scrapers/adapters/microsite';
import { extractionProvider } from '../lib/llm/extract-event';

const args = process.argv.slice(2);
const wantRender = args.includes('--render');
const wantLlm = args.includes('--llm');
const auditArg = args.find(a => a.startsWith('--audit'));
/**
 * Default audit directory is under `audit/`, which `.gitignore` already excludes wholesale.
 *
 * Not cosmetic: the audit captures the verbatim rendered text of somebody else's marketing site
 * plus a model response about it, which is exactly the class of local probe output that gitignore
 * entry exists for — and a default that lands in the working tree is how a bare `git add -A`
 * commits 30 KB of a third party's page copy.
 */
const auditDir = auditArg ? auditArg.split('=')[1] || './audit/microsite-probe' : undefined;
const urlArgs = args.filter(a => a.startsWith('--url=')).map(a => a.slice('--url='.length));

const entries: MicrositeEntry[] = urlArgs.length
  ? urlArgs.map(url => ({ url, organizer: hostOf(url) }))
  : MICROSITE_WATCHLIST;

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * Load the renderer the same way `pipeline.ts` does — a dynamic import of `core/render.ts`, whose
 * own Playwright specifier is assembled at runtime so no bundler can trace it. Copied rather than
 * shared because a script importing the pipeline just to borrow one private helper would pull the
 * whole scraper graph in for nothing.
 */
async function loadRenderer(): Promise<{
  render?: (url: string) => Promise<string | null>;
  close: () => Promise<void>;
  describe: () => string;
}> {
  if (!wantRender) {
    return { close: async () => {}, describe: () => 'rendering OFF (pass --render)' };
  }
  try {
    const mod = await import('../lib/scrapers/core/render');
    return {
      render: (url: string) => mod.renderHtml(url),
      close: () => mod.closeRenderer(),
      describe: () => {
        const stats = mod.renderStats();
        if (stats.launchError) return `browser unavailable: ${stats.launchError}`;
        return `browser rendered ${stats.rendered}/${stats.requested} page(s) in ${(
          stats.totalMs / 1000
        ).toFixed(1)}s`;
      },
    };
  } catch (error) {
    console.warn(`  ! could not load core/render.ts: ${String(error)}`);
    return { close: async () => {}, describe: () => 'renderer failed to load' };
  }
}

function pad(value: string, width: number): string {
  return value.length > width ? `${value.slice(0, width - 1)}…` : value.padEnd(width);
}

function printReport(report: MicrositePageReport): void {
  const rejections = Object.entries(report.rejections)
    .map(([reason, count]) => `${reason}×${count}`)
    .join(' ');
  console.log(
    `  ${pad(report.organizer, 14)} ${pad(report.via, 15)} ` +
      `text ${String(report.textLength).padStart(6)}  ` +
      `fp ${pad(report.fingerprint ?? '—', 17)} ` +
      `kept ${String(report.candidates).padStart(2)}  ` +
      `offCity ${String(report.offCity).padStart(2)}  ` +
      `${(report.latencyMs / 1000).toFixed(1)}s`
  );
  if (report.platform) {
    console.log(
      `      → PLATFORM ${report.platform.platform}` +
        `${report.platform.sourceKind ? ` (adapter: ${report.platform.sourceKind})` : ' (no adapter yet)'}` +
        `\n        evidence: ${report.platform.evidence}`
    );
  }
  if (report.jsonLdEvents || report.pastEvents) {
    console.log(
      `      → JSON-LD gave ${report.jsonLdEvents ?? 0} upcoming event(s)` +
        `${report.pastEvents ? `, ${report.pastEvents} past (archive) dropped` : ''}`
    );
  }
  if (report.policy?.contentSignal) {
    console.log(
      `      → Content-Signal: ${report.policy.contentSignal}` +
        `${report.policy.llmAllowed ? '' : '  [LLM REFUSED BY SITE]'}` +
        `${report.policy.refusesTraining ? '  [ai-train=no, reported only]' : ''}`
    );
  }
  if (rejections) console.log(`      → REJECTED: ${rejections}`);
  if (report.error) console.log(`      → error: ${report.error}`);
}

function printCandidate(candidate: MicrositeCandidate, index: number): void {
  const e = candidate.event;
  console.log(`\n  [${index + 1}] ${e.title}`);
  console.log(`      from      ${candidate.url}`);
  console.log(
    `      when      ${e.startsAt.toISOString()}${e.endsAt ? ` → ${e.endsAt.toISOString()}` : ''}` +
      `${e.assumedIst ? '  (naked local time read as IST)' : ''}`
  );
  if (e.timeAssumed) {
    console.log('      NOTE      the page gave a DATE and no time — start is midnight IST');
  }
  console.log(
    `      where     ${e.isOnline ? 'ONLINE' : [e.venue, e.address, e.city].filter(Boolean).join(' · ') || '—'}`
  );
  console.log(`      organizer ${e.organizer ?? '—'}`);
  console.log(`      register  ${e.registrationUrl ?? '—'}`);
  console.log(
    `      price     ${e.priceInr !== undefined ? `₹${e.priceInr}` : e.isFree ? 'free' : '—'}`
  );
  if (e.speakers?.length) {
    console.log(`      speakers  ${e.speakers.map(s => s.name).join(', ')}`);
  }
  console.log(`      desc      ${e.description.slice(0, 160)}`);
}

async function main(): Promise<void> {
  const provider = extractionProvider();

  console.log('─'.repeat(100));
  console.log('MICROSITE PROBE');
  console.log(`  pages       ${entries.length}`);
  console.log(`  render      ${wantRender ? 'ON' : 'off'}`);
  console.log(
    `  LLM         ${wantLlm ? (provider ? `ON — ${provider.name} / ${provider.model}` : 'ON but NO PROVIDER CONFIGURED') : 'off'}`
  );
  console.log(`  audit dir   ${auditDir ?? '—'}`);
  console.log('─'.repeat(100));

  const renderer = await loadRenderer();
  let outcome;
  try {
    outcome = await scrapeMicrosites({
      entries,
      render: renderer.render,
      // The probe measures the cascade; a stale fingerprint map would make it skip the very step
      // it exists to exercise. Change detection is exercised by its own unit tests.
      knownFingerprints: new Map(),
      maxExtractions: wantLlm ? entries.length : 0,
      concurrency: 2,
      keepAudit: Boolean(auditDir),
      // With --llm off, stub the extractor so the cheap steps are still measured end to end and
      // the report row reads `llm` with a stated reason rather than pretending the page was skipped.
      ...(wantLlm
        ? {}
        : {
            extract: async () => ({
              events: [],
              rejected: [],
              error: '--llm not passed, no model call made',
              latencyMs: 0,
            }),
          }),
    });
  } finally {
    await renderer.close();
  }

  console.log('\nPER-PAGE\n');
  for (const report of outcome.reports) printReport(report);

  console.log(`\n${renderer.describe()}`);

  if (outcome.structuredEvents.length) {
    console.log(
      `\nJSON-LD EVENTS (these are ordinary scraped events and would join the PUBLIC path): ${outcome.structuredEvents.length}`
    );
    for (const event of outcome.structuredEvents.slice(0, 10)) {
      console.log(`  · ${event.title} — ${event.startDateTime.toISOString()} — ${event.venue ?? '—'}`);
    }
  }

  if (outcome.discovered.length) {
    console.log('\nPLATFORM HANDLES WORTH REGISTERING AS REAL SOURCES:');
    for (const source of outcome.discovered) {
      console.log(`  · ${source.kind}  ${source.handle}  (${source.label})`);
    }
  }

  console.log(
    `\nCANDIDATES THAT WOULD LAND AS visibility:'pending' — ${outcome.candidates.length}`
  );
  console.log('JUDGE EACH ONE BY EYE. A row here is a claim about a real event.');
  outcome.candidates.forEach(printCandidate);

  // ── Tally ────────────────────────────────────────────────────────────────
  const byVia = new Map<string, number>();
  const allRejections = new Map<string, number>();
  for (const report of outcome.reports) {
    byVia.set(report.via, (byVia.get(report.via) ?? 0) + 1);
    for (const [reason, count] of Object.entries(report.rejections)) {
      allRejections.set(reason, (allRejections.get(reason) ?? 0) + count);
    }
  }
  const rejectedTotal = [...allRejections.values()].reduce((a, b) => a + b, 0);
  const offCityTotal = outcome.reports.reduce((a, r) => a + r.offCity, 0);

  console.log(`\n${'─'.repeat(100)}`);
  console.log('TALLY');
  console.log(`  how each page resolved   ${[...byVia].map(([k, v]) => `${k}=${v}`).join('  ')}`);
  console.log(`  model rows accepted      ${outcome.candidates.length}`);
  console.log(`  model rows refused       ${rejectedTotal}` +
    (allRejections.size ? `  (${[...allRejections].map(([k, v]) => `${k}×${v}`).join(' ')})` : ''));
  console.log(`  accepted then off-city   ${offCityTotal}`);
  if (outcome.errors.length) {
    console.log('  errors:');
    for (const error of outcome.errors) console.log(`    ! ${error}`);
  }
  console.log('─'.repeat(100));

  if (auditDir) {
    /*
     * ONE PAIR OF FILES PER LLM PAGE, NOT PER ACCEPTED CANDIDATE.
     *
     * The first version wrote only the pages that produced something, which meant the four pages
     * worth investigating were the four with nothing to inspect: a page returning zero events is
     * either a correct refusal or a silent miss, and the input is the only thing that separates
     * them. That is exactly the "a metric that cannot fall is not a metric" trap.
     */
    fs.mkdirSync(auditDir, { recursive: true });
    let written = 0;
    for (const report of outcome.reports) {
      if (!report.auditText) continue;
      const stem = `${hostOf(report.url)}-${report.fingerprint ?? 'nofp'}`;
      fs.writeFileSync(path.join(auditDir, `${stem}.text.txt`), report.auditText, 'utf8');
      fs.writeFileSync(
        path.join(auditDir, `${stem}.response.json`),
        report.auditResponse ?? '(no response)',
        'utf8'
      );
      written += 2;
    }
    console.log(`\nAudit written to ${auditDir} (${written} files, one pair per page the model read)`);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
