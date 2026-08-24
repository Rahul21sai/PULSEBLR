#!/usr/bin/env tsx
/**
 * Do the Contact and Folder derived-key hooks actually run?
 *
 * `Contact.contactKey` and `Folder.slug` are both `required` AND derived, which puts them
 * on the exact landmine this repo has already stepped on twice:
 *
 *   TRAP 1 — `pre('save')` is too late. Mongoose registers its own validation as the
 *   FIRST pre-save middleware, so a `pre('save')` hook that fills a `required` field
 *   never executes: validation has already rejected the document. `diag-hook-order.ts`
 *   proves this for `Event`, where it cost 3 events in a single scrape.
 *
 *   TRAP 2 — `pre('validate')` does NOT run on `findOneAndUpdate`/`updateOne`/`bulkWrite`.
 *   `runValidators` invokes Mongoose's separate update-validator helper, not document
 *   middleware. That is why every Contact write must go through `findOne` + assign +
 *   `.save()`. This script cannot catch a route that violates it — `diag-contact-flow.ts`
 *   does that against a live server — so the assertions here are about the document path.
 *
 * THE DECISIVE ASSERTION is "a document that never supplied contactKey validates
 * successfully". If the hook were on the wrong event, that would fail with
 * "Path `contactKey` is required" and every scanned contact would be lost.
 *
 * Read-only. No DB, no network — Mongoose runs document middleware in process, so this
 * needs neither a connection nor a dev server.
 *
 * Run: npx tsx scripts/diag-contact-identity.ts
 */
import Contact from '../lib/models/Contact';
import Folder, { folderSlug } from '../lib/models/Folder';
import { deriveContactKey } from '../lib/scan/contact-key';
import mongoose from 'mongoose';

const failures: string[] = [];
let checks = 0;

function check(label: string, condition: boolean, detail?: string) {
  checks++;
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!condition) failures.push(label);
}

/** Run document validation and return the error, or null on success. */
async function validationErrorOf(doc: mongoose.Document): Promise<Error | null> {
  try {
    await doc.validate();
    return null;
  } catch (err) {
    return err as Error;
  }
}

function newContact(fields: Record<string, unknown>) {
  return new Contact({
    userId: 'devlogin:test@example.com',
    folderId: new mongoose.Types.ObjectId(),
    clientId: 'client-uuid-1',
    ...fields,
  });
}

async function main() {
  console.log('Contact.contactKey / Folder.slug — derived-key hook behaviour\n');

  /* ── The decisive one: the hook must run BEFORE required-field validation ── */
  console.log('hook fires on pre(validate), not pre(save):');
  {
    const doc = newContact({ name: 'Priya Sharma' });
    const err = await validationErrorOf(doc);
    check(
      'a document that never supplied contactKey still validates',
      err === null,
      err ? `<-- ${err.message}` : `key=${doc.contactKey}`
    );
    check('and the key was derived from the name', doc.contactKey === 'nm:priya sharma', doc.contactKey);
  }

  /* ── Precedence ────────────────────────────────────────────────────────── */
  console.log('\nprecedence (slug > email > phone > name):');
  {
    const doc = newContact({
      name: 'Priya Sharma',
      email: 'priya@example.com',
      phone: '+91 98765 43210',
      linkedinSlug: 'priya-sharma-3f21',
    });
    await doc.validate();
    check('LinkedIn slug wins', doc.contactKey === 'li:priya-sharma-3f21', doc.contactKey);
  }
  {
    const doc = newContact({ name: 'Priya', phone: '09876543210' });
    await doc.validate();
    check('phone beats name, normalised to the last 10 digits', doc.contactKey === 'ph:9876543210', doc.contactKey);
  }

  /* ── The upgrade path: why the key is recomputed, not frozen ───────────── */
  console.log('\nupgrade when a stronger identifier arrives later:');
  {
    const doc = newContact({ name: 'Priya Sharma' });
    await doc.validate();
    const before = doc.contactKey;

    // A week later you find their LinkedIn and add it.
    doc.linkedinSlug = 'priya-sharma-3f21';
    await doc.validate();

    check('key was nm: before', before === 'nm:priya sharma', before);
    check('key is li: after', doc.contactKey === 'li:priya-sharma-3f21', doc.contactKey);
    check('so the next scan of their QR matches this person', doc.contactKey !== before);
  }

  /* ── Self-healing, mirroring diag-clusterkey-selfheal.ts ───────────────── */
  console.log('\nself-heal (a document written before the field existed):');
  {
    const doc = newContact({ name: 'Priya Sharma', linkedinSlug: 'priya-sharma-3f21' });
    await doc.validate();
    // Simulate a legacy document: strip the key and touch nothing else.
    doc.set('contactKey', undefined);
    const err = await validationErrorOf(doc);
    check(
      'repairs itself rather than throwing "Path `contactKey` is required"',
      err === null && doc.contactKey === 'li:priya-sharma-3f21',
      err ? `<-- ${err.message}` : doc.contactKey
    );
  }

  /* ── Failing cleanly beats storing a meaningless key ───────────────────── */
  console.log('\nno usable identity at all:');
  {
    check('deriveContactKey returns empty rather than inventing one', deriveContactKey({}) === '');
    const doc = newContact({});
    const err = await validationErrorOf(doc);
    check(
      'a nameless contact is refused, and the message names `name`',
      err !== null && /name/.test(err.message),
      err ? err.message.slice(0, 90) : 'validated when it should not have'
    );
  }

  /* ── Folder.slug ───────────────────────────────────────────────────────── */
  console.log('\nFolder.slug:');
  {
    const doc = new Folder({ userId: 'devlogin:test@example.com', name: 'I/O Connect' });
    const err = await validationErrorOf(doc);
    check(
      'derived without being supplied',
      err === null && doc.slug === 'i-o-connect',
      err ? `<-- ${err.message}` : doc.slug
    );

    doc.name = 'Google I/O Connect Bangalore';
    await doc.validate();
    check('re-derived on rename', doc.slug === 'google-i-o-connect-bangalore', doc.slug);
  }
  {
    // Two folders genuinely named the same thing must produce the same slug, so the
    // { userId, slug } unique index catches the duplicate rather than allowing two.
    const a = new Folder({ userId: 'u', name: 'I/O Connect' });
    const b = new Folder({ userId: 'u', name: 'i/o  connect' });
    await a.validate();
    await b.validate();
    check('same name → same slug, so the unique index can catch a duplicate', a.slug === b.slug, `${a.slug} / ${b.slug}`);
  }
  {
    // slugify keeps only [a-z0-9], so a name in another script reduces to ''. An empty
    // slug would make the unique index collapse every such folder into one.
    const doc = new Folder({ userId: 'u', name: 'प्रिया की मीटिंग' });
    await doc.validate();
    check('a non-Latin name still gets a non-empty, stable slug', Boolean(doc.slug) && doc.slug.startsWith('f-'), doc.slug);
    check('and it is deterministic', doc.slug === folderSlug('प्रिया की मीटिंग'));
  }

  console.log(`\n${checks - failures.length}/${checks} checks passed`);
  if (failures.length) {
    console.log('\nfailures:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
