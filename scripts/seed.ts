/**
 * Seed script — populates the DB with sample Bangalore tech events
 * Run with: npx tsx scripts/seed.ts
 */
import mongoose from 'mongoose';
import * as fs from 'fs';
import * as path from 'path';

// Load .env.local manually
const envPath = path.resolve(process.cwd(), '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) process.env[match[1].trim()] = match[2].trim();
  }
}

const MONGODB_URI = process.env.MONGODB_URI!;
if (!MONGODB_URI) { console.error('❌ MONGODB_URI not set'); process.exit(1); }

const EventSchema = new mongoose.Schema({
  title: String, description: String, source: String, sourceUrl: String,
  organizer: String, category: [String], format: String, hasFood: String,
  isFree: Boolean, price: Number, venue: String, area: String,
  startDateTime: Date, endDateTime: Date, applyLink: String, dedupHash: String,
}, { timestamps: true });

const Event = mongoose.models.Event || mongoose.model('Event', EventSchema);

const now = new Date();
const d = (daysFromNow: number, hour = 18) => {
  const dt = new Date(now);
  dt.setDate(dt.getDate() + daysFromNow);
  dt.setHours(hour, 0, 0, 0);
  return dt;
};

const events = [
  {
    title: 'LLM Optimization & Fine-Tuning Workshop',
    description: 'Hands-on workshop on LoRA, QLoRA and production LLM optimization. For AI practitioners and ML engineers. Food provided.',
    source: 'manual', sourceUrl: 'https://lu.ma/blr-llm-workshop',
    organizer: 'Bangalore AI Tinkerers', category: ['AI/ML'],
    format: 'offline', hasFood: 'yes', isFree: true,
    venue: 'WeWork Galaxy, Residency Rd', area: 'MG Road',
    startDateTime: d(1, 18), applyLink: 'https://lu.ma/blr-llm-workshop',
    dedupHash: 'llm-workshop-blr-001',
  },
  {
    title: 'Future of UPI & Digital Payments Mixer',
    description: 'Fintech founders and PMs discuss the next wave of UPI 2.0, credit on UPI and cross-border payments.',
    source: 'manual', sourceUrl: 'https://lu.ma/upi-mixer',
    organizer: 'Fintech Bangalore', category: ['Fintech', 'Networking/Meetup'],
    format: 'offline', hasFood: 'unknown', isFree: false, price: 500,
    venue: 'Toit Brewpub, Indiranagar', area: 'Indiranagar',
    startDateTime: d(2, 19), applyLink: 'https://lu.ma/upi-mixer',
    dedupHash: 'upi-mixer-blr-001',
  },
  {
    title: 'Founders & Funders Meetup Q3 2025',
    description: 'Exclusive invite-style mixer for early-stage founders and active angels. Koramangala Social.',
    source: 'manual', sourceUrl: 'https://lu.ma/founders-funders-blr',
    organizer: 'StartupBlr', category: ['Networking/Meetup'],
    format: 'offline', hasFood: 'yes', isFree: true,
    venue: 'Koramangala Social, Koramangala', area: 'Koramangala',
    startDateTime: d(3, 17), applyLink: 'https://lu.ma/founders-funders-blr',
    dedupHash: 'founders-funders-blr-001',
  },
  {
    title: 'AWS re:Invent Watch Party Bangalore',
    description: 'Live screening of AWS re:Invent keynotes with cloud engineers. Pizza + discussions.',
    source: 'manual', sourceUrl: 'https://meetup.com/aws-blr',
    organizer: 'AWS User Group Bangalore', category: ['Cloud/DevOps'],
    format: 'offline', hasFood: 'yes', isFree: true,
    venue: 'Nimhans Convention Centre, Hosur Rd', area: 'BTM Layout',
    startDateTime: d(4, 10), applyLink: 'https://meetup.com/aws-blr',
    dedupHash: 'aws-watch-party-blr-001',
  },
  {
    title: 'React & Next.js Builders Meetup',
    description: 'Monthly meetup for frontend engineers. Lightning talks on React 19, Server Components and Next.js 16.',
    source: 'manual', sourceUrl: 'https://hasgeek.com/blrjs',
    organizer: 'BangaloreJS', category: ['Web/Mobile'],
    format: 'offline', hasFood: 'yes', isFree: true,
    venue: 'ThoughtWorks, Whitefield', area: 'Whitefield',
    startDateTime: d(5, 18, ), applyLink: 'https://hasgeek.com/blrjs',
    dedupHash: 'react-nextjs-blr-001',
  },
  {
    title: 'Cybersecurity CTF Challenge — BLR Edition',
    description: 'Capture the flag competition for security enthusiasts. Cash prizes for top 3 teams.',
    source: 'manual', sourceUrl: 'https://devfolio.co/blr-ctf',
    organizer: 'null[0x0] Security', category: ['Cybersecurity', 'Hackathon'],
    format: 'offline', hasFood: 'yes', isFree: true,
    venue: 'HSR Layout Club, HSR Layout', area: 'HSR Layout',
    startDateTime: d(6, 9), applyLink: 'https://devfolio.co/blr-ctf',
    dedupHash: 'ctf-blr-001',
  },
  {
    title: 'Data Science & Analytics Summit 2025',
    description: 'Full-day conference on ML pipelines, feature stores, and real-time analytics at scale.',
    source: 'manual', sourceUrl: 'https://blr-data-summit.com',
    organizer: 'DataBlr', category: ['Data/Analytics', 'Summit/Conference'],
    format: 'offline', hasFood: 'yes', isFree: false, price: 999,
    venue: 'Palace Grounds, Vasanth Nagar', area: 'MG Road',
    startDateTime: d(8, 9), applyLink: 'https://blr-data-summit.com',
    dedupHash: 'data-summit-blr-001',
  },
  {
    title: 'GenAI Hackathon — Build with NVIDIA NIM',
    description: '24-hour hackathon to build production-ready GenAI apps using NVIDIA NIM inference APIs.',
    source: 'manual', sourceUrl: 'https://devfolio.co/nvidia-nim-hack',
    organizer: 'NVIDIA Developer', category: ['AI/ML', 'Hackathon'],
    format: 'offline', hasFood: 'yes', isFree: true,
    venue: 'NASSCOM CoE, Electronic City', area: 'Electronic City',
    startDateTime: d(10, 8), applyLink: 'https://devfolio.co/nvidia-nim-hack',
    dedupHash: 'nvidia-nim-hack-blr-001',
  },
];

async function seed() {
  await mongoose.connect(MONGODB_URI);
  console.log('✅ Connected to MongoDB');

  let inserted = 0, skipped = 0;
  for (const ev of events) {
    const exists = await Event.findOne({ dedupHash: ev.dedupHash });
    if (exists) { skipped++; continue; }
    await Event.create(ev);
    inserted++;
    console.log(`  ➕ ${ev.title}`);
  }

  console.log(`\n✅ Done — inserted: ${inserted}, skipped (already exist): ${skipped}`);
  await mongoose.disconnect();
}

seed().catch(e => { console.error('❌', e.message); process.exit(1); });
