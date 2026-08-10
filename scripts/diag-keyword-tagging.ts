#!/usr/bin/env tsx
/**
 * Is keywordTagging() actually working?
 *
 * It is the documented FLOOR of the tagging cascade — "an event is never dropped for
 * want of a classification" — and it is what runs when every LLM provider is down,
 * which happened twice during development. A regression here is invisible in normal
 * runs because the LLM masks it, so it needs its own check.
 *
 * Regression it guards: a shell heredoc once rewrote every `\b` word boundary in the
 * keyword regexes as a literal 0x08 BACKSPACE byte, which made all 70 boundaries
 * match nothing and silently disabled the whole function.
 *
 * Read-only. No DB, no network.
 *
 * Run: npx tsx scripts/diag-keyword-tagging.ts
 */
import { keywordTagging } from '../lib/llm/tagger';

interface Case {
  title: string;
  description?: string;
  /** A category that MUST appear. */
  expect: string;
  /** Whether this should be judged a software/hardware engineering event. */
  tech: boolean;
}

const CASES: Case[] = [
  { title: 'Bangalore Kubernetes Meetup #42', expect: 'Cloud/DevOps', tech: true },
  { title: 'Hands-on LLM fine-tuning workshop', expect: 'AI/ML', tech: true },
  { title: 'IndiaFOSS 2026 — open source conference', expect: 'Open Source', tech: true },
  { title: 'Embedded systems and FPGA design night', expect: 'Hardware/Robotics', tech: true },
  { title: 'React and TypeScript frontend meetup', expect: 'Web/Mobile', tech: true },
  { title: 'OWASP web application security talk', expect: 'Cybersecurity', tech: true },
  { title: 'Postgres internals and query planning', expect: 'Data/Analytics', tech: true },
  { title: 'Ethereum smart contract workshop', expect: 'Blockchain/Web3', tech: true },
  { title: 'Weekend trek to Skandagiri', expect: 'Health/Fitness', tech: false },
  { title: 'Live jazz and open mic night', expect: 'Arts/Culture', tech: false },
];

function main() {
  let pass = 0;
  let techOk = 0;
  const misses: string[] = [];

  console.log('keywordTagging() — LLM-free classification floor\n');

  for (const c of CASES) {
    const result = keywordTagging({
      title: c.title,
      description: c.description || '',
    } as Parameters<typeof keywordTagging>[0]);

    const categories = result.categories || [];
    const hit = categories.includes(c.expect);
    const techMatch = result.isTechEvent === c.tech;
    if (hit) pass++;
    else misses.push(`${c.title} → expected ${c.expect}, got [${categories.join(', ') || 'NONE'}]`);
    if (techMatch) techOk++;

    console.log(
      `  ${hit ? 'PASS' : 'FAIL'}  tech=${String(result.isTechEvent).padEnd(5)}` +
        `${techMatch ? '  ' : ' !'} ${c.title.slice(0, 44).padEnd(44)} [${categories.join(', ')}]`
    );
  }

  console.log(`\ncategories: ${pass}/${CASES.length} matched`);
  console.log(`isTechEvent: ${techOk}/${CASES.length} matched`);

  if (misses.length) {
    console.log('\nmisses:');
    for (const m of misses) console.log(`  - ${m}`);
  }

  // The decisive signal: if the word boundaries are mangled again, EVERY case
  // returns no categories at all rather than a few wrong ones.
  const totalCategories = CASES.reduce((sum, c) => {
    const r = keywordTagging({ title: c.title, description: '' } as Parameters<typeof keywordTagging>[0]);
    return sum + (r.categories?.length || 0);
  }, 0);
  console.log(
    `\ntotal categories emitted across all cases: ${totalCategories}` +
      (totalCategories === 0 ? '  <-- REGRESSION: the regexes match nothing' : '')
  );

  process.exit(pass === CASES.length && totalCategories > 0 ? 0 : 1);
}

main();
