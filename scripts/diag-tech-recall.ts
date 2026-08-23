#!/usr/bin/env tsx
/**
 * The other half of tech classification: how many genuinely technical events are NOT
 * flagged `isTechEvent`, and therefore invisible in the default feed?
 *
 * Precision turned out to be fine — scripts/diag-tech-precision.ts measures 1.1%
 * unambiguous false positives, not the ~20% an earlier hand-count suggested (that count
 * included borderline founder/career events, which are a policy question rather than a
 * bug). So if the tech feed feels thin, the fault is more likely RECALL.
 *
 * A miss here is worse than a false positive: a wrong row costs a second of attention,
 * whereas a missed Kubernetes meetup is an event the user never learns exists.
 *
 * Read-only.
 *
 * Run: npx tsx scripts/diag-tech-recall.ts
 */
import './load-env';
import mongoose from 'mongoose';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';

/**
 * Unmistakably technical vocabulary. Every term names a specific technology, discipline
 * or artifact — no generic words like "tech", "digital" or "innovation", which appear in
 * marketing copy for everything.
 */
/**
 * Every term here names a specific technology, discipline or artifact.
 *
 * DELIBERATELY EXCLUDED, having been tried and rejected: `\bgo\b`, `\bjava\b`, `spark`,
 * `swift`, `vue`, `rag`, `git`, `sre`. Each matched ordinary prose or unrelated names —
 * "Go" in a sentence, "spark conversations", and best of all "The August Affair - A Taylor
 * Swift Fan Experience" surfacing as a missed engineering event. That is the same trap
 * CLAUDE.md documents for the tagger itself, where a bare `\bpm\b` matched the "PM" in
 * "6 PM" and mis-tagged a fifth of the corpus. A loose term here does not corrupt data,
 * but it does produce a measurement that cannot be trusted — which is worse, because it
 * gets reported.
 *
 * Ambiguous language names are kept only in an unambiguous form: `golang`, `java\s`
 * followed by a qualifier, `swiftui`.
 */
const STRONG_TECH =
  /\b(kubernetes|k8s|docker|containerd|terraform|ansible|postgres(ql)?|mysql|mongodb|redis|kafka|pulsar|clickhouse|iceberg|trino|presto|airflow|dbt|databricks|golang|typescript|javascript|python|kotlin|swiftui|scala|elixir|haskell|react(js)?|svelte|angular|next\.js|node\.js|django|flask|spring boot|graphql|grpc|rest api|webassembly|wasm|\bllm(s)?\b|retrieval.augmented|embeddings?|fine.?tun(e|ing)|pytorch|tensorflow|hugging ?face|langchain|vector (db|database|search)|mlops|llmops|devops|ci\/cd|observability|prometheus|grafana|opentelemetry|linux|kernel|compiler|interpreter|open ?source|foss\b|github actions|serverless|microservices|distributed systems|system design|firmware|embedded|rtos|fpga|vlsi|verilog|risc.?v|arduino|raspberry pi|semiconductor|penetration test|owasp|cryptograph|zero.?trust|smart contract|solidity|ethereum)\b/i;

/** Phrasings that mean it is NOT an engineering event even if it names a technology. */
const NOT_ENGINEERING =
  /\b(get .{0,20}certified|certification (cohort|bootcamp)|placement (guarantee|assistance)|job guarantee|business (exchange|referral)|speed (friending|dating)|manifestation|law of attraction|astrology|reiki|board ?games?|book club|trek(king)?|karaoke|open mic)\b/i;

async function main() {
  await connectDB();
  const now = new Date();

  const nonTech = await Event.find({
    startDateTime: { $gte: now },
    isTechEvent: { $ne: true },
  })
    .select('title description category organizer tagConfidence source')
    .lean();

  const tech = await Event.countDocuments({ startDateTime: { $gte: now }, isTechEvent: true });

  console.log(`${tech} flagged tech · auditing ${nonTech.length} NON-tech upcoming events\n`);

  const misses: Array<{ title: string; term: string; cats: string[]; conf: number; source: string }> = [];

  for (const e of nonTech) {
    const haystack = `${e.title || ''} ${(e.description || '').slice(0, 500)}`;
    const m = STRONG_TECH.exec(haystack);
    if (!m) continue;
    if (NOT_ENGINEERING.test(haystack)) continue;
    misses.push({
      title: (e.title || '').slice(0, 60),
      term: m[0],
      cats: e.category || [],
      conf: e.tagConfidence ?? 0.6,
      source: e.source || '?',
    });
  }

  console.log(`LIKELY MISSES: ${misses.length}\n`);
  for (const m of misses.slice(0, 25)) {
    console.log(
      `  "${m.term}".padded  ${m.title.padEnd(62)} [${m.cats.join(', ')}]  conf=${m.conf} ${m.source}`
    );
  }

  const rate = tech + misses.length ? (misses.length / (tech + misses.length)) * 100 : 0;
  console.log(
    `\nRecall gap: ${misses.length} missed of ${tech + misses.length} that should be tech ` +
      `= ${rate.toFixed(1)}% of the true tech corpus is hidden from the default feed.`
  );

  // Which tag source is dropping them?
  const bySource = new Map<string, number>();
  for (const m of misses) {
    const key = m.conf >= 0.8 ? 'LLM (>=0.8)' : 'keyword (<0.8)';
    bySource.set(key, (bySource.get(key) ?? 0) + 1);
  }
  console.log('\nMisses by tag source:');
  for (const [k, v] of bySource) console.log(`  ${k.padEnd(16)} ${v}`);

  console.log('\nMisses by category assigned instead:');
  const byCat = new Map<string, number>();
  for (const m of misses) {
    for (const c of m.cats.length ? m.cats : ['(none)']) {
      byCat.set(c, (byCat.get(c) ?? 0) + 1);
    }
  }
  for (const [c, n] of [...byCat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ${String(n).padStart(3)}  ${c}`);
  }

  await mongoose.disconnect();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
