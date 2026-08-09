#!/usr/bin/env tsx
/** READ-ONLY: diagnose text search and tech-flag accuracy. */
import './load-env';
import mongoose from 'mongoose';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';

async function main() {
  await connectDB();

  console.log('--- text index present? ---');
  const idx = await Event.collection.indexes();
  for (const i of idx) console.log(`   ${i.name}  ${JSON.stringify(i.key).slice(0, 90)}`);

  for (const term of ['kubernetes', 'python', 'trek', 'AI', 'startup', 'react']) {
    const rx = new RegExp(term, 'i');
    const regexCount = await Event.countDocuments({
      startDateTime: { $gte: new Date() },
      $or: [{ title: rx }, { organizer: rx }, { venue: rx }, { tags: rx }],
    });
    let textCount = -1;
    try {
      textCount = await Event.countDocuments({
        startDateTime: { $gte: new Date() },
        $text: { $search: term },
      });
    } catch {
      // No text index, or the term is all stop-words.
      textCount = -1;
    }
    const descCount = await Event.countDocuments({
      startDateTime: { $gte: new Date() },
      description: rx,
    });
    console.log(`   ${term.padEnd(12)} regex(title/org/venue/tags)=${String(regexCount).padStart(4)}  $text=${String(textCount).padStart(4)}  desc-regex=${String(descCount).padStart(4)}`);
  }

  console.log('\n--- trek events: are they flagged tech? ---');
  const treks = await Event.find({ title: /trek/i, startDateTime: { $gte: new Date() } })
    .select('title category isTechEvent')
    .limit(6)
    .lean();
  for (const t of treks) {
    console.log(`   tech=${t.isTechEvent} ${String(t.category).padEnd(60)} ${String(t.title).slice(0, 40)}`);
  }

  console.log('\n--- how many upcoming are flagged tech, and what are their top categories? ---');
  const techTop = await Event.aggregate([
    { $match: { startDateTime: { $gte: new Date() }, isTechEvent: true } },
    { $unwind: '$category' },
    { $group: { _id: '$category', n: { $sum: 1 } } },
    { $sort: { n: -1 } },
    { $limit: 12 },
  ]);
  for (const r of techTop) console.log(`   ${String(r._id).padEnd(26)} ${r.n}`);

  console.log('\n--- events with >3 categories (merge artefacts) ---');
  const many = await Event.countDocuments({ 'category.3': { $exists: true } });
  console.log(`   ${many}`);

  await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
