#!/usr/bin/env tsx
/**
 * READ-ONLY ICA tagging test. Isolates the ICA provider (unsets NVIDIA/Anthropic
 * for this process only) and runs a sample event through the REAL tagEventWithLLM
 * cascade, so it exercises the actual code path — including the temperature retry.
 * No DB writes. Proves whether the ICA_MODEL in .env.local actually tags events.
 *
 * Usage: npx tsx scripts/test-ica.ts
 */
import './load-env';

async function main() {
  if (!process.env.ICA_API_KEY || !process.env.ICA_BASE_URL || !process.env.ICA_MODEL) {
    console.error('❌ ICA_API_KEY / ICA_BASE_URL / ICA_MODEL not all set in .env.local');
    process.exit(1);
  }

  // Isolate ICA: drop the other providers so the cascade can't mask an ICA
  // failure by silently falling through to NVIDIA/Anthropic/keyword tagging.
  delete process.env.NVIDIA_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;

  console.log(`ICA endpoint: ${process.env.ICA_BASE_URL}`);
  console.log(`ICA_MODEL:    ${process.env.ICA_MODEL}`);
  console.log('Cascade isolated to ICA only (NVIDIA/Anthropic disabled for this test)\n');

  // Import AFTER env is tweaked so the provider chain reflects the isolation.
  const { tagEventWithLLM } = await import('../lib/llm/tagger');

  const t0 = Date.now();
  const result = await tagEventWithLLM(
    'GenAI Builders Meetup Bangalore',
    'Hands-on LLM and RAG workshop with pizza and networking afterwards.',
    'Indiranagar, Bengaluru'
  );
  const ms = Date.now() - t0;

  console.log('\n─────────────────────────────────────────────');
  console.log('Result:', JSON.stringify(result, null, 2));
  console.log(`Took ${ms}ms`);
  // A confidence of exactly 0.7 with only keyword categories means the LLM path
  // failed and we fell back — flag that so a "pass" can't hide a silent failure.
  if (result.confidence === 0.7) {
    console.log('\n⚠️  Looks like KEYWORD fallback (confidence 0.7) — ICA did NOT tag this.');
    process.exit(1);
  }
  console.log('\n✅ ICA tagged the event successfully.');
  process.exit(0);
}

main().catch(e => { console.error('❌', e); process.exit(1); });
