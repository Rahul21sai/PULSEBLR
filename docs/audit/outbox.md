# Audit: outbox

## Summary

The `417138c` fix landed and works: `classifyStatus`/`ITEM_REFUSALS` split transient from permanent, `blocked` is re-evaluated per drain rather than latched, `markFolderFailed` exists, `attempted` counts both stores, `applyFolderMap` converts `folderClientId` to a durable `folderId`, and /folders shows two banners plus a named blocked list with Discard. Seventeen ways a capture still gets stuck (or lost) survive it.\n\nThe reported symptom — \"1 capture not synced yet\", Sync now does nothing — has three live causes, in order of likelihood. (1) Neither outbox fetch has a timeout while `draining` is a bare module boolean cleared only in `finally`, so one hung request on hall Wi-Fi wedges the queue for the life of the page: every later drain, forced or not, returns at `outbox.ts:486` and the UI reports \"Could not reach the server\" without attempting anything. (2) `navigator.onLine === false` is checked *before* `options.force`, so an explicit Sync now is discarded on a flag that is wrong behind captive portals and VPNs. (3) `DrainResult.synced` counts contacts only — the folder loop at `outbox.ts:559` never increments it — so a folder-only queue uploads successfully, `folders/page.tsx:100` skips `load()`, and the folder never appears; /scan reports \"Still offline\" right after the upload succeeded.\n\nWorse than stuck: `saveContact` treats any 2xx as saved without checking that the body was the API's JSON, so a captive-portal 200/HTML returns `outcome: 'saved'` and the person is written nowhere — the queue's core guarantee broken by the one network condition it was built for. And `queueContact` can reject (Safari private mode, quota); the throw escapes `saveContact` from inside its own catch block, no call site handles it, so the Save button sticks on \"Saving…\" and the capture is lost with no message.\n\nEvery `ok:false` from `POST /api/contacts/sync`, classified: **folders** — `missing-client-id` (permanent, echoed as the literal `'(missing)'`, so it matches no IndexedDB key and nothing gets marked); `missing-name` (permanent, no UI can supply one); `fromThrown` ValidationError/CastError (permanent, no `refusal` code, unactionable prose); `fromThrown` other, e.g. E11000 or a dropped Atlas connection (transient, self-heals via the next drain's `findOne({slug})` adopt). **Contacts** — `missing-client-id` (permanent, same unmatchable echo); `missing-name` (permanent, and its copy \"Add one and it will upload\" promises an action no screen offers); `no-folder` inherited from a folder that failed permanently in the same batch (permanent, correct); \"Waiting for its folder to upload first\" (transient, correctly clears `blocked`); `no-folder` with no folder id at all (permanent, unreachable today since every capture site passes a real `folderId`); `folder-not-found` (permanent — the realistic one, a folder deleted after the scan, and Discard is the only thing offered even though `PATCH /api/contacts/[id]` already supports moving); `fromThrown` permanent/transient as above. **Batch level** — 413 (permanent, and because `drain()` never chunks it stamps all 500 good records `blocked`, after which the auto-drain refuses to try them and Discard is the only affordance); 401 (auth, nothing marked — correct, but discarded silently by `startAutoDrain`, so the queue retries forever on every focus change while the banner keeps promising \"they will upload on their own\" and no sign-in link is ever shown); 5xx (transient); a 200 that is not the API's JSON (falls into the catch-all and is reported as offline).\n\nTwo structural gaps behind those. `folderClientId` is set by nothing in the app (only `types.ts` and `diag-contact-flow.ts` mention it), and /scan requires a folder id from a server list it cannot fetch offline, so the offline-folder-then-scan-into-it flow — the one `applyFolderMap` and the folders-first ordering exist for — is unreachable through the product; a queued folder is invisible on /folders, counted only as an unsynced \"capture\". And the outbox carries no user identity, so after switching Google accounts the previous account's captures drain as the new one, come back `folder-not-found`, and are displayed by name to the wrong user — the same class of leak as the sw.js v2 cache bug, in the store the v3 sweep deliberately cannot touch.

## Findings

### [BLOCKER] `lib/scan/outbox.ts`:219

**What** `saveContact()` treats ANY 2xx as "on the server" — `if (response.ok) { const data = await response.json().catch(() => ({})); return { outcome: 'saved', contact: data.contact }; }`. It never checks that the body was JSON or that it contained a contact. A captive-portal Wi-Fi (the standard conference-hall condition this whole queue exists for) answers every request with 200 and an HTML login interstitial. `response.ok` is true, `.json()` throws, `.catch(() => ({}))` swallows it, `data.contact` is undefined, and the function returns 'saved'.

