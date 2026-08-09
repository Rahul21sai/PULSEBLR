#!/usr/bin/env tsx
/** READ-ONLY: inspect every document matching a title, to explain contradictions. */
import './load-env';
import mongoose from 'mongoose';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';

async function main() {
  await connectDB();
  console.log('DB:', mongoose.connection.name, '| host:', mongoose.connection.host);

  for (const title of ['Kudremukh New Year Trek', 'Mahabaleshwar Diaries']) {
    const docs = await Event.find({ title }).select('category isTechEvent source startDateTime clusterKey updatedAt').lean();
    console.log(`\n"${title}" → ${docs.length} document(s)`);
    for (const d of docs) {
      console.log(`   _id=${d._id} src=${d.source} tech=${d.isTechEvent}`);
      console.log(`      cats=${JSON.stringify(d.category)}`);
      console.log(`      start=${new Date(d.startDateTime).toISOString()} updated=${d.updatedAt ? new Date(d.updatedAt).toISOString() : '?'}`);
      console.log(`      clusterKey=${d.clusterKey}`);
    }
  }

  const overTagged = await Event.find({ 'category.3': { $exists: true } })
    .select('title category isTechEvent updatedAt').limit(20).lean();
  console.log(`\n${overTagged.length} shown of events with 4+ categories:`);
  for (const d of overTagged) {
    console.log(`   tech=${d.isTechEvent} ${JSON.stringify(d.category)}  ${String(d.title).slice(0,40)}`);
  }

  await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
