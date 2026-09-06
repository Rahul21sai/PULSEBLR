# Audit: user-events

## Summary

Adding `createdByUserId` + `visibility` to `Event` touches far more than the model. I found 28 required changes; 12 are blockers.

The four structural ones, in the order they will bite:

1. **`pruneStale()` deletes user events, permanently.** `lib/scrapers/pipeline.ts:335-338` selects on `{ startDateTime < now-7d, lastSeenAt < now-7d }`. `lastSeenAt` is only ever refreshed by `ingestEvents` (`lib/scrapers/ingestion.ts:346`), and nothing re-reports a hand-entered event, so it is frozen at creation. Consequence confirmed: any user event created more than a week before it happens is deleted exactly 7 days after it ends. Referrers — `TrackerEntry.eventId` is `required` and `app/tracker/page.tsx:100` *drops* entries whose populate came back null, so the tracked entry and its notes vanish from the kanban with no error; `Folder.eventId` dangles but survives on denormalised fields; `lib/helpers/phase6.ts:194,342` already null-guard.

2. **A scrape can merge INTO a user event and swallow the public one.** `POST /api/events:126` computes `clusterKey` with the same generator as the pipeline, so a manual event collides with a scraped one on title+IST day by construction. `ingestion.ts:324` then finds the user's document, `mergeInto` overwrites its description, venue, categories and `isTechEvent`, `Event.create` at `:360` never runs, and the merge is counted as `crossSourceMerged` at `:352`. If the user's row is private, the city loses that event and the run reports success. Two more routes into the same hole: the `sourceEventId` match at `:316` (which then rewrites title/start/dedupHash/clusterKey at `:334-338`), and `dedupHash: body.dedupHash || …` at `route.ts:124`, which lets a caller pre-claim a hash. **My recommendation: namespace both keys for owned events** (owner in the dedupHash input, `user:<id>|…` clusterKey prefix) rather than patching five call sites — it makes an owned document structurally ineligible for merging or cluster-collapsing.

3. **The feed and the facet counts share one unfiltered builder.** `buildEventFilter` (`lib/events/query.ts:154`) has no visibility predicate and is the only one, used by the list *and* `countDocuments` *and* all six facet aggregations. The clause must go inside the `and` array (not a top-level `$or`, which the search branch would collide with) and needs a **three-arm** `$or` — the `{ visibility: { $exists: false } }` arm is not optional, or the ~1500 existing documents disappear on deploy. Make `viewerId` **required** in the signature: `tests/search-filter.test.ts` casts its argument, so the suite will not catch a caller that forgets it, and an optional parameter fails open. `app/api/events/facets/route.ts` has *no auth call at all* and needs a nullable session read (not `requireUser()` — `diag-api-auth.ts:138` asserts the facets route stays 200 signed-out).