**Consequence** The person is neither on the server nor in IndexedDB. `/scan` prints "Saved <name>", the recent-captures chip shows a green tick, and the record is gone — the one outcome outbox.ts's header promises is impossible. It is worse than being stuck, because nothing anywhere counts it. `app/folders/page.tsx:366` (NewFolderSheet) has the identical shape for folder creation: a 200 HTML portal response passes `!res.ok`, calls `onCreated()`, and the folder is never created and never queued.

**Action** On a 2xx, require evidence that the API answered: parse without a swallowing catch and require `data.contact` (or `created`) to be present. Anything else is not a success — classify it as transient, `queueContact(record)`, and return 'queued'. Same guard in NewFolderSheet: require the created folder in the body before treating the POST as done.

### [BLOCKER] `lib/scan/outbox.ts`:486

**What** The module-level `draining` latch is guarded only by `finally`, and neither outbox fetch has a timeout (`AbortSignal.timeout` appears in lib/scrapers/core/http.ts, lib/security/safe-fetch.ts and lib/llm/tagger.ts, but nowhere in lib/scan/outbox.ts). A saturated hall network that accepts the connection and never responds leaves `await fetch('/api/contacts/sync')` pending indefinitely, so `finally` never runs and `draining` stays `true` for the life of the page.

**Consequence** This is the reported bug exactly. Every subsequent drain — including `drain({ force: true })` from "Sync now" — returns `NOTHING` at line 486 before doing anything. On /folders the note falls through to "Could not reach the server. Everything is still saved on this device."; on /scan it prints "Nothing to upload" while the chip above it says N waiting. The queue is wedged until a page reload, and no record is ever marked, so the waiting banner keeps promising the upload.

**Action** Put `signal: AbortSignal.timeout(20000)` on the sync POST and on `saveContact`'s POST. Make the latch recoverable rather than boolean: store `drainStartedAt` and let a new drain proceed if the previous one has been in flight beyond the timeout. Have `drain()` distinguish "a drain is already running" from "queue empty" and "offline" in `DrainResult` (three separate reasons, not one `skipped: true`), so no caller can report a concurrency skip as a network failure.

### [BLOCKER] `lib/scan/outbox.ts`:215

**What** `queueContact()` can reject — `tx()` rejects when `openDb()` fails or a write fails (iOS Safari private browsing, storage-quota pressure, a blocked upgrade). In `saveContact` every `await queueContact(record)` sits on a path with no handler: the one at line 215 is inside the `catch` block itself, so a throw there escapes `saveContact` entirely. No caller wraps it — `app/scan/page.tsx:196`, `app/c/[token]/SaveToFolder.tsx:66` and `app/folders/[id]/page.tsx:717` all `await saveContact(...)` bare.

**Consequence** Unhandled rejection. `setSaving(false)` on the line after never runs, so the Save button stays disabled reading "Saving…" forever, the sheet does not close, no toast appears, and the capture exists nowhere — server, queue, or screen. The user is standing in front of the person with a frozen button and no way to know the scan was lost.

**Action** Wrap the queue write: `try { await queueContact(record) } catch { return { outcome: 'lost', reason: 'This device would not store the capture — write the details down.' } }`, add that outcome to `SaveOutcome`, and have all three capture sites render it as an error that keeps the sheet open with the typed fields intact. Independently, wrap each `await saveContact(...)` call site in try/finally so `setSaving(false)` cannot be skipped.

### [BLOCKER] `lib/scan/outbox.ts`:524

**What** `drain()` posts the ENTIRE queue in one request and the route refuses >500 items with 413 (`app/api/contacts/sync/route.ts:107`). `classifyStatus(413)` is 'permanent', so the `!response.ok` branch marks every contact AND every folder in the batch `blocked: true` with "There are too many queued captures to upload in one go." There is no chunking anywhere. The same 413 arrives well below 500 items on Vercel, whose 4.5 MB request-body limit is reachable at ~500 records because `rawPayload` alone is capped at 4000 chars each.

**Consequence** One oversized batch permanently blocks 500 good captures. `queued.every(r => r.blocked)` is then true, so the auto-drain stops attempting them entirely; the only affordance the UI offers for a blocked row is Discard, rendered as 500 individual Cards. A retry via "Try again" re-sends the same oversized batch and gets the same 413 forever. The failure is entirely self-inflicted — every record is individually acceptable.

