#!/usr/bin/env tsx
/**
 * READ-ONLY: who is actually hosting the events we already hold?
 *
 * This is the inverted question that matters. Platform search cannot answer
 * "what are Google's events" — a nonsense keyword returns the same page size as
 * "Google", and only 5 of 12 "Google" hits even name Google. But 86% of the events
 * we already store name their host, so the companies are IN the data and only need
 * resolving into canonical names.
 *
 * Run: npx tsx scripts/diag-organizers.ts
 */
import './load-env';
import mongoose from 'mongoose';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';

/** Escape a company name for safe use inside a RegExp. */
function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const KNOWN_COMPANIES = [
  'Google', 'Microsoft', 'Amazon', 'AWS', 'Meta', 'Apple', 'Nvidia', 'IBM', 'Oracle',
  'Salesforce', 'Adobe', 'SAP', 'Intel', 'Qualcomm', 'Samsung', 'Cisco', 'VMware',
  'Atlassian', 'GitHub', 'GitLab', 'MongoDB', 'Docker', 'Elastic', 'Confluent',
  'Databricks', 'Snowflake', 'Redis', 'Grafana', 'HashiCorp', 'ServiceNow', 'Postman',
  'Flipkart', 'Swiggy', 'Zomato', 'PhonePe', 'Razorpay', 'CRED', 'Zerodha', 'Meesho',
  'Groww', 'Freshworks', 'Zoho', 'BrowserStack', 'Hasura', 'Chargebee', 'Atlan',
  'Sarvam', 'Krutrim', 'Lyzr', 'ThoughtWorks', 'Infosys', 'Wipro', 'TCS', 'Accenture',
  'Deloitte', 'Walmart', 'Target', 'Intuit', 'JPMorgan', 'Goldman',
];

async function main() {
  await connectDB();
  const now = new Date();

  const rows = await Event.aggregate([
    { $match: { startDateTime: { $gte: now }, organizer: { $nin: [null, ''] } } },
    { $group: { _id: '$organizer', n: { $sum: 1 } } },
    { $sort: { n: -1 } },
  ]);
  console.log(`${rows.length} distinct organizer strings across upcoming events\n`);
  console.log('Top 40 hosts:');
  for (const r of rows.slice(0, 40)) {
    console.log(`   ${String(r.n).padStart(3)}  ${String(r._id).slice(0, 58)}`);
  }

  const noHost = await Event.countDocuments({
    startDateTime: { $gte: now },
    $or: [{ organizer: null }, { organizer: '' }, { organizer: { $exists: false } }],
  });
  console.log(`\n${noHost} upcoming events have no host recorded`);

  const hits: Array<[string, number]> = [];
  for (const name of KNOWN_COMPANIES) {
    const rx = new RegExp(escapeRegex(name), 'i');
    const n = await Event.countDocuments({
      startDateTime: { $gte: now },
      $or: [{ organizer: rx }, { title: rx }, { description: rx }],
    });
    if (n > 0) hits.push([name, n]);
  }
  hits.sort((a, b) => b[1] - a[1]);

  console.log(`\n${hits.length}/${KNOWN_COMPANIES.length} known companies already appear in upcoming events:`);
  for (const [name, n] of hits) console.log(`   ${String(n).padStart(3)}  ${name}`);

  const missing = KNOWN_COMPANIES.filter(n => !hits.some(h => h[0] === n));
  console.log(`\nAbsent (${missing.length}): ${missing.join(', ')}`);

  await mongoose.disconnect();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
