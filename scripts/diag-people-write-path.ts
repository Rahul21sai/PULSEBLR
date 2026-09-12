#!/usr/bin/env tsx
/**
 * The people spine's WRITE PATH, driven by a write-then-delete fixture. Exits non-zero on any
 * failed assertion.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS ALONGSIDE `diag-people-spine.ts`, WHICH ALREADY PASSES 9 CHECKS.
 *
 * That script is READ-ONLY: it asserts that the stored corpus is internally consistent. Consistency
 * is not the same claim as "the write path behaves", and the four properties the hybrid spec asks to
 * be proven are all properties of a SEQUENCE of writes — a replay, an upgrade, a collision, a merge
 * and its reversal. None of them is visible in a snapshot, and three of them are not exercised by
 * today's data at all: there are no tombstones in the corpus, so `mergePersons`/`unmergePersons` and
 * `resolvePerson`'s tombstone-follow are code nothing has ever run.
 *
 * `migrate-connections-to-contacts.ts` records the general form of that lesson in its own header —
 * a dry run over 0 rows never reached its `.populate('eventId')` and so hid a `MissingSchemaError`.
 * ZERO ROWS EXERCISE NOTHING. Hence a fixture.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * The four properties, from the spec's Verification section, and why each is a real risk:
 *
 *   1. REPLAYING A `clientId` YIELDS ONE `met` INTERACTION. `POST /api/contacts` must answer a
 *      replayed capture with 200 and the existing document, so a scan retried on conference wifi
 *      cannot duplicate anybody. The guarantee lives in a partial unique index on
 *      `{userId, contactId}` filtered to `kind: 'met'`; this proves the index and the code agree,
 *      including the duplicate-key CATCH branch, which the end-to-end replay never reaches.
 *   2. A `nm:` → `li:` UPGRADE APPENDS A KEY. `contactKey` is a pointer that gets recomputed, unlike
 *      `Event.clusterKey`, so the same human scanned by name and later by QR must end as ONE person
 *      carrying both keys — otherwise the notes, timeline and follow-ups attached to the old
 *      spelling are orphaned.
 *   3. A KEY COLLISION PRODUCES A SUGGESTION, NOT A MERGE. Two people called Rahul at one event is
 *      the exact failure `contactKey` was invented to stop; a wrong merge is very hard to unwind and
 *      an un-merged duplicate is merely untidy.
 *   4. MERGE IS REVERSIBLE. Nothing is deleted, the loser keeps a tombstone, and unmerge restores
 *      both rows — including the winner's own identity, which a merge recompute overwrites.
 *
 * §5 is not in the spec. It is a gap this fixture FOUND: the product's own edit path
 * (`PATCH /api/contacts/[id]`) upgrades a contact's key without re-resolving its person, so
 * property 2 does NOT hold through the route a user actually touches. It is asserted rather than
 * merely printed, because a FAIL is the only form of a finding that survives being read later.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WRITES, THEN DELETES, WITH THE CLEANUP IN A `finally`.
 *
 * This runs against the live Atlas that serves the product. Everything it creates is scoped to one
 * synthetic `userId` that no real account can hold — `devlogin:` is the dev-provider prefix and
 * `@pulseblr.local` is not a routable address — so the purge can be a blunt `deleteMany` by
 * `userId` without a filter anybody has to get right. It purges BEFORE it starts as well as after,
 * so a previous crashed run cannot poison this one, and it re-counts afterwards and FAILS loudly
 * with the surviving ids if anything is left: a silent leak in the people spine is worse than a
 * failed check.
 *
 * No `Event` rows are written. The `eventId`s are synthetic ObjectIds, which is faithful rather than
 * lazy — `Interaction.eventId` is a SOFT link (`pruneStale()` deletes events out from under it every
 * scrape), so a dangling reference is the normal case, not a shortcut.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * Needs a database. Needs no server and no sign-in — every call goes through the real service
 * functions rather than HTTP, which is the point: importing the production write path is what makes
 * this a proof rather than a re-implementation.
 *
 *   npx tsx scripts/diag-people-write-path.ts
 */
import './load-env';
import mongoose from 'mongoose';
import connectDB from '../lib/mongodb';
import Contact from '../lib/models/Contact';
import Folder from '../lib/models/Folder';
import Person from '../lib/models/Person';
import Interaction from '../lib/models/Interaction';
import User from '../lib/models/User';
import { normalizeName } from '../lib/scan/contact-key';
import { upsertContact, updateOwnedContact } from '../lib/contacts/service';
import {
  resolvePerson,
  recordInteraction,
  recomputePerson,
  mergePersons,
  unmergePersons,
  dismissMergeSuggestion,
  mergeSuggestionsFor,
} from '../lib/people/service';

