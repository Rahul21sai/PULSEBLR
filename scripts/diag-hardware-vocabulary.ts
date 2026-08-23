#!/usr/bin/env tsx
/**
 * Asserts the Hardware/Robotics keyword floor recognises the vocabulary Bengaluru's silicon
 * community actually writes — AND that it still refuses the ambiguous near-misses.
 *
 * WHY THIS EXISTS:
 * Hardware is the feed's weakest dimension, and probing established it is a SUPPLY problem —
 * five independent classes of source were tested (consumer platforms, IEEE vTools, IEEE
 * Bangalore's own site, IESA/SEMI, IISc/IIIT-B) and none publishes machine-readable hardware
 * events. See probe-hardware-bodies.ts / -round2.ts.
 *
 * But one link in the chain WAS ours to fix: the Meetup discovery fan-out searches `vlsi`,
 * `fpga`, `semiconductor` and `embedded`, while the keyword floor knew only `fpga` and
 * `embedded`. So a chip-design meetup could be discovered and then, with every LLM provider
 * down, stored with zero categories and isTechEvent=false. Discovery and classification must
 * share a vocabulary.
 *
 * The negative half is the more important half. CLAUDE.md records a bare `\bpm\b` matching the
 * "PM" in "6 PM" and tagging a fifth of the corpus Product/Design. Every term below was
 * considered and rejected for the same reason, and this asserts they STAY rejected — the
 * failure mode of a widened regex is silent over-tagging, which no aggregate count reveals.
 *
 * Exits non-zero on regression. No DB writes, no network.
 *
 * Run: npx tsx scripts/diag-hardware-vocabulary.ts
 */
import './load-env';
import { keywordTagging } from '../lib/llm/tagger';

const HARDWARE = 'Hardware/Robotics';

/** Must be tagged Hardware/Robotics. The words Bengaluru's chip and embedded people use. */
const MUST_MATCH: string[] = [
  'VLSI physical design study group',
  'Verilog and SystemVerilog for beginners',
  'VHDL RTL coding session',
  'RISC-V India meetup',
  'RISCV core design deep dive',
  'ASIC design flow walkthrough',
  'Tapeout party — our first silicon',
  'Tape-out retrospective',
  'Silicon photonics research talk',
  'MEMS sensor fabrication seminar',
  'Microcontrollers 101 with STM32',
  'ESP32 workshop for makers',
  'Mechatronics and motion control',
  'Analog design fundamentals',
  'SoC design verification night',
  'IEEE Electron Devices Society lecture',
  'IEEE Signal Processing Society talk',
  '3D printing clinic',
  '3D printer calibration hands-on',
  'Soldering basics for beginners',
  'Makerspace open house',
  'Maker Faire Bengaluru',
  'Sensor fusion for autonomous robots',
  'PCB layout review session',
  // Already covered before the widening — regression cover for the originals.
  'Embedded systems and FPGA design night',
  'Semiconductor industry outlook',
  'Arduino and Raspberry Pi tinkering',
  'Firmware and RTOS internals',
  'Drone building workshop',
  'IoT gateway architecture',
];

/**
 * Must NOT be tagged Hardware/Robotics. Each is a real phrase from this corpus or an obvious
 * neighbour of a term that was considered and rejected.
 */
const MUST_NOT_MATCH: Array<[string, string]> = [
  ['Basic Python for absolute beginners', '"basic" must not match `asic`'],
  ['ASICS presents the Bengaluru 10K run', '"ASICS" the shoe brand — why only singular `asic` is listed'],
  ['SOC 2 compliance for startups', '`soc` alone = Security Operations Center'],
  ['Building AI Agents with Microsoft Foundry', '`foundry` is an AI product, not a fab'],
  ['Decision makers roundtable', '`maker` alone matches decision-maker'],
  ['Policy makers and market makers panel', '`maker` again'],
  ['Bare metal Kubernetes on rented servers', '`bare metal` is a cloud term'],
  ['Wafer biscuits and chai tasting', '`wafer` is also food'],
  ['A sensory sound bath and meditation', '"sensory" must not match `sensors?`'],
  ['RF proposal writing workshop', '`rf` is too short to be safe'],
  ['Product management masterclass', 'unrelated — guards against a catch-all'],
  ['Live jazz and open mic night', 'unrelated'],
];

let failures = 0;

function categoriesFor(title: string): string[] {
  // keywordTagging takes ONE object, and concatenates title + description + hints before
  // matching. Passing positional strings silently yields "undefined undefined" as the text and
  // therefore the no-match fallback ['Meetup'] for every input — which looks exactly like a
  // dead regex. Description is left empty so this measures the title regex alone.
  return keywordTagging({ title, description: '' } as Parameters<typeof keywordTagging>[0]).categories;
}

console.log('Hardware/Robotics keyword floor\n');
console.log('══ Must be tagged Hardware/Robotics ══\n');

for (const title of MUST_MATCH) {
  const cats = categoriesFor(title);
  const ok = cats.includes(HARDWARE);
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${title.slice(0, 46).padEnd(46)} [${cats.join(', ') || 'none'}]`);
}

console.log('\n══ Must NOT be tagged Hardware/Robotics ══\n');

for (const [title, why] of MUST_NOT_MATCH) {
  const cats = categoriesFor(title);
  const ok = !cats.includes(HARDWARE);
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${title.slice(0, 46).padEnd(46)} [${cats.join(', ') || 'none'}]`);
  if (!ok) console.log(`        ${why}`);
}

// A widened regex fails silently by over-matching, so also assert it is not now matching
// EVERYTHING. If the negative set were tagged hardware this would already have failed, but a
// caught-everything regex would also inflate the positive set's category counts.
const hwHits = MUST_NOT_MATCH.filter(([t]) => categoriesFor(t).includes(HARDWARE)).length;

console.log(`\n  positives: ${MUST_MATCH.length - MUST_MATCH.filter(t => !categoriesFor(t).includes(HARDWARE)).length}/${MUST_MATCH.length}`);
console.log(`  negatives: ${MUST_NOT_MATCH.length - hwHits}/${MUST_NOT_MATCH.length} correctly refused`);

console.log(`\n${failures === 0 ? 'OK — vocabulary matches discovery, no over-matching' : `${failures} case(s) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
