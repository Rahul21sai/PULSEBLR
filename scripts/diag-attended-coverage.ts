#!/usr/bin/env tsx
/**
 * Did seeding from the user's attendance history actually put THEIR communities in the
 * feed? Counting total events is not the answer — the point of the seed was specific
 * communities, so check for those by name.
 *
 * Read-only.
 *
 * Run: npx tsx scripts/diag-attended-coverage.ts
 */
import './load-env';
import mongoose from 'mongoose';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';

/** Communities and organisers named in the user's spreadsheet. */
const TARGETS: Array<{ label: string; re: RegExp }> = [
  { label: 'Bengaluru Tech Week', re: /bengaluru tech week|btw 2026/i },
  { label: 'Apache Iceberg', re: /iceberg/i },
  { label: 'Apache Pinot / StarTree', re: /pinot|startree/i },
  { label: 'Presto / Trino', re: /presto|trino/i },
  { label: 'n8n', re: /\bn8n\b/i },
  { label: 'Claude Community (CCCL)', re: /claude community|cccl|\bclaude\b/i },
  { label: 'GDG Cloud Bengaluru', re: /gdg cloud/i },
  { label: 'UiPath', re: /uipath/i },
  { label: 'Snowflake user group', re: /snowflake/i },
  { label: 'FOSS / IndiaFOSS', re: /\bfoss\b|indiafoss/i },
  { label: 'AI Xchange', re: /ai ?xchange/i },
  { label: 'Platform Engineers (GPEN)', re: /platform engineer/i },
  { label: 'CEDAT founders', re: /cedat/i },
  { label: 'TechNexus', re: /technexus/i },
  { label: 'Apidays / FOST', re: /apidays|\bfost\b/i },
  { label: 'AgentCon / Global AI', re: /agentcon|global ai/i },
];

async function main() {
  await connectDB();
  const now = new Date();

  const totalUpcoming = await Event.countDocuments({ startDateTime: { $gte: now } });
  const techUpcoming = await Event.countDocuments({ startDateTime: { $gte: now }, isTechEvent: true });
  console.log(`upcoming: ${totalUpcoming}  |  tech: ${techUpcoming}\n`);

  console.log('Communities from the attendance list, in UPCOMING events:');
  for (const t of TARGETS) {
    const docs = await Event.find({
      startDateTime: { $gte: now },
      $or: [{ title: t.re }, { organizer: t.re }],
    })
      .select('title organizer startDateTime isTechEvent connectionScore')
      .sort({ startDateTime: 1 })
      .limit(3)
      .lean();
    const n = await Event.countDocuments({
      startDateTime: { $gte: now },
      $or: [{ title: t.re }, { organizer: t.re }],
    });
    console.log(`  ${String(n).padStart(3)}  ${t.label}`);
    for (const d of docs) {
      console.log(
        `        ${d.startDateTime.toISOString().slice(0, 10)}  ` +
          `${(d.title || '').slice(0, 52).padEnd(52)} tech=${d.isTechEvent ? 'Y' : 'n'} score=${d.connectionScore ?? '?'}`
      );
    }
  }

  // Open Source and Hardware are the two weakest dimensions in the audit.
  for (const cat of ['Open Source', 'Hardware/Robotics', 'Conference']) {
    const n = await Event.countDocuments({ startDateTime: { $gte: now }, category: cat });
    const sample = await Event.find({ startDateTime: { $gte: now }, category: cat })
      .select('title startDateTime')
      .sort({ startDateTime: 1 })
      .limit(5)
      .lean();
    console.log(`\n${cat}: ${n} upcoming`);
    for (const d of sample) {
      console.log(`     ${d.startDateTime.toISOString().slice(0, 10)}  ${(d.title || '').slice(0, 60)}`);
    }
  }

  await mongoose.disconnect();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