**Action** Chunk in `drain()`: send at most MAX_ITEMS/2 records per request (folders always in the first chunk so `folderMap` precedes its contacts), and loop until the queue is empty or a chunk fails. A 413 should then be structurally unreachable; if one still arrives, halve the chunk and retry rather than condemning records. Do not mark a batch-level 413 permanent on the individual records — the record is not what is wrong.

### [IMPORTANT] `lib/scan/outbox.ts`:559

**What** `DrainResult.synced` counts contacts only. The folder loop does `await removeFolder(item.clientId); continue;` with no `synced++` (compare line 572 in the contacts loop), while `attempted` counts both stores — so `synced + failed !== attempted` and the accounting the `attempted` docblock claims to have fixed is still broken on the other axis.

**Consequence** A queue holding one folder and no contacts (create a folder offline, come online, press Sync now) uploads the folder successfully and reports `synced: 0`. `app/folders/page.tsx:100` then skips `await load()`, so the folder never appears in the grid; the note reads "Everything is uploaded" over an unchanged empty page. On /scan the same drain prints "Still offline" (`app/scan/page.tsx:241`) immediately after a successful upload. Both read as "Sync now did nothing".

**Action** Increment `synced` for a confirmed folder too, or add a separate `foldersSynced` and have both callers reload on `synced + foldersSynced > 0`. Also make `/folders`'s `subscribe()` handler call `load()` alongside `refreshQueue()` — `app/folders/[id]/page.tsx:110` already does this, so the folder list is the one screen that ignores its own queue notifications.

### [IMPORTANT] `lib/scan/outbox.ts`:487

**What** `if (typeof navigator !== 'undefined' && navigator.onLine === false) return NOTHING;` runs BEFORE the `options.force` check, so an explicit "Sync now" is discarded on the browser's word alone. `navigator.onLine` is false for a captive portal, a VPN transition, and several documented Windows/Android states where HTTP works fine.

**Consequence** Sync now does literally nothing and returns `skipped: true` with no status — /folders reports "Could not reach the server" without having attempted one, /scan reports "Nothing to upload". No record is judged, so the waiting banner keeps promising an upload that no code path will attempt until the OS flips the flag.

**Action** Move the `onLine` check below `if (options.force)` — a person pressing a button outranks a heuristic. Return a distinct reason ('offline') in `DrainResult` for the automatic path so the two callers can say "waiting for a network" rather than "could not reach the server".

### [IMPORTANT] `lib/scan/outbox.ts`:541

**What** A 401 sets `authExpired` and marks nothing — no `attempts`, no `lastError`, no `blocked` (correct: the records are fine). But `startAutoDrain()`'s `run` is `void drain()`, so `authExpired` is discarded on every automatic drain, and the only place it surfaces is a transient `syncNote` on /folders and a toast on /scan, both of which require the user to press the button first.

**Consequence** A session that lapses mid-event (a conference day outlasts a token) puts the queue into a silent infinite retry: one POST on every `visibilitychange` and every `online` event, forever, all 401. The waiting banner keeps saying "They are saved on this device and will upload on their own", which is false until a sign-in that the UI never asks for. The blocked list is empty, so nothing names the problem.

**Action** Persist the auth state where the banner can read it (a module-level `authExpiredAt` exposed through `subscribe`, or an `authBlocked` flag on the records that a non-401 drain clears). Render the waiting banner in an auth variant — "Sign in again and N captures will upload" — with a real link to /login. Have the auto-drain back off after an authExpired result rather than firing on every focus change.

### [IMPORTANT] `app/folders/page.tsx`:203

**What** The only action offered on a blocked row is Discard. There is no retry-one, no edit, and no reassign-folder — even though `PATCH /api/contacts/[id]` already validates a destination folder and `POST /api/contacts/sync` would accept any owned folder id. `blockedCaptures()` also carries no folder name, only `label` and `reason`. The escape hatch that does exist is broken: a pending row's `_id` is `pending:<clientId>` (`app/folders/[id]/page.tsx:73`), and `saveContact()` at line 141 PATCHes `/api/contacts/pending:<clientId>`, which cannot resolve; the rollback then does `setContacts(previous)` on an array that never contained the pending row, so the edit is a silent no-op behind "Could not save that change."

