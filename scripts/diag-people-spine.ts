#!/usr/bin/env tsx
/**
 * Is the people spine internally consistent? READ-ONLY, and it exits non-zero on any failure.
 *
 * Seven assertions, each covering a way this design fails SILENTLY — which is the whole reason it is
 * a script rather than a code review:
 *
 *   1. Every `Contact` has a `personId`. One without is invisible on a `/people` that lists persons.
 *   2. Every `personId` points at a person that EXISTS and is not a tombstone.
 *   3. No `contactKey` appears on two LIVE persons — the drift the create race would produce.
 *   4. Every `met` interaction has a `contactId`, and that contact exists.
 *   5. No `met` interaction is duplicated for one contact — the replay bug, checked in the data.
 *   6. No ghost persons: a person with no contacts renders in the list with nothing to open.
 *   7. THE DENORMALISED COUNTERS MATCH A LIVE RECOUNT.
 *
 * Number 7 is the one that earns the script. `eventCount`, `interactionCount`, `lastInteractionAt` and
 * `nextActionAt` are denormalised so `/people` can filter and sort on them at all, and a denormalised
 * counter drifts — a lost write, an interrupted backfill, a route that deletes a contact without
 * calling `onContactDeleted`. It is checked through the SAME pure functions `recomputePerson()` writes
 * with (`derivePersonCounters`, `deriveNextActionAt`, `derivePersonTags`, `derivePersonFields`), so the
 * check cannot drift from the writer — the arrangement `diag-offcity.ts` uses when it imports
 * `offCityReason()` rather than mirroring it. It writes NOTHING; a mismatch is a report, and
 * `scripts/backfill-person-spine.ts` plus `recomputePerson()` are the repair.
 *
 *   npx tsx scripts/diag-people-spine.ts
 */
import './load-env';
import mongoose from 'mongoose';
import connectDB from '../lib/mongodb';
import Contact from '../lib/models/Contact';
import Person from '../lib/models/Person';
import Interaction from '../lib/models/Interaction';
import {
  derivePersonFields,
  derivePersonCounters,
  deriveNextActionAt,
  derivePersonTags,
  PersonContactFacts,
} from '../lib/people/service';

let failures = 0;

function check(label: string, ok: boolean, detail?: string[]) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) {
    failures++;
    for (const line of (detail ?? []).slice(0, 15)) console.log(`        ${line}`);
    if ((detail ?? []).length > 15) console.log(`        … and ${detail!.length - 15} more`);
  }
}

function iso(value: Date | null | undefined): string {
  return value ? new Date(value).toISOString() : 'null';
}

