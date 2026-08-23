#!/usr/bin/env tsx
/**
 * How many events flagged `isTechEvent` are not actually software/hardware events?
 *
 * This is the single biggest hit to the product's daily usefulness: the feed defaults to
 * techOnly, so every false positive is a wasted row in the one view the user lives in.
 * An audit put it around 20% by hand; this measures it repeatably so a fix can be proven
 * rather than asserted.
 *
 * The detectors below are deliberately CONSERVATIVE — they only flag phrasings that are
 * unambiguously non-engineering. The real rate is therefore at least what this reports.
 *
 * Read-only.
 *
 * Run: npx tsx scripts/diag-tech-precision.ts
 */
import './load-env';
import mongoose from 'mongoose';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';

/**
 * Families of false positive, each with the phrasing that identifies it. Ordered by how
 * clearly they are NOT a software/hardware engineering event.
 */
const FALSE_POSITIVE_PATTERNS: Array<{ family: string; re: RegExp }> = [
  {
    family: 'generic business networking',
    re: /\b(business (exchange|network(ing)?|referral)|b2b networking|speed (friending|networking)|chamber of commerce|mixer for (professionals|entrepreneurs)|weekly business)\b/i,
  },
  {
    family: 'sales / marketing / growth',
    re: /\b(sales funnel|lead gen(eration)?|cold (call|email)|marketing (innovation|strategy|automation)|seo|copywriting|brand building|influencer)\b/i,
  },
  {
    family: 'HR / recruiting-as-a-product',
    re: /\b(hr (teams?|leaders?|tech|summit)|talent acquisition|payroll|employee engagement|people ops)\b/i,
  },
  {
    family: 'paid certification / cohort selling',
    re: /\b(get .{0,20}certified|certification (cohort|bootcamp|program)|\bcohort\b.{0,20}\[\d|batch \d|placement (guarantee|assistance)|job guarantee)\b/i,
  },
  {
    family: 'wellness / spiritual / lifestyle',
    re: /\b(manifestation|law of attraction|reiki|astrology|sound healing|breathwork|satsang|gut.health|yoga|meditation retreat)\b/i,
  },
  {
    family: 'trading / real estate pitch',
    re: /\b(intraday|forex|stock market (course|training)|options trading|real estate (investment|expo)|wealth creation)\b/i,
  },
  {
    family: 'social / hobby',
    re: /\b(board ?games?|book club|trek(king)?|hike|potluck|karaoke|open mic|dating|speed dating|pickleball|badminton)\b/i,
  },
];

/** Phrasings that mean it IS engineering, and override a weak false-positive hit. */
const GENUINELY_TECHNICAL =
  /\b(kubernetes|docker|terraform|postgres|kafka|rust|golang|typescript|react|llm|rag|embeddings?|fine.?tun|inference|observability|sre|devops|ci\/cd|api|sdk|compiler|fpga|vlsi|rtos|firmware|embedded|open ?source|git|linux|hackathon)\b/i;

async function main() {
  await connectDB();
  const now = new Date();

  const tech = await Event.find({ startDateTime: { $gte: now }, isTechEvent: true })
    .select('title description category organizer tagConfidence connectionScore')
    .lean();

  console.log(`Auditing ${tech.length} upcoming events flagged isTechEvent\n`);

  const hits = new Map<string, Array<{ title: string; cats: string[] }>>();
  const flagged = new Set<string>();

  for (const e of tech) {
    const haystack = `${e.title || ''} ${(e.description || '').slice(0, 400)}`;
    for (const { family, re } of FALSE_POSITIVE_PATTERNS) {
      if (!re.test(haystack)) continue;
      // A real Kubernetes talk that happens to say "yoga" in a joke stays technical.
      if (GENUINELY_TECHNICAL.test(haystack)) continue;
      if (!hits.has(family)) hits.set(family, []);
      hits.get(family)!.push({ title: (e.title || '').slice(0, 62), cats: e.category || [] });
      flagged.add(String(e._id));
      break;
    }
  }

  for (const [family, list] of [...hits.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`${family}: ${list.length}`);
    for (const item of list.slice(0, 4)) {
      console.log(`   ${item.title.padEnd(64)} [${item.cats.join(', ')}]`);
    }
  }

  const rate = tech.length ? (flagged.size / tech.length) * 100 : 0;
  console.log(
    `\nFALSE POSITIVES: ${flagged.size}/${tech.length} = ${rate.toFixed(1)}%  (conservative — the real rate is at least this)`
  );

  // Where do the bad tags come from? Keyword tagging is the prime suspect: it derives
  // isTechEvent from whether ANY assigned category is technical, so one loose keyword
  // match promotes a sales webinar into the tech feed.
  const byConfidence = new Map<string, { total: number; bad: number }>();
  for (const e of tech) {
    const conf = e.tagConfidence ?? 0.6;
    const bucket = conf >= 0.8 ? 'LLM (>=0.8)' : 'keyword (<0.8)';
    const row = byConfidence.get(bucket) ?? { total: 0, bad: 0 };
    row.total++;
    if (flagged.has(String(e._id))) row.bad++;
    byConfidence.set(bucket, row);
  }
  console.log('\nBy tag source:');
  for (const [bucket, row] of byConfidence) {
    const pct = row.total ? ((row.bad / row.total) * 100).toFixed(1) : '0';
    console.log(`  ${bucket.padEnd(16)} ${row.bad}/${row.total} bad (${pct}%)`);
  }

  await mongoose.disconnect();
  // Non-zero above 5% so this can gate a fix.
  process.exit(rate > 5 ? 1 : 0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
