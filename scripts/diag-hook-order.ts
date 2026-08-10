#!/usr/bin/env tsx
/**
 * Does a `pre('save')` hook run early enough to satisfy a `required` field?
 *
 * This matters because lib/models/Event.ts derives `clusterKey` in `pre('save')`,
 * and the last scrape lost 3 events to "clusterKey: Path `clusterKey` is required"
 * when merging into legacy documents that predate the field.
 *
 * Uses throwaway schemas on a scratch collection — it never touches Event data.
 *
 * Run: npx tsx scripts/diag-hook-order.ts
 */
import './load-env';
import mongoose from 'mongoose';
import connectDB from '../lib/mongodb';

async function main() {
  await connectDB();

  const order: string[] = [];

  const saveSchema = new mongoose.Schema({
    title: { type: String, required: true },
    derived: { type: String, required: true },
  });
  saveSchema.pre('save', function () {
    order.push('pre-save ran');
    const self = this as unknown as { derived?: string; title: string };
    if (!self.derived) self.derived = `from:${self.title}`;
  });
  saveSchema.pre('validate', function () {
    order.push('pre-validate ran');
  });

  const A = mongoose.model('HookOrderSave', saveSchema, 'scratch_hook_order');

  console.log('CASE 1 — derive in pre("save"), field absent:');
  try {
    const doc = new A({ title: 'hello' });
    await doc.save();
    console.log('   saved OK, derived =', (doc as unknown as { derived: string }).derived);
    await A.deleteOne({ _id: doc._id });
  } catch (err) {
    console.log('   FAILED:', (err as Error).message);
  }
  console.log('   hook order:', order.join(' → ') || '(none)');

  // Same thing, but derive in pre('validate').
  const order2: string[] = [];
  const validateSchema = new mongoose.Schema({
    title: { type: String, required: true },
    derived: { type: String, required: true },
  });
  validateSchema.pre('validate', function () {
    order2.push('pre-validate ran');
    const self = this as unknown as { derived?: string; title: string };
    if (!self.derived) self.derived = `from:${self.title}`;
  });

  const B = mongoose.model('HookOrderValidate', validateSchema, 'scratch_hook_order');

  console.log('\nCASE 2 — derive in pre("validate"), field absent:');
  try {
    const doc = new B({ title: 'hello' });
    await doc.save();
    console.log('   saved OK, derived =', (doc as unknown as { derived: string }).derived);
    await B.deleteOne({ _id: doc._id });
  } catch (err) {
    console.log('   FAILED:', (err as Error).message);
  }
  console.log('   hook order:', order2.join(' → ') || '(none)');

  await mongoose.connection.collection('scratch_hook_order').drop().catch(() => {});
  await mongoose.disconnect();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
