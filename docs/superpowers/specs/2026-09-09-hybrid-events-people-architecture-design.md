# PulseBLR — hybrid events ↔ people architecture

**Date:** 2026-09-09 · **Status:** design approved, implementation plan to follow

---

## Why

PulseBLR has two halves that barely touch. The events half (`Event`, `Source`, `TrackerEntry`,
`buildEventFilter`, `connectionScore`) is mature. The people half (`Folder`, `Contact`, `contactKey`,
`buildContactFilter`, `phase6`) is well-built at capture and thin at recall. They are joined by one
chain, and it is broken in practice:

```
Contact ──folderId (required)──▶ Folder ──eventId (optional, NULL in practice)──▶ Event
```

Measured consequences (audit 2026-09-07, `audit/`, plus a full code map):

- A person **cannot exist without a folder** — `Contact.folderId` is `required: true`.
- The same human met three times is **three Contact rows** with three notes and three follow-up
  dates, and there is **no merge** anywhere: no route, no UI, no service function. `contactKey`
  detects the duplicate and the entire product surface for that is a `met 3×` badge.
- **No last-contacted date exists.** `completeContactFollowUp()` flips a boolean and records no
  timestamp, so "when did I last talk to her" is unanswerable.
- `/people` rows are **not clickable** and there is no `app/people/[id]/`. The only contact editor
  lives inside `app/folders/[id]/page.tsx`, so fixing a name means recalling which event you met
  them at.
- The tracker reports **"People met: 0"** over a folder holding forty scans, because it still reads
  the deprecated `TrackerEntry.connections[]`.
- `repeatOnly` on `/people` is a **two-stage query**; the first attempt post-filtered a page, so the
  heading read "6 people" beside a list of 2 and pagination broke.

**Competitive context.** B2Bangalore (audited 2026-09-09, logged-out + owner screenshots) has
shipped the discovery half comprehensively: personalised feed, 27 programmatic SEO landing pages, a
Play Store app, a Chrome extension, an MCP server with 16 tiered tools, WhatsApp community,
marketplaces, referrals, on Supabase, with a team. Their networking layer is *"professionals who
**may be** attending"* behind ₹899/month, plus a social feed post. **Nothing anywhere in their
product records who you actually met.** That is the half this architecture makes first-class, while
keeping discovery as the acquisition surface — a hybrid, not a pivot.

---

## The decisions, and why

| # | Decision | Rationale |
| --- | --- | --- |
| 1 | **Encounter spine: add `Person` + `Interaction`; `Contact` stays the capture record** | Same identity/occurrence split `Event` already uses (`dedupHash` strict, `clusterKey` fuzzy). Contacts have the same split (`clientId`, `contactKey`) but the fuzzy key was never materialised into something you can open, name or merge |
| 2 | **`Person` holds a SET of keys; its `_id` is the identity** | `contactKey` is a **pointer, not an identity** — `Contact.ts:189-211` recomputes it, so `nm:asha rao` upgrades to `li:asha-rao-123`. Keying `Person` on it would orphan the person on every upgrade |
| 3 | **Key collision never auto-merges** | A wrong merge destroys the distinction between two real humans and is very hard to unwind once notes and follow-ups interleave. Surface a suggestion; remember a dismissal |
| 4 | **Storage is per-encounter; the card is per-person** | One card, history inside it. Per-encounter rows are also what make **job-change detection** possible — "was at Razorpay in July" — which a single updated-in-place row would silently overwrite |
| 5 | **Most recent value wins; user overrides win over that; history is kept** | Zero effort, nothing lost, and the change becomes a feature |
| 6 | **Folders stop being a destination** | A folder is a capture container, not a concept a user should hold. Its contents surface on the event page and on `/people` |
| 7 | **Folders are only created by event-aware paths + one implicit folder per user** | Fixes `Folder.eventId`-is-null at the source instead of patching it, and keeps `Contact.folderId` **required** so the outbox and the delete cascade need no change |
| 8 | **Search federates; it does not unify** | One text index per collection in Mongo; `visibilityClause`'s three arms must not be routed around; events and people rank on different things |

---

## The spine