**Consequence** The most likely real refusal — `folder-not-found`, i.e. the folder was deleted after the scan — leaves the user with one button that destroys a real person's contact details. The `missing-name` refusal is worse: its copy is "This capture has no name yet. Add one and it will upload", and there is no UI anywhere that can add one.

**Action** Add "Move to another folder" (a folder picker that rewrites `folderId` in IndexedDB and clears `blocked`) and "Retry" per row on the blocked list; that turns `folder-not-found` and `no-folder` into recoverable states. Make the pending-row edit sheet write back to IndexedDB via a new `updateQueuedContact(clientId, draft)` instead of PATCHing a `pending:` id — that also makes the `missing-name` copy true. Show the folder name on each blocked row.

### [IMPORTANT] `app/folders/[id]/page.tsx`:106

**What** The folder detail page never calls `startAutoDrain()` — only `app/folders/page.tsx:75` and `app/scan/page.tsx:105` do — and it has no Sync button. It subscribes to the outbox and renders `local`/`stuck` chips, so it displays the queue without ever draining it.

**Consequence** /folders/[id] is the screen the user lands on after "Save & close" and the one they read between people. Captures sit there showing a grey `local` chip indefinitely while signal is available; nothing uploads until the user navigates to /folders or /scan. Combined with the wedged-latch bug it reads as a scanner that quietly stopped working.

**Action** Call `startAutoDrain()` here too (it is idempotent enough — the `draining` latch is shared), and surface the same waiting/blocked banner pair with a Sync button, so every screen that shows queued rows can also move them.

### [IMPORTANT] `lib/scan/outbox.ts`:565

**What** Records are removed and marked by the clientId the SERVER echoes, and an echo that matches nothing is silently ignored: `const record = contacts.find(c => c.clientId === item.clientId); if (record) await markContactFailed(...)`. The route echoes `clientId.trim()` (`app/api/contacts/sync/route.ts:187`) and substitutes the literal `'(missing)'` when the id is blank (lines 131, 189), which by construction matches no IndexedDB key — and collides across items when two records are affected.

**Consequence** `failed++` and `blocked++` are counted for a record that gets no `blocked` flag, no `attempts`, no `lastError`. It stays in the `waiting` bucket, is re-sent on every drain forever, and appears in no blocked list — so `DrainResult.blocked` and `pendingSummary().blocked` disagree and the row is invisible in exactly the way the fix commit set out to eliminate. The same silent path opens for any echo mismatch (whitespace-trimmed ids).

**Action** Never key results on the echoed id: send an array index or correlate on the id the client sent. Treat an unmatched result as a defect — log it and mark the record `blocked` with a generic reason rather than dropping the verdict. Refuse to queue a record whose `clientId` is not a non-empty trimmed string, so `'(missing)'` cannot arise.

### [IMPORTANT] `lib/scan/outbox.ts`:420

**What** Nothing in the app ever sets `folderClientId` — the only occurrences outside outbox.ts/the sync route are `lib/contacts/types.ts:88` and `scripts/diag-contact-flow.ts:208`. `/scan` derives `folderId` from `GET /api/folders` (line 86), which fails offline, leaving `folders: []`, `folderId: null` and the "Pick a folder first" screen; a folder queued by `NewFolderSheet` is never offered in the picker. `/folders` renders only server folders, so a queued folder is invisible there too — it appears solely as an increment in the "N captures not synced yet" count.

**Consequence** The offline flow the queue was designed around — make the folder on the way to the venue, scan people into it — cannot be performed. `applyFolderMap()` and the whole `folderClientId` branch in the sync route are correct code that is unreachable through the product, which is the same trap CLAUDE.md §9 records for `Folder.eventId`. Meanwhile the user who creates a folder offline sees a warning about an unsynced "capture" and no folder anywhere.

**Action** Render queued folders as rows on /folders (a `local`/`stuck` chip, same as the contact table does) and include them in /scan's folder picker, with `saveContact` writing `folderClientId` instead of `folderId` when the chosen folder has no server id. That makes `applyFolderMap` reachable and the offline path real. Until then, label the banner by kind rather than calling a folder a "capture".

### [IMPORTANT] `lib/scan/outbox.ts`:103

**What** The outbox database is per-origin and carries no user identity: `DB_NAME = 'pulseblr-outbox'`, no `userId` on `QueuedContactRecord`, and sign-out (`app/settings/page.tsx:30`) purges Cache Storage only — deliberately, so captures are not lost. `drain()` posts whatever it finds under whoever is signed in now.

