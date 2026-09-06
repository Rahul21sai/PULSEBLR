# Audit: people-view

## Summary

The data layer is largely ready; the feature is missing its read surface, its tag input, and one fix to stop user tags corrupting registry attribution.

What exists: `Contact` is a top-level collection with `role`, `company`, `tags[]`, registry-resolved `companies[]`, `isTargetCompany` and a derived `contactKey`. Tags are fully writable and persist through every path (scan, manual add, PATCH, offline outbox) and already appear in the CSV export — traced line by line. `GET /api/contacts` already serves cross-folder rows. `Contact.distinct` and `{userId,contactKey}` give repeat detection an index.

Three blockers. (1) `GET /api/contacts` (route.ts:41) accepts only `folderId` and `pendingFollowUp`, sorts `scannedAt:-1`, caps at 2000 with no pagination, has no search and no facet companion — and has zero consumers; there is no `app/people` and the "People" nav item points at the folder list. (2) `Contact.tags[]` has no input anywhere in `app/` — `ContactFields.tsx:28` types it and renders nothing, so the custom-tag half of the requirement cannot be exercised at all. (3) `deriveContactMeta` feeds tags into `resolveCompanies`, and `resolve.ts:121` matches them with the full alias matcher for ambiguous companies too, scoring 60 — above the strength-gated title branch. Verified: a tag pair `embedded, arm` matches Arm, a bare `slice` tag matches slice. So the tags meant for employers the registry does *not* know get laundered back into the registry facet — the `Docker`/"SriVidya" leak shape, from a direction `strength` cannot defend.