/** Same instant, tolerant of the millisecond a BSON round trip can shave off a Date. */
function sameInstant(a: Date | null | undefined, b: Date | null | undefined): boolean {
  const left = a ? new Date(a).getTime() : 0;
  const right = b ? new Date(b).getTime() : 0;
  return Math.abs(left - right) < 1000;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

async function main() {
  await connectDB();

  /**
   * Three full reads and an in-memory join, rather than a per-person query.
   *
   * The scale assumption is explicit: this is one user's private contact set, in the hundreds. If it
   * ever reaches the tens of thousands this becomes an aggregation — but a diagnostic that is easy to
   * read is worth more than one that scales, because the moment it is hard to read nobody trusts its
   * output enough to act on a FAIL.
   */
  const [persons, contacts, interactions] = await Promise.all([
    Person.find({}).lean(),
    Contact.find({}).lean(),
    Interaction.find({}).lean(),
  ]);

  console.log(
    `${persons.length} persons · ${contacts.length} contacts · ${interactions.length} interactions\n`
  );

  const personById = new Map(persons.map(p => [String(p._id), p]));
  const contactById = new Map(contacts.map(c => [String(c._id), c]));

  const contactsByPerson = new Map<string, typeof contacts>();
  for (const contact of contacts) {
    if (!contact.personId) continue;
    const key = String(contact.personId);
    if (!contactsByPerson.has(key)) contactsByPerson.set(key, []);
    contactsByPerson.get(key)!.push(contact);
  }

  const interactionsByPerson = new Map<string, typeof interactions>();
  for (const row of interactions) {
    const key = String(row.personId);
    if (!interactionsByPerson.has(key)) interactionsByPerson.set(key, []);
    interactionsByPerson.get(key)!.push(row);
  }

  /* ── 1. every contact is attached ───────────────────────────────────────────────────────────── */
  const unattached = contacts.filter(c => !c.personId);
  check(
    `every Contact has a personId (${contacts.length - unattached.length}/${contacts.length})`,
    unattached.length === 0,
    unattached.map(c => `${c.name} · ${c.contactKey} · ${String(c._id)}`).concat(
      unattached.length ? ['→ run: npx tsx scripts/backfill-person-spine.ts --apply'] : []
    )
  );

  /* ── 2. no dangling or tombstoned pointers ──────────────────────────────────────────────────── */
  const dangling: string[] = [];
  const pointsAtTombstone: string[] = [];
  for (const contact of contacts) {
    if (!contact.personId) continue;
    const person = personById.get(String(contact.personId));
    if (!person) {
      dangling.push(`${contact.name} → missing person ${String(contact.personId)}`);
      continue;
    }
    /**
     * A merge REPOINTS every contact onto the winner, so a contact still pointing at a tombstone means
     * the repoint did not finish. It is not cosmetic: `buildPersonFilter` hides tombstones, so this
     * person's encounters count towards a row nobody can see, and they vanish from `/people`.
     */
    if (person.mergedInto) {
      pointsAtTombstone.push(
        `${contact.name} → merged-away person ${String(person._id)} (winner ${String(person.mergedInto)})`
      );
    }
  }
  check('every Contact.personId resolves to a real Person', dangling.length === 0, dangling);
  check('no Contact points at a merged-away Person', pointsAtTombstone.length === 0, pointsAtTombstone);

  /* ── 3. a contactKey belongs to at most one LIVE person ─────────────────────────────────────── */
  /**
   * Restricted to LIVE persons on purpose. `mergePersons()` unions the loser's keys onto the winner
   * and LEAVES them on the loser, precisely so `resolvePerson()` can follow the tombstone when a
   * later capture arrives carrying an old key. Asserting global uniqueness would report every
   * successful merge as corruption.
   */
  const keyOwners = new Map<string, string[]>();
  for (const person of persons) {
    if (person.mergedInto) continue;
    for (const key of person.contactKeys ?? []) {
      const composite = `${person.userId}::${key}`;
      if (!keyOwners.has(composite)) keyOwners.set(composite, []);
      keyOwners.get(composite)!.push(`${person.displayName} (${String(person._id)})`);
    }
  }
  const shared = [...keyOwners.entries()].filter(([, owners]) => owners.length > 1);
  check(
    `no contactKey is held by two live Persons (${keyOwners.size} keys)`,
    shared.length === 0,
    shared.map(([composite, owners]) => `${composite.split('::')[1]} → ${owners.join('  ,  ')}`)
  );

  /* ── 4 & 5. the met interactions ────────────────────────────────────────────────────────────── */
  const metRows = interactions.filter(i => i.kind === 'met');
  const metNoContact = metRows.filter(i => !i.contactId);
  check(
    `every met interaction carries a contactId (${metRows.length} met rows)`,
    metNoContact.length === 0,
    metNoContact.map(
      i => `${String(i._id)} person=${String(i.personId)}  → collides on null in the unique index`
    )
  );

  const metMissingContact = metRows.filter(
    i => i.contactId && !contactById.has(String(i.contactId))
  );
  check(
    'every met interaction points at a Contact that exists',
    metMissingContact.length === 0,
    metMissingContact
      .map(i => `${String(i._id)} → missing contact ${String(i.contactId)}`)
      .concat(
        metMissingContact.length
          ? ['→ a delete path is not calling onContactDeleted() / onFolderDeleted()']
          : []
      )
  );

  const metPerContact = new Map<string, number>();
  for (const row of metRows) {
    if (!row.contactId) continue;
    const composite = `${row.userId}::${String(row.contactId)}`;
    metPerContact.set(composite, (metPerContact.get(composite) ?? 0) + 1);
  }
  const duplicated = [...metPerContact.entries()].filter(([, count]) => count > 1);
  check(
    'no contact has two met interactions (the replay bug, checked in the data)',
    duplicated.length === 0,
    duplicated.map(([composite, count]) => {
      const contact = contactById.get(composite.split('::')[1]);
      return `${contact?.name ?? composite} × ${count}  → the partial unique index is missing or wrong`;
    })
  );

  /* ── 6. no ghost persons ────────────────────────────────────────────────────────────────────── */
  const ghosts = persons.filter(
    p => !p.mergedInto && (contactsByPerson.get(String(p._id))?.length ?? 0) === 0
  );
  check(
    'no Person has zero Contacts',
    ghosts.length === 0,
    ghosts
      .map(p => `${p.displayName} (${String(p._id)}) — renders in /people with nothing to open`)
      .concat(ghosts.length ? ['→ a delete path is not calling onContactDeleted() / onFolderDeleted()'] : [])
  );

  /* ── 7. the denormalised counters against a live recount ────────────────────────────────────── */
  const drifted: string[] = [];
  for (const person of persons) {
    if (person.mergedInto) continue; // A tombstone's counters are frozen by design; nothing reads them.

    const id = String(person._id);
    const own = contactsByPerson.get(id) ?? [];
    const timeline = interactionsByPerson.get(id) ?? [];

    const facts: PersonContactFacts[] = own.map(c => ({
      scannedAt: c.scannedAt as Date,
      name: c.name,
      company: c.company,
      role: c.role,
      headline: c.headline,
      followUpAt: c.followUpAt,
      followedUp: c.followedUp,
      tags: c.tags,
    }));

    const counters = derivePersonCounters(
      timeline.map(i => ({ at: i.at as Date, eventId: i.eventId }))
    );
    const nextActionAt = deriveNextActionAt(facts);
    const tags = derivePersonTags(facts, person.ownTags ?? []);
    const fields = derivePersonFields(facts, person.overrides ?? {});

    const wrong: string[] = [];
    if (person.eventCount !== counters.eventCount) {
      wrong.push(`eventCount ${person.eventCount} → ${counters.eventCount}`);
    }
    if (person.interactionCount !== counters.interactionCount) {
      wrong.push(`interactionCount ${person.interactionCount} → ${counters.interactionCount}`);
    }
    if (!sameInstant(person.lastInteractionAt, counters.lastInteractionAt)) {
      wrong.push(`lastInteractionAt ${iso(person.lastInteractionAt)} → ${iso(counters.lastInteractionAt)}`);
    }
    if (!sameInstant(person.nextActionAt, nextActionAt)) {
      wrong.push(`nextActionAt ${iso(person.nextActionAt)} → ${iso(nextActionAt)}`);
    }
    if (!sameSet(person.tags ?? [], tags)) {
      wrong.push(`tags [${(person.tags ?? []).join(',')}] → [${tags.join(',')}]`);
    }
    // The EFFECTIVE display name, so a stale row where an override was set but never recomputed shows
    // up here rather than as a name the user cannot find by searching for their own correction.
    if (fields.displayName && person.displayName !== fields.displayName) {
      wrong.push(`displayName "${person.displayName}" → "${fields.displayName}"`);
    }
    if (fields.company !== (person.company ?? undefined)) {
      wrong.push(`company "${person.company ?? ''}" → "${fields.company ?? ''}"`);
    }

    if (wrong.length) drifted.push(`${person.displayName} (${id}): ${wrong.join(' ; ')}`);
  }
  check(
    `denormalised fields match a live recount (${persons.length - drifted.length}/${persons.length})`,
    drifted.length === 0,
    drifted.concat(
      drifted.length ? ['→ repair: recomputePerson(userId, personId) for each, or re-run the backfill'] : []
    )
  );

  /* ── context, not an assertion ──────────────────────────────────────────────────────────────── */
  const live = persons.filter(p => !p.mergedInto);
  const repeats = live.filter(p => p.eventCount >= 2);
  const due = live.filter(p => p.nextActionAt);
  const keyless = live.filter(p => !(p.contactKeys ?? []).length);
  console.log('');
  console.log(`live persons          ${live.length}   (${persons.length - live.length} merged tombstones)`);
  console.log(`met at 2+ events      ${repeats.length}   ← what repeatOnly now selects in one predicate`);
  console.log(`follow-up outstanding ${due.length}`);
  console.log(
    `persons with no key   ${keyless.length}   ` +
      `← unfindable by a future capture; see resolvePerson's keyless branch`
  );

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);

  await mongoose.connection.close();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async error => {
  console.error(error);
  await mongoose.connection.close().catch(() => {});
  process.exit(1);
});
