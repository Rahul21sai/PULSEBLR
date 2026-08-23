#!/usr/bin/env tsx
/**
 * Hardware is the weakest dimension of this product: 9 upcoming events for a city that
 * houses Qualcomm, Texas Instruments, Bosch, Intel, ARM, Micron, Samsung R&D, Nvidia and
 * IISc. Before trying to fix it, establish WHICH problem it is:
 *
 *   SUPPLY   — hardware events exist but no adapter reaches where they are announced.
 *   TAGGING  — they are already in the corpus and being filed under something else.
 *   REALITY  — they are not published online in machine-readable form at all.
 *
 * Those need completely different responses, and guessing wrong wastes the effort. This
 * searches the WHOLE corpus, not just events tagged Hardware/Robotics, so a mis-filed
 * event shows up.
 *
 * Read-only.
 *
 * Run: npx tsx scripts/diag-hardware-gap.ts
 */
import './load-env';
import mongoose from 'mongoose';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';

/**
 * Unambiguous hardware vocabulary. Every term names a physical-engineering artifact or
 * discipline, nothing a software event would use in passing.
 *
 * DELIBERATELY EXCLUDED: bare "iot" and "robotics", which saturate business and AI
 * marketing copy ("IoT-enabled growth"; "robotic process automation" is not robotics), and
 * "chip", which matches chipsets in laptop giveaways. Same discipline as the recall
 * diagnostic — a loose term here produces a number that gets reported.
 */
const HARDWARE_TERMS: Array<[string, RegExp]> = [
  ['embedded / firmware', /\b(embedded (systems?|linux|c\b)|firmware|bare.?metal|rtos|freertos|zephyr)\b/i],
  ['silicon / EDA', /\b(vlsi|asic|fpga|verilog|systemverilog|vhdl|rtl design|tape.?out|semiconductor|eda tools|cadence|synopsys)\b/i],
  ['RISC-V / architecture', /\b(risc.?v|arm cortex|instruction set|microarchitecture|soc design)\b/i],
  ['boards / making', /\b(arduino|raspberry pi|esp32|stm32|jetson|pcb\b|soldering|3d print|makerspace|fab ?lab)\b/i],
  ['robotics / drones', /\b(ros2?\b|robot(ics)? (arm|lab|competition|workshop|showcase)|drone (build|racing|workshop|journey)|slam\b|lidar)\b/i],
  ['electronics / power', /\b(analog design|power electronics|signal integrity|oscilloscope|spectrum analy[sz]er|rf design|antenna design)\b/i],
];

async function main() {
  await connectDB();
  const now = new Date();

  const taggedHardware = await Event.countDocuments({
    startDateTime: { $gte: now },
    category: 'Hardware/Robotics',
  });
  const totalUpcoming = await Event.countDocuments({ startDateTime: { $gte: now } });

  console.log(`${totalUpcoming} upcoming events · ${taggedHardware} tagged Hardware/Robotics\n`);

  const all = await Event.find({ startDateTime: { $gte: now } })
    .select('title description category isTechEvent source organizer')
    .lean();

  const found = new Map<string, Array<{ title: string; cats: string[]; tagged: boolean }>>();
  const matchedIds = new Set<string>();

  for (const e of all) {
    const haystack = `${e.title || ''} ${(e.description || '').slice(0, 600)}`;
    for (const [family, re] of HARDWARE_TERMS) {
      if (!re.test(haystack)) continue;
      if (!found.has(family)) found.set(family, []);
      found.get(family)!.push({
        title: (e.title || '').slice(0, 58),
        cats: e.category || [],
        tagged: (e.category || []).includes('Hardware/Robotics'),
      });
      matchedIds.add(String(e._id));
      break;
    }
  }

  let misfiled = 0;
  for (const [family, list] of [...found.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`${family}: ${list.length}`);
    for (const item of list) {
      if (!item.tagged) misfiled++;
    }
    for (const item of list.slice(0, 5)) {
      console.log(
        `   ${item.tagged ? 'tagged  ' : 'MISFILED'} ${item.title.padEnd(60)} [${item.cats.join(', ')}]`
      );
    }
  }

  console.log(`\nEvents mentioning real hardware vocabulary: ${matchedIds.size}`);
  console.log(`Already tagged Hardware/Robotics:            ${taggedHardware}`);
  console.log(`Mentioning hardware but NOT tagged:          ${misfiled}`);

  console.log('\nVERDICT');
  if (misfiled > taggedHardware) {
    console.log('  TAGGING — the events are in the corpus, filed elsewhere.');
    console.log('  Fix: sharpen the tagger, then run scripts/retag-events.ts.');
  } else if (matchedIds.size <= taggedHardware + 2) {
    console.log('  SUPPLY or REALITY — the corpus barely contains hardware events at all, so');
    console.log('  tagging cannot be the bottleneck. Fixing it needs new sources, or accepting');
    console.log('  that Bengaluru hardware events are not published machine-readably.');
  } else {
    console.log('  MIXED — some mis-filed and the corpus is also thin. Do both.');
  }

  await mongoose.disconnect();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