4. **Four id-addressable read paths bypass the feed entirely.** `GET /api/events/[id]:20`, its `related` query at `:28` (which leaks other users' private events onto every public detail page with no id guessing), `app/api/events/[id]/ics/route.ts:56` (which also sends `Cache-Control: public, max-age=3600`), and — the worst — `app/api/tracker/route.ts:68`, where any signed-in user can track a private event by id and read the fully populated document back forever through `GET /api/tracker`. Return 404, not 403.

Also blocking: `public/sw.js:29` omits `/api/events` from `PRIVATE_API`, so private rows get written to the origin-wide dynamic cache and served to the next account offline — the exact leak the v3 bump closed for the other routes. And three destructive scripts delete without an ownership predicate: `cleanup-duplicate-clusters.ts:60` (which can delete *either* side — losing the user's event, or losing the public one to a private survivor), `cleanup-non-bengaluru.ts:163`, `cleanup-implausible.ts:21`.

Two decisions worth making before any schema edit. **`visibility: 'public'` as written has no review surface** — `app/admin/AdminDashboard.tsx:634` lists events through `/api/events`, so once that scopes to the caller, submissions become invisible to the admin too, and the alternative (instant publication) reopens the `applyLink`-into-an-href phishing vector the admin guard exists to close. A third `pending` state plus an admin-only listing is the honest shape. And **user submissions currently inherit `isTechEvent: true`** (`lib/models/Event.ts:226`), because `POST /api/events:109` bypasses the normalizer entirely — so every submission lands in the default tech feed with `connectionScore: 20` and no off-city gate. Note `/add-event` is already signed-in-only in `proxy.ts:25` while `POST /api/events` is `requireAdmin()`, so today the form is a dead end that 403s on submit.

## Findings

### [BLOCKER] `lib/scrapers/pipeline.ts`:332

**What** pruneStale() deletes on { startDateTime < now-7d, lastSeenAt < now-7d } with no ownership predicate. lastSeenAt is set once at creation (lib/models/Event.ts:224) and is only ever refreshed by ingestEvents (lib/scrapers/ingestion.ts:346). Nothing re-reports a user-authored event, so its lastSeenAt is frozen at creation time.

**Consequence** Every user-created event is silently deleted 7 days after it ends (immediately at the 7-day mark for the normal case, where the event was entered more than a week before it happened). No re-scrape recovers it because there is no upstream. The user gets no error and no notice — the row simply stops existing. Dangling referrers: TrackerEntry.eventId (lib/models/TrackerEntry.ts:73, required, compound-unique {userId,eventId} at :112) — app/tracker/page.tsx:100 filters out entries whose populate returned null, so the tracked entry AND its status/notes/connections disappear from the kanban with no message; Folder.eventId (lib/models/Folder.ts:67) dangles but survives because name/date/venue are denormalised; lib/helpers/phase6.ts:194 and :342 already null-guard so no 500.

**Action** Add `createdByUserId: { $exists: false }` (or `$in: [null, undefined]` to also cover explicit nulls) to the deleteMany filter at pipeline.ts:335-338, and give user events their own explicit retention rule. Also update the PipelineOptions.onlySources docblock at pipeline.ts:74-80, which currently states pruning's contract as 'any past event no source has reported for a week' — that sentence becomes false the moment events exist that no source ever reports.

### [BLOCKER] `lib/scrapers/ingestion.ts`:324

**What** The clusterKey lookup `Event.findOne({ clusterKey: event.clusterKey })` has no ownership or source predicate, and POST /api/events computes clusterKey with the same generator the pipeline uses (app/api/events/route.ts:126 calls Event.generateClusterKey, identical to lib/models/Event.ts:300-311). A user event titled 'React Meetup' on the same IST calendar day as the scraped one shares a clusterKey by construction — normalizeTitleForMatch strips city words and noise, so collisions are easy, not exotic.

**Consequence** A scrape merges INTO the user-created document. mergeInto (ingestion.ts:104-266) then overwrites the user's description if the incoming one is 20+ chars longer (:131), fills venue/address/area/city/organizer/imageUrl (:107-117), REPLACES category and isTechEvent when incoming tagConfidence is higher (:176-185), recomputes companies (:234-244), and refreshes lastSeenAt (:346). Worse, `Event.create(event)` at :360 is never reached and the merge is counted as crossSourceMerged at :352 — so the real, public event never gets a document of its own. If the user document is private, the whole city loses that event from the feed, silently, and the run reports success.

**Action** Add an owner exclusion to all four lookups: ingestion.ts:301, :312, :316, :324. Belt and braces: make mergeInto return false (or throw) when `existing.createdByUserId` is set, so a future fourth lookup path cannot reintroduce this. The cleanest structural fix is to namespace the derived keys for owned events (see the dedupHash/clusterKey finding), so an owned document is incapable of entering a scraped cluster.

### [BLOCKER] `app/api/events/route.ts`:124

**What** `dedupHash: body.dedupHash || Event.generateDedupHash(...)` — the caller can supply an arbitrary dedupHash. Separately, line 110 spreads the entire request body into the document (`...body`), so the caller also controls `source` (:108 `body.source || 'manual'`), `sourceEventId`, `spotlightAt`, `connectionScore`, `isTechEvent`, `companies`, `lastSeenAt`, `seenInSources` — and, once the fields exist, `createdByUserId` and `visibility` themselves.

**Consequence** Three distinct attacks once a user-scoped create path exists. (1) A user pre-claims the dedupHash of an event not yet scraped; the next run matches at ingestion.ts:312 and merges the public event into the user's private document instead of inserting it — same swallow as the clusterKey path but deliberate. (2) A user sets `visibility: 'public'` on a submission that was supposed to await review, or sets `createdByUserId` to somebody else's id, transferring ownership by request body. (3) A user sets `spotlightAt: <now>` and `connectionScore: 100` and pins their own event into the home page Spotlight (app/page.tsx:540-544 renders whatever `?spotlight=true` returns) — the field CLAUDE.md documents as 'editorial, human-chosen, nothing may recompute it'.

**Action** Replace the `...body` spread with an explicit allowlist of accepted fields. Never accept dedupHash, clusterKey, source, sourceEventId, spotlightAt, connectionScore, companies, isTechEvent, lastSeenAt, seenInSources, createdByUserId or visibility from the body. Derive createdByUserId from the session and assign it LAST, copying the `{ ...input, userId }` ordering already used at app/api/tracker/route.ts:80. Force `source: 'manual'`. Take `visibility` from a single validated enum check, not from a spread.

### [BLOCKER] `lib/events/query.ts`:154

**What** buildEventFilter has no visibility or ownership predicate. It is the ONLY filter builder, shared by app/api/events/route.ts:35 (list, and the countDocuments at :62) and app/api/events/facets/route.ts:26-31 (all six facet aggregations plus baseFilter). Its own header (query.ts:1-6) states the reason it is shared: a filter that behaves differently between the list and the counts is a bug users notice immediately.

**Consequence** Every user's private events appear in every other user's feed, in the pagination total, in every facet count, and in the search results — full titles, venues, organizers and descriptions, to signed-out visitors included. This is the primary privacy leak.

**Action** Add the clause INSIDE the `and` array before line 246, never as a top-level `filter.$or` — the search branch already owns `$or` inside `and` (:239) and top-level keys are set unconditionally at :158-169, so a second top-level `$or` would be silently overwritten by a future param or conflict with `$text`. The clause needs three arms, not two: `{ $or: [ { visibility: 'public' }, { visibility: { $exists: false } }, { createdByUserId: viewerId } ] }` — the ~1500 existing documents have no `visibility` key at all, and omitting that arm empties the entire feed on deploy. Make viewerId a REQUIRED parameter (or required field of EventQueryParams): an optional one fails open, and failing open here is the leak. Note tests/search-filter.test.ts:20/69/86/97 casts its argument through `Parameters<typeof buildEventFilter>[0]`, so the test suite will NOT catch a caller that forgets it — the type must be required at the call site.

### [BLOCKER] `app/api/events/facets/route.ts`:19

**What** The facets route has no auth call of any kind — no `auth()`, no `getCurrentUserId()`, no guard. It cannot identify the caller, so it cannot pass a viewerId into any of its seven buildEventFilter calls (:26-31).

**Consequence** Even after the list route is fixed, the counts beside the filters would still be computed over every user's private events. The list and the counts would disagree — the exact failure the shared query builder exists to prevent — and the facet numbers alone disclose how many private events exist per category, area, source, format and company.

**Action** Add a NULLABLE session read (`getCurrentUserId()`, not `requireUser()`) — the feed must stay public for signed-out visitors, which scripts/diag-api-auth.ts:138 asserts as a 200. Pass the resulting viewerId (or null) into all six dimension filters and baseFilter. Same for the `$match` at :41 and :56, which spread the dimension filters and would otherwise lose the clause.

### [BLOCKER] `app/api/events/[id]/route.ts`:20

**What** `GET /api/events/[id]` is fully public: `Event.findById(id).lean()` with no visibility or ownership check. The `related` query at :28-36 likewise matches on category + upcoming with no visibility clause.

**Consequence** A private event is readable in full by anyone who has or guesses its id — and Mongo ObjectIds are not secrets: they embed a timestamp and an incrementing counter, so one known id makes neighbours enumerable. Independently, other users' private events surface as 'similar events' at the bottom of every public event's detail page (app/events/[id]/page.tsx:46 renders `data.related`), which leaks them with no id guessing at all.

**Action** Return 404 (not 403 — a 403 confirms the row exists) when the event is private and the caller is not its owner. Add the same visibility clause to the `related` query. Do the ownership check after `connectDB()` but before building `related`, so a refused request costs one query.

### [BLOCKER] `app/api/events/[id]/ics/route.ts`:56

**What** Same unguarded `Event.findById(id).lean()`, and the response sets `Cache-Control: public, max-age=3600` at :112. The body carries title, full description, organizer, venue, address, area, city and sourceUrl (:68-100).

**Consequence** A private event's entire contents are fetchable by id with no session, and then cached for an hour by any shared or CDN cache along the path — so revoking access does not revoke the cached copy. CLAUDE.md §9 already records this exact distinction for the CSV export ('the route serving it must send no-store — do not copy the ICS route's public, max-age=3600, since that is a shared calendar and this is one person's private list'); a private event turns the ICS route into the second instance of that mistake.

**Action** Gate on ownership, 404 otherwise, and send `Cache-Control: no-store` whenever the event is not public.

### [BLOCKER] `app/api/tracker/route.ts`:68

**What** `Event.findById(eventId)` with no visibility check, then `TrackerEntry.create({ ...input, userId })` at :80 and `.populate('eventId')` at :81, returning the fully populated event in the 201 body. GET at :65 re-populates it on every subsequent read.

**Consequence** Any signed-in user can track another user's private event by id and get the complete event document back in the response — and then keep reading it forever through GET /api/tracker. This turns the id-guessing oracle into a durable read channel, and it survives the fix to GET /api/events/[id] because it is a different route. Downstream, moving that entry to Confirmed/Attended calls ensureFolderForEvent (lib/contacts/service.ts:218-247), which copies the private event's title, startDateTime and venue into a Folder the attacker owns — a permanent denormalised copy that no later access-control change can claw back.

**Action** After the findById at :68, refuse (404, matching the existing 'Event not found' shape) when the event is private and `event.createdByUserId !== userId`. Keep it after the guard and the validator so the ordering rule in CLAUDE.md §6 still holds.

### [BLOCKER] `public/sw.js`:29

**What** `PRIVATE_API` (:29-38) lists /api/tracker, /api/contacts, /api/folders, /api/me/, /api/phase6, /api/notifications, /api/admin and /api/auth — but NOT /api/events. So /api/events falls into the network-first branch at :96-103 and every successful response is written to the origin-wide `pulseblr-dynamic-v3` cache (:101-102) and served offline at :105-106.

**Consequence** Once /api/events returns the caller's private events, account A's private event titles are cached on the device and served to account B offline. This is precisely the cross-account leak the v3 bump exists to close (sw.js:3, :17). The `purge-caches` message (:140+) only mitigates it when the app itself sends it before signOut(); a session expiry, a cleared cookie, a sign-out from another tab, or a crash leaves the cache intact.

**Action** Pick one: keep private events off /api/events entirely and serve them from a new path added to PRIVATE_API; or add '/api/events' to PRIVATE_API and accept that the feed is no longer readable offline (state that cost explicitly, as sw.js:3 does for the others). Either way bump STATIC_CACHE/DYNAMIC_CACHE to v4 (:25-26) so existing clients drop the already-poisoned cache. Note this cannot be verified under `npm run dev` — app/layout.tsx unregisters the worker in development.

### [BLOCKER] `scripts/cleanup-duplicate-clusters.ts`:60

**What** The `$match` at :61 groups every upcoming event by clusterKey with no ownership predicate, sorts each group by `completeness()` (:81), keeps the winner and `deleteMany`s the rest (:183). It repoints TrackerEntry (:143-155) and Folder.eventId (:169-176) but has no concept of an owner.

**Consequence** Two symmetrical data-loss paths on a user/scraper clusterKey collision. If the scraped document is more complete, the user's hand-entered event is DELETED — and unlike a scraped row nothing re-creates it, so that is permanent loss of user-authored content from a script whose stated job is deduplication. If the user's document wins (it easily can: it has venue, description, image, price and organizer if they filled the form in), the PUBLIC scraped document is deleted and the whole city loses that event to a row only one person can see.

**Action** Add `createdByUserId: { $exists: false }` to the `$match` at :61 so owned documents never enter a cluster group. Do not try to solve this inside `completeness()` — the fix belongs at selection, before anything is a candidate.

### [BLOCKER] `scripts/cleanup-non-bengaluru.ts`:163

**What** `Event.find({})` over the whole collection (:163), judged by offCityReason (:180-189), deleted with `deleteMany` at :260. The only spare is 'a user tracked it or built a Folder for it' (:225-249). Ownership is not considered.

**Consequence** A user's own event whose venue or title contains a gazetteer hit — 'Mysore Road', a Chennai-office demo, a title naming another city — is deleted with `--apply` and cannot be recovered, because the spare only fires if the user ALSO tracked it. The script's own header argues that a deliberate human action outranks a geo heuristic; typing the event in by hand is a stronger human action than tracking one.

**Action** Exclude owned documents from the `find` at :163, or at minimum add 'created by a user' to `protectedIds` at :232-236 on the same footing as tracked/foldered, and name the spared rows in the report the way the tracked ones are named at :244-248.

### [BLOCKER] `scripts/cleanup-implausible.ts`:21

**What** `Event.find({})` (:21) then `deleteMany` (:54) on any event starting before 2020-01-01 (:31) or more than 550 days out (:32), plus `updateMany` clearing endDateTime (:58). No ownership predicate. Same shape in scripts/migrate-events.ts:103-110 (junkFilter deleteMany, whose dedupHash-regex arm is unscoped by source), scripts/cleanup-past.ts:39-49 and scripts/cleanup-seed.ts:27-41.

**Consequence** A date typo in the add-event form (`2026` mistyped as `2016`), or a genuinely far-out conference the user wants to remember, is permanently deleted by a maintenance script the user never ran and cannot see. The dedupHash regex in migrate-events.ts:105 is a prefix match over a hex hash and could in principle catch a user-supplied dedupHash (see the body-spread finding).

**Action** Add an ownership exclusion to the selection in each of these four scripts, or invert them to opt-in with an explicit `--include-user-events` flag. Update the scripts table in CLAUDE.md, which currently describes them as operating on 'stored events' with no ownership caveat.

### [IMPORTANT] `lib/models/Event.ts`:282

**What** `generateDedupHash` mixes title + instant + venue + source (:288) — not the owner. `dedupHash` is `{ required: true, unique: true }` (:222). The pre('validate') hook only derives it when absent (:343), so a caller-supplied value wins. `generateClusterKey` (:300-311) is title + IST day, with no owner either.

**Consequence** Two users adding the same event privately (same title, time, venue, source 'manual') collide on the global unique index. The second gets the 409 at app/api/events/route.ts:132 saying 'Event already exists' — an existence oracle for a document they are not allowed to see, and a hard block: the feature simply does not work for the second person. And because clusterKey carries no owner, every owned document remains eligible for scraper cluster merges and for cleanup-duplicate-clusters.

**Action** For owned events, namespace both keys: include createdByUserId in the generateDedupHash input, and prefix clusterKey (e.g. `user:<id>|<normalized title>|<istDay>`). That single change makes the ingest merge (ingestion.ts:301/312/316/324) and the cluster cleanup structurally incapable of touching a user event, which is a stronger guarantee than adding a predicate to each of the five call sites. Keep the derivation in pre('validate') — pre('save') runs after validation and would leave the required field unset (scripts/diag-hook-order.ts).

### [IMPORTANT] `app/api/events/route.ts`:88

**What** POST is `requireAdmin()`, while proxy.ts:22-31 lists `/add-event` as merely signed-in. So a signed-in non-admin can already reach the form and submit it.

**Consequence** Today that path ends in a 403 rendered as `alert(data.error)` at app/add-event/page.tsx:103 — a dead-end form with no explanation. The user-ownership feature has to resolve this split, and getting the order wrong reintroduces a documented defect: if the new validation or the visibility branch runs above the guard, an anonymous caller with a bad body gets 400 instead of 401, which is the ordering rule CLAUDE.md §6 spells out and scripts/diag-api-auth.ts asserts.

**Action** Branch inside POST: `requireUser()` for a create that is private or a pending submission; keep `requireAdmin()` for anything that lands in the shared corpus directly. Keep the gate above `request.json()` at :94 (it currently is — preserve that). Add the new cases to scripts/diag-api-auth.ts:30-32 including a deliberately-invalid-body probe, which is how a validator that outran the guard gets caught.

### [IMPORTANT] `app/api/events/route.ts`:109

**What** The create path sets none of the derived fields the scraper computes. lib/scrapers/normalizer.ts:197-206 sets isTechEvent, companies and connectionScore; POST sets neither, so the schema defaults apply: `isTechEvent: true` (lib/models/Event.ts:226) and `connectionScore: 20` (:228). No off-city gate runs either — lib/scrapers/pipeline.ts:611-627 applies offCityReason to scraped batches only.

**Consequence** Every user-submitted event is flagged tech by default, so it lands in the DEFAULT feed (lib/events/query.ts:165 sets `filter.isTechEvent = true`) regardless of what it actually is — a book club, a wedding, a Chennai workshop. connectionScore 20 puts it near the bottom of the default `connections` sort, so it is simultaneously in the tech feed and unrankable. And a user-submitted off-city event enters the corpus the stage-5c gate exists to keep clean, where scripts/diag-offcity.ts will report it as a leak with no source to attribute it to.

**Action** Run user submissions through the same normalizer path — tagEvents/keywordTagging for category+isTechEvent, resolveCompanies, connectionScore — or, if that is too much for a synchronous request, default `isTechEvent: false` for anything unreviewed rather than inheriting the schema's `true`. Apply offCityReason to the submission and reject with a 400 that names the city it matched.

### [IMPORTANT] `app/admin/AdminDashboard.tsx`:634

**What** The admin events panel lists events by fetching `/api/events?${params}` — the same public feed endpoint that will start filtering by viewer. There is no admin-only event listing endpoint and no review state in the model (visibility is proposed as a two-value enum, private | public).

**Consequence** 'Submitted for inclusion in the shared corpus' has nowhere to be reviewed. Once /api/events scopes to the caller, other users' submissions become invisible to the admin too — so submissions are either instantly public (no review at all, and app/events/[id]/page.tsx renders applyLink into an href, which is the phishing vector the admin guard at app/api/events/route.ts:82-86 was added to close) or invisible forever. The admin's per-event controls at :688 (spotlight pin) and :716 (isTechEvent toggle) also cannot reach a submission they cannot list.

**Action** Decide the review model before writing the schema. Either add a third state (`pending`) plus an admin-only listing endpoint, or add an explicit bypass parameter to the shared filter that the ROUTE gates with requireAdmin() — never a bypass the query builder decides for itself, since the query builder is also called by the unauthenticated facets route.

### [IMPORTANT] `app/api/companies/route.ts`:26

**What** Both aggregations match only on `startDateTime >= now`: the counts pipeline at :27 and the unmatchedHosts pipeline at :70-74. No visibility clause, no auth on the route at all.

**Consequence** A private event whose organizer resolves to a registry company inflates that company's public `upcoming` and `techEvents` counts, and can supply the `nextEventAt` (`$min` at :34) and the representative cover `image` (`$first` at :36) shown on /companies. `unmatchedHosts` (:76) publishes the raw organizer string of private events to every visitor — and the /companies page exists specifically to surface unrecognised hosts, so it is the one surface guaranteed to display them.

**Action** Add the shared visibility clause to both `$match` stages. Since this route has no session read, either add a nullable one or restrict both aggregations to `visibility: 'public'` plus the no-key legacy arm — a company browse page arguably should show only the shared corpus regardless of who is looking.

### [IMPORTANT] `app/api/events/calendar/route.ts`:51

**What** The filter is hand-built at :51 (`{ startDateTime: { $gte: from, $lt: to } }`, plus isTechEvent at :52) rather than going through buildEventFilter, and the route has no auth.

**Consequence** Other users' private events light up day dots and inflate the monthly total on the public calendar grid, and the numbers will not agree with the feed once the feed is scoped. Because this filter is a hand-rolled copy, it is also the place a visibility fix is most likely to be forgotten — the same duplicated-constant failure mode CLAUDE.md documents for CATEGORY_KEYWORDS and the source caps.

**Action** Export the visibility clause as a single helper from lib/events/query.ts and apply it here rather than reimplementing it, so this route cannot drift from the feed.

### [IMPORTANT] `lib/scrapers/ingestion.ts`:386

**What** `getNewEventsSince` (:388) and `getEventsWithDeadlineSoon` (:398) query Events with no user or visibility predicate. lib/notifications/digest.ts:70 and :73 put their results straight into `newEvents` and `upcomingDeadlines`.

**Consequence** Every user's daily email contains every OTHER user's private event titles, areas, food flags and registration deadlines — rendered at digest.ts:136-138 (text) and :270-271 (HTML). generateDailyDigest is already scoped per user and its header (:51-60) records that both TrackerEntry queries once ran unscoped and leaked private notes; these two are the same defect in the half that was assumed 'global by nature'. That assumption stops being true the moment an event can be private.

**Action** Give both functions a required userId parameter and apply the visibility clause — required, not optional, for the same reason generateDailyDigest's userId is required (digest.ts:57-60): an optional parameter lets a caller silently reintroduce the leak with TypeScript saying nothing.

### [IMPORTANT] `app/api/admin/stats/route.ts`:41

**What** Every Event query here is unscoped: total (:41), upcoming (:42), tech (:43), addedToday (:44), withoutClusterKey (:48), byCategory (:51), bySource (:58) and nextEvents (:69-73), which returns titles, venues, organizers and connectionScores.

**Consequence** Not a leak to strangers (requireAdmin at :20), but it silently redefines what 'the corpus' means on the operator console — and scripts/diag-admin-stats.ts:33-37 asserts invariants (source buckets sum, `tech <= upcoming`, non-empty breakdowns) that would start describing a mixed population of shared and private rows. addedToday in particular becomes a mix of scrape output and user submissions with no way to tell them apart, which is exactly the signal the dashboard exists to give.

**Action** Decide whether admin stats mean 'the shared corpus' (filter to public) or 'everything stored' (keep unfiltered but report the split as a separate figure, e.g. userSubmitted / pendingReview). Mirror whichever you choose in scripts/diag-admin-stats.ts so the dashboard and the CLI keep telling one story.

### [IMPORTANT] `scripts/retag-events.ts`:99

**What** Selects on a time window with no ownership clause (filter built :64-92) and `updateOne`s categories and isTechEvent at :135. Same pattern in scripts/retag-category.ts:64 and :107, scripts/backfill-companies.ts:29 and :58, scripts/backfill-connection-score.ts:29 and :57, and scripts/diag-overtagged.ts:24 with :43/:61 under --fix.

**Consequence** These scripts REPLACE the categories a user chose by hand in the add-event form (app/add-event/page.tsx:246-275) with LLM or keyword output, and rewrite their companies and connectionScore. For a scraped event that is correct — those fields are derived and recomputable. For a user's own event the categories are user INPUT, and CLAUDE.md's rule for spotlightAt ('editorial, not derived — nothing may recompute or clear it') applies with equal force. The user sees their event silently re-labelled by a job they never ran.

**Action** Exclude owned events from the selection in each script, or add an explicit `--include-user-events` opt-in that says what it will overwrite. Same treatment for scripts/migrate-categories.ts:33/71.

### [IMPORTANT] `lib/models/Event.ts`:244

**What** Every index leads with startDateTime, isTechEvent, source, createdAt, lastSeenAt, companies or spotlightAt (:244-269). None mentions visibility or an owner. The hot path is :252, `{ isTechEvent: 1, connectionScore: -1, startDateTime: 1 }`, which backs the default feed sort.

**Consequence** A visibility `$or` added inside `$and` cannot be served by any existing index, so the default feed query degrades to a filter-after-fetch on every request over ~1500 documents and growing. The facets route runs six aggregations over the same predicate, so the cost multiplies there.

**Action** Add `visibility` and `createdByUserId` to the schema, fold visibility into the two feed indexes (:248 and :252), and add `{ createdByUserId: 1, startDateTime: 1 }` for a 'my events' view. If any index over createdByUserId is ever made unique, use `partialFilterExpression`, NEVER `sparse` — on a compound key sparse only skips a document when every field is missing, and userId-style fields are always present, which is the bug that capped every user at one folder (CLAUDE.md §9).

### [MINOR] `app/api/events/route.ts`:131

**What** The 409 branch returns the full colliding document in the response body (`{ error: 'Event already exists', event: existing }`).

**Consequence** On a user-scoped create path this hands back an event the caller may have no right to see — including another user's private event that happens to share the dedupHash. It is also the existence oracle described in the dedupHash finding, with the contents attached.

**Action** Return the conflict without the document, or return only the id when the caller owns it.

### [MINOR] `app/api/folders/route.ts`:72

**What** `Event.findById(body.eventId).select('title startDateTime venue area')` with no visibility check, then copies title/date/venue into the Folder (:73-76). Same at app/api/folders/[id]/route.ts:70.

**Consequence** A user can link a folder to another user's private event and read its title, start time and venue back through the denormalised copy — and because the copy is denormalised on purpose (the folder must survive pruneStale), the leaked values persist in the attacker's own document after any access-control fix.

**Action** Add the same ownership/visibility check used in the tracker fix before assigning doc.eventId, and silently skip the link rather than 403ing — the route already treats a missing event as 'just do not link' (:69).

### [MINOR] `lib/helpers/phase6.ts`:437

**What** `Event.countDocuments()` (:437), `Event.countDocuments({ createdAt: { $gte: thisMonth } })` (:438) and `Event.countDocuments({ isTargetCompany: true })` (:451) are unscoped inside getStats(userId), whose every other query is correctly filtered by userId.

**Consequence** The per-user dashboard's totalEvents, eventsThisMonth and targetCompanyEvents count other users' private events. Numeric disclosure only, but the dashboard presents these as facts about the corpus the user can browse, and they will not match what the feed returns.

**Action** Apply the visibility clause with the same userId the function already takes.

### [MINOR] `proxy.ts`:22

**What** PROTECTED already contains '/add-event' (:25), so today's form is behind sign-in. The matcher at :54 excludes `api`, so nothing here protects any events endpoint — every guard must live in the handler.

**Consequence** Nothing is broken today, but the prefix-matching trap documented at :12-21 makes the naming of any new page load-bearing. A 'my events' page at `/events/mine` would NOT be protected (only `/events/...` public pages exist and `/events` is deliberately absent from PROTECTED), and adding `/events` to PROTECTED would redirect the public event detail page to /login for every signed-out visitor.

**Action** Put any owner-facing page at a distinct top-level segment (e.g. `/my-events`) and add that exact prefix to PROTECTED. Do not add `/events`. Re-read the `/c/` and `/f/` note at :12-21 before choosing the segment, and re-run scripts/diag-api-auth.ts, which asserts a 307 to /login for every protected page.

### [MINOR] `app/layout.tsx`:28

**What** There is no sitemap or robots route in the repo — `app/sitemap.ts`, `app/sitemap.xml`, `app/robots.ts` do not exist, layout metadata (:28) is static, and the only generateMetadata functions are app/c/[token]/page.tsx:48 and app/f/[token]/page.tsx:39, both of which read Folder/card data rather than Events.

**Consequence** Nothing leaks today. But a sitemap is the natural next addition for a public event feed, and it is the one surface where a forgotten visibility clause publishes private event titles to search engines permanently — a leak that outlives the fix.

**Action** When the visibility predicate is written, export it as a single named helper from lib/events/query.ts (not an inline object literal in two routes), so any future sitemap, RSS or OG-image author reaches for the same thing. State in the helper's docblock that it must be applied to every Event read that is not owner-scoped.

### [MINOR] `scripts/diag-scorecard.ts`:92

**What** Roughly 30 read-only diagnostics query Events with no ownership predicate and will start measuring a mixed population: diag-scorecard.ts:92, diag-events.ts:25-99, diag-tech-fp.ts:32, diag-offcity.ts:113-122, diag-tech-consistency.ts:44-55, diag-flagship-events.ts:60, diag-tagquality.ts:11-22, diag-tag-supply.ts:37-77, diag-legacy-docs.ts:34-69, diag-clusterkey.ts:24, diag-company-leak.ts:38, diag-recent-writes.ts:30-32, diag-coaching-leak.ts:54, diag-gamingxr-leak.ts:42, diag-city-spelling-dupes.ts:65, diag-hardware-corpus-delta.ts:59, diag-district-precision.ts:28-43, diag-organizers.ts:38-58, diag-search.ts:17-58, diag-dupe.ts:13-23, diag-seed-dupes.ts:33-78, diag-attended-coverage.ts:40-70, diag-venue-attribution.ts:28, diag-tech-recall.ts:54-61, diag-tech-precision.ts:65, diag-hardware-gap.ts:46-54, diag-meetup-geo-leak.ts:70, cleanup-dryrun.ts:38-102. Two of these WRITE: diag-overtagged.ts:43/:61 under --fix, and diag-clusterkey-selfheal.ts:20-55, which picks an arbitrary `findOne({})` victim, strips its clusterKey and re-saves it.

**Consequence** Tech-precision, off-city and duplicate-cluster figures start including events no scraper produced, so a user's mis-categorised private event reads as a classifier regression. diag-scorecard.ts is the one that matters most because it EXITS NON-ZERO on a capability shortfall — it would begin failing CI on user content. diag-clusterkey-selfheal.ts could pick a user's event as its mutation victim.

**Action** Exclude owned events from the selection in each, so every figure keeps describing the shared corpus. Prioritise diag-scorecard.ts (exits non-zero), diag-overtagged.ts --fix and diag-clusterkey-selfheal.ts (both write), then diag-offcity.ts and diag-tech-fp.ts (both feed cleanup decisions).