**Consequence** Sign out, sign in with a second Google account (the exact scenario sw.js v3 was bumped for), and account A's queued captures are posted as account B. `findOwnedFolder(B, folderIdOfA)` returns null, so each is refused `folder-not-found` and marked permanently blocked — and the blocked list on /folders then displays account A's captured people by name to account B, with Discard as the only option. A's captures are also now unrecoverable by A, since the reason is latched against a folder id B will never own.

**Action** Stamp every queued record with the `session.user.id` that captured it, drain only records matching the current session, and show the rest as "captured by another account — sign back in to upload". This is the outbox analogue of the v3 network-only rule and should be verified the same way (sign out, sign in as a different account, confirm the first account's rows are neither uploaded nor displayed).

### [IMPORTANT] `app/folders/page.tsx`:366

**What** `NewFolderSheet.submit()` still has the pre-fix shape that `lib/scan/failure.ts` documents as the bug: `if (res.status === 409) {…} if (!res.ok) throw new Error(...)` and then `catch { await queueFolder(...) }`. It never calls `classifyStatus`, and `queueFolder()` — unlike `queueContact()` — takes no `blockedReason` parameter at all, so a folder can only ever be queued as "waiting".

**Consequence** A 400, 403, 404 or any other refusal from `POST /api/folders` is queued as if the network ate it, under the banner promising it will upload on its own. It then has to be rediscovered by a drain before the user learns anything, and if the refusal is not one the sync route reproduces, the row waits indefinitely.

**Action** Route folder creation through the same three-outcome shape as `saveContact` — a `saveFolder()` in outbox.ts that classifies the status, gives `queueFolder` a `blockedReason` parameter, and returns 'saved' | 'queued' | 'auth' | 'blocked' — so the sheet can keep itself open with the reason instead of closing on a refusal.

### [MINOR] `app/api/contacts/sync/route.ts`:83

**What** `fromThrown()` returns no `refusal` code, only prose: permanent → "The server could not accept this record as it stands.", transient → "The server could not be reached for this record." The permanent branch fires for any Mongoose ValidationError or CastError (`isSchemaRejection`, lib/tracker/validate.ts:217).

**Consequence** A record blocked this way gets a reason that names nothing actionable, and the client has no code to branch on — so the blocked list can only offer Discard even where the defect is a single fixable field. It is also the one permanent path the client cannot render specific copy for, which is the drift `ITEM_REFUSALS` exists to prevent.

**Action** Extend `ITEM_REFUSALS` with a code for a shape rejection (and, if the field is knowable from `error.errors`, name the field without echoing Mongoose's wording), so the blocked row can say what to change. Keep the message body server-side as it is now.

### [MINOR] `lib/scan/outbox.ts`:270

**What** `pendingCount()` is exported and called from nowhere — `pendingSummary()` replaced it at every site. It sums folders and contacts into a single number, the exact conflation the `PendingSummary` docblock says made the bug unreadable.

**Consequence** A dead export that models the discredited shape is the one a future capture surface will import, reintroducing the single misleading count.

**Action** Delete it, or mark it `@deprecated` pointing at `pendingSummary()`.

### [MINOR] `app/api/contacts/route.ts`:115

**What** The 500 branch still returns `details: err.message ?? String(error)` — the leak pattern CLAUDE.md §6 lists this route as an outstanding instance of. `POST /api/contacts` is on the capture hot path, so the string reaches the phone.

**Consequence** A Mongoose error hands back the model name and schema path to any signed-in caller. `saveContact` ignores `details` (it reads `error`/`refusal`), so nothing benefits from it; a 500 is classified transient regardless.

**Action** Drop `details` and keep the `console.error` above it, matching the fix already applied to the tracker write paths and to `app/api/contacts/sync/route.ts:263`.

### [MINOR] `lib/scan/outbox.ts`:546

**What** `const result = await response.json()` on the 200 path is unguarded, and `result.folders ?? []` / `result.contacts ?? []` silently accept a body that omits them.

**Consequence** A 200 that is not the API's JSON (portal interstitial, proxy) throws into the catch-all at line 602, which returns `{ attempted: 0, failed: 0, skipped: false }` — indistinguishable from "the request never left" — and reports "Could not reach the server" for a server that answered. A 200 with a valid-JSON but empty body silently removes nothing and marks nothing while reporting `attempted: N, synced: 0, failed: 0`.

**Action** Parse with a catch and treat an unparseable or arrays-missing 200 as its own transient outcome with a distinct reason, so "the server answered with something we do not understand" is never reported as "offline".

