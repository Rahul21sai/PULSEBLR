#!/usr/bin/env tsx
/**
 * Would re-tagging actually FIX the mis-tagged events, or just churn them?
 *
 * diag-tech-consistency.ts found 75 of 1048 upcoming events (7.2%) where `isTechEvent` and the
 * tech-topic categories disagree, and inspection showed the signature of the tagger's
 * batch-misalignment bug: `IndiaFOSS 2026` carrying `Arts/Culture`, a `Social Mixer` carrying
 * `AI/ML, Cloud/DevOps`, `Navigating Difficult Marriages` carrying `Career/Hiring` — categories
 * that belong to a DIFFERENT event in the same batch of five. That bug is fixed (results are
 * now matched by the event number the model echoes back, not by array position), but the stored
 * damage persists because ingestion UNIONS categories and can never remove one.
 *
 * The obvious next move is `retag-events.ts --all`. That would rewrite ~1048 documents using
 * NVIDIA's llama-3.1-8b, since the IBM ICA key has expired — a smaller model than whatever
 * produced some of the current tags. Rewriting the whole corpus with an unvalidated model is
 * how you turn a 7% problem into a 30% one.
 *
 * So this re-tags a TARGETED sample — the specific events that are provably wrong, plus
 * controls that are provably right — and prints old → new for each without writing anything.
 * Controls matter more than the broken ones: a model that fixes IndiaFOSS while breaking the
 * Kubernetes meetup is not an improvement.
 *
 * Read-only. WRITES NOTHING.
 *
 * Run: npx tsx scripts/diag-retag-preview.ts
 */
import './load-env';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';
import { tagEvents } from '../lib/llm/tagger';
import { TECH_CATEGORY_NAMES } from '../lib/event-types';
import mongoose from 'mongoose';

const TECH = new Set<string>(TECH_CATEGORY_NAMES);

/**
 * Title fragments to pull from the corpus, with what we expect afterwards.
 * `tech` is the expected isTechEvent. `null` means "judgement call, just show me".
 */
const CASES: Array<{ match: string; expectTech: boolean | null; why: string }> = [
  // ── Direction A: genuinely tech, currently hidden from the default feed.
  { match: 'IndiaFOSS', expectTech: true, why: "India's flagship open-source conference" },
  { match: 'Unicorn AI Summit', expectTech: true, why: 'an AI summit' },
  { match: 'Engineering Leaders Roundtable', expectTech: true, why: 'engineering practice talk' },
  { match: 'Agent Arena', expectTech: true, why: 'agentic AI session' },

  // ── Direction A: the flag is right and the CATEGORY is the error.
  { match: 'Boardgames', expectTech: false, why: 'board games are not Gaming/XR the tech topic' },
  { match: 'Social Mixer', expectTech: false, why: 'carries AI/ML + Cloud/DevOps from another event' },
  { match: 'CMMI Audits', expectTech: false, why: 'process audit, tagged Cybersecurity' },

  // ── Direction B: in the tech feed, plainly not tech.
  { match: 'Navigating Difficult Marriages', expectTech: false, why: 'tagged Career/Hiring' },
  { match: 'Win Over Anxiety', expectTech: false, why: 'wellness' },
  { match: 'SongGully', expectTech: false, why: 'music jam tagged Product/Design' },
  { match: 'Cancer and Oncology', expectTech: false, why: 'medical conference' },
  { match: 'Hospitality Education Expo', expectTech: false, why: 'hospitality trade show' },

  // ── CONTROLS: must stay correct. These are the ones that matter.
  { match: 'Kubernetes', expectTech: true, why: 'control — must stay tech' },
  { match: 'Hackathon', expectTech: true, why: 'control — must stay tech' },
  { match: 'Standup Comedy', expectTech: false, why: 'control — must stay non-tech' },
  { match: 'Open Mic', expectTech: false, why: 'control — must stay non-tech' },
];

function esc(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function main() {
  await connectDB();

  const picked: Array<{
    doc: { _id: unknown; title: string; description?: string; venue?: string; onlineLink?: string; category: string[]; isTechEvent?: boolean; tags?: string[] };
    expectTech: boolean | null;
    why: string;
  }> = [];

  for (const c of CASES) {
    const doc = await Event.findOne(
      { title: new RegExp(esc(c.match), 'i') },
      { title: 1, description: 1, venue: 1, onlineLink: 1, category: 1, isTechEvent: 1, tags: 1 }
    ).lean();
    if (!doc) {
      console.log(`  (no event matching "${c.match}" — skipped)`);
      continue;
    }
    picked.push({ doc: doc as never, expectTech: c.expectTech, why: c.why });
  }

  console.log(`\nre-tagging ${picked.length} targeted event(s) — nothing is written\n`);

  const results = await tagEvents(
    picked.map(p => ({
      title: p.doc.title,
      description: p.doc.description ?? '',
      venue: p.doc.venue,
      onlineLink: p.doc.onlineLink,
      hints: p.doc.tags,
    }))
  );

  let fixed = 0;
  let broken = 0;
  let unchanged = 0;

  for (let i = 0; i < picked.length; i++) {
    const { doc, expectTech, why } = picked[i];
    const r = results[i];

    const oldTech = Boolean(doc.isTechEvent);
    const newTech = r.isTechEvent;
    const oldCats = (doc.category || []).join(', ');
    const newCats = r.categories.join(', ');

    const oldOk = expectTech === null ? null : oldTech === expectTech;
    const newOk = expectTech === null ? null : newTech === expectTech;

    let verdict = '     ';
    if (oldOk === false && newOk === true) { verdict = 'FIXED'; fixed++; }
    else if (oldOk === true && newOk === false) { verdict = 'BROKE'; broken++; }
    else if (oldOk === false && newOk === false) { verdict = 'still'; unchanged++; }
    else if (oldOk === true && newOk === true) { verdict = ' ok  '; }

    // A category disagreement that survives is still a defect even when the flag is right.
    const newAgrees = r.categories.some(c => TECH.has(c)) === newTech;

    console.log(`  ${verdict}  ${doc.title.slice(0, 52)}`);
    console.log(`         want tech=${expectTech === null ? '?' : expectTech}   ${why}`);
    console.log(`         old  tech=${oldTech}  [${oldCats}]`);
    console.log(`         new  tech=${newTech}  [${newCats}]${newAgrees ? '' : '   ← flag still disagrees with its own categories'}`);
  }

  console.log(`\n  FIXED ${fixed}   BROKE ${broken}   still wrong ${unchanged}`);
  console.log('\n  DECISION RULE: run retag-events.ts only if FIXED clearly exceeds BROKE and no');
  console.log('  control regressed. Otherwise the model is not good enough to rewrite the corpus');
  console.log('  with, and the right move is to restore a stronger provider first (the IBM ICA');
  console.log('  key has expired) rather than to re-tag 1048 documents with this one.');

  await mongoose.disconnect();
}

main().catch(async e => {
  console.error(e);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