```
Person {
  userId,                                  // plain string (Google sub | devlogin:…), repo convention
  displayName, company, role, headline,    // DERIVED — newest encounter wins
  overrides: { displayName?, company?, role? },   // USER-SET — always wins over derived
  contactKeys: [ 'nm:asha rao', 'li:asha-rao-123' ],
  tags: [], companies: [],                 // companies resolved via lib/companies/resolve.ts
  lastInteractionAt, nextActionAt,         // denormalised so /people can sort by them at last
  eventCount, interactionCount,            // denormalised so repeatOnly is one predicate
  isTargetCompany,
  notSamePersonAs: [ObjectId],             // dismissed merge suggestions never return
  mergedInto?: ObjectId                    // soft tombstone — old URLs still resolve
}
  index { userId, contactKeys }             // resolver lookup
  index { userId, lastInteractionAt: -1 }   // default /people sort
  index { userId, nextActionAt }            // follow-ups due
  index { userId, tags }                    // ── three SEPARATE single-array indexes.
  index { userId, companies }               //    NEVER one compound index spanning two arrays:
                                            //    Mongo refuses parallel arrays at WRITE time, which
                                            //    presents as contacts failing to save.
```

```
Interaction {                               // APPEND-ONLY. Never updated.
  userId, personId,
  kind: 'met' | 'note' | 'follow-up-set' | 'follow-up-done' | 'message-sent' | 'intake' | 'merged',
  at, eventId?, contactId?, note?
}
  index { userId, personId, at: -1 }        // the person timeline
  index { userId, eventId }                 // event → who I met there
  index { userId, at: -1 }                  // the user's own activity
  index({ userId, contactId }, { unique: true, partialFilterExpression: { kind: 'met' } })
```

```
Contact { … unchanged … , personId }        // still the capture record
```

### Derivation rules — specified, because each has a wrong-but-plausible reading

| Field | Derived as | Why not the obvious alternative |
| --- | --- | --- |
| `displayName`, `company`, `role`, `headline` | the value from the Contact with the greatest **`scannedAt`** that has a non-empty value for that field | Per-field, not per-row: if the newest capture has a name but no company, the company should fall back to the newest capture that *had* one rather than becoming empty |
| `eventCount` | count of **distinct `eventId`** across that Person's Interactions, ignoring nulls | **Not** the number of `met` interactions, and **not** the number of folders. `detectRepeatConnections` already carries this bug's scar — two folders for one event counted as two events. `met 3×` must mean three distinct events |
| `interactionCount` | total Interaction rows | — |
| `lastInteractionAt` | `max(Interaction.at)` | Not `Contact.scannedAt` — a note or a completed follow-up is contact too, and treating capture time as last-contact is exactly today's defect |
| `nextActionAt` | `min(followUpAt)` across the Person's Contacts where `followedUp` is false | A person can carry several encounters each with a follow-up date; the soonest outstanding one is the actionable one |
| `isTargetCompany` | `matchesTargetCompany()` over the resolved company, reusing `lib/contacts/service.ts` | Must not be recomputed independently, or the person page and the contact row can disagree |

**`partialFilterExpression`, never `sparse`.** On a compound index `sparse` omits a document only
when *every* key is missing, so with `userId` always present it indexes everything and `unique` then
permits exactly one `met` interaction per user. This repo has been bitten by that substitution twice
already: `{userId, clientId}` sparse-compound capped every user at one folder, and
`Source.index({kind,handle},{unique,sparse})` is still latent.

**Bidirectionality** — replacing the two-hop chain that is null in practice:

```
event  → people :  Interaction.find({ userId, eventId })   → distinct personId
person → events :  Interaction.find({ userId, personId, eventId: { $exists: true } })
```

`Folder` keeps its real jobs (offline container, export unit, intake-QR owner) but is no longer the
only path to an event.

**Merge** = union `contactKeys`, repoint `Contact.personId` and `Interaction.personId`, write a
`merged` interaction, set `mergedInto` on the loser. Reversible.

---

## Write path

```
  offline                          │  server
  ─────────────────────────────── │ ────────────────────────────────────────────
  saveContact()                    │   POST /api/contacts
    └─ queueContact → IndexedDB    │     └─ requireUser
       {clientId, folderId, …}     │     └─ findOwnedFolder
       drain() ─────────────────▶  │     └─ pickWritable      ← personId NOT in the allowlist
                                   │     └─ contact.save()  → pre('validate') computes contactKey
                                   │     └─ NEW resolvePerson(userId, contact)
                                   │     └─ NEW recordInteraction('met', eventId: folder.eventId)
```