/**
 * The fixture owner. `devlogin:` is the dev-only provider's prefix and `.local` is not a routable
 * TLD, so this cannot be a real Google `sub` and cannot be a real dev sign-in either. Stable rather
 * than per-run, deliberately: a stable id means the pre-run purge can clean up after a crash, which
 * a pid-suffixed one could never do.
 */
const FIXTURE_USER = 'devlogin:diag-people-write-path@pulseblr.local';

const EVENT_A = new mongoose.Types.ObjectId();
const EVENT_B = new mongoose.Types.ObjectId();

const NOW = Date.now();
/** `pickWritable` only accepts a STRING `scannedAt`, so these are ISO, not `Date`. */
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

let failures = 0;

function check(label: string, ok: boolean, measured: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}  — ${measured}`);
}

/** A measurement that is context, not an assertion. Indented under the checks it explains. */
function note(text: string) {
  console.log(`        ${text}`);
}

function section(title: string) {
  console.log(`\n${title}`);
}

const id = (value: unknown): string => (value === null || value === undefined ? '' : String(value));

/**
 * Run something that might throw, and hand back the throw as a value.
 *
 * A diagnostic must never let one defect hide the next one. `mergePersons()` throws today, and a
 * bare `await` on it aborted this script before §5 — so one run reported one finding where there
 * were two. Takes `PromiseLike` rather than `Promise` so a Mongoose `Query` can be passed directly.
 */
async function attempt<T>(fn: () => PromiseLike<T>): Promise<{ value?: T; error?: Error }> {
  try {
    return { value: await fn() };
  } catch (err) {
    return { error: err instanceof Error ? err : new Error(String(err)) };
  }
}

async function loadPerson(personId: unknown) {
  return Person.findOne({ _id: id(personId), userId: FIXTURE_USER });
}

async function loadContact(contactId: unknown) {
  return Contact.findOne({ _id: id(contactId), userId: FIXTURE_USER });
}

async function metRowsFor(contactId: unknown) {
  return Interaction.countDocuments({
    userId: FIXTURE_USER,
    contactId: id(contactId),
    kind: 'met',
  });
}

/** Every fixture row still in the database, as printable ids. Empty is the only acceptable answer. */
async function survivingRows(): Promise<string[]> {
  const [contacts, folders, persons, interactions, users] = await Promise.all([
    Contact.find({ userId: FIXTURE_USER }).select('_id').lean(),
    Folder.find({ userId: FIXTURE_USER }).select('_id').lean(),
    Person.find({ userId: FIXTURE_USER }).select('_id').lean(),
    Interaction.find({ userId: FIXTURE_USER }).select('_id').lean(),
    User.find({ googleId: FIXTURE_USER }).select('_id').lean(),
  ]);
  return [
    ...contacts.map(r => `Contact ${id(r._id)}`),
    ...folders.map(r => `Folder ${id(r._id)}`),
    ...persons.map(r => `Person ${id(r._id)}`),
    ...interactions.map(r => `Interaction ${id(r._id)}`),
    ...users.map(r => `User ${id(r._id)}`),
  ];
}

/**
 * Delete every fixture row. Scoped to `FIXTURE_USER` in all five collections, which is why it is
 * safe to run before the fixture as well as after it.
 *
 * `User` is included even though nothing here creates one — `getTargetCompanies()` only READS it —
 * so that if a future service call starts upserting the owner, the leak is swept rather than
 * discovered months later.
 */
async function purge(): Promise<number> {
  const results = await Promise.all([
    Contact.deleteMany({ userId: FIXTURE_USER }),
    Folder.deleteMany({ userId: FIXTURE_USER }),
    Person.deleteMany({ userId: FIXTURE_USER }),
    Interaction.deleteMany({ userId: FIXTURE_USER }),
    User.deleteMany({ googleId: FIXTURE_USER }),
  ]);
  return results.reduce((total, r) => total + (r.deletedCount ?? 0), 0);
}

async function makeFolder(name: string, eventId: mongoose.Types.ObjectId | null) {
  const folder = new Folder({
    userId: FIXTURE_USER,
    name,
    ...(eventId ? { eventId } : {}),
    venue: 'Diag fixture venue',
  });
  await folder.save();
  return folder;
}

async function main() {
  await connectDB();
  console.log(`people spine WRITE PATH fixture\nowner: ${FIXTURE_USER}`);

  const preexisting = await purge();
  if (preexisting) {
    console.log(
      `\n  swept ${preexisting} row(s) left behind by an earlier run — cleanup did not complete last time`
    );
  }

  try {
    const folderA = await makeFolder('Diag Write Path — Event A', EVENT_A);
    const folderB = await makeFolder('Diag Write Path — Event B', EVENT_B);

    /* ═══ 1. REPLAYING A clientId YIELDS ONE met INTERACTION ═══════════════════════════════════ */
    section('1. replay idempotency — one clientId, one contact, one `met`');

    const CID_REPLAY = 'diag-wp-replay-0001';
    const first = await upsertContact(FIXTURE_USER, folderA._id as mongoose.Types.ObjectId, {
      clientId: CID_REPLAY,
      name: 'Diag Replay Rao',
      company: 'Razorpay',
      linkedin: 'https://www.linkedin.com/in/diag-replay-rao-9f31?fromQR=1',
      capturedVia: 'qr-linkedin',
      scannedAt: daysAgo(6),
    });
    check('the first POST creates the capture', first.created, `created=${first.created}`);
    check(
      'and its key is the LinkedIn tier',
      first.contact.contactKey === 'li:diag-replay-rao-9f31',
      first.contact.contactKey
    );

    const replay = await upsertContact(FIXTURE_USER, folderA._id as mongoose.Types.ObjectId, {
      clientId: CID_REPLAY,
      name: 'Diag Replay Rao',
      company: 'Razorpay',
      linkedin: 'https://www.linkedin.com/in/diag-replay-rao-9f31?fromQR=1',
      capturedVia: 'qr-linkedin',
      scannedAt: daysAgo(6),
    });
    check(
      'the replay returns the EXISTING document, not a second one',
      !replay.created && id(replay.contact._id) === id(first.contact._id),
      `created=${replay.created} sameId=${id(replay.contact._id) === id(first.contact._id)}`
    );

    const contactRows = await Contact.countDocuments({ userId: FIXTURE_USER, clientId: CID_REPLAY });
    check('exactly one Contact for that clientId', contactRows === 1, `${contactRows} contact(s)`);

    let metRows = await metRowsFor(first.contact._id);
    check('exactly one `met` interaction after the replay', metRows === 1, `${metRows} met row(s)`);

    const replayPerson = await loadPerson(first.contact.personId);
    check(
      'the person counts one interaction and one event',
      replayPerson?.interactionCount === 1 && replayPerson?.eventCount === 1,
      `interactionCount=${replayPerson?.interactionCount} eventCount=${replayPerson?.eventCount}`
    );

    /**
     * The end-to-end replay above never reaches the duplicate-key catch: `upsertContact` skips
     * attaching when the capture already has a `personId`, so no second `Interaction.create()` is
     * even attempted. That makes the index and its error handler UNTESTED by the happy path — so
     * call `recordInteraction` directly, which is what every future write path will do.
     */
    const forced = await recordInteraction(FIXTURE_USER, {
      personId: id(first.contact.personId),
      kind: 'met',
      at: new Date(NOW - 6 * 86_400_000),
      eventId: EVENT_A,
      contactId: first.contact._id as mongoose.Types.ObjectId,
    });
    const firstMet = await Interaction.findOne({
      userId: FIXTURE_USER,
      contactId: id(first.contact._id),
      kind: 'met',
    });
    check(
      'a direct duplicate `met` returns the existing row instead of throwing or inserting',
      id(forced._id) === id(firstMet?._id),
      `returned=${id(forced._id)} stored=${id(firstMet?._id)}`
    );
    metRows = await metRowsFor(first.contact._id);
    check(
      'still exactly one `met` interaction — the partial unique index refused the second',
      metRows === 1,
      `${metRows} met row(s)`
    );
    note('index: {userId, contactId} unique, partialFilterExpression {kind: "met"}');

    /* ═══ 2. A nm: → li: UPGRADE APPENDS A KEY ═════════════════════════════════════════════════ */
    section('2. the upgrade — `nm:` → `li:` appends a key, it does not fork the person');

    const upgraded = await upsertContact(FIXTURE_USER, folderA._id as mongoose.Types.ObjectId, {
      clientId: 'diag-wp-upgrade-0002',
      name: 'Diag Upgrade Sharma',
      company: 'Postman',
      capturedVia: 'manual',
      scannedAt: daysAgo(10),
    });
    check(
      'a name-only capture starts on the weakest key tier',
      upgraded.contact.contactKey === 'nm:diag upgrade sharma',
      upgraded.contact.contactKey
    );
    const personB0 = await loadPerson(upgraded.contact.personId);
    check(
      'and its person holds exactly that one key',
      (personB0?.contactKeys ?? []).join(',') === 'nm:diag upgrade sharma',
      `[${(personB0?.contactKeys ?? []).join(', ')}]`
    );

    // The upgrade itself: the LinkedIn arrives later, so `Contact`'s `pre('validate')` hook
    // recomputes the key. This is the case `contactKey` is a POINTER rather than an identity for.
    const editedB = await updateOwnedContact(FIXTURE_USER, id(upgraded.contact._id), {
      linkedin: 'https://www.linkedin.com/in/diag-upgrade-sharma-4a17?fromQR=1',
    });
    check(
      "the contact's key upgrades to the LinkedIn tier",
      editedB?.contactKey === 'li:diag-upgrade-sharma-4a17',
      id(editedB?.contactKey)
    );

    /**
     * `resolvePerson` is the function the spec's property is about, and it is what
     * `backfill-person-spine.ts` calls. §5 measures what the PRODUCT path does instead.
     */
    const reresolved = await resolvePerson(FIXTURE_USER, editedB!);
    check(
      'resolving the upgraded capture keeps the SAME person',
      id(reresolved.person._id) === id(personB0?._id) && !reresolved.created,
      `same=${id(reresolved.person._id) === id(personB0?._id)} created=${reresolved.created}`
    );
    check(
      'no merge suggestion — nobody else holds the new key',
      reresolved.suggestion === null,
      `suggestion=${reresolved.suggestion === null ? 'null' : id(reresolved.suggestion?.personId)}`
    );
    const personB1 = await loadPerson(upgraded.contact.personId);
    check(
      'the person now carries BOTH keys',
      (personB1?.contactKeys ?? []).length === 2 &&
        (personB1?.contactKeys ?? []).includes('nm:diag upgrade sharma') &&
        (personB1?.contactKeys ?? []).includes('li:diag-upgrade-sharma-4a17'),
      `[${(personB1?.contactKeys ?? []).join(', ')}]`
    );

    // The half that makes the append load-bearing: the next QR scan must land on the same human.
    const secondScan = await upsertContact(FIXTURE_USER, folderB._id as mongoose.Types.ObjectId, {
      clientId: 'diag-wp-upgrade-0002b',
      name: 'Diag Upgrade Sharma',
      linkedin: 'https://www.linkedin.com/in/diag-upgrade-sharma-4a17?fromQR=1',
      capturedVia: 'qr-linkedin',
      scannedAt: daysAgo(4),
    });
    check(
      'a fresh QR capture of the same human attaches to that person, not a new one',
      id(secondScan.contact.personId) === id(personB1?._id),
      `personId=${id(secondScan.contact.personId)} expected=${id(personB1?._id)}`
    );
    const personB2 = await loadPerson(personB1?._id);
    check(
      'and the counters read two encounters at two distinct events',
      personB2?.interactionCount === 2 && personB2?.eventCount === 2,
      `interactionCount=${personB2?.interactionCount} eventCount=${personB2?.eventCount}`
    );
    const personsForB = await Person.countDocuments({
      userId: FIXTURE_USER,
      contactKeys: { $in: ['nm:diag upgrade sharma', 'li:diag-upgrade-sharma-4a17'] },
    });
    check('one human, one Person row', personsForB === 1, `${personsForB} person(s) hold those keys`);

    /* ═══ 3. A KEY COLLISION PRODUCES A SUGGESTION, NOT A MERGE ════════════════════════════════ */
    section('3. the collision — a suggestion, and nothing is joined');

    const collideA = await upsertContact(FIXTURE_USER, folderA._id as mongoose.Types.ObjectId, {
      clientId: 'diag-wp-collide-0003a',
      name: 'Diag Collide Alpha',
      capturedVia: 'manual',
      scannedAt: daysAgo(9),
    });
    const collideB = await upsertContact(FIXTURE_USER, folderB._id as mongoose.Types.ObjectId, {
      clientId: 'diag-wp-collide-0003b',
      name: 'Diag Collide Beta',
      linkedin: 'https://www.linkedin.com/in/diag-collide-shared-7b02?fromQR=1',
      capturedVia: 'qr-linkedin',
      scannedAt: daysAgo(8),
    });
    const personAlpha = await loadPerson(collideA.contact.personId);
    const personBeta = await loadPerson(collideB.contact.personId);
    check(
      'two captures, two persons to begin with',
      id(personAlpha?._id) !== id(personBeta?._id),
      `${id(personAlpha?._id)} vs ${id(personBeta?._id)}`
    );

    // Alpha's key is upgraded onto a slug BETA ALREADY HOLDS. Whether they are one human is exactly
    // what the app must not guess.
    const editedAlpha = await updateOwnedContact(FIXTURE_USER, id(collideA.contact._id), {
      linkedin: 'https://www.linkedin.com/in/diag-collide-shared-7b02?fromQR=1',
    });
    check(
      "alpha's capture now points at beta's key",
      editedAlpha?.contactKey === 'li:diag-collide-shared-7b02',
      id(editedAlpha?.contactKey)
    );

    const collision = await resolvePerson(FIXTURE_USER, editedAlpha!);
    check(
      'the collision returns a SUGGESTION',
      collision.suggestion !== null &&
        id(collision.suggestion?.personId) === id(personBeta?._id),
      collision.suggestion
        ? `suggests ${collision.suggestion.displayName} (${collision.suggestion.personId}) on ${collision.suggestion.contactKey}`
        : 'suggestion=null'
    );
    check(
      'and NOTHING was merged — the capture stays on its own person',
      id(collision.person._id) === id(personAlpha?._id),
      `person=${id(collision.person._id)} expected=${id(personAlpha?._id)}`
    );
    const alphaAfter = await loadPerson(personAlpha?._id);
    const betaAfter = await loadPerson(personBeta?._id);
    check(
      "the contested key was NOT appended to alpha's person",
      !(alphaAfter?.contactKeys ?? []).includes('li:diag-collide-shared-7b02'),
      `[${(alphaAfter?.contactKeys ?? []).join(', ')}]`
    );
    check(
      'neither person got a tombstone',
      !alphaAfter?.mergedInto && !betaAfter?.mergedInto,
      `alpha.mergedInto=${id(alphaAfter?.mergedInto) || 'null'} beta.mergedInto=${id(betaAfter?.mergedInto) || 'null'}`
    );
    const contactAlpha = await loadContact(collideA.contact._id);
    check(
      "the capture's personId is unchanged",
      id(contactAlpha?.personId) === id(personAlpha?._id),
      id(contactAlpha?.personId)
    );

    // A dismissal must be permanent, in both directions.
    await dismissMergeSuggestion(FIXTURE_USER, id(personAlpha?._id), id(personBeta?._id));
    const afterDismissal = await resolvePerson(FIXTURE_USER, (await loadContact(collideA.contact._id))!);
    check(
      'once dismissed, the same collision suggests nothing',
      afterDismissal.suggestion === null,
      `suggestion=${afterDismissal.suggestion === null ? 'null' : id(afterDismissal.suggestion?.personId)}`
    );
    const alphaDismissed = await loadPerson(personAlpha?._id);
    const betaDismissed = await loadPerson(personBeta?._id);
    check(
      'and the dismissal is recorded on BOTH rows',
      (alphaDismissed?.notSamePersonAs ?? []).some(x => id(x) === id(personBeta?._id)) &&
        (betaDismissed?.notSamePersonAs ?? []).some(x => id(x) === id(personAlpha?._id)),
      `alpha→beta=${(alphaDismissed?.notSamePersonAs ?? []).length} beta→alpha=${(betaDismissed?.notSamePersonAs ?? []).length}`
    );

    /* ═══ 4. MERGE IS REVERSIBLE ═══════════════════════════════════════════════════════════════ */
    section('4. merge, and the unmerge that has to put everything back');

    const followUpAt = new Date(NOW + 3 * 86_400_000);
    const mergeWinnerCapture = await upsertContact(
      FIXTURE_USER,
      folderA._id as mongoose.Types.ObjectId,
      {
        clientId: 'diag-wp-merge-0004a',
        name: 'Diag Merge Alpha',
        capturedVia: 'manual',
        scannedAt: daysAgo(5),
      }
    );
    const mergeLoserCapture = await upsertContact(
      FIXTURE_USER,
      folderB._id as mongoose.Types.ObjectId,
      {
        clientId: 'diag-wp-merge-0004b',
        name: 'Diag Merge Beta',
        company: 'BrowserStack',
        capturedVia: 'manual',
        scannedAt: daysAgo(2),
        followUpAt: followUpAt.toISOString(),
      }
    );
    const winnerId = id(mergeWinnerCapture.contact.personId);
    const loserId = id(mergeLoserCapture.contact.personId);
    check('two separate persons before the merge', winnerId !== loserId, `${winnerId} vs ${loserId}`);

    /**
     * WRAPPED, NOT AWAITED BARE — and that is a finding, not defensive style. `mergePersons()` THREW
     * on the first run of this script, which aborted §5 entirely. A fixture that stops at the first
     * defect finds exactly one defect, so the throw is captured and reported as a FAIL instead.
     *
     * The whole reversibility block below is kept behind `if (merged)`, so it becomes a real
     * property-4 proof the moment the throw is fixed rather than needing to be written again.
     */
    const mergeAttempt = await attempt(() => mergePersons(FIXTURE_USER, loserId, winnerId));
    const merged = mergeAttempt.value ?? null;
    check(
      'mergePersons() completes without throwing',
      !mergeAttempt.error,
      mergeAttempt.error
        ? `THREW: ${mergeAttempt.error.message}`
        : `contactsMoved=${merged?.contactsMoved} interactionsMoved=${merged?.interactionsMoved}`
    );

    if (!merged) {
      /**
       * The mechanism, measured against a filter that matches NOTHING — which is what makes it
       * decisive: the guard rejects the QUERY SHAPE before a row is ever read, so this is not a
       * reaction to the fixture's data and would happen to any merge on any corpus.
       */
      const strayPerson = new mongoose.Types.ObjectId();
      const repointOnly = await attempt(() =>
        Interaction.updateMany(
          { userId: FIXTURE_USER, personId: strayPerson },
          { $set: { personId: new mongoose.Types.ObjectId() } }
        )
      );
      note(
        `a repoint-ONLY updateMany matching zero rows: ${
          repointOnly.error ? `THROWS — ${repointOnly.error.message}` : 'succeeds'
        }`
      );
      const noTimestamps = await attempt(() =>
        Interaction.updateMany(
          { userId: FIXTURE_USER, personId: strayPerson },
          { $set: { personId: new mongoose.Types.ObjectId() } },
          { timestamps: false }
        )
      );
      note(
        `the SAME call with { timestamps: false }: ${
          noTimestamps.error
            ? `THROWS — ${noTimestamps.error.message}`
            : `succeeds, matched ${noTimestamps.value?.matchedCount ?? 0} row(s)`
        }`
      );
      note("cause: Interaction declares timestamps { createdAt: true, updatedAt: false }, so mongoose's");
      note('built-in _setTimestampsOnUpdate hook adds $setOnInsert: { createdAt } to EVERY update, and');
      note('assertOnlyRepointing() walks every operator, finds a path outside MUTABLE_PATHS, refuses.');
      note('lib/people/service.ts:742 and :804 are the ONLY guarded update call sites in the app, and');
      note('both are this pair — so merge and unmerge together are the entire blast radius.');

      const winnerPartial = await loadPerson(winnerId);
      const loserPartial = await loadPerson(loserId);
      check(
        'the failed merge left NO partial state behind',
        (winnerPartial?.contactKeys ?? []).length === 1 && !loserPartial?.mergedInto,
        `winner.contactKeys=[${(winnerPartial?.contactKeys ?? []).join(', ')}] loser.mergedInto=${
          id(loserPartial?.mergedInto) || 'null'
        }`
      );
      note('winner.save() runs BEFORE the failing updateMany, so the key union survives the throw and');
      note('two LIVE persons end up sharing a contactKey — which diag-people-spine.ts check 3 reports');
      note('as corruption, produced by a merge the caller was told had failed.');

      const rollback = await attempt(() => unmergePersons(FIXTURE_USER, loserId));
      check(
        'merge is REVERSIBLE — unmergePersons() restores both rows',
        Boolean(rollback.value),
        rollback.error
          ? `THREW: ${rollback.error.message}`
          : `returned ${
              rollback.value
                ? id(rollback.value._id)
                : 'null — no tombstone was ever written, so there is nothing to reverse'
            }`
      );
      note("also unreachable while the merge throws: resolvePerson()'s tombstone-follow branch, which");
      note('no stored row has ever exercised — there are 0 tombstones in the corpus.');
    } else {
      check(
        "the merge moves the loser's capture and its timeline",
        merged.contactsMoved === 1 && merged.interactionsMoved === 1,
        `contactsMoved=${merged.contactsMoved} interactionsMoved=${merged.interactionsMoved}`
      );
      const winnerMerged = await loadPerson(winnerId);
      const loserMerged = await loadPerson(loserId);
      check(
        'the winner holds both keys',
        (winnerMerged?.contactKeys ?? []).length === 2,
        `[${(winnerMerged?.contactKeys ?? []).join(', ')}]`
      );
      check(
        'the loser is a tombstone pointing at the winner',
        id(loserMerged?.mergedInto) === winnerId,
        `mergedInto=${id(loserMerged?.mergedInto)}`
      );
      check(
        'counters are RECOMPUTED, not added: two distinct events, three interactions (2 met + 1 merged)',
        winnerMerged?.eventCount === 2 && winnerMerged?.interactionCount === 3,
        `eventCount=${winnerMerged?.eventCount} interactionCount=${winnerMerged?.interactionCount}`
      );
      check(
        "the winner inherits the loser's outstanding follow-up",
        Math.abs((winnerMerged?.nextActionAt?.getTime() ?? 0) - followUpAt.getTime()) < 1000,
        `nextActionAt=${winnerMerged?.nextActionAt?.toISOString() ?? 'null'}`
      );
      check(
        "and the newest capture's identity now shows on the winner",
        winnerMerged?.displayName === 'Diag Merge Beta' && winnerMerged?.company === 'BrowserStack',
        `displayName="${id(winnerMerged?.displayName)}" company="${id(winnerMerged?.company)}"`
      );

      /**
       * The tombstone's job, and code that nothing in the corpus has ever run: a later capture
       * carrying an OLD key must route to the survivor rather than re-create the person that was
       * just merged away. A bare `ResolvableContact` — no `personId` — is what a fresh capture is.
       */
      const followed = await resolvePerson(FIXTURE_USER, { contactKey: 'nm:diag merge beta' });
      check(
        "a capture carrying the loser's key follows the tombstone to the winner",
        id(followed.person._id) === winnerId && !followed.created,
        `resolved=${id(followed.person._id)} created=${followed.created}`
      );

      const rollback = await attempt(() => unmergePersons(FIXTURE_USER, loserId));
      check(
        'merge is REVERSIBLE — unmergePersons() restores both rows',
        Boolean(rollback.value),
        rollback.error ? `THREW: ${rollback.error.message}` : id(rollback.value?._id)
      );
      const winnerBack = await loadPerson(winnerId);
      const loserBack = await loadPerson(loserId);
      const loserContactBack = await loadContact(mergeLoserCapture.contact._id);
      check(
        'the tombstone is cleared',
        loserBack?.mergedInto === null,
        `mergedInto=${loserBack?.mergedInto === null ? 'null' : id(loserBack?.mergedInto)}`
      );
      check(
        'the capture goes back to the person it came from',
        id(loserContactBack?.personId) === loserId,
        `personId=${id(loserContactBack?.personId)}`
      );
      const loserMet = await Interaction.findOne({
        userId: FIXTURE_USER,
        contactId: id(mergeLoserCapture.contact._id),
        kind: 'met',
      });
      check(
        'so does its `met` interaction',
        id(loserMet?.personId) === loserId,
        `met.personId=${id(loserMet?.personId)}`
      );
      check(
        "the winner gives back the loser's key",
        (winnerBack?.contactKeys ?? []).join(',') === 'nm:diag merge alpha',
        `[${(winnerBack?.contactKeys ?? []).join(', ')}]`
      );
      check(
        "the winner's OWN identity is restored, not left showing the loser's",
        winnerBack?.displayName === 'Diag Merge Alpha' && !winnerBack?.company,
        `displayName="${id(winnerBack?.displayName)}" company="${id(winnerBack?.company) || '(unset)'}"`
      );
      check(
        "and its follow-up goes back with the loser's capture",
        winnerBack?.nextActionAt === null &&
          Math.abs((loserBack?.nextActionAt?.getTime() ?? 0) - followUpAt.getTime()) < 1000,
        `winner.nextActionAt=${
          winnerBack?.nextActionAt === null ? 'null' : id(winnerBack?.nextActionAt)
        } loser.nextActionAt=${loserBack?.nextActionAt?.toISOString() ?? 'null'}`
      );
      check(
        'both persons count one event again',
        winnerBack?.eventCount === 1 && loserBack?.eventCount === 1,
        `winner=${winnerBack?.eventCount} loser=${loserBack?.eventCount}`
      );
      /**
       * The residue, asserted rather than glossed: the `merged` row is NOT removed. An append-only
       * timeline that forgets the merge is not evidence, so the winner keeps 2 interactions (its own
       * `met` plus the `merged` note) where a naive reading of "reversible" would expect 1.
       */
      const mergedRows = await Interaction.countDocuments({
        userId: FIXTURE_USER,
        personId: winnerId,
        kind: 'merged',
      });
      check(
        'the `merged` timeline row SURVIVES the reversal (history is append-only)',
        mergedRows === 1 && winnerBack?.interactionCount === 2,
        `merged rows=${mergedRows} winner.interactionCount=${winnerBack?.interactionCount}`
      );
    }

    /* ═══ 5. THE GAP THIS FIXTURE FOUND ════════════════════════════════════════════════════════ */
    section('5. FOUND: the product edit path upgrades the key WITHOUT re-resolving the person');

    note('PATCH /api/contacts/[id] calls updateOwnedContact() then recomputePerson().');
    note('recomputePerson() never touches Person.contactKeys — only resolvePerson() appends.');

    const gapCapture = await upsertContact(FIXTURE_USER, folderA._id as mongoose.Types.ObjectId, {
      clientId: 'diag-wp-gap-0005',
      name: 'Diag Gap Iyer',
      capturedVia: 'manual',
      scannedAt: daysAgo(7),
    });
    const gapPersonId = id(gapCapture.contact.personId);

    // Exactly what the route does, in the route's order.
    const gapEdited = await updateOwnedContact(FIXTURE_USER, id(gapCapture.contact._id), {
      linkedin: 'https://www.linkedin.com/in/diag-gap-iyer-2c55?fromQR=1',
    });
    if (gapEdited?.personId) await recomputePerson(FIXTURE_USER, gapEdited.personId);

    const gapPerson = await loadPerson(gapPersonId);
    check(
      'after the product edit, the person carries the upgraded key',
      (gapPerson?.contactKeys ?? []).includes('li:diag-gap-iyer-2c55'),
      `contact.contactKey=${id(gapEdited?.contactKey)} person.contactKeys=[${(gapPerson?.contactKeys ?? []).join(', ')}]`
    );

    // The consequence, measured rather than argued: the next QR scan forks the human.
    const gapScan = await upsertContact(FIXTURE_USER, folderB._id as mongoose.Types.ObjectId, {
      clientId: 'diag-wp-gap-0005b',
      name: 'Diag Gap Iyer',
      linkedin: 'https://www.linkedin.com/in/diag-gap-iyer-2c55?fromQR=1',
      capturedVia: 'qr-linkedin',
      scannedAt: daysAgo(3),
    });
    check(
      'and a later QR scan of that human lands on the SAME person (same root cause as above)',
      id(gapScan.contact.personId) === gapPersonId,
      `scan.personId=${id(gapScan.contact.personId)} edited.personId=${gapPersonId}`
    );

    const gapSuggestions = await mergeSuggestionsFor(FIXTURE_USER, gapPersonId);
    note(
      `mergeSuggestionsFor() on the split human returns ${gapSuggestions.length} suggestion(s) — ` +
        'the two rows share NO key, so the duplicate is invisible to the suggestion surface'
    );
    note(
      "diag-people-spine.ts check 3 also passes on it: it looks for one key on two persons, and " +
        'these hold different keys'
    );
    note('repair for existing rows: scripts/backfill-person-spine.ts, which does call resolvePerson()');
  } finally {
    section('cleanup');
    const removed = await purge();
    const left = await survivingRows();
    console.log(`  removed ${removed} fixture row(s)`);
    check('no fixture row survives', left.length === 0, `${left.length} left`);
    for (const row of left.slice(0, 40)) console.log(`        LEAKED  ${row}`);
    if (left.length > 40) console.log(`        … and ${left.length - 40} more`);
  }

  /* ═══ context — read-only, not an assertion ════════════════════════════════════════════════ */
  section('context (read-only, real corpus — no assertions)');

  const live = await Person.find({ mergedInto: null }).select('userId displayName contactKeys').lean();
  const byName = new Map<string, typeof live>();
  for (const person of live) {
    const key = `${person.userId}::${normalizeName(person.displayName)}`;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key)!.push(person);
  }
  const splits = [...byName.values()].filter(group => group.length > 1);
  console.log(`  ${live.length} live persons · ${splits.length} same-name group(s) with >1 person`);
  for (const group of splits.slice(0, 10)) {
    const suggestions = await mergeSuggestionsFor(group[0].userId, id(group[0]._id));
    console.log(
      `        "${group[0].displayName}" × ${group.length}  keys: ${group
        .map(p => `[${(p.contactKeys ?? []).join(', ')}]`)
        .join(' + ')}  → ${suggestions.length} suggestion(s)`
    );
  }
  if (splits.length > 10) console.log(`        … and ${splits.length - 10} more`);

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);

  await mongoose.connection.close();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async error => {
  console.error(error);
  await mongoose.connection.close().catch(() => {});
  process.exit(1);
});
