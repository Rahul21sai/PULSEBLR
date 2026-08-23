#!/usr/bin/env tsx
/**
 * What did widening the Hardware/Robotics regex do to the LIVE corpus?
 *
 * diag-hardware-vocabulary.ts proves the pattern on 42 synthetic titles. That is the wrong
 * test for over-matching: the damage a loose regex does only shows up against real scraped
 * copy, which is where a bare `\bpm\b` found the "PM" in "6 PM" and tagged a fifth of the
 * corpus Product/Design. Synthetic negatives cannot find that, because you have to think of
 * the phrase to test it.
 *
 * So this runs the OLD and NEW patterns over every stored event and prints the delta with the
 * titles attached. A jump from 1 to ~200 means the widening was reckless; a handful of genuine
 * hardware events means it was recall the feed was missing.
 *
 * Read-only — reads events, writes nothing. Re-tagging is scripts/retag-events.ts.
 *
 * Run: npx tsx scripts/diag-hardware-corpus-delta.ts
 */
import './load-env';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';
import mongoose from 'mongoose';

/** The pattern as it stood before the widening. Kept verbatim so the delta is exact. */
const OLD =
  /\b(hardware|embedded|robotics|iot|drone|semiconductor|chip design|silicon|fpga|arduino|raspberry pi|firmware|rtos|pcb|electronics)\b/i;

/** The pattern now in lib/llm/tagger.ts. */
const NEW =
  /\b(hardware|embedded|robotics|iot|drone|semiconductor|chip design|soc design|analog design|silicon|fpga|vlsi|verilog|systemverilog|vhdl|asic|risc-?v|tape-?outs?|photonics?|mems|arduino|raspberry pi|esp32|stm32|microcontrollers?|mechatronics|firmware|rtos|pcb|soldering|electronics|electron devices?|signal processing|3d print(?:ing|ers?)?|makerspaces?|maker faire|sensors?)\b/i;

/** Which of the new alternatives fired, so a bad one is named rather than inferred. */
const NEW_TERMS: Array<[string, RegExp]> = [
  ['vlsi', /\bvlsi\b/i],
  ['verilog', /\b(systemverilog|verilog)\b/i],
  ['vhdl', /\bvhdl\b/i],
  ['asic', /\basic\b/i],
  ['risc-v', /\brisc-?v\b/i],
  ['tapeout', /\btape-?outs?\b/i],
  ['photonics', /\bphotonics?\b/i],
  ['mems', /\bmems\b/i],
  ['esp32/stm32', /\b(esp32|stm32)\b/i],
  ['microcontroller', /\bmicrocontrollers?\b/i],
  ['mechatronics', /\bmechatronics\b/i],
  ['soc design', /\bsoc design\b/i],
  ['analog design', /\banalog design\b/i],
  ['soldering', /\bsoldering\b/i],
  ['electron device', /\belectron devices?\b/i],
  ['signal processing', /\bsignal processing\b/i],
  ['3d print', /\b3d print(?:ing|ers?)?\b/i],
  ['makerspace', /\bmakerspaces?\b/i],
  ['maker faire', /\bmaker faire\b/i],
  ['sensor', /\bsensors?\b/i],
];

async function main() {
  await connectDB();

  const events = await Event.find({}, { title: 1, description: 1, category: 1, startDateTime: 1 }).lean();
  console.log(`corpus: ${events.length} events\n`);

  let oldHits = 0;
  let newHits = 0;
  const gained: Array<{ title: string; terms: string[]; upcoming: boolean }> = [];
  const termCounts = new Map<string, number>();
  const now = Date.now();

  for (const e of events) {
    const text = `${e.title ?? ''} ${e.description ?? ''}`;
    const o = OLD.test(text);
    const n = NEW.test(text);
    if (o) oldHits++;
    if (n) newHits++;
    if (n && !o) {
      const terms = NEW_TERMS.filter(([, re]) => re.test(text)).map(([label]) => label);
      for (const t of terms) termCounts.set(t, (termCounts.get(t) ?? 0) + 1);
      gained.push({
        title: String(e.title ?? '').slice(0, 72),
        terms,
        upcoming: new Date(e.startDateTime as unknown as string).getTime() >= now,
      });
    }
  }

  console.log(`  OLD pattern matched  ${oldHits}`);
  console.log(`  NEW pattern matched  ${newHits}`);
  console.log(`  newly matched        ${gained.length}  (${((gained.length / (events.length || 1)) * 100).toFixed(1)}% of corpus)`);
  console.log(`  of those, upcoming   ${gained.filter(g => g.upcoming).length}`);

  console.log('\n  which new term fired, and how often:');
  for (const [term, count] of [...termCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(count).padStart(4)}  ${term}`);
  }

  console.log('\n  every newly-matched event (judge these by eye — that is the point):');
  for (const g of gained.slice(0, 60)) {
    console.log(`    ${g.upcoming ? 'up ' : 'past'}  [${g.terms.join(',')}]  ${g.title}`);
  }
  if (gained.length > 60) console.log(`    … ${gained.length - 60} more`);

  console.log('\n  READ THIS: a term firing on many events whose titles are not hardware is the');
  console.log('  `\\bpm\\b` failure repeating. Remove that alternative rather than accepting the count.');

  await mongoose.disconnect();
}

main().catch(async e => {
  console.error(e);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