Three invariants:

1. **The client never knows about `Person`.** The outbox record is unchanged. It could not resolve
   identity anyway — it is offline and cannot see the rest of the corpus. This keeps
   `lib/scan/outbox.ts` (1,236 lines of hard-won failure handling: owner stamping, non-latched
   `blocked`, stale-latch timeout, body-size chunking, the honest `lost` outcome) untouched.
2. **`personId` stays out of `pickWritable`.** That function is the trust boundary for *every*
   contact write path — scan, manual add, PATCH, offline drain, `/c/<token>`, `/f/<token>`. A client
   able to set `personId` could attach its capture to any person id.
3. **The append-only timeline must be idempotent under replay.** `POST /api/contacts` answers a
   replayed `clientId` with **200 and the existing document** — the contract that stops a retried
   scan on bad conference wifi duplicating anybody. A naive `Interaction.create()` would append a
   second `met` row on that replay and a person met once would read "met 2×". The partial unique
   index above enforces one `met` per `contactId` in the database, rather than relying on a caller
   remembering to check.

**Key-upgrade handling** in `resolvePerson`: look up by the new key; if a *different* Person already
holds it, do **not** merge — record a suggestion unless the pair is in `notSamePersonAs`. Otherwise
append the new key to the existing Person's `contactKeys`.

**Interaction sources:**

| kind | written by | eventId |
| --- | --- | --- |
| `met` | the capture path | `folder.eventId` when set |
| `note` | a note added on the person page (append, never overwrite the previous) | — |
| `follow-up-set` / `follow-up-done` | the follow-up controls — **this is what finally produces a real last-contacted date** | — |
| `message-sent` | follow-up drafting, when the user copies or opens LinkedIn | — |
| `intake` | someone adds themselves via `/f/<token>` | the folder's event |
| `merged` | a merge, so the timeline explains its own history | — |

---

## Read path

```
lib/people/query.ts     pure, no mongoose — third instance of an established pattern
  buildPersonFilter(userId, params)     ← userId positional AND required, like the other two builders
  buildPersonSort(sort)
```

`/people` lists **Person**, not Contact. Shared by the list, its `countDocuments` and the facet
route, exactly as `lib/contacts/query.ts` and `lib/events/query.ts` are, so a chip can never say 12
and show 9.

| Today | After |
| --- | --- |
| `repeatOnly` is a two-stage query that broke the count and pagination | `eventCount >= 2` — one predicate |
| Cannot sort by last-contacted, follow-up date or met-count; **none of those fields exist** | all three sortable |
| Merge impossible | one row per human, `met N×` interrogable |

**Tags** stay written on `Contact` (so the offline capture sheet and `canonicaliseTags` are
untouched) and are **unioned onto `Person`** at resolve time, plus anything added directly on the
person.

**Federated search.** `/api/search?q=` fans out to `buildEventFilter` and `buildPersonFilter` and
returns two labelled groups.

**The payoff — the event page answers both questions:**

```
  vLLM Inference Meetup Bengaluru                     19 Sept
  ──────────────────────────────────────────────────────────
  WHO'S GOING     42 registered                ← public Luma data
  YOU MET HERE    Asha Rao · Ravi K            ← Interaction.find({userId, eventId})
                  + record someone
```

That second row is what no competitor shows at any price, and it is one indexed query.

**Module boundaries** (acyclic): `lib/people/query.ts` pure · `lib/people/service.ts` owns
`resolvePerson`, `recordInteraction`, `mergePersons`, `recomputePerson` · `lib/contacts/service.ts`
calls into it **one direction only** · **no route file ever imports another route file** — the audit
found `/api/contacts/export` importing from a folders route put every `/api/*` path into a 404.

---

## Navigation

`Events · Calendar · Tracker · People · Settings` — **no Folders tab.** Folder becomes plumbing and
is never named in the UI.