Indexes needed: `{userId,scannedAt:-1}`, `{userId,companies,scannedAt:-1}`, `{userId,tags,scannedAt:-1}`. The documented `sparse`-on-compound-`unique` bug does not recur (nothing here needs `unique`), but three other traps do: tags and companies can never share one compound index (MongoDB's parallel-array restriction, which fails at write time), `sparse` would omit the `[]` default that most rows carry, and only one text index per collection is allowed.

Tag vocabulary belongs on `User.contactTags`, mirroring `User.targetCompanies` (User.ts:80) — read via `ensureUser()`, unioned with `Contact.distinct('tags')`. A `Tag` collection is more machinery than this needs until rename is asked for.

## Findings

### [BLOCKER] `app/api/contacts/route.ts`:41

**What** `GET /api/contacts` supports exactly two query params — `folderId` (lines 28-34) and `pendingFollowUp=true` (36-39) — then runs `Contact.find(filter).sort({ scannedAt: -1 }).limit(2000).lean()` on line 41. There is no `company`, `companies`, `tag`, `role`, `q`, `folderIds`, `skip`, `cursor`, `sort` or `limit` param, no `$text` or regex search branch, and no facet/count aggregate anywhere for contacts (compare `lib/events/query.ts`, which the events feed shares with `/api/events/facets` precisely so counts and rows cannot disagree). The endpoint also has ZERO consumers in `app/` — grep for `api/contacts` finds only `[id]` PATCH/DELETE from the folder page and `lib/scan/outbox.ts` POSTing. There is no `app/contacts` or `app/people` directory; `NavBar.tsx:22` maps the label "People" to `/folders`, which lists folders, not people.

**Consequence** The feature does not exist and cannot be built client-side without accepting a hard ceiling: with no filter params every filter has to be applied in the browser over a payload capped at 2000 rows, so the 2001st contact is silently invisible and "who do I know at Razorpay" is answerable only for an arbitrary recent slice. With no facet endpoint the filter chips and their counts would be computed from that same truncated page, so the counts would be wrong rather than merely incomplete.

**Action** Add `company`/`tag`/`role`/`q` params plus cursor pagination to `GET /api/contacts`, and factor the filter builder into `lib/contacts/query.ts` so a companion facet route (distinct `companies`, distinct `tags`, distinct `role`, each with a count) is built from the same function the list uses — the arrangement `lib/events/query.ts` already establishes. Then build `app/people/page.tsx` against it and repoint the "People" nav item.

### [BLOCKER] `app/components/scan/ContactFields.tsx`:28

**What** `Contact.tags[]` has no input surface anywhere in `app/`. `ContactDraft` declares `tags?: string[]` on line 28 and the component renders no field for it — the rendered inputs are name, company, role, phone, note, follow-up chips, then LinkedIn/headline/X/GitHub/email/website behind `showAll`. The only other mentions of contact tags in `app/` are pass-throughs: `app/folders/[id]/page.tsx:596` copies `tags: contact.tags` into the draft and `:136` preserves it in the optimistic update, so an edit round-trips existing tags without ever being able to change them. `app/api/intake/[token]/route.ts:71` deliberately does not accept tags either.

**Consequence** The "user creates their own tag and applies it to people" half of the requirement has no way to be exercised at all — `tags` is permanently `[]` for every contact, so a tag facet would render empty on a real database and the registry-unknown-employer case has no fallback.

**Action** Add a tag input to `ContactFields.tsx` (chips with type-ahead over the user's existing vocabulary plus free entry) so both the post-scan capture sheet and the folder table's `EditContactSheet` gain it from one definition, as that file's header intends. Also add a bulk "tag these people" affordance on the new cross-folder page — tagging 40 contacts one sheet at a time is the difference between a usable feature and a demo.

### [BLOCKER] `lib/companies/resolve.ts`:121

**What** `deriveContactMeta` (lib/contacts/service.ts:98-102) feeds `tags` straight into `resolveCompanies`, and `resolve.ts:121` matches the tag string with the FULL alias matcher for every company regardless of `strength`, scoring 60 — above the title branch's 50, which is itself gated on `strength === 'distinctive'`. So a user-created tag is treated as stronger company evidence than an event title. Verified the boundary regex behaviour directly: the joined tag string `"embedded arm"` matches Arm's matcher, and a bare `slice` tag matches slice. The registry is full of names that are ordinary tag words — `Arm`, `slice`, `Navi`, `Shell`, `Target`, `Visa`, `Elastic`, `Jupiter`, `Zeta`, `Setu`, `Accel`, `Fractal`, `Meta`, `Apple`, `Docker`, `Redis`, `Intel`, `CRED` (registry.ts:62-196, all `ambiguous`). `updateOwnedContact` (service.ts:518) recomputes on `isModified('tags')`, so this fires the moment the new tag UI saves. Note the asymmetry: `matchesTargetCompany` (service.ts:69) reads only company/role/headline, so a tag changes `companies` but never `isTargetCompany` — the two derived fields disagree about whether a tag is evidence.

**Consequence** Tagging a hardware contact `embedded, arm` files them under the company Arm in the company filter; tagging someone `slice` or `shell` or `target` attributes them to slice, Shell or Target. This is exactly the false-attribution class `strength` exists to prevent, arriving from the direction `strength` cannot defend — the same shape as the documented `Docker` → "SriVidya Tradition" leak. It is also self-defeating: custom tags exist precisely for employers the registry does NOT know, and this path launders them back into registry output, so the one facet that is supposed to be trustworthy becomes the one polluted by free text.

**Action** Stop passing `tags` to `resolveCompanies` from `deriveContactMeta` (drop `tags: fields.tags ?? null` at service.ts:101) so a contact's `companies` is derived only from what the person stated about themselves. Keep user tags in `Contact.tags` as an independent facet dimension. If tag-driven attribution is ever wanted back, gate it on `strength === 'distinctive'` at resolve.ts:121 and score it below title — but the event-side `tags` are organiser-supplied topic tags, a different thing from a user's private label, so the honest fix is to sever them. Re-run `scripts/backfill-contact-companies.ts --apply` afterwards.

### [IMPORTANT] `lib/models/Contact.ts`:126

**What** Existing indexes (126-132): `{userId,clientId}` unique, `{userId,folderId,scannedAt:-1}`, `{userId,contactKey}`, `{userId,followUpAt}`, `{userId,linkedinSlug}` sparse, plus single-field `userId` (line 91) and `folderId` (92). None serves the cross-folder query: `{userId,folderId,scannedAt:-1}` cannot supply sorted `scannedAt` when `folderId` is absent from the filter, so an unfiltered people list selects on `userId` and sorts in memory. There is no index on `tags`, `companies`, `role` or `company`, and no text index on this collection at all (only `Event` has one, `event_text_search`).

**Consequence** Every people-page query does an in-memory sort over the user's whole contact set, and a company/tag/role filter is a full scan of it. Tolerable at today's row counts, silently quadratic as the collection grows — and the 32 MB in-memory sort limit turns it into a hard query failure rather than a slowdown at the top end.

**Action** Add `{userId:1, scannedAt:-1}` (base cross-folder order), `{userId:1, companies:1, scannedAt:-1}` and `{userId:1, tags:1, scannedAt:-1}`. Three index traps, in order of how much they cost if missed: (1) **Never put `tags` and `companies` in the same compound index** — MongoDB rejects two array fields in one key with "cannot index parallel arrays", which surfaces as a write failure on any contact that has both, not as an index-creation error; they must be two separate indexes. (2) The repo's documented `sparse`-on-compound-`unique` bug does NOT recur here, because none of these needs `unique` — but do not reach for `sparse` on the tag/company indexes either: `tags` and `companies` default to `[]` (109/119), an empty array indexes as the missing-key sentinel, so a sparse index would omit most rows and be unusable for the unfiltered sort. Use no option at all, or `partialFilterExpression` if the intent is genuinely "only rows that have tags". (3) Only ONE text index is permitted per collection, so if the people-page search box is to use `$text`, decide its full field set and weights in a single index up front; and mirror `lib/events/query.ts`'s dual path, since `$text` matches whole words only and a search box must work mid-typing.

### [IMPORTANT] `lib/contacts/service.ts`:147

**What** `contactToDTO` emits `folderId` as a bare string and nothing else about the folder — no name, no `eventDate`, no `eventId`. `GET /api/contacts` (route.ts:41) does not `.populate('folderId')`; the only place that joins is `detectRepeatConnections` (phase6.ts:308) and `getPendingFollowUps` (145-152).

**Consequence** A combined list of people from many folders cannot say where you met each person — the single most valuable column on that page — without either N fetches of `/api/folders/[id]` or the client holding the full folder list and joining by id, which breaks for an archived folder that the default `listFolders` filter (service.ts:276) excludes.

**Action** Have the list route project the folder name and date alongside each contact (a `$lookup`, or one `Folder.find` over the distinct folderIds of the page plus an in-memory join — cheap, and the same one-round-trip discipline `listFolders` already uses for its counts) and add `folderName`/`folderEventDate` to `ContactDTO` in lib/contacts/types.ts.

### [IMPORTANT] `lib/helpers/phase6.ts`:364

**What** `detectRepeatConnections(userId)` returns `RepeatConnection[]` — `{ name, details:{role,company,linkedin}, eventCount, eventIds, contactKey, matchedOn, places }` — grouped by `contactKey` and unioned with legacy `TrackerEntry.connections[]`. Two properties make it unusable as-is for a people page: line 364 filters to `eventIds.size >= 2`, so it knows nothing about anyone met once, and the returned objects carry no `Contact._id`, only a name and a key. It also loads every contact for the user with `.populate('folderId')` unbounded (line 308) and groups in memory. Its only consumer is `app/dashboard/page.tsx` via `/api/phase6/repeat-connections`; nothing in the scan/folder UI surfaces it.

**Consequence** To badge rows on a people page you would have to match this function's output back to contacts by `name` — reintroducing the exact defect the `contactKey` work exists to fix (two Rahuls collapsing, one Rahul splitting). And because singletons are dropped, the page cannot render "met 1 time" versus "met 3 times" from one call; it would need a second pass.

**Action** Do not extend `detectRepeatConnections` for this. Add a small aggregate in `lib/contacts/` that returns `contactKey → { eventCount, contactIds[] }` for all of a user's contacts (no `>= 2` filter), served by the `{userId,contactKey}` index already on Contact.ts:130, and join it onto the list page by `contactKey` — which every DTO already carries (types.ts:59). Keep `detectRepeatConnections` as the dashboard's legacy-union view.

### [IMPORTANT] `lib/models/User.ts`:80

**What** There is no model for a per-user tag vocabulary and no model that fits one. The closest precedent is `User.targetCompanies: { type: [String], default: () => [...DEFAULT_TARGET_COMPANIES] }` (line 80) — a per-user string list on the User document, read through one accessor (`getTargetCompanies`, service.ts:50) that falls back to a seed. The only other option available today is deriving the vocabulary from the contacts themselves, for which the precedent is `Contact.distinct('folderId', { userId })` at phase6.ts:448.

**Consequence** Without a stored vocabulary the tag list can only be `Contact.distinct('tags')`, which means: a tag created but not yet applied to anybody does not exist; a typo'd tag is a permanent phantom facet entry with one member and no way to rename it; and there is nowhere to hold ordering or colour. With a full `Tag` collection you inherit a `{userId,slug}` unique index and a rename-cascade over `Contact.tags[]`, which is materially more work than this feature needs.

**Action** Add `User.contactTags: string[]` following the `targetCompanies` shape exactly (per-user, on the User doc, read through one accessor in `lib/contacts/service.ts`, seeded empty rather than from a default list), and build the facet as the union of `contactTags` with `Contact.distinct('tags')` so a tag applied before the vocabulary knew about it still shows. Note `ensureUser()` (lib/user-record.ts) must be used to read it, not `findOne` — a valid session can legitimately have no `User` row, which is what made `/api/me/card` 404. Defer a `Tag` collection until rename or colour is actually asked for.

### [IMPORTANT] `lib/contacts/service.ts`:399

**What** `tags` IS writable and DOES persist — traced end to end: `pickWritable` handles it at 399-407, `upsertContact` passes it into `Contact.create` (479-486), `updateOwnedContact` assigns it and `.save()`s (507-526), `PATCH /api/contacts/[id]` calls that, `ContactInput.tags` (types.ts:101) means the offline outbox carries it too (`QueuedContactRecord extends ContactInput`, outbox.ts:74), and the export already emits it (folders/[id]/export/route.ts:45). But `pickWritable` performs no canonicalisation: it filters to strings, trims, drops blanks and `.slice(0, 20)` the array — no case folding, no dedupe, and no per-tag length cap (the schema's `tags: [String]` at Contact.ts:109 has no `maxlength` either, unlike every sibling text field).

**Consequence** `"AI/ML"` and `"ai/ml"` become two separate facet entries for what the user means as one tag, so the filter splits their people in half with no way to notice; `['ibm','ibm']` stores twice and inflates any per-tag count; and a single tag can be an arbitrarily long string, which a chip UI will render as a broken row.

**Action** Canonicalise inside `pickWritable` so every write path (scan, manual add, PATCH, offline drain) gets it identically: trim, collapse internal whitespace, lowercase for comparison while preserving the first-seen display form or simply storing lowercase, dedupe, cap each tag at ~40 chars, keep the 20-item cap. Add `maxlength` to the schema path to match. Pin it in `tests/` — `pickWritable` is pure, so it belongs with the other pure-function suites rather than in a diag script.

### [MINOR] `app/api/folders/[id]/export/route.ts`:45

**What** The CSV export keeps user tags and registry attribution in separate columns — `{ label: 'Tags', value: c => c.tags?.join(', ') }` on line 45 and `{ label: 'Known companies', value: c => c.companies?.join(', ') }` on line 49 — with `lib/scan/csv.ts#csvCell` escaping each against formula injection. The route is folder-scoped throughout (`findOwnedFolder` at 61, `folderId: folder._id` at 64) and there is no all-people export.

**Consequence** A cross-folder export bolted on without reusing these columns would either merge the two tag kinds into one cell — destroying the distinction between "the registry recognised this employer" and "the user made this label up", which is the whole point of the feature — or lose the formula escaping, which matters because both fields now originate in free text and QR payloads.

**Action** Add an export to the new people route that reuses `COLUMNS` from this file (export it) plus a `Folder` column, keeping `Tags` and `Known companies` separate, and copy the `Cache-Control: no-store` header at line 93 — it is a bulk PII export for the same reason this one is. Note the existing export is served from a bare `<a>` (`app/folders/[id]/page.tsx:307`) with no error state, so a 500 renders a raw error page; do not repeat that on a route that will be slower.

### [MINOR] `lib/models/Contact.ts`:97

**What** `role` is free text, `{ type: String, trim: true, maxlength: 200 }` (line 97), populated from a hand-typed field (`ContactFields.tsx:113-122`) or from a vCard `TITLE`. There is no controlled vocabulary, no normalisation, and no index. `headline` (96) holds an overlapping free-text claim, and the folder table already treats them as interchangeable (`contact.role || contact.headline`, folders/[id]/page.tsx:418).

**Consequence** A "by role" facet built from `distinct('role')` is a long tail of one-off strings — "SDE", "SDE II", "Software Engineer", "Sr. Software Engineer" all separate — so the filter looks broken rather than sparse. Substring matching instead requires an unanchored regex per query with no index behind it.

**Action** Treat role as a search dimension, not a facet: include it in the `q` free-text path rather than rendering role chips, or derive a small bucketed seniority/discipline label at write time in `deriveContactMeta` (where `companies`/`isTargetCompany` already live, so it stays recomputable by `backfill-contact-companies.ts`) and facet on the derived field instead of the raw string.