| Was on `/folders` | Moves to |
| --- | --- |
| Offline banners (waiting / other-account / blocked), "Sync now" | **the app shell** — an unsynced capture matters on every page, and `OutboxOwner.tsx` is already a global mount |
| Stuck-capture retry / discard / move | a sheet from that global banner |
| Per-folder CSV + vCard export | the event page; all-people export on `/people` |
| Sign-up QR (`/f/<token>`) | the event page |

**Folder creation** happens only via the tracker's Confirmed/Attended transition
(`ensureFolderForEvent()` already does this and already sets `eventId`), a "record someone" action on
an event page, and one auto-provisioned implicit folder per user:

```
Folder { name: 'Not at an event', eventId: null, implicit: true }
```

so off-event captures have a home while `Contact.folderId` stays `required` and the cascade is
unchanged.

---

## Ranking — three scores, never conflated

```
Event.connectionScore    corpus-wide, recomputed by script     "is this worth attending"
relevanceScore           per-user, computed at query time      "is this for me"
Person.lastInteractionAt / nextActionAt                        "who needs me next"
```

No invented relationship-strength number: a fabricated warmth score is worse than none, and
`lastInteractionAt` + `nextActionAt` answer the real question — *who have I gone quiet on* — with
facts.

---

## Rollout — dual-read, ordered

1. Add `Person` + `Interaction`. Nothing reads them.
2. **Run `migrate-connections-to-contacts.ts --apply` FIRST.** After the Person backfill instead, and
   everyone still trapped in `TrackerEntry.connections[]` never gets a Person.
3. Backfill: per Contact, `resolvePerson` + one `met` Interaction. Idempotent via the partial unique
   index, so re-running is safe. **Dry by default, `--apply` to write** — repo convention.
4. Cut `/people` over to `Person`.
5. **Retire `connections[]` for real** by repointing `EditTrackerModal` at Contacts. Until that
   ships it is a live *write* UI for a deprecated store and the migration can never finish.
6. `backfill-person-fields.ts` for the denormalised counters, matching `backfill-connection-score.ts`.

---

## Not building (deliberately)

Relationship-strength score · person↔person introductions (real — and `ContactFields.tsx:156`'s
placeholder literally reads *"wants an intro to the platform team"* — but deferred) · a unified
search collection · who's-going sourced from our own users (renders empty below ~200 users; the
public-Luma version is separate) · a native app.

---

## This is two implementation plans, not one

Flagged deliberately rather than pretending otherwise. The two halves are independently shippable and
have different risk profiles:

**Plan A — the spine** (`Person`, `Interaction`, resolver, backfill, merge, `/people` cutover,
`/people/[id]`). Data-layer work with a migration. Risky in the backfill, invisible to the UI until
step 4. This is the moat.

**Plan B — the navigation restructure** (retire the `/folders` destination, relocate the offline
banners to the shell, move export and intake-QR onto the event page, event-only folder creation, the
implicit folder). Pure UI/IA work with no migration. Safe, and it depends on Plan A only for the
"you met here" row.

Build A first. B is where the hybrid becomes *visible*, but A is what makes it *true*.

## Risks, stated plainly

- **The backfill must be correct before the cutover.** A `Person` with a wrong `contactKeys` array
  merges two humans, and that is the one failure this design cannot make cheap to undo.
- **A window with two people-lists in the tree** during step 4 (new Person list, old Contact list).
- **Denormalised counters can drift** from `Interaction` — hence `recomputePerson` plus a backfill
  script, following the `connectionScore` precedent rather than trusting increments.
- **`Person` carries three arrays.** Any future compound index spanning two of them fails at write
  time, not build time, and presents as contacts failing to save.

## Verification

- Unit tests on `lib/people/query.ts` (pure), mirroring `tests/connection-score.test.ts` — including
  that `repeatOnly` is a single predicate and that `overrides` beat derived values.
- A write-then-delete fixture script proving: replaying a `clientId` yields **one** `met` interaction,
  not two; a `nm:` → `li:` upgrade appends a key rather than creating a second Person; a key collision
  produces a *suggestion* and not a merge; and merge is reversible.
- `diag-people-spine.ts` (new, repo diag convention): every Contact has a `personId`; every Person's
  `contactKeys` are unique across Persons; denormalised counters match a live recount.
- `npm test`, `npx tsc --noEmit`, `npm run lint`, `npm run build` clean before each commit.
