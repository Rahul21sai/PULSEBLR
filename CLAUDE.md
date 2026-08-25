# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

> **Next.js version warning (from AGENTS.md, repeated because it governs almost every change here):** This repo pins Next.js `16.3.2` (exactly, no caret), which has breaking changes from older releases. Before writing any Next.js code, read the relevant guide in `node_modules/next/dist/docs/` and heed deprecation notices. Notably, route protection lives in **`proxy.ts`** at the repo root (this version's middleware equivalent) — there is no `middleware.ts`, and route-handler `params` is a `Promise` you must `await`.

> **Why it moved off 16.2.9 (2026-08-23):** `npm audit` reported 9 vulnerabilities, and two mattered
> here — a **critical `next-auth` fail-open on existence-based auth checks** (which is exactly what
> `requireUser()` is), and a **high `next` Middleware/Proxy bypass in App Router**, which is
> `proxy.ts`, this app's route protection. `next@16.2.12` cleared all nine of Next's own advisories;
> `16.3.2` additionally cleared the transitive `postcss` and `sharp` ones. `next-auth@5.0.0-beta.32`
> pins the patched `@auth/core@0.41.3`. Peer requirements are byte-identical between 16.2.12 and
> 16.3.2 (same React range), `proxy.ts` and the awaited-`params` convention are unchanged in the
> bundled docs, and the full suite passes. **`npm audit` is now 0 vulnerabilities.** Versions are
> pinned exactly on purpose — `npm install` rewrites them to carets, which would let a future
> install drift off the pin this warning exists to protect.

## Commands

```bash
npm run dev          # start dev server (http://localhost:3000)
npm run build        # production build
npm run start        # serve the production build
npm run lint         # eslint (flat config: eslint.config.mjs)
npm test             # vitest, pure functions only (tests/); npm run test:watch to iterate
npm run scrape       # full pipeline → MongoDB (~5-10 min, ~700 upstream requests)
npm run send-digest  # generate + email the daily digest via Resend
```

`npm run scrape` flags: `--no-llm` (keyword tagging only, fast), `--fast` (skip Eventbrite + the company-page sweep), `--no-prune`, `--only=district,hasgeek` (run just those source ids).

> **`--only` forces pruning off, and that is load-bearing.** `pruneStale()` deletes any past
> event no source has reported for a week. The sources that did not run cannot report theirs,
> so a partial run must never reach the pruner. The 7-day grace would usually absorb it;
> "usually" is not a guarantee to build a delete on. Source ids: `luma-city`, `luma-calendars`,
> `meetup-city`, `meetup-groups`, `bevy`, `devfolio`, `unstop`, `allevents`, `devevents`,
> `hasgeek`, `fossunited`, `district`, `eventbrite`, `company-pages`.

Verification is **two-tier**, and the tiers have a deliberate boundary.

`npm test` runs **vitest** (`vitest.config.mts`, suites in `tests/`), scoped by that
config's own docblock to **pure functions only** — scoring, dedup and identity keys, the
taxonomy, the search filter, the SSRF guard, QR payload parsing, CSV escaping, request-body
validation for the tracker write path, and the two city gates (`geo.test.ts` characterises
`isBengaluru`/`resolveArea`; `off-city.test.ts` pins `offCityReason`). Nothing there touches
MongoDB or the network.

> **`tests/off-city.test.ts` is mostly NEGATIVE cases, and that is the point.** A false
> positive in the off-city gate does not mis-tag an event, it deletes it before storage, and
> no re-scrape recovers it because merging only ever fills gaps. So the suite pins the things
> that must **survive**: `city: 'BENGALURU'`, `city: 'Karnataka'`, the suburb `Hebbagodi`, an
> empty `{}`, Delhivery against `\bdelhi\b`, Goan against `\bgoa\b`, Mysore **Road**, an
> RCB-vs-CSK screening, and a Bengaluru meetup whose description names five other cities. It
> also pins the `RawEvent` → gate seam, where every field is optional and a rename would
> silently stop matching rather than fail.

> **`tests/scan-decode-e2e.test.ts` is the exception worth knowing about.** It encodes real QR
> PNGs with `qrcode`, decodes them through the production `zxing-wasm` engine, and runs the result
> through `parseScanPayload` — so it proves the whole chain rather than just the parser's string
> handling. It still needs no database, server or network (the `.wasm` loads from the installed
> package), which is why it belongs here. It is also the regression guard for the scanner
> dependency: if a `zxing-wasm` build ever ships a `.wasm` that cannot load, this fails loudly
> instead of the scanner silently finding nothing on a phone at an event.

Everything with a database or a server behind it is covered by the read-only
`scripts/diag-*.ts` family (below), which is how most claims in this document were
verified. Duplicating those as unit tests would only produce slow, flaky copies.

> This paragraph previously said "there is **no test runner** configured — no `test`
> script and no test files exist". That was stale and actively misleading: it caused a
> pure-function parser to be planned as a diag script when it belonged in `tests/`. If
> you are about to assert what tooling exists, read `package.json` rather than this file.

> **RESTART `npm run dev` AFTER ADDING A FIELD TO AN EXISTING MODEL.** Every model uses the
> `mongoose.models.X || mongoose.model('X', schema)` guard, which is required for hot reload —
> but it also means a model registered BEFORE your schema change keeps its old schema for the
> life of the dev server. Mongoose then silently drops writes to the new path: no error, the
> in-memory document even shows the value, and only the database disagrees. This cost real time
> during the scan work — adding `User.card` looked like a persistence bug for twenty minutes,
> and a fresh `tsx` process proved the code was correct all along. A brand-new model
> (`Folder`, `Contact`) registers on first use and is unaffected; it is only fields added to
> models the running server has already touched.

### Diagnostics and maintenance (`scripts/`, run with `tsx`)

| Script | Purpose |
| --- | --- |
| `probe-sources.ts` | Probes ~38 candidate event endpoints, reports which return machine-readable data. Read-only. |
| `probe-round2.ts` / `probe-round3.ts` | Drill into viable sources: pagination, detail endpoints, auto-discovery. Read-only. |
| `test-adapters.ts` | Live smoke test of every adapter with field-coverage percentages. No DB writes. `--all` for the slow sources. |
| `diag-events.ts` | What the feed actually contains: counts by source/category/area, field coverage, duplicate clusters. |
| `diag-search.ts` | Text-index health and search-term hit counts. |
| `check-llm.ts` | Which LLM providers are configured, whether their credentials work, and end-to-end tagging latency. |
| `check-nvidia-models.ts` | Times candidate NVIDIA models so `NVIDIA_MODEL` is chosen from evidence. |
| `retag-events.ts` | Re-tag stored events with the LLM, **replacing** categories. `--ongoing`, `--all`, `--limit N`, `--dry`, **`--inconsistent`** (only documents whose two "tech" signals contradict each other — usually the right flag; see the warning under §3). |
| `migrate-events.ts` | Backfill documents written before `clusterKey` / `lastSeenAt` / `isTechEvent` existed. |
| `cleanup-implausible.ts` | Delete evergreen adverts and impossible date ranges. |
| `cleanup-non-bengaluru.ts` | Delete stored events that are not in Bengaluru. The stage-5c gate stops new ones arriving but filters the incoming batch only — it never queries the collection, so everything that got in before it existed stays in the feed forever. Selects on **the gate's own `offCityReason()`**, imported not mirrored, so it judges `city` / `venue` / `address` / **`title`** and **never the description** — deleting on "lessons from our Chennai rollout" would be the tagger's `\bpm\b` over-match with a DELETE attached. Online events **are** judged (see below); `--keep-online` restores the old exemption and names the rows it spares. Skips any event a user has **tracked** or built a **`Folder`** for, sparing outright rather than repointing. **Destructive** — dry by default, `--apply` to write. |
| `backfill-companies.ts` | Recompute `Event.companies` from the registry. Run after editing it. |
| `diag-organizers.ts` | Which hosts and known companies appear in the corpus. |
| `diag-overtagged.ts` | Documents with more categories than the tagger emits. `--fix` / `--trim`. |
| `probe-company-discovery.ts` / `probe-company-overlap.ts` | Prove whether a platform's company search is real or a generic fallback. |
| `probe-luma-handles.ts` | Verify which `luma.com/<handle>` calendars exist, to seed them. |
| `probe-bevy-tenants.ts` | Test candidate Bevy hosts for a real `/api/search/event`. Run before adding to `BEVY_HOSTS` — 36 candidates yielded only 5. Read-only. |
| `probe-event-microsites.ts` / `probe-microsites-round2.ts` | Why per-event company microsites (aws-experience.com and friends) cannot be scraped. Read-only. |
| `test-new-adapters.ts` | Smoke test for `devevents` and the expanded Bevy tenant list. No DB writes. |
| `test-tagging.ts` / `test-ica.ts` | Tagger and IBM ICA credential checks in isolation. |
| `migrate-categories.ts` | Map stored events from the retired 32-category taxonomy onto the current 22 via `CATEGORY_MIGRATION`. `--dry`. |
| `backfill-connection-score.ts` | Recompute `Event.connectionScore`. Run after editing the weights. |
| `cleanup-sources.ts` | Delete stale legacy `Source` rows that no adapter can ever scrape again. |
| `diag-clusterkey.ts` | Find documents missing `clusterKey` and show what the generator produces for them. Read-only. |
| `diag-clusterkey-selfheal.ts` | Assert that a document stripped of `clusterKey` repairs itself on save. |
| `diag-hook-order.ts` | Proves `pre('validate')` runs before required-field validation and `pre('save')` does not. Scratch collection only. |
| `diag-dupe.ts` / `diag-tagquality.ts` | Duplicate clusters, and how many events carry LLM vs keyword tags. |
| `diag-keyword-tagging.ts` | Asserts `keywordTagging()` still classifies. Exits non-zero on regression — see the `\b` warning below. |
| `diag-breaker-scope.ts` | Asserts the provider circuit breaker survives across `tagEvents()` calls and that a 401/403 retires a provider on the **first** rejection — for the SDK-based Anthropic tier as well as the two OpenAI-compatible ones. Points every provider at a local stub server; no credentials, no outbound network, no DB. Measured 5 doomed requests where the per-call breaker made 18. |
| `diag-seed-integrity.ts` | Duplicate company names, name/alias collisions, duplicate seed handles, over-confident `strength`. Run after editing the registry or a seed list. |
| `diag-api-auth.ts` | Hits every mutating endpoint signed-out and asserts 401/403/503, every public one and asserts 200, and every protected page and asserts a 307 to `/login`. Needs a dev server. Run after touching any route. |
| `diag-admin-stats.ts` | Asserts the invariants `/admin` relies on (source buckets sum, `tech <= upcoming`, non-empty breakdowns). Read-only. |
| `diag-ssrf-guard.ts` | Asserts the SSRF guard blocks metadata IPs, loopback, private ranges, v4-mapped IPv6, decimal-encoded IPs and non-http schemes. No network calls. |
| `diag-tracker-flow.ts` | Drives the whole tracker signed-in via the dev-only provider: create, kanban moves, record a person, follow-up complete, cross-user isolation, and **that bad input is a 400 which names the field and leaks no Mongoose wording** (invalid and lowercase `status` on both POST and PUT, a malformed `eventId`, a nameless connection, a non-JSON body, then a read-back proving no rejected write was a partial update). **Writes then deletes** its own rows. Needs a dev server with `DEV_LOGIN=true`. |
| `diag-contact-identity.ts` | Asserts the `Contact.contactKey` / `Folder.slug` derived-key hooks: that they run on `pre('validate')` (so a document that never supplied the key still validates), that the key upgrades when a LinkedIn slug arrives later, and that a legacy document self-heals. Read-only, **no DB and no server** — Mongoose runs document middleware in process. |
| `diag-contact-flow.ts` | Drives the whole scan feature signed-in: create a folder, reject a duplicate name, **replay a `clientId` and assert exactly one contact**, drain the offline outbox (including a folder that only existed offline, and one bad record that must not fail the batch), upgrade a `nm:` key to `li:`, export CSV and assert the formula escaping and `no-store`, mint and revoke a public intake token, and eight cross-user isolation refusals. 48 checks. **Writes then deletes** its own rows. Needs a dev server with `DEV_LOGIN=true`. |
| `migrate-connections-to-contacts.ts` | Move people out of `TrackerEntry.connections[]` into the `Contact` collection, one folder per event. Idempotent (deterministic `migrated:<entryId>:<index>` clientIds) and non-destructive — the legacy array is left in place, and `phase6.ts` reads both stores while suppressing the overlap. **Dry by default**, `--apply` to write. Verified end-to-end against a seeded legacy fixture, which is the only way to test it: a dry run over 0 rows never reaches the `.populate('eventId')` and so hid a `MissingSchemaError` for the unregistered `Event` model. |
| `backfill-contact-companies.ts` | Recompute `Contact.companies` / `isTargetCompany` using the same `deriveContactMeta()` the write path uses. Run after editing the registry, the resolver, or a user's target list. **Dry by default**, `--apply`. |
| `migrate-folder-clientid-index.ts` | Replace `folders.userId_1_clientId_1` with a **partial** unique index. Needed because the sparse compound version capped every user at ONE folder — see the warning under §9. Idempotent, reports the row counts it is unblocking. **Dry by default**, `--apply`. |
| `copy-wasm.js` | Copies the ZXing reader wasm into `public/wasm/`. Plain JS, run by `postinstall`. See §9 for why self-hosting is mandatory. |
| `diag-dev-login.ts` | Truth table proving the dev-only sign-in cannot activate in production. No network. |
| `probe-district.ts` / `-round2.ts` / `-round3.ts` | How District went from "dismissed" to the city-breadth source. Round 1 starts at robots.txt instead of guessing paths; round 2 follows the events sitemap; round 3 measures what fraction are REAL dated events versus always-on attractions, and whether the slug can pre-filter the fetch list. Read-only. |
| `test-district.ts` | Live smoke test: pins `districtSlugDate()` against the real slug forms, then asserts the scrape returns dated Bengaluru events with no evergreen listings. Exits non-zero on regression. No DB writes. |
| `diag-district-precision.ts` | Asserts District did not cost tech precision — prints every District row flagged `isTechEvent` so each is judged by eye, not by an aggregate. Read-only. |
| `probe-heapheaphurray.ts` / `-hhh-round2.ts` / `-round3.ts` / `-round4.ts` | Recon on `events.heapheaphurray.com`, a direct competitor ("Tech Events in India"). Kept because the rounds narrow rather than repeat: round 1 separates the PRODUCT question from the SOURCE question, round 2 gets the data and the IA, round 3 finds every event `url` points **off-site** to lu.ma / devfolio — both of which we already scrape, so it is a different *selection* over the same supply, not new supply — and round 4 reduces the whole site to the two Bengaluru events we lacked. Verdict: do NOT scrape it — its upstreams are Luma and Devfolio, which this app already scrapes directly, so it is a different SELECTION over supply we have rather than new supply. The long write-up is a local working note and is gitignored; everything load-bearing from it is in this file. Read-only. |
| `verify-hhh-calendar.ts` | The seed gate applied to the one candidate that audit produced: fetch the Luma calendar with the **production** mechanism and seed it only if it returns upcoming events. Read-only. |
| `probe-hardware-bodies.ts` / `-round2.ts` | Hardware via the PROFESSIONAL BODIES rather than the consumer platforms: IEEE vTools, IEEE Bangalore, IESA, SEMI, Hackster, IISc, IIIT-B. Round 2 follows the leads round 1 was too quick to dismiss (a `tribe_events` route answering 200 means the plugin is installed, not that events exist). Read-only. |
| `diag-hardware-vocabulary.ts` | Asserts the Hardware/Robotics floor recognises `vlsi`/`verilog`/`risc-v`/`asic` AND still refuses the ambiguous near-misses. **The negative half is the important half** — a widened regex fails by over-matching, which no aggregate count reveals. Exits non-zero on regression. |
| `diag-hardware-corpus-delta.ts` | Runs the OLD and NEW hardware patterns over the live corpus and names every newly-matched event, so over-matching is caught against real scraped copy rather than synthetic titles. Read-only. |
| `diag-tech-consistency.ts` | Do the app's TWO definitions of "tech" agree — `isTechEvent` (what `techOnly` filters on) versus membership of `TECH_CATEGORY_NAMES` (what the rail counts)? Reports both directions separately, because one is recall loss and the other precision risk. Read-only. |
| `diag-retag-preview.ts` | Would re-tagging FIX the mis-tagged events or just churn them? Re-tags a targeted sample plus controls and prints old → new, writing nothing. Run this before any bulk retag — the controls matter more than the broken ones. |
| `diag-gamingxr-leak.ts` | Leisure gaming leaking into the tech feed through `Gaming/XR`, the one tech category whose everyday sense is a leisure activity. Read-only. |
| `diag-coaching-leak.ts` | Training-institute course adverts in the tech feed, and what `connectionScore` gives them. Read-only. |
| `diag-flagship-events.ts` | Are the marquee Bengaluru tech events (IndiaFOSS, droidCon, GIDS, Open Source India …) actually IN the default feed? Checks **by name**, because a rising total does not prove the right things are present. Read-only. |
| `retag-category.ts` | Re-tag a SUBSET, replacing categories. By category name, for when a category has gone bad; or **`--match=<title regex>`** for when a category is being *missed* and the documents carry no marker to select on. `--dry`, `--all`. |
| `diag-scorecard.ts` | **The product scorecard as measurements, not estimates.** Each dimension is a criterion a query decides. Two rules keep it honest: CAPABILITY and SUPPLY are never averaged (hardware is externally capped, so mixing it with a code metric hides what you can act on), and no dimension scores itself on a proxy that cannot fail. Ratios with a denominator under 10 are printed but **not judged** — a supply cap must not be reported as a code defect. Exits non-zero only on a capability shortfall with enough evidence to call it one. |
| `diag-source-caps.ts` | Are the per-run caps silently dropping discovered sources? This is what found 80 of 200 Meetup groups being skipped on every run. Read-only. |
| `diag-offcity.ts` | Replays the real `offCityReason()` predicate over the stored corpus and **names every row on both sides** — the rejects and the spares — so the gate's false positives can be argued with rather than trusted. Run it after touching the gazetteer. Read-only. |
| `diag-meetup-geo-leak.ts` | Proves the Meetup adapter's city guard **cannot reject anything** (its `=== false` is unsatisfiable, because `isBengaluru`'s only text-driven `false` sits inside `if (location)` and ICS emits no LOCATION), and measures what got in: 23 of 886 upcoming events, 19 in-person, 9 in the default tech feed. Read-only. |
| `diag-city-spelling-dupes.ts` | Does cross-source dedup survive **Bangalore** vs **Bengaluru**? **Suspected bug, DISPROVED, and the mechanism is what closes it** — not the count. `normalizeTitleForMatch()` (`lib/scrapers/core/text.ts`) lists `bangalore`, `bengaluru`, `blr` and `india` in `NOISE_WORDS` and **deletes** them before building the key, so two titles differing only by the city word are structurally incapable of producing different keys. Measured 2026-08-24 for confirmation: identical keys (`founders running club\|2026-08-30`), 0 of 1237 upcoming events in a spelling-caused duplicate group. **One real edge:** line 71 falls back to the **un-stripped** title when noise-stripping empties it, so a title that is *only* a city plus noise words — `"Bangalore Meetup"` vs `"Bengaluru Meetup"`, the source's own example — does NOT collide. Re-run after touching the normalizer; a non-zero count is a normalizer regression, not a cleanup job. Read-only. |
| `diag-tag-supply.ts` | Could `Event.tags` back a topic-tag facet? **No, and that is the finding** — 32 of 1212 upcoming events carry any tag, only 8 of 334 tech ones do, and there are six distinct values in the whole corpus. A tag facet would have to be GENERATED by the tagger; the harvested supply is not there. Read-only. |
| `diag-cap-victims.ts` | Which specific named handles the old cap dropped, and which the new ordering rescues. Read-only, does not scrape. |
| `diag-tech-fp.ts` | Tech-feed false positives **with the organiser and description head**, plus how many land on the first 20 — because the default sort is soonest, so 2% of the corpus can be 10% of what a user sees. A count is not a ranking. Read-only. |
| `diag-deploy-readiness.ts` | Every production failure that is **invisible locally**, grouped by consequence and stating what BREAKS rather than naming a variable. Detects a dev environment and reports `DEV_LOGIN` / localhost `NEXTAUTH_URL` as "set this on the host" rather than as failures — they are correct locally. No network, no DB; safe in CI. |
| `diag-company-leak.ts` | Where an ambiguous company name came from on an event that is not that company's. Prints every field and says whether the attribution is justified, stale, or absent from the document entirely. Read-only. |
| `diag-recent-writes.ts` | What was written in the last N minutes, and whether it carries the keyword-tagging fingerprint (`tagConfidence` exactly 0.6). Reports; does not judge — the floor is often right. Read-only. |
| `probe-attended-sources.ts` / `probe-attended-round2.ts` / `probe-attended-round3.ts` | Probe the platforms named in the user's attendance history. Round 2/3 drill into the leads. Read-only. |
| `verify-attended-seeds.ts` | The gate before a seed is added: fetches each candidate with its production mechanism and keeps it only if it returns **upcoming** events. Read-only. |
| `probe-seed-candidates.ts` | FOSS United sitemap shape, Luma handle → calendar id, and Meetup name → slug resolution. Read-only. |
| `probe-india-platforms.ts` / `probe-india-ticketing.ts` | Survey of Indian event platforms (Konfhub, Townscript, District, 10times, HasGeek…). Read-only. |
| `diag-attended-coverage.ts` | Checks the user's own communities are present **by name** — a rising total does not prove a seed worked. |
| `diag-legacy-docs.ts` | Groups pre-migration damage by creation date. This is what identified the stale cron as the writer. |
| `diag-seed-dupes.ts` | Full dedup identity of a suspected duplicate pair, so "why didn't clustering catch this" is answerable. |
| `cleanup-duplicate-clusters.ts` | Collapse documents sharing a `clusterKey`; keeps the most complete, repoints `TrackerEntry` rows, gap-fills only. **Destructive** — dry by default, `--apply` to write. |
| `cleanup-past.ts` / `cleanup-seed.ts` / `cleanup-dryrun.ts` | Older one-off cleanups, kept for reference. |

> **OUTSTANDING as of 2026-08-24: `cleanup-non-bengaluru.ts --apply` has NOT been run.** The script
> is fixed and verified; the database is not cleaned. Its dry run reports **39 rows total, 29
> upcoming, 10 in the default tech feed**, and all of them are still stored — including
> `KONG API + AI Summit 2026` (`city: Los Angeles`, `connectionScore` 100), which
> `diag-offcity.ts` ranks **#2 in the entire tech feed**. Do not read "the off-city work landed" as
> "the feed is clean": the ingest gate stops new arrivals from the next scrape onward, and nothing
> has deleted the backlog. Run `diag-offcity.ts` first — it names all 29 rejects and all 6 spares —
> then `--apply`.
>
> Why it cannot be waited out: rejecting a re-sighting stops `lastSeenAt` refreshing, so each
> stored row is **frozen** — a later scrape can no longer correct or cancel it — and `pruneStale()`
> only removes it a week after its own start date. They drain **after** being shown.

> **WHY THE CLEANUP SELECTS ON `offCityReason()`, AND WHY IT JUDGES ONLINE EVENTS.** Both were
> defects, fixed 2026-08-24; this records the evidence, because both look like things a later
> "simplification" would undo.
>
> It used to condemn on `isBengaluru(...) === false`, which is a different question from the one
> stage 5c asks. `isBengaluru` reads `city` for a POSITIVE match only, then builds its `location`
> string from **venue + address alone** — `city` is not in it — and only `if (namesOther) return
> false` can condemn. So it can never reject on `city`: `Los Angeles`, `San Francisco`, `Chennai`
> and `Mysuru` all return `null`, which the cleanup correctly kept. `OTHER_STATE_HINTS` is
> other-**state** only on top of that, so `city: 'Mysuru'` matches no hint and no Bengaluru
> pattern. Measured against live Atlas, same corpus, same moment:
>
> | | all stored | upcoming | of those, tech |
> | --- | --- | --- | --- |
> | `isBengaluru(...) === false` — the old predicate | 21 | **14** | **3** |
> | `offCityReason(...)` — the gate's own | 39 | **29** | **10** |
>
> — 15 upcoming and 7 tech-flagged rows were invisible to it. Compare the **upcoming** figures: the
> old headline `will delete: 21` counted 7 already-past events, which makes the gap look half its
> real size. The switch only ever deletes MORE, never differently — the set of rows the old
> predicate condemned that `offCityReason` spares is **empty**, so it is a strict superset.
>
> Swapping the predicate alone was **not enough**, and this is the half that looks reckless without
> the evidence. The script skipped `format === 'online' || onlineLink` before any geo judgement, so
> four tech-flagged `Chennai - Build Your First AI Agent` rows survived — `format: 'online'`,
> `city`/`venue`/`address` all empty, Chennai in the TITLE only. The series is a natural controlled
> experiment: all **9** upcoming rows are online, geo-empty and `isTechEvent: true`, differing by
> one word of title.
>
> ```
> KEEP                    Bengaluru - Build Your First AI Agent…   ×4
> KEEP                    Build Your First AI Agent…               ×1   (unprefixed → unknown)
> REJECT Chennai (title)  Chennai - Build Your First AI Agent…      ×4
> ```
>
> So the title rule is **necessary** — nothing else distinguishes a Chennai edition from a Bengaluru
> one — and **safe**, because the Bengaluru-evidence veto spares all four siblings and the
> unprefixed row passes as unknown. "Attendable from anywhere" is right for a venue-less event with
> no city signal and wrong when the title names the city it is scoped to. `--keep-online` restores
> the exemption and **names** the rows it spares instead of silently skipping them.
>
> **Do not copy `cleanup-duplicate-clusters.ts`'s referrer handling in here.** That script
> *repoints* `TrackerEntry` and `Folder.eventId` because a surviving twin exists to repoint **to**;
> an off-city delete has no twin, so a dangling soft ref is the correct outcome and the cleanup
> **spares** the referenced row instead. It skips anything a user has tracked or built a `Folder`
> for — a folder means they scanned people there. Both guard paths are asserted with a
> write-then-delete fixture, because zero rows exercise them in production today.

`scrape.ts`, `send-digest.ts` and `seed.ts` back the npm scripts; `load-env.ts` is the
shared `.env.local` loader every script imports first. `generate-icons.js` is plain
JS: `node scripts/generate-icons.js`.

> **The daily cron runs the DEFAULT branch.** `.github/workflows/daily-scrape.yml`
> executes `npm run scrape` from whatever is on `main`, against the same Atlas
> database a local run uses. While improvements sit on an unmerged branch, the cron
> keeps writing documents with the *old* schema — measured 11–18 Aug 2026: 26
> documents with no `clusterKey`, no `connectionScore` and retired categories, one
> small batch per day. Documents without a `clusterKey` cannot match at ingest, so
> they surface as duplicate cards in the feed. If the feed shows doubles, run
> `diag-legacy-docs.ts` before suspecting the dedup logic.

> **Treat commit attribution in this repo as unverified unless you check `git log`.** Six agent
> sessions worked the same tree on 2026-08-24, and at least one had its context compacted
> mid-run — it could attest to 5 of the 10 commits credited to it and no more. Git records the
> same author and committer on all of them, so it cannot distinguish sessions either: any
> session-to-commit mapping in a summary was reconstructed, not observed. Some warnings in this
> file were also written up by a session relaying a measurement another had taken. None of that
> makes the measurements wrong — they were re-run before landing — but "who did this" is the one
> thing here that was inferred, and a confident guess about it is what made a day of
> reconciliation necessary in the first place.

## Environment

Copy `.env.example` → `.env.local`. Required: `MONGODB_URI` (defaults to `mongodb://localhost:27017/pulseblr`), `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL`. `RESEND_API_KEY` is optional (email digests).

> **`NEXTAUTH_URL` is not optional once deployed.** Auth.js v5 auto-trusts only Vercel. On any other host every `/api/auth/*` route returns 500 with `[auth][error] UntrustedHost: Host must be trusted` — reproduced with `next start` under `NODE_ENV=production`, where `/api/auth/providers`, `/api/auth/csrf` and the Google callback all failed, making sign-in impossible. It is invisible in development because dev mode trusts localhost. `auth.ts` sets `trustHost: true` to fix it and logs an error at boot if `NEXTAUTH_URL` is unset in production, because `trustHost` without a pinned origin lets a spoofed `Host` header into generated links.

> **`vercel.json` MUST NOT contain `//`-prefixed comment keys.** Vercel validates the file against
> a strict schema and rejects any property it does not know, so the import fails before the build
> with `Invalid request: should NOT have additional property '//regions'`. JSON has no comments; the
> reasoning lives here instead:
>
> · **`regions: ["bom1"]` (Mumbai) is not cosmetic.** Every user is in Bengaluru, the Atlas cluster
>   and the whole corpus are India-region, and `lib/format.ts` pins all formatting to Asia/Kolkata.
>   A US default region adds a round trip to every query for no benefit.
> · **There are deliberately NO Vercel crons.** `daily-scrape.yml` and `daily-digest.yml` run
>   `npm run scrape` / `npm run send-digest` directly on a GitHub runner rather than calling an API
>   route — so there is no shared secret to leak and no serverless timeout to fight. A full scrape is
>   5-10 minutes and ~700 upstream requests, far past any serverless limit. This is the thing that
>   makes hosting the app on serverless viable at all.
> · **Never set `DEV_LOGIN` on a deployed environment.** `lib/dev-login.ts` also requires
>   `NODE_ENV !== 'production'`, so it cannot activate on Vercel — but do not rely on one guard.
> · Set env vars in the Vercel project, never in this file: it is committed.

**`ADMIN_EMAILS` is required to use the Settings page** — a comma-separated list of Google account emails allowed to run the scraper and edit events/sources. It fails closed: unset means every admin endpoint returns 503 with a message naming the variable, so a 503 from `/api/scrape` is a configuration problem, not a bug.

LLM tagging cascades **IBM ICA → NVIDIA NIM → Anthropic → keyword heuristics**, and every tier is optional — with no key at all the pipeline still runs on keywords.

> **`NVIDIA_MODEL` matters more than it looks.** Verified 2026-08-09: `z-ai/glm-5.2` and `meta/llama-3.3-70b-instruct` are both listed by `GET /models` on a valid key but never respond (>25 s timeout), while `meta/llama-3.1-8b-instruct` answers in ~376 ms. Classification is a small task, so the 8B model is the right fit. Run `scripts/check-nvidia-models.ts` before changing it. The tagger also fails over to a known-good model on its own and trips a circuit breaker after 3 consecutive provider failures (process-scoped — see §3), so a bad config degrades to keywords in seconds rather than adding ~46 s per batch.

> **`{"detail":"Model not found"}` from IBM ICA usually means the TEMPERATURE is missing, not the
> model.** This is the most expensive error message in the stack, because it sends you to the
> wrong place: you check `ICA_MODEL` against `GET /models`, find it present and correct, and
> conclude the catalogue is lying. Measured 2026-08-24 against the live endpoint with
> `claude-sonnet-5`, varying only the request body:
>
> | request | response |
> | --- | --- |
> | `temperature` omitted | **400 `{"detail":"Model not found"}`** |
> | `temperature: 0.2` | 400, and honest about it — "only temperature=1 is supported" |
> | `temperature: 1` | 200 |
>
> So the model name is a red herring: ICA rejects the *request shape* and blames the model. Send
> `temperature: 1` explicitly on this provider. `max_tokens: 4000` is fine either way.
>
> **Worse, the model-level fallback cannot rescue it.** `tagger.ts` falls through to
> `fallbackModel` on a **404** but THROWS on a **400**, so an ICA failure of this shape skips the
> model chain entirely and drops to the next provider. The chain looks configured and is
> unreachable on this path — which is how `check-llm.ts` can report "2/2 via LLM" while none of it
> came from ICA. If you fix the temperature, also decide whether a 400 should fall through.

> `README.md` predates the current architecture. Trust the code and this file where they disagree.

## Architecture

PulseBLR's purpose is narrow: surface Bengaluru **software and hardware engineering**
events that are worth attending **to make professional connections**, and track who you
met. It's a PWA (service worker + `manifest.json`, share-target support).

The scraper still ingests the whole city (concerts, treks, book clubs and all) because
one broad pass is cheaper than many narrow ones and the classifier sorts it out — but
the **feed defaults to `techOnly`**, and "show all events" is a deliberate opt-out in
the filter rail. Roughly 20% of the corpus is tech; the other 80% is noise for this
product's purpose.

Two derived fields encode the purpose, and both are recomputable without re-scraping:

- **`isTechEvent`** — software/hardware engineering only. The LLM prompt explicitly
  excludes generic business/sales networking, wellness, book clubs, and paid
  certification sessions that merely name a technology. Sharpening this moved the tech
  count from 239 to 169.

  > **Hardware is a SUPPLY problem, and this is settled — do not re-probe it.** Five
  > independent classes of source were tested and none publishes machine-readable Bengaluru
  > hardware events. Consumer platforms: hardware vocabulary appears in **24 of 1354** events.
  > **IEEE vTools**, the system every IEEE chapter files events in, returns 404/500 — the
  > public surface is retired. **IEEE Bangalore** *has* The Events Calendar installed and its
  > REST route answers (`tribe_events` is a registered post type), but the collection holds
  > **exactly one event, from 2020** — the mechanism exists and is abandoned. **IESA** 404s and
  > **SEMI** 403s. **IISc** has no events post type and its feeds are empty; **IIIT-B** has no
  > `wp-json` at all. A 200 that needs a browser is not a source, and a `tribe_events` route
  > answering 200 means the plugin is installed, not that events exist. Evidence:
  > `probe-hardware-bodies.ts` / `-round2.ts`, `diag-hardware-gap.ts`, `diag-tech-recall.ts`.
  > What *is* actionable is the classifier vocabulary (see §3) — so that when a hardware event
  > does appear, it is not found and then discarded.
- **`connectionScore`** (0-100, `lib/events/connection-score.ts`) — a deterministic
  ranking signal for "will I leave with useful contacts", powering the
  **"Best for connections"** sort. In-person is the biggest term; attendee counts are
  log-scaled; and titles matching certification/cohort/webinar/course are penalised
  hard, because those put you in an audience rather than a room. Measured effect: real
  practitioner meetups with food and a company host score 88-99, while
  "Get Google AI Certified … Cohort" and "Webinar: …" land at 0-2.

  > The funnel list was built around the word **"paid"**, which let the coaching centres
  > through: "Free DevOps Demo Class in Electronic City" scored 58 and "Free Gen AI &
  > Agentic AI Demo at eMexo" scored 70 — both lead generation for paid courses, sitting
  > near the top of the feed. `demo` is now matched under a **lookahead**, because the same
  > word marks the best events and the worst: "Demo Night" and "Demos" are community
  > show-and-tell (and "demo night" already earns the peer bonus), "Demo Day" is
  > networking-dense, while "Demo Class" and "… Demo at \<institute\>" are sales sessions.
  > Course adverts scoring ≥ 50 went 2 → 0. `tests/connection-score.test.ts` pins both the
  > penalised and the spared forms — that lookahead is exactly the kind of thing a later
  > "simplification" breaks silently. Re-run `scripts/backfill-connection-score.ts` after
  > editing the weights, and `scripts/diag-coaching-leak.ts` to re-measure.

### 1. Scraping (`lib/scrapers/`)

```
core/       http (retry + concurrency pool), jsonld, ics, geo, text, types
adapters/   one module per platform, each returns ScrapeResult
pipeline.ts orchestrator: discover → scrape → enrich → tag → ingest → prune
```

**Every adapter is isolated**: it runs in its own try/catch, records its own health, and on failure contributes zero events. One dead feed can never fail a run.

**Coverage compounds through auto-discovery** — this is the central design idea, and it is what covers company events without a hand-maintained list of company websites:

- **Luma**: the public city discover feed (`api.lu.ma/discover/get-paginated-events`) returns fully structured events *and* names each event's host `calendar`. Those calendar ids are harvested and each host's own feed is scraped, which yields far more (recon: *The Product Folks* appeared once in the city feed but had 18 events on its own calendar). Hosts include company calendars like *Razorpay Rize* and *Lyzr Community Events*.
- **Meetup**: city find pages are fanned out across ~72 keywords (pagination is a no-op — pages 1/2/3 return byte-identical payloads, but different keywords return different events). Group slugs are harvested from those pages, then each group's ICS feed is read in one request. The keyword list spans software, **open source** (foss, apache, kafka, cncf, linux, hacktoberfest) and **hardware** (embedded, fpga, vlsi, semiconductor, arduino) topics, because keyword search is the discovery mechanism that works: probing 35 guessed open-source group slugs returned **0 hits**, while keywords both surface events and harvest real slugs.

Discovered sources are **persisted to the `Source` collection** (`kind` + `handle`, unique-sparse index), so every run starts from everything ever found. A first run discovered ~110 Meetup groups and 18 Luma calendars from a seed list of 24.

> **A per-run cap on a compounding set is a permanent blind spot, not a rate limit.** Because
> discovery only ever grows, `maxMeetupGroups`/`maxLumaCalendars` eventually bite — and the
> caps were applied as a bare `.slice()` on an **unsorted** query. Measured 2026-08-23
> (`scripts/diag-source-caps.ts`): **200 Meetup groups known against a cap of 120, so 80 were
> dropped — the same 80 on every run**, since Mongo's return order was stable. No log line, no
> health signal, and in the feed it is indistinguishable from 80 groups with nothing scheduled.
>
> What was in that tail (`scripts/diag-cap-victims.ts`): `microsoft-reactor-bengaluru`
> (6 events), `lfdt-bengaluru` (Linux Foundation, 7), `owasp-bangalore-chapter`,
> `microsoft-365ug`, `makers-tribe` — company events, security and makers, i.e. exactly the
> coverage that was being written off as a supply gap. Worse, **30 groups had never been
> scraped at all and all 30 were past the cap**, so they could never prove themselves.
>
> Two fixes, both needed. `loadDiscovered()` now orders by expected yield — never-scraped
> first (so a new discovery gets its first look), then most productive, then quietest, with the
> long-dead last — so if a cap does bite it drops the least valuable rather than the
> alphabetically unlucky. And `applyCap()` **logs and records a source error** when it bites, so
> the drop can never be silent again. Caps raised to 260 / 120 against 200 / 55 known; a Meetup
> group costs exactly one request (its ICS feed), so the headroom is cheap.
>
> Hand-verified `SEED_MEETUP_GROUPS` are ordered **first**, so a cap can never drop them.

Adapters and their measured quirks — read the file header before changing one, each documents what was tried and rejected:

| Adapter | Mechanism | Notes |
| --- | --- | --- |
| `luma.ts` | Discover + per-host calendar JSON | Best source: cover images, coords, guest counts, ticket prices. Descriptions need enrichment. |
| `meetup.ts` | Keyword fan-out (JSON-LD) + per-group ICS | **ICS emits no `LOCATION`** — venue/image come from `enrichMeetupEvents`. |
| `eventbrite.ts` | Category browse pages (JSON-LD), real pagination | Main source of paid events. The private search API is CSRF-gated (401). |
| `bevy.ts` | `<tenant>/api/search/event` across 5 verified tenants | GDG, CNCF, Snowflake, UiPath, Linux Foundation. Bevy is the ONE route to company-run event pages that returns structured JSON — but `probe-bevy-tenants.ts` found only 5 of 36 candidates are tenants, so guessing `community.<company>.com` does not work. |
| `devevents.ts` | `developers.events/all-events.json` | Curated tech-conference index; the source of the open-source conferences (IndiaFOSS, UbuCon, gRPConf, droidCon, GIDS). `date` is an epoch-millis **array**, and the city is spelled `Bangalore`. |
| `devfolio.ts` | Public hackathons API | Filters out the vendor's own `(Demo)`/`Fake` sandbox rows. |
| `unstop.ts` | Public opportunity search | Listings are **deadlines, not events**; in-person Bengaluru only. |
| `allevents.ts` | City page JSON-LD | Category pages are NOT category-scoped — `/technology` and `/music` return identical sets. Culture/concerts only. |
| `district.ts` | Sitemap → per-event JSON-LD | **The city-breadth source, not a tech one** — comedy, concerts, theatre, cultural festivals, runs, business networking. Measured 0 of 23 flagged `isTechEvent`, which is the safety argument: the feed defaults to `techOnly`, so breadth cannot dilute it. Best field coverage of any source (venue/address/image/description/price/organizer all 100%). **The slug is the filter:** District appends the date for dated events and omits it for its always-on "experiences" catalogue; 11 of 11 dated slugs were real events, 13 of 13 undated ones were Timezone arcades, vineyard tours and play areas reporting `startDate` = today. Undated slugs are skipped WITHOUT a request, so the run costs ~27 fetches rather than 365 × 233 KB. Fails loudly: zero dated slugs is reported as a source error. |
| `universal.ts` | JSON-LD → ICS → RSS → embedded JSON, for any URL | Adding a company page is a one-line registry entry. Deliberately has **no** LLM-on-HTML or selector-guessing fallback. **Measured: 19 of the 20 pages in `COMPANY_EVENT_PAGES` yield nothing** — corporate marketing sites are JS-rendered shells with no schema.org markup. Kept because each costs one request and starts working the moment a site adds markup. |

### 2. Dedup — two keys, two jobs (`lib/models/Event.ts`)

- `dedupHash` — strict, per-source (title + instant + venue + source), unique-indexed. Makes re-scraping idempotent.
- `clusterKey` — fuzzy, cross-source: normalized title + **IST calendar day**. Collapses the same event announced on both Luma and Meetup, while keeping "React Meetup #107" and "#108" distinct (digits are preserved). IST rather than UTC because a 9 PM IST event would otherwise straddle two UTC days.

Ingestion **upserts and merges** rather than skipping duplicates (`mergeInto`): a later sighting may only fill gaps or improve values, never blank them. That is what makes multi-source coverage additive.

> **Consequence to remember:** because merging *unions* categories, a bad tag can never be removed by re-scraping. Fixing tags requires `scripts/retag-events.ts`, which replaces them.

Both keys are derived in a **`pre('validate')`** hook, and that is not interchangeable with `pre('save')`. Mongoose registers its own validation as the first pre-save middleware, so a `pre('save')` hook that fills a `required` field never runs — validation has already rejected the document. Verified with `scripts/diag-hook-order.ts`: identical logic fails in `pre('save')` (hook body never entered) and succeeds in `pre('validate')`. This cost 3 events in one run — six documents predating `clusterKey` were stored without it, and merging a fresh sighting into one threw `clusterKey: Path 'clusterKey' is required`. The hook now self-heals such documents; `scripts/diag-clusterkey-selfheal.ts` asserts it end-to-end.

### 3. LLM tagging (`lib/llm/tagger.ts`)

`tagEvents(inputs)` classifies in **batches of 5** (measured: batch-of-8 with 600-char descriptions caused enough wrong-length responses that only 8 of 840 events got LLM tags). Parsing is deliberately lenient — a short array is applied positionally and the remainder keeps keyword tags, rather than discarding the whole batch. `keywordTagging` is the floor, so an event is never dropped for want of a classification.

The category taxonomy (`EVENT_CATEGORIES`, 32 values) lives in `lib/models/Event.ts` and the system prompt is generated from it, so they cannot drift.

> **The circuit breaker is scoped to the PROCESS, not to one `tagEvents()` call**, and
> that distinction is not academic. It used to be per-call while logging that the
> provider was "disabled for this run" — which happened to be true only for
> `npm run scrape`, because `pipeline.ts` calls `tagEvents()` exactly **once** with the
> whole corpus. Every other caller re-probed a dead provider `TRIP_AFTER` times per
> call: `retag-events.ts` chunks by 40 (25 calls on `--all` over ~1000 events), and the
> Next.js server tags one event per call on the manual add-event path. Two disable
> scopes now match the two kinds of evidence — a **401/403 retires the provider for the
> whole process on the first rejection** (a credential cannot heal without a restart,
> so this is the provider-level analogue of the 404 → `DEAD_MODELS` rule), while
> transient failures trip a 10-minute cooldown so a long-lived server heals instead of
> needing a redeploy. The Anthropic tier needs its own hook because it calls the SDK
> rather than `callOpenAICompatible`; it was the last tier still retrying a rejected
> credential `TRIP_AFTER` times per call. Measured by `scripts/diag-breaker-scope.ts`:
> 5 doomed requests across six calls where the per-call breaker spent 18.

> Keyword regexes are load-bearing when the LLM is unavailable, and loose ones do real damage: a bare `\bpm\b` matched the "PM" in "6 PM" and tagged a fifth of the corpus `Product/Design`. Keep them specific.

> **The discovery keywords and the classifier vocabulary must agree.** The Meetup fan-out
> searches `vlsi`, `fpga`, `semiconductor` and `embedded`, but the keyword floor knew only the
> last two — so a chip-design meetup could be *discovered* and then, with every LLM provider
> down, stored with zero categories and `isTechEvent: false`. Found and then discarded.
> `Hardware/Robotics` now covers what Bengaluru's silicon community actually writes (`vlsi`,
> `verilog`, `vhdl`, `risc-v`, `asic`, `tapeout`, `photonics`, `mems`, `microcontroller`,
> `mechatronics`, `signal processing`, `electron devices`, `3d printing`, `makerspace`,
> `sensors`). Run `scripts/diag-hardware-vocabulary.ts` after touching it — **its negative
> half is the important half**, because a widened regex fails by silently over-matching and
> no aggregate count reveals that.

> **"Tech" is defined TWICE, and the two can disagree.** `isTechEvent` is what `techOnly`
> filters on (`lib/events/query.ts`: `filter.isTechEvent = true`); membership of
> `TECH_CATEGORY_NAMES` is what the "Tech topic" rail counts. The keyword floor derives one
> from the other, so it cannot drift — the LLM sets both independently, so it can. Measured at
> 75 of 1048 upcoming events (7.2%), with `IndiaFOSS 2026` stored `[Arts/Culture, AI/ML,
> Data/Analytics]` and `isTechEvent: false`, i.e. **hidden from the default feed**. Those
> mis-tags carry the signature of the batch-misalignment bug: categories belonging to a
> different event in the same batch of five.
>
> The fix was `retag-events.ts --inconsistent`, not `--all`. A blanket retag is not free —
> measured with `diag-retag-preview.ts`, the current provider fixes flags well (7 fixed, 0
> broken) but returns **fewer** categories, so `Databricks Campus Hackathon` came back
> `[Data/Analytics]` having held `[Hackathon, AI/ML, Data/Analytics]`. Selecting only the
> self-contradicting documents took disagreement to 0.6% while leaving consistent documents
> their richer tags. `diag-flagship-events.ts` then confirms 0 marquee events hidden.

> **That `--inconsistent` choice was a decision about a MODEL, not a law — re-decide it when the
> provider changes.** The measurement above is specific to `llama-3.1-8b`: it fixes `isTechEvent`
> well but returns FEWER categories, losing a correct Event-type tag the filter rail depends on.
> That trade-off is a property of an 8B model. A frontier model on the ICA path may well invert
> it, which would make `--all` strictly better and would reach the *agreed-upon* errors
> `--inconsistent` is structurally blind to (see the next warning).
>
> Re-measure with `diag-retag-preview.ts` before switching — it writes nothing, and its rule is
> that FIXED must clearly exceed BROKE with no control regressing. **Fix the ICA temperature
> defect documented under Environment first**, or the preview silently measures NVIDIA again and
> tells you nothing about the model you are actually asking about.

> **Consistency-based selection is structurally blind to agreed-upon errors, and that blind
> spot has now bitten twice.** `--inconsistent` finds documents whose two "tech" signals
> contradict each other. A board-game night tagged `[Web/Mobile]` with `isTechEvent: true` is
> **self-consistent and wrong**, so it survives — as did the `Gaming/XR` leak. Both were found
> by reading the feed's actual first page. When a wrong tag is *agreed upon*, only content-based
> selection reaches it: `retag-category.ts --match=<title regex>`.
>
> Measured: "Sunday Sports🏏 & Dinner meet🍛" stored `[AI/ML, Data/Analytics]` with a description
> reading "cricket sesh followed by dinner", and "Sunday Jamming 🎶" stored `[Web/Mobile,
> Gaming/XR]`. No technical text in either — those categories belong to other events in the same
> batch of five, and **ingestion unions categories, so re-scraping can never remove them.**

> **A count is not a ranking, and the user sees the ranking.** Tech precision measured 98% while
> the top of the default feed was board games and jamming: the feed sorts soonest-first, so 2% of
> the corpus was 10% of the first twenty. `diag-tech-fp.ts` reports the first-page share
> separately for this reason. Same story for the coaching-centre adverts — `connectionScore`
> buries them correctly, but the default sort is soonest, so the penalty never reached the page.

> **UPDATE to the warning above — the default sort is no longer `soonest`, it is `connections`**
> (`8b0b247`). Read the paragraph above as the history that motivated the change, not as current
> behaviour. The measurement that drove it, first 20 rows of the default tech feed: `soonest` gave
> median score 20 with 15 of 20 ONLINE and 14 of 20 clean; `connections` gives median 88, 0 online,
> 19 of 20 clean. The corpus is near-evenly split (163 in-person / 174 online), so that gap is not
> supply — online events post more often and at shorter notice, so chronological ordering does not
> merely fail to rank, it actively selects the worst quartile. `diag-tech-fp.ts` now reports 0 of
> 20 on the first page.

> **Triage a leak by RANK, not by what was reported.** Because the default sort is `connections`
> and `connectionScore` penalises online hard while rewarding in-person-with-a-venue, a leak is
> never uniform in visibility. Measured 2026-08-24 with `diag-offcity.ts`: of 10 off-city tech
> rows, `KONG API + AI Summit 2026` (Los Angeles) scored a flat 100 and sat at **#2 in the entire
> tech feed**, while the four `Chennai - Build Your First AI Agent` rows that prompted the gate
> scored 15 and sat at **#279–#301**, where nobody scrolls. The rows a user actually meets were
> close to the inverse of the rows that got reported, so a partial cleanup triaged by complaint
> would have fixed the invisible ones and left the prominent one. The general form: **a diagnostic
> that names rows without ranking them under-reports severity.** `diag-offcity.ts` now prints
> `feed#N score S` per row plus a severity block, ranked via `buildSort('connections')` — the
> feed's own sort function, not a copy, for the same reason `CATEGORY_KEYWORDS` is exported.

> **`diag-tech-fp.ts` reporting 0 of 20 on page 1 is CONSISTENT with off-city rows sitting in the
> feed, not in tension with it.** Only 1 of those 10 rows was in the top 20, and a Los Angeles
> developer summit is a *true* positive for "is this tech" — that probe measures topic, not
> geography. The two numbers read as contradictory and are not, which is precisely why geo needed
> its own diagnostic rather than being folded into the tech-precision one.

> **`isTechEvent` excludes course selling EVEN WHEN THE SESSION IS FREE.** The prompt used to say
> "**paid** certification or course-selling sessions", and "paid" was exactly what let "Free
> DevOps Demo Class in Electronic City" and "Java Training with Placement" into the tech feed.
> The identical wording gap existed in `connection-score.ts`'s funnel list, which is why it is
> worth stating rather than patching quietly: the test is **what happens in the room** — a sales
> pitch to an audience is false however technical the syllabus sounds.

> **Internal consistency is not correctness.** A metric that only finds contradictions is
> blind to agreed-upon errors, so read the feed's actual first page, not just its totals.
> `Gaming/XR` — the one entry in `TECH_CATEGORY_NAMES` whose everyday sense is a *leisure*
> activity — had become the bin the classifier reached for when unsure: of 7 upcoming events
> tagged with it, **zero** were games engineering, and it had put a DJ night, a board-game
> Sunday and a design-thinking workshop into the tech feed. Two causes, both fixed: the
> keyword `gaming` matched "Board**Gaming**", and the prompt never said the category means
> games *engineering*. `scripts/retag-category.ts "Gaming/XR"` re-decided all seven.

> **An `Agents` / `GenAI` split is the one competitor-audit recommendation that was not built,
> and it cannot be done cheaply.** The corpus is saturated with agentic-AI events and
> they all collapse into a single `AI/ML` chip, so someone wanting agent engineering and someone
> wanting classical ML get the same filter. The obvious cheap fix — surface the `tags` already
> collected — does not exist to be surfaced: `diag-tag-supply.ts` measured 32 of 1212 upcoming
> events carrying any tag, **8 of 334** tech ones, and six distinct values in the whole corpus.
> Tags would have to be GENERATED by the tagger, competing for the same batch budget as the
> categories that already work. A real feature, not a tidy-up.

> **Never edit `tagger.ts` through a shell heredoc.** Doing so once rewrote all 70 `\b`
> word boundaries as literal **0x08 BACKSPACE bytes**, so `/\b(ai|...)\b/i` became
> `/<BS>(ai|...)<BS>/i` and matched *nothing* — `keywordTagging()` was silently dead
> code. It was invisible because the LLM tier was succeeding on 100% of events, but the
> documented floor ("an event is never dropped for want of a classification") had no
> floor at all: with every provider down, events would store zero categories and no
> `isTechEvent`. Measured before the repair: 0 of 10 representative events classified.
> After: 10 of 10. Use the Write/Edit tools or a Python file for this file, and run
> `scripts/diag-keyword-tagging.ts` afterwards — its decisive assertion is the
> aggregate count, because a mangled boundary yields *no* categories rather than a few
> wrong ones. `python -c "print(open('lib/llm/tagger.ts','rb').read().count(b'\x08'))"`
> must print `0`.

### 4. Company attribution (`lib/companies/`)

The product goal is "every Bengaluru company that runs events is listed". Platform
search cannot deliver that, and recon proved it: on Meetup a **nonsense keyword
returns the same 12 results as "Google"** (12 is the page size, not a match count),
and only 5 of those 12 even mention Google. Eventbrite's company URLs return 0.

The obvious alternative — go straight to the per-event microsites companies build,
like `aws-experience.com` or `aws.amazon.com/events/summits/` — was probed and
**rejected on evidence** (`probe-event-microsites.ts`, `probe-microsites-round2.ts`):
`aws-experience.com` serves a 1.6 KB Angular shell with no data in the HTML, and every
`aws.amazon.com/api/dirs` directory id returns 0 items. Corporate marketing pages are
the same story — 19 of 20 in `COMPANY_EVENT_PAGES` yield nothing. Scraping those would
need a headless browser per site plus per-site selectors, which is exactly the
brittleness `universal.ts` refuses to take on.

What actually reaches company events, in order of yield: company-run **Meetup groups**
(docker-bangalore, bangalore-mongodb-user-group, microsoft-azure-bangalore,
servicenow-bangalore, thoughtworks-bangalore …), company **Luma calendars** (Razorpay
Rize, Lyzr), **Bevy tenants**, and `developers.events` for conferences.

So the question is inverted. Rather than asking each platform "what are Google's
events", we resolve the host strings we ALREADY scrape — 86% of events name their
organiser — into canonical companies:

- `registry.ts` — ~109 companies with a Bengaluru presence, each tagged with a
  `sector` and a **`strength`**.
- `resolve.ts` — matches text to companies and writes `Event.companies[]`.

> **`strength` is the load-bearing field.** A naive substring match is actively
> harmful: measured against the live corpus it reported "Intel" 37 times (matching
> *intel*ligence), "CRED" 31 (*cred*entials, in*cred*ible) and "SAP" 157. So
> `distinctive` names (Razorpay, BrowserStack) may be matched anywhere including
> descriptions, while `ambiguous` ones (Intel, Meta, Target, CRED, SAP, Apple,
> Docker, Redis) are matched **only against the organiser field**, where a bare
> mention really does mean the company is hosting. When in doubt, choose `ambiguous`.

Attribution is derived data — `scripts/backfill-companies.ts` recomputes it from
stored fields after any registry change, with no re-scraping.

> **`Event.companies` is RECOMPUTED at ingest, not unioned — and that had to change.** It used
> to union, on the reasoning that "the resolver only emits names it could actually justify".
> True at the moment of writing; union is forever. Enrichment **replaces** descriptions on most
> runs (Meetup's ICS carries none at all), so a name justified by text that no longer exists
> survives permanently — and tightening a `strength` from `distinctive` to `ambiguous`, the
> documented remedy for a false positive, cannot undo the rows it already produced.
>
> Measured: `Docker` was attributed to *"Meetup new people/seekers of SriVidya Tradition"*,
> hosted by "srividya personal spiritua", with the string `docker` in **no field** of the
> document (`scripts/diag-company-leak.ts`). Exactly the harm `strength` exists to prevent, from
> a direction `strength` cannot defend against.
>
> Recomputing is the right shape because the field is purely derived from the same document and
> `resolveCompanies()` is local and cheap — no network, no LLM. Ingest and
> `backfill-companies.ts` now agree, instead of the backfill existing to clean up after ingest.
> Co-hosts are not lost: the merge has already taken the best organiser, title, venue and tags
> from both sightings, so the resolver sees strictly more evidence than either source alone.
>
> Consequence to expect after running the backfill: **attributions fell 150 → 109 and distinct
> companies 51 → 27.** The higher figures were accumulated history plus names appearing only in
> descriptions, which the resolver deliberately never matches. 109 is what the current text can
> justify.

Company names are also fed into the Meetup keyword fan-out. That is a *discovery*
lever only (it surfaces real events like "Building AI Agents with Microsoft Foundry"
and harvests more group slugs); the irrelevant remainder collapses at ingest.

`/companies` browses every company with events, and deliberately also shows the
companies with **nothing** scheduled and the hosts the registry does **not** yet
recognise — so the coverage gap is visible rather than hidden.

### 5. Query layer (`lib/events/query.ts`)

Shared by `/api/events` and `/api/events/facets` so the list and the counts beside the filters can never disagree. Time windows (`when=today|tomorrow|weekend|week|month`) resolve in **IST**. Search uses `$text` for multi-word queries (weighted relevance) and a substring regex for single words, because `$text` only matches whole words and a search box must work mid-typing — **both paths search `description`**.

"Upcoming" includes in-progress events, but an event only counts as ongoing if it *also started recently*; without that floor an Eventbrite evergreen listing dated 2015→2030 sat at the top of the feed permanently. `pipeline.ts` rejects such listings at the source.

### 6. Auth & per-user scoping

NextAuth v5 (Auth.js) config lives in the root `auth.ts`, imported as `@/auth`. Strategy is **JWT** (no DB session): the `jwt` callback stashes the Google `sub`/email/name/picture into the token *and* upserts the `User` doc by `googleId` on first sign-in; `session` surfaces `token.sub` as `session.user.id`. Server code uses `getCurrentUserId()` (`lib/auth-helpers.ts`). `proxy.ts` redirects `/dashboard`, `/tracker`, `/add-event` and `/settings` to `/login`. **Everything user-owned must be scoped by `userId`** — `TrackerEntry` has a compound-unique index `{ userId, eventId }`.

> **`proxy.ts` NO LONGER GATES PAGES, AND EVERY PROXY NOTE BELOW IS NOW HISTORY.** Read the two
> warnings that follow as the record of why this layer was removed, not as current behaviour.
>
> The check looked for an Auth.js session cookie BY NAME in the edge runtime. Two independent
> problems, neither fixable there:
>
> · **It secured nothing.** The edge has no secret to verify a JWT with, so it could only ask "is a
>   cookie present". Measured against production: `Cookie: __Secure-authjs.session-token=dummy`
>   returned **200** on all eight protected paths. A stranger walked past it by inventing a cookie.
>   Putting the secret in the edge to make it real is the wrong trade too - getting that wrong
>   signs out every user at once.
> · **It locked out users who were signed in.** Confirmed from the app's own screen, which is the
>   only reason this was finally provable: `/login?callbackUrl=%2Ffolders` rendered "You're already
>   signed in as <the address>". So the browser held a session `/api/auth/session` could decode
>   while the proxy had just refused the navigation that led there. Only `proxy.ts` writes that URL
>   shape, so the redirect was unambiguously from there.
>
> A check that cannot refuse an attacker but does refuse a real user has negative value. **Two
> earlier attempts to fix this by tuning the cookie matching (chunked-cookie support, then
> forwarding `callbackUrl`) were both real defects and neither was this bug** - which is the lesson
> worth keeping: the instrument was wrong, not its calibration.
>
> **Where the gate lives now.** Authorisation is unchanged: `requireUser()` / `requireAdmin()` on
> every private API route, and `/admin`'s own server-component session + allowlist check, which
> still `redirect()`s and is still asserted by `diag-api-auth.ts`. What to DRAW is
> `app/components/ProtectedRouteGate.tsx`, mounted inside `Providers` in the root layout, which
> asks `useSession()` - the same session the API routes see - so the page and its data cannot
> disagree. `lib/protected-routes.ts` holds the path list, and `tests/protected-routes.test.ts`
> pins the prefix-matching trap that `/c/<token>` and `/f/<token>` depend on.
>
> **`loading` renders the page, deliberately.** `useSession()` starts as `loading` on every hard
> navigation, and treating that as signed-out would flash a sign-in wall at a signed-in user - the
> same false-negative class, moved to the client. Only a settled `unauthenticated` gates, so the
> gate fails OPEN.
>
> **Consequence for `diag-api-auth.ts`: a 200 on those seven pages is now CORRECT.** They are all
> client components, so no user data is in the HTML; the script asserts that separately by scanning
> the anonymous response for an email address. Its canary needs an ALPHABETIC TLD - a looser
> pattern matched `FILL@100..700` from the Material Symbols URL in `app/layout.tsx` and reported
> all seven as leaking, and a canary that cries wolf everywhere gets switched off.

> **`/dashboard` HAD ITS OWN NAV AND ITS OWN HERO, WHICH IS WHY IT LOOKED LIKE A DIFFERENT APP.**
> It hand-rolled a desktop nav, a mobile header and a bottom bar from a local `NAV_LINKS` array,
> and that array had gone **stale**: it offered Feed / Calendar / Tracker / Add / Settings and was
> missing Companies, People and Dashboard itself. So opening the dashboard changed the whole chrome
> AND dropped links the rest of the app has. It also drew a full-bleed **black** hero, the loudest
> element in the product, on exactly one page - against the globals.css rule that keeps everything
> greyscale so cover images are the only colour. Now uses the shared `DesktopNav` /
> `MobileBottomNav`. A second copy of the nav cannot stay in step with the first; do not reintroduce
> one.

> **THE LOGIN PAGE THREW AWAY THE `callbackUrl`, WHICH IS WHY SIGNING IN LOOKED LIKE IT FAILED.**
> `proxy.ts` carefully appends `?callbackUrl=<path>` when it bounces a signed-out visitor, and
> `app/login/page.tsx` passed a hard-coded `signIn('google', { callbackUrl: '/' })`. So the
> sequence was: tap **Tracker**, get sent to `/login`, sign in with Google, and land on the **home
> page**. Nothing tells the user the sign-in worked, and the page they asked for never opens - which
> is indistinguishable from being refused, and is exactly how it was reported ("clicking on the
> tracker and people it redirects to sign in").
>
> **Forwarding the parameter is not the whole fix, because the value is attacker-chosen.** Passing
> it through raw is a textbook open redirect: `…/login?callbackUrl=https://evil.example/login` gives
> a real sign-in on the real domain that lands on somebody else's page - better phishing than a
> lookalike domain, because every signal up to the final hop is genuine. `lib/auth-callback-url.ts`
> allows exactly one shape, a same-origin absolute path, and `tests/auth-callback-url.test.ts` pins
> the rejections that a `startsWith('/')` check would wave through: `//evil.example` and
> `/\evil.example` (browsers read both as a HOST), their percent-encoded forms - which is why
> decoding happens BEFORE inspection - and control characters, since browsers strip tab/CR/LF while
> parsing a URL so `/<TAB>/evil.example` would BECOME protocol-relative.
>
> It also refuses `/login` itself. Otherwise the proxy sends you to `/login`, `/login` sends you to
> `/login`, forever.
>
> **The second half: `/login` now says when you are ALREADY signed in.** Reaching it with a live
> session is not hypothetical - the proxy decides on the session COOKIE while the page reads the
> session through `/api/auth/session`, and when those disagree the user is shown a "Sign in" button
> while holding a perfectly good session. It now names the account and offers **Continue**.
> Deliberately a BUTTON, not an auto-redirect: if the proxy is going to bounce that navigation
> again, redirecting automatically turns one confusing screen into an infinite loop, which is
> strictly worse. Verified end to end against the production build - `callbackUrl=%2Ftracker`
> reaches Auth.js as `/tracker` where it used to be `/`, and `%2F%2Fevil.example%2Fsteal` is
> coerced to `/`.

> **`proxy.ts` WAS BLIND TO A CHUNKED SESSION COOKIE, and that failure mode is a total sign-out
> that looks like the app forgetting you.** It compared the cookie name against two exact strings.
> `@auth/core/lib/utils/cookie.js` splits the session cookie once the value passes
> `ALLOWED_COOKIE_SIZE - ESTIMATED_EMPTY_COOKIE_SIZE` (4096 - 160 = **3936** chars) into
> `<name>.0`, `<name>.1`, ... and **the unchunked name then does not exist at all** - so a perfectly
> valid session read as "signed out" on `/tracker`, `/folders`, `/add-event`, `/settings`, `/admin`,
> `/scan` and `/card` simultaneously, while the client still drew the avatar because
> `/api/auth/session` reassembles the chunks and this did not. Measured against production:
>
> | `Cookie:` sent to `/tracker` | response |
> | --- | --- |
> | *(none)* | 307 to `/login?callbackUrl=%2Ftracker` |
> | `__Secure-authjs.session-token=x` | **200** |
> | `__Secure-authjs.session-token.0=x` | **307 to `/login`** |
>
> **It is latent, not currently firing.** A real Google session encoded with this app's own
> `encode()` measured **649-883 chars** against the 3936 threshold, so nothing chunks today. It goes
> live the moment a token grows - a longer `picture` URL, a longer display name, one more claim in
> the `jwt` callback. `tests/proxy-session-cookie.test.ts` pins it (23 cases), including that
> `__Host-authjs.csrf-token`, `__Secure-authjs.callback-url` and the PKCE verifier must NOT count as
> a session (all three are set on any anonymous visit to `/api/auth/csrf`, so accepting one would
> admit every visitor), and that `/c/<token>` and `/f/<token>` stay public.
>
> **The check stays a PRESENCE check, deliberately.** Verifying the JWT in the proxy needs the
> secret in the edge runtime, and getting that wrong logs out every user at once - the blast radius
> is the whole app, not one route. The boundary is `requireUser()` in each handler. So this layer may
> only ever become MORE permissive.

> **`GET /api/me/whoami` exists to tell "looks signed in" apart from "is signed in", because the app
> can be both at once.** `NavBar` draws the avatar when `session.user` is merely TRUTHY, while
> `getCurrentUserId()` returns `session?.user?.id ?? null` and every `requireUser()` route answers
> 401 on null. **A session missing `user.id` therefore looks signed in and behaves signed out** -
> the avatar renders, and `/tracker` loads its shell and then shows its own "Sign in to use your
> tracker" panel, whose button links to `/login`. That is indistinguishable from a redirect to
> anyone reporting it, and it is why a report of "it sends me to the login page" must not be assumed
> to be `proxy.ts`.
>
> The route is deliberately **not** behind a guard - it has to work exactly when the session is
> broken, which is when a guard would refuse it. Safe because every field derives from the caller's
> own cookies: it returns cookie **names**, never values, and truncates the user id, so an anonymous
> request gets all-false and learns nothing. `sentSessionCookie` vs `hasUserId` is the whole
> diagnostic - cookie absent is a cookie/domain/expiry problem, cookie present with no user id is a
> token-shape problem, and the two have nothing in common.

> **NOTHING EXERCISES THE GOOGLE JWT PATH.** Every `scripts/diag-*.ts` that signs in uses the
> DEV_LOGIN provider, and `auth.ts`'s dev-login branch sets `token.sub` **explicitly** while the
> Google branch relies on `profile.sub ?? token.sub`. So the one field every `requireUser()` route
> depends on is set by hand in every test and inferred in production. `next start` cannot close this
> gap either - `lib/dev-login.ts` requires `NODE_ENV !== 'production'`, so the provider is correctly
> unavailable in exactly the build that behaves like production. Treat a production-only auth report
> as plausible even when the whole diag suite is green.

> **`proxy.ts` protects NO API route.** Its matcher is `'/((?!api|_next/static|…).*)'` — `api` is the first negative-lookahead term, so the proxy never runs for `/api/*`. Every API guard must live in its own handler. Six endpoints were reachable with no credentials because of this (`POST /api/events`, `PUT`+`DELETE /api/events/[id]`, `POST /api/sources`, `PUT`+`DELETE /api/sources/[id]`, `POST /api/scrape`, `POST /api/scrape-url`, `POST`+`GET /api/notifications/send-digest`). `scripts/diag-api-auth.ts` hits every one signed-out and asserts a refusal; run it after touching any route.

> **A route that hands the raw body to Mongoose reports the CALLER's mistake as a 500, and
> pays for it twice.** Both tracker write paths did — `POST /api/tracker` via
> `TrackerEntry.create({ ...body, userId })`, `PUT /api/tracker/[id]` via `{ $set: body }` with
> `runValidators: true`. Either way a bad `status` raised a Mongoose ValidationError, which
> reached the catch-all and was returned as **500 with `details: err.message`**:
>
> ```
> TrackerEntry validation failed: status: `Ghosted` is not a valid enum value for path `status`.
> ```
>
> Two defects in one response. A 5xx tells a client "server fault, retry" when retrying can
> never work, and it hides a real fault behind the same code as a typo. And the body hands
> back the model name and the schema path — free reconnaissance on the internal shape of the
> data. The same four field classes all did it: the `status` enum, `appliedAt`'s date cast,
> `connections[].name`'s `required`, and a malformed `eventId` reaching `Event.findById()` as
> a CastError. A malformed JSON body did it one layer earlier, since `request.json()` throws.
>
> `lib/tracker/validate.ts` now runs **before** the write and before `connectDB()` — a bad
> request needs no database to refuse. It is pure, so `tests/tracker-validation.test.ts` pins
> it without a server, and `TRACKER_STATUSES` lives there for the schema enum to import, so
> the list the API rejects against cannot drift from the list the schema enforces (the same
> arrangement as `EVENT_CATEGORIES` in `lib/event-types.ts`).
>
> Two things to preserve if you touch it. **Do not make the validator stricter than the
> schema where a client depends on the leniency:** a Date path casts `''` to null and
> `EditTrackerModal`'s `EMPTY` draft sends `followUpAt: ''` for anyone recorded without a
> follow-up date, so refusing `''` would 400 every save from the one screen that records
> people. And the 500 branch **no longer carries `details`** — the only thing it ever held was
> the message this fix exists to stop leaking, nothing read it, and the real wording is in the
> server log. `isSchemaRejection()` catches a ValidationError that somehow still gets through
> and answers 400 rather than letting it revert to a 500.
>
> **The same `details: err.message` shape is still on ~10 other routes** — `POST /api/events`
> (whose `category` enum is the identical defect), `/api/contacts`, `/api/contacts/sync`,
> `/api/folders`, `/api/me/card` and others. Not fixed here; the pattern to copy is above.

**Two guard tiers** live in `lib/api-auth.ts`:

- `requireUser()` — any signed-in user. For per-user data (`/api/tracker`, `/api/phase6`, the digest preview, `/api/scrape-url`).
- `requireAdmin()` — email must be in the `ADMIN_EMAILS` allowlist. For anything **global**: creating/editing/deleting events, adding/removing sources, triggering a scrape, sending the digest email. Google sign-in is open to anyone with a Google account, so "signed in" is not a bar for operations that affect everyone — a stranger could otherwise empty the corpus or loop `/api/scrape` and burn the LLM quota.

`requireAdmin()` **fails closed**: with `ADMIN_EMAILS` unset every admin route returns 503, never "any signed-in user". Neither cron needs it — `daily-scrape.yml` and `daily-digest.yml` run `npm run scrape` / `npm run send-digest` directly rather than calling the API, so there is no shared secret to leak.

> **GUARD FIRST, VALIDATE SECOND — in that order, in every route.** The guard must return
> 401/403 before any body parsing or validation runs. Get it backwards and an anonymous caller
> sending a bad payload receives **400 instead of 401**, which tells a stranger their body parsed
> and validated far enough to be judged — free information about the shape of your API, handed to
> someone with no credentials. It also breaks the contract `scripts/diag-api-auth.ts` asserts,
> which is that *every* mutating route refuses an un-authed request with a refusal code.
>
> This is easy to get wrong precisely when you are doing the right thing. Adding input validation
> to a route is an improvement, and the natural place to put it is at the top of the handler —
> which is above the guard. The tracker write paths were the first routes here to gain a real
> validator, and the ordering is why `diag-api-auth.ts` now probes them with a **deliberately
> invalid body**: a 400 on those two cases means validation outran the guard, and the assertions
> say so in their own labels. Copy that pattern when you add a validator to any of the ~10 routes
> still returning `details: err.message`.

`POST /api/scrape-url` fetches a URL the caller supplies, which made it an SSRF. It now goes through `lib/security/safe-fetch.ts`: http(s) only, no embedded credentials, and every **resolved** address checked against loopback/private/link-local/CGNAT/multicast ranges (including v4-mapped IPv6 and decimal-encoded forms), with redirects followed manually so each hop is re-validated. `scripts/diag-ssrf-guard.ts` asserts the bypasses. Full DNS-rebinding protection would need connection pinning and is documented as out of scope in the module header.

The digest is scoped too: `generateDailyDigest(userId)` takes a **required** userId, because both its `TrackerEntry` queries previously ran unfiltered and `GET /api/notifications/send-digest` served that object anonymously — every user's contacts, companies, follow-up dates and private notes.

### 7. App layer

- `lib/format.ts` — all date/label formatting, **pinned to Asia/Kolkata**. Never format event times with the ambient locale; a server in UTC would put a 9 PM IST event on the wrong day.
- `lib/event-types.ts` — the client-side event shape (dates are ISO **strings** over JSON, not `Date`).
- Feed (`app/page.tsx`) is a date-grouped **time rail** with a "Happening now" bucket pinned above the day groups, plus a grid view, faceted filters with live counts, debounced search, and infinite scroll.
- Event covers use a plain `<img>`, not `next/image`, on purpose: covers come from a long and growing list of third-party CDNs, and `remotePatterns` would break every time a source changes host. The fallback is a category-tinted monogram.

#### Design system (`app/globals.css`)

Four rules carry the whole look. Breaking any one of them is what made the earlier version read as generic:

1. **Tracking is a function of size.** `.t-display` is set at `-0.035em`, `.t-body` at `-0.008em`, `.t-label` at **+0.055em**. A single `letter-spacing` applied across a ramp is the tell of a default type scale. Display sizes use **Inter Tight** (`--font-display`), body uses Inter; headings pick up the display face automatically via an `h1, h2, h3` rule.
2. **Elevation is a ring plus a lift, never one blur.** `--lift-1`/`--lift-2` stack a `0.5px` hairline ring for the edge with a soft offset shadow for the height. The old single `0 4px 40px rgba(0,0,0,.04)` read as fog — no defined edge, barely separated from the page.
3. **Hairlines are alpha, not solid grey.** A solid `#E5E5EA` border looks like a light line on white and a *darker* line on the page grey. `--hairline: rgba(0,0,0,0.07)` composites correctly on both.
4. **One accent, rationed.** `--blue` means "you can act on this" — links, focus, primary actions, the connection meter — and is never decoration. `--live` marks exactly one state. Everything else is greyscale, which is what leaves the **cover images** as the only colourful thing on screen. Eight category gradients, a hero gradient and a `hover-lift` (all verified unreferenced) were deleted for this reason.

Interactive surfaces **press** (`.pressable`, `scale(0.978)`) rather than lift: a hover-grow has no touch equivalent, and most of this app is used on a phone. All motion uses one curve, `--ease: cubic-bezier(0.32, 0.72, 0, 1)` — Apple's decelerate, which settles instead of coasting.

> **The signature element is the connection meter** (`.meter` + `ConnectionMeter` in `EventRow.tsx`). `connectionScore` is computed for every event and powers the "Best for connections" sort, but it was rendered **nowhere**, so the app's one signal that Luma and Meetup cannot show was invisible and that sort looked arbitrary. It renders as three bars, not the number, because the score is a ranking signal rather than a measurement and printing "83" implies a precision it does not have.

> **Verifying layout changes:** run the clip-aware overlap probe and **exclude `position: fixed`/`sticky` ancestors**. A naive probe reports the command bar and bottom nav "overlapping" every row they scroll over, which is intended behaviour — those bars are near-opaque. Measured after this redesign: 0 content-only overlaps at 1440×900 and 390×844, at both scroll-top and scrolled.
- Tracker (`app/tracker/page.tsx`) is a drag-and-drop kanban with optimistic updates and rollback, a list view, and a "follow-ups due" strip on top.

**Two audiences, two surfaces.** A regular user browses, tracks and applies; they never see the scraping machinery. `/admin` (`app/admin/`) is the operator console: corpus stats, the scraper trigger, source enable/disable/delete, and event administration (delete, and correct a mis-tagged `isTechEvent`). Its data comes from `GET /api/admin/stats` in one round trip, so the dashboard cannot render internally inconsistent totals.

The scraper and source controls used to live in `/settings`, which every signed-in user can open — that was the boundary problem in one page. `/settings` is now purely per-user (account, digest, a "your permissions" list that names what is admin-only) and links to `/admin` only for admins.

> **The home page Spotlight has TWO modes, and the fallback is the point.** `Event.spotlightAt`
> is a date an admin sets from the star toggle in `/admin`'s events panel. With any upcoming event
> pinned, the Spotlight is editorial and the caption reads "Hand-picked"; with none pinned — the
> normal state — it falls back to the top of the same `connectionScore` ranking the feed below uses
> and reads "Best for connections right now". Falling back rather than hiding is deliberate: an
> empty pin set is not a misconfiguration, so the feature has to look finished on a database where
> nobody has ever opened `/admin`.
>
> Four things that are easy to get wrong here:
>
> · **`spotlightAt` is EDITORIAL, not derived.** `connectionScore`, `companies` and `isTechEvent`
>   are all recomputable, so backfills rewrite them freely. A human chose this one, so nothing may
>   recompute or clear it. `mergeInto()` is already safe because it uses an explicit allowlist of
>   SCRAPED fields — keep it that way.
> · **The filter is `{ $type: 'date' }`, not `$exists`.** Unpinning sends `spotlightAt: null`,
>   because `PUT /api/events/[id]` does a plain `$set` and cannot express `$unset`. Under `$exists`
>   that null would read as "pinned". Verified both directions.
> · **It is a query FILTER (`?spotlight=true`), not a separate endpoint**, so a pin is narrowed by
>   the same `techOnly` and upcoming-window logic as everything else — an event pinned in August
>   cannot resurface in October. A bespoke endpoint would be a second definition of "upcoming".
> · **Only two render** (`SPOTLIGHT_COUNT`), most recently pinned first. Pinning a third is allowed
>   and simply does not show, which is worth knowing before wondering why nothing changed.
>
> Adding this field hit the warning at the top of this file — a field on an EXISTING model, where a
> dev server holding a stale schema silently drops the write. Verified from a fresh `tsx` process
> instead: the write persisted, `spotlight=true` matched it, an explicit null stopped matching, and
> `0` of ~1500 documents carry the key when nothing is pinned.

> **"Curated by us" is a SECOND curation surface, and it is not the Spotlight.** A pin promotes
> something the scraper already found; this shelf shows supply the scraper never had —
> `source: 'manual'`, which is what `POST /api/events` writes when a body names no source, i.e.
> every event added by hand through `/add-event`. Those are the events platform coverage misses: an
> invite-only company evening, a college fest, anything announced only in a WhatsApp group.
>
> **The measurement that justifies the section rather than just a badge.** With 5 hand-added
> upcoming events in the corpus, the ranked first page rendered 28 rows and **not one of the 5 was
> among them** — they do not score highly enough on `connectionScore` to reach page 1, so before
> this they were reachable only by paging or by `?source=manual` in the URL. A badge alone would
> have marked them without making them findable.
>
> Four things worth knowing:
>
> · **It sorts `soonest`, NOT `connections` — a deliberate exception to this app's own thesis.**
>   Everywhere else the ranking is the product. Here a human already made the quality judgement by
>   typing the event in, so re-ranking the shelf by `connectionScore` would second-guess the
>   curation with a heuristic and could bury the event the admin most wanted seen. What a reader
>   still needs is WHEN, so the shelf is chronological.
> · **Precedence is enforced by SUBTRACTION at each step: live > spotlight > curated > coming up.**
>   The sets are NOT disjoint — a hand-added event can be in progress, an admin can pin one, and it
>   can rank onto page 1 on merit, so the same `_id` legitimately arrives from three requests.
>   Whichever section claims it first wins.
> · **`CURATED_COUNT` is capped at 6** so a burst of manual adds cannot push the ranked feed off
>   the screen. It still goes through `buildParams`, so a hand-added event must be upcoming and
>   still respects `techOnly` — being typed in by an admin does not exempt a row from the visible
>   filters. All 5 current rows happen to be `isTechEvent: true`, so the default feed shows them;
>   a manually-added NON-tech event would correctly be invisible until "show all events" is on.
> · **The mobile treatment is a horizontal shelf, and the first attempt got it wrong.** Five
>   vertical rows measured 877px and pushed the first ranked row to **y=1899 on 375x812 — 2.34
>   screens of scroll before the feed**, worse than the y=1511 the note above already calls out as
>   too far. A horizontal snap scroller costs one card height instead of five: section 877 -> 412px,
>   feed start 1899 -> **1435px**. Note this is the OPPOSITE width-switch from the Spotlight (which
>   is a grid on desktop and a rail on mobile) for the same reason — two covers fit side by side,
>   six do not stack.
>
> **A shorter list was NOT an option, and this is the trap.** The memo REMOVES these events from
> "Coming up" so nothing renders twice, so a row dropped on mobile is gone from the phone entirely
> rather than merely deferred — the same mistake the Spotlight comment warns about. Every card in
> the scroller stays reachable by swipe or by Tab.

> **When verifying a rebuild in a browser that has this PWA installed, clear the service worker
> first — a stale build looks exactly like your change not working.** Verifying this shelf,
> `next start` rendered markup with no shelf in it while the production build on disk demonstrably
> contained it (`grep -rl overscroll-x-contain .next/static` matched, and the source line was
> there). Unregistering the SW and emptying Cache Storage fixed it:
> ```js
> (await navigator.serviceWorker.getRegistrations()).forEach(r => r.unregister());
> (await caches.keys()).forEach(k => caches.delete(k));  // held pulseblr-static-v3 + -dynamic-v3
> ```
> **The exact mechanism was NOT established, and the obvious explanation is ruled out by the code.**
> `sw.js:78` is `if (url.pathname.startsWith('/_next/')) return;` — the worker never touches Next
> build assets at all — and `sw.js:97` makes navigations **network-first**, with cache used only as
> an offline fallback. So the chunks cannot have come from Cache Storage, and the document is only
> served from cache when the network fetch **fails**. The most likely reading is that the navigation
> landed inside the `next start` stop/restart window, failed, and took the `sw.js:107` offline
> fallback to the previous HTML. The fix is also confounded: the reload that worked used a new query
> string, so it busted the browser's own HTTP cache at the same time.
>
> **So do NOT conclude that deploys fail to reach users.** An earlier draft of this note claimed the
> `v3` cache name pins returning visitors to the previous build until the version is bumped. That is
> wrong for this worker, for the two reasons above — and `sw.js:5` records that serving navigations
> cache-first was the **v1** bug, already fixed. A version bump is not required for a release to
> reach existing installs.

> **`npm run build` does NOT disturb a running `next dev` on Next 16.3.2 — the earlier note in this
> file was over-broad.** Dev artifacts live under `.next/dev/` (observable: `.next/dev/static/
> chunks/`, `.next/dev/server/`), while a production build writes `.next/BUILD_ID`, `.next/static/`
> and `.next/server/`. Verified directly: built while another session held port 3000 and that
> server still answered 200 immediately afterwards. What a build DOES clobber is what a
> **`next start`** server is serving — which is what the phantom-404 incident behind
> `diag-api-auth.ts` actually was. So `pulseblr-verify` on 3100 is safe to use alongside another
> chat's dev server; just rebuild before starting it, not while it runs.

> **`/admin` is a server component and that is load-bearing.** `proxy.ts` can only see whether a session cookie exists; it cannot know whether that session is an admin. So the page re-checks the allowlist server-side and `redirect()`s a non-admin to `/` before any admin markup is generated. `session.user.isAdmin` (set in `auth.ts`) exists **only** to decide whether to draw the nav link — it is a courtesy, not authorisation, and editing it in devtools buys a 403 from `requireAdmin()`. `token.isAdmin` is recomputed on every JWT callback rather than written once at sign-in, so removing someone from `ADMIN_EMAILS` takes effect on their next request instead of whenever their weeks-long token happens to expire.

`scripts/diag-admin-stats.ts` asserts the invariants the dashboard's UI assumes (bucket sums, `tech <= upcoming`, non-empty breakdowns) because the HTTP path cannot be exercised headlessly — Google OAuth can't complete.

### 8. Career intelligence (`lib/helpers/phase6.ts`)

Pending follow-ups, repeat-connection detection (same person across 2+ events),
target-company/recruiter detection, and `getStats(userId)`. Surfaced via `app/api/phase6/*`.

**Person identity now comes from `Contact.contactKey`, and that fixed two real defects.**
`detectRepeatConnections()` used to key on `connection.name.toLowerCase().trim()`, so two
different people called Rahul at one event collapsed into one and the same person spelled two
ways became two. `markFollowUpComplete()` matched `c.name === connectionName` — exact, case
sensitive, first match wins — so the Done button silently no-opped **forever** on the second
person with a given name, because `ConnectionSchema` is `{ _id: false }` and there was nothing
better to address them by. Grouping is now by `contactKey` (which prefers a scanned LinkedIn
slug) and completion is by `Contact._id`, via `completeContactFollowUp()`.

Every function here **unions both stores** and tags each result with
`source: 'contact' | 'tracker'`, so nothing disappears while
`migrate-connections-to-contacts.ts` has not been run yet; `POST /api/phase6/follow-ups`
accepts `{ contactId }` or the legacy `{ trackerEntryId, connectionName }` for the same reason.

> **A union is not enough on its own — after migrating, the person is in BOTH stores.** Measured
> against a real fixture: a migrated connection appeared TWICE in the follow-ups strip (and so
> twice in the digest email), and `detectRepeatConnections` claimed "met at 2 events" for somebody
> met once. Two causes, both fixed:
> 1. The overlap is now suppressed exactly, not guessed at from names. The migration writes the
>    deterministic clientId `migrated:<entryId>:<index>`, so `migratedClientIds()` computes which
>    legacy rows already have a Contact and skips them. The Contact wins, because it is the row
>    with a real `_id` to address.
> 2. Repeat detection identifies the EVENT as `folder.eventId ?? folder._id`. Keying on the
>    folder id alone made a migrated contact and its legacy twin look like two events — and would
>    also have counted two folders for one event as two events.

> **The two follow-up windows used to disagree**, which is why
> `getPendingFollowUps(userId, { includeUpcomingDays })` takes an explicit parameter. This
> function selected `followUpAt <= now` (OVERDUE) while the digest selected `now … now+3 days`
> (UPCOMING) — so an overdue follow-up reached the dashboard but never the inbox, and
> `diag-tracker-flow.ts` has to backdate its fixture to test anything. Default 0 preserves
> overdue-only; the digest passes 3.

> **`getTargetCompanies()`, `addTargetCompany()` and `removeTargetCompany()` were DELETED, not
> extended.** The getter returned the module-level array **by reference**, so the adder mutated
> a process-global shared by every user of the deployment, and the remover discarded its own
> result. All three were uncalled. Per-user targets now live on `User.targetCompanies` and are
> read by `lib/contacts/service.ts#getTargetCompanies`. `isTargetCompanyEvent()` stays here and
> deliberately reads the default list, because it judges a shared event corpus at ingest time
> where there is no signed-in user.

### 9. Scan & contacts (`lib/scan/`, `lib/models/{Folder,Contact}.ts`)

Capturing the people you meet at an event by scanning a QR code, into a per-event
**folder** you can read as a table and export as CSV.

Surfaces: `/scan` (camera), `/folders` and `/folders/[id]` (the table), `/card` (show your
own code), plus two **public** pages — `/c/<token>` (somebody's card, opened from a QR by a
stranger with no account) and `/f/<token>` ("add yourself to this folder"). Neither public
page may ever be nested under a prefix listed in `proxy.ts`'s `PROTECTED`, which matches by
`startsWith`; `/card` is safe only because `'/c/abc'.startsWith('/card')` is false.

The scanner is `zxing-wasm@3.1.3`, self-hosted from `public/wasm/` by
`scripts/copy-wasm.js` (wired to `postinstall`). **That self-hosting is mandatory, not
tidy:** the shipped dist has no CDN fallback and resolves the `.wasm` relative to the
script URL, which under Turbopack is `/_next/static/chunks/` — so without the `locateFile`
override the first scan 404s, and only in a production build. Measured: 1,093,289 bytes
raw, 349 KB brotli, 445 KB gzip. A native `BarcodeDetector` fast path exists but is gated
behind a **runtime self-test that decodes a known QR**, because on iOS with the Shape
Detection flag on the global exists and does not work (WebKit 281848).

> **Verified first-hand on 2026-08-23, not just inferred.** Pointing the scanner at a real
> LinkedIn QR decoded
> `https://www.linkedin.com/in/naga-sai-rahul-vudumula-93419524b?fromQR=1` — exactly the
> shape the 19-sample sweep predicted, on the current app build. The slug became
> `contactKey: li:naga-sai-rahul-vudumula-93419524b`, `guessNameFromSlug` dropped the
> trailing `93419524b` and offered "Naga Sai Rahul Vudumula" as an editable guess, and
> `rawPayload` kept the string verbatim including `?fromQR=1`.

> **The same test found a real bug worth remembering: a scanner re-detects the code it just
> saved.** After "Save & scan next" the camera is still aimed at the same QR, the loop picks
> it up within ~100 ms, and the obvious next tap files that person twice — which is how two
> identical contacts appeared during verification. `clientId` idempotency cannot catch it,
> because each capture legitimately mints a new one. `app/scan/page.tsx` therefore ignores a
> payload identical to the one just saved for 10 seconds.

**What a LinkedIn QR contains — measured, and the fact the whole design rests on:**

```
https://www.linkedin.com/in/<public-vanity-slug>?fromQR=1
```

19 independently published "My code" screenshots were decoded during research, spanning
**Jun 2018 → Mar 2026**, iOS and Android, six locales, with **zero structural variation**.
No opaque token, no `/qr/` route, no `mwlite` form, no embedded vCard — and **no name**.
So the vanity slug is a globally unique identity available offline with no network call,
and the name must come from the person or from the vCard. Of those 19 slugs only ~5 were
hyphenated enough to guess a name from and ~4 contained no name at all
(`ebusinesstutor`, `iraklizv`), which is why `guessNameFromSlug()` declines far more often
than it fires and why anything it returns is flagged `nameIsGuess`.

> **We never fetch linkedin.com.** LinkedIn's User Agreement forbids software "to scrape
> or copy the Services, including profiles and other data from the Services" and
> robots.txt terminates in `User-agent: * / Disallow: /`. It also does not work: measured,
> `curl` of a profile returns **HTTP 999** and headless Chromium from the same address is
> sent to `/authwall`, so a Vercel or Actions fetch gets nothing. There is no API
> substitute — LinkedIn's self-serve endpoint returns only the *authenticated member's
> own* profile. (*hiQ v. LinkedIn* found scraping public pages is not a CFAA violation,
> but hiQ still lost on breach of the User Agreement.) Enrichment is out, permanently.

> **Conference badge and ticket QRs carry no contact data.** Verified per platform:
> HasGeek is exactly **16 chars** (an 8-char `puk` + 8-char `key`, both random URL-safe
> base64); Meetup an opaque per-RSVP token readable only by their organiser app, valid 1 h
> before → 24 h after; KonfHub and Luma server-side ids; Bevy undocumented; FOSS United a
> URL carrying a ticket id. None lets a third party recover who the attendee is. So
> "scan a badge, get a contact" is not buildable on any platform, and the parser's job is
> to **recognise a ticket and say so** rather than save a person named `aB3xK9pQmZ2vL7wR`.
> The same applies to the UPI payment codes that are everywhere in India.

`parseScanPayload()` (`lib/scan/parse-payload.ts`) is a cascade shaped like
`universal.ts` — most structured format first, never throws, and **always keeps `raw`**,
so a payload shape we do not understand today can be re-parsed from stored documents
tomorrow. Order: vCard → MECARD → recognised-not-a-person (Wi-Fi, UPI, calendar, geo) →
mailto/tel → ticket → LinkedIn/X/GitHub/URL → text.

The vCard parser (`lib/scan/vcard.ts`) is 200 lines rather than a `split('\n')` because
each of its documented traps corrupts data *silently*: unfolding, QUOTED-PRINTABLE soft
line breaks (a trailing `=`), splitting compound values on unescaped semicolons only,
Apple's `item1.URL` + `X-ABLabel` grouping, case-insensitivity, and CHARSET decoding.

**Two identity fields, and both differ from `Event`'s on purpose:**

- **`Contact.contactKey`** (`lib/scan/contact-key.ts`) — `li:<slug>` > `em:<email>` >
  `ph:<last 10 digits>` > `nm:<name>`, tier-prefixed so two tiers can never collide.
  Unlike `Event.clusterKey` it is **recomputed when a source field changes**, not frozen:
  an event's identity is fixed at ingest, a person's sharpens as you learn their LinkedIn.
  Phone uses the last 10 digits because `9876543210`, `+919876543210` and `09876543210`
  are one number.
- **`Contact.clientId`** — a client-generated UUID, unique on `{ userId, clientId }`.
  It is the idempotency key for offline sync: the create endpoint must treat a duplicate
  as **success returning the existing document**, not a 409, or a replayed queued scan
  duplicates people.

> **Contacts are a top-level collection, not `TrackerEntry.connections[]`,** for four
> independent reasons: `eventId` is `required` (so the subdocument cannot hold anyone met
> at an event the scraper has never seen — Google I/O Connect is not in the corpus);
> `ConnectionSchema` is `{ _id: false }` so there is no stable id, which is why
> `markFollowUpComplete()` matches on `name` and silently no-ops on the second person with
> that name; the only write path is `PUT /api/tracker/[id]` doing `{ $set: body }` with
> the edit modal sending its **entire** local array, so every save is a full-array replace
> and a queued offline scan replayed against a stale base array **drops contacts**; and
> you cannot put a unique index on a subdocument array element.

> **Every `Contact` write must go through `findOne` + assign + `.save()`.** The
> `contactKey` hook is `pre('validate')` — mandatory, because Mongoose registers its own
> validation as the first pre-save middleware so a `pre('save')` hook filling a `required`
> field never runs — but `pre('validate')` **does not run on `findOneAndUpdate`**:
> `runValidators` invokes Mongoose's separate update-validator helper, not document
> middleware. `scripts/diag-contact-identity.ts` asserts the document path, including
> that a document which never supplied `contactKey` still validates.

`Folder` denormalises its own name, date and venue and treats `eventId` as a **soft**
link, because `pruneStale()` deletes events 7 days past on every scrape without touching
anything that references them — dangling refs are normal, and
`getPendingFollowUps` already 500s on one by reading `entry.eventId.title` with no null
guard. `scripts/cleanup-duplicate-clusters.ts` repoints `TrackerEntry` when it collapses a
cluster and must repoint `Folder.eventId` too.

The CSV export (`lib/scan/csv.ts`) escapes **spreadsheet formula injection** — a cell
beginning `=`, `+`, `-`, `@`, tab or CR is executed as a formula by Excel and Sheets, and
every cell here comes from a QR code somebody else generated. It also emits a UTF-8 BOM,
without which Excel on Windows mangles non-ASCII names. The route serving it must send
`Cache-Control: no-store` — do **not** copy the ICS route's `public, max-age=3600`, since
that is a shared calendar and this is one person's private contact list.

**Offline capture** (`lib/scan/outbox.ts`) writes every scan to **IndexedDB first**, then
posts. `POST /api/contacts` and `POST /api/contacts/sync` are idempotent on `clientId` and
answer a replay with **200 and the existing document, never 409** — that is the whole reason
a queued scan can be retried on a saturated conference network without duplicating anybody.
The queue is app-level, not in the service worker, because `sw.js` returns early for every
non-GET request, has no Background Sync wired (and iOS has none), **deletes every
non-current cache on activate** (so Cache Storage would lose the queue on a version bump),
and exposes no page↔worker channel.

> **`sw.js` is v3, and the bump fixed a real cross-account leak.** v2 cached every successful
> API GET into an origin-wide cache and sign-out did not purge it, so signing out, signing in
> with a different Google account and going offline served the PREVIOUS user's tracker
> entries and contacts. v3 makes every private API path **network-only** and adds a
> `purge-caches` message the app sends before `signOut()`. The cost, stated plainly: private
> data can no longer be read offline. Unsynced captures are unaffected — they live in
> IndexedDB, which the cache sweep cannot touch.

> **`viewportFit: 'cover'` is set in `app/layout.tsx` and it is global.** Without it
> `env(safe-area-inset-*)` resolves to 0 everywhere, which is why the mobile bottom nav's
> `max(6px, env(safe-area-inset-bottom))` was always just 6px. The scan and card screens are
> full-bleed and need the real insets — but changing it affects **every** page, so re-check
> the feed and tracker after touching it.

> **A `User` row can be missing for a valid session, so use `ensureUser()`
> (`lib/user-record.ts`) rather than `findOne`.** `User.email` is unique, so the sign-in
> upsert `findOneAndUpdate({ googleId }, { email }, { upsert: true })` throws E11000 whenever
> that email already exists under a different googleId — and `auth.ts` used to catch, log and
> continue, leaving no row at all. The dev-only provider hits this on **every** sign-in for an
> account that has also used real Google, because its googleId is `devlogin:<email>` rather
> than the Google `sub`. Found when `/api/me/card` returned 404 for a perfectly good session.

> **NEVER USE `sparse` ON A COMPOUND UNIQUE INDEX. Use `partialFilterExpression`.** On a compound
> index, `sparse` omits a document only when **every** indexed field is missing. Any always-present
> field in the key — `userId`, here — means every document gets indexed, with `null` standing in for
> the field you meant to skip, and `unique` then permits exactly ONE such row.
>
> This shipped, and it capped every user at **one folder**. `{ userId, clientId }` was declared
> `{ unique: true, sparse: true }`; folders created in the app carry no `clientId`, so the second
> one always collided:
>
> ```
> E11000 duplicate key error index: userId_1_clientId_1 dup key: { userId: "1001028…", clientId: null }
> ```
>
> One folder per event is the core of this feature, and it was capped at one folder, full stop.
> `POST /api/folders` made it worse by assuming every 11000 was the `{ userId, slug }` name clash
> and answering **"You already have a folder with that name"** — naming the only thing that was not
> wrong. A duplicate-key handler must branch on `err.keyPattern`, or a schema bug gets reported as
> user error. Fixed with `partialFilterExpression: { clientId: { $type: 'string' } }`.
>
> **A schema edit alone does not fix a deployed database.** Mongoose creates a missing index and
> otherwise leaves an existing one exactly as it found it — `createIndex` with different options on
> the same key raises IndexOptionsConflict rather than migrating. Run
> `scripts/migrate-folder-clientid-index.ts --apply`.
>
> `Contact` is unaffected: its `clientId` is `required`, so a plain unique compound index is right
> there. **`Source.index({ kind, handle }, { unique: true, sparse: true })` is the same shape and is
> latent** — it survives only because its 76 handle-less rows also lack `kind`, so `sparse` really
> does omit them. The first row with a `kind` and no `handle` will collide with the next one.

> **WHAT THE SCAN FEATURE DOES NOT DO YET (measured 2026-08-24).** Capture works and has real
> usage — an `"api days"` folder holding a `qr-linkedin` contact under a real Google `sub`,
> captured through the production path. **Recall does not.** None of the following exists, and
> every one is UI-only work against a data layer that already supports it:
>
> - **No cross-folder view of people, and no search.** `GET /api/contacts` already serves it
>   (capped `.limit(2000)`, `app/api/contacts/route.ts:40`) and nothing consumes it — there is no
>   `app/contacts` or `app/people` — so "who do I know at Razorpay" is unanswerable in the product.
> - **Repeat connections are surfaced NOWHERE in the scan/folder UI.** `Contact.contactKey` exists
>   precisely so "have I met this person before" is an index lookup rather than a lowercased-name
>   guess, and its only consumer is the old `/dashboard`. The most valuable networking signal in
>   the feature is invisible.
> - **No folder rename, delete or archive.** `PATCH /api/folders/[id]` handles
>   name/note/venue/eventDate/archive and `DELETE` cascades its contacts; the UI calls neither. The
>   only `PATCH` calls anywhere in `app/` are `app/folders/[id]/page.tsx:138` and `:171`, both to
>   `/api/contacts/`.
> - **No move-contact-between-folders**, though `PATCH /api/contacts/[id]` already validates that
>   the destination folder is yours.
> - **`Contact.tags[]` has no input.** It is in the model and in the CSV export and is always
>   empty; `ContactFields.tsx:28` types it and renders no field.
> - **A pending (unsynced) capture cannot be edited or discarded** — the edit sheet blocks it by
>   design, so a name mistyped offline stays wrong until it syncs.
> - **CSV export is a bare `<a>`** — no loading or error state, so a 500 renders a raw error page.

> **`Folder.eventId` IS ALWAYS NULL IN PRACTICE, WHICH MAKES CORRECT CODE UNREACHABLE.** Nothing in
> the UI links a folder to a corpus event. So the `folder.eventId ?? folder._id` branch in
> `detectRepeatConnections()` — added specifically so a migrated contact and its legacy twin are
> not counted as two separate events — can never take its better half. Consequence today: two
> folders for one event still count as two events, and one folder per event is the only shape that
> behaves. The logic is right and is untestable through the product. **Any fix starts with a UI
> that SETS `eventId`, not with the detection code** — that is the trap, because the detection code
> is what looks wrong.

> **UPDATE — a UI that sets it now exists, so the paragraph above is history for NEW folders only.**
> Moving a tracker entry to **Confirmed** or **Attended** auto-creates a folder for that event via
> `ensureFolderForEvent()` (`lib/contacts/service.ts`), wired into `PUT /api/tracker/[id]`, and that
> path DOES set `eventId`. So `detectRepeatConnections()`'s better branch is finally reachable — for
> folders created that way. Every folder made by hand still has `eventId: null`, and the three in the
> database as of 2026-08-24 all do, so the trap above still applies to them. There is no backfill:
> guessing which event a hand-named folder meant is not something a script should decide.
>
> `ensureFolderForEvent` has three outcomes and the third is the interesting one — **`adopted`**.
> `{ userId, slug }` is unique, so if the user already made a folder with that event's name by hand,
> creating would throw E11000; it links the existing folder to the event instead. The manual and
> automatic paths converge on one folder per event rather than racing to own it, and nobody ends up
> with "Databricks Hackathon (2)". The other two are `created` and `linked` (already linked, do
> nothing — idempotent, so Confirmed → Attended → Confirmed makes exactly one folder).
>
> It is **non-fatal by design**: the status change has already committed and is what the user asked
> for, so a folder failure is logged, not turned into a 500 that makes a successful move look broken.
> And note the side effect on tooling — `diag-tracker-flow.ts` moves through Confirmed and Attended,
> so it now creates a folder and had to learn to delete it (matched on `eventId`, never on name,
> which would also delete a hand-made folder for the same event).

> **`public/sw.js` v3 IS UNVERIFIED, AND CANNOT BE VERIFIED UNDER `npm run dev`.** `app/layout.tsx`
> unregisters every service worker and deletes every cache in development, so offline behaviour
> needs `npm run build && npm start` with `NEXTAUTH_URL` set. Three checks constitute verification:
> (1) offline, a private API GET such as `/api/folders` must **fail** rather than serve a cached
> copy — that is the fix working, and losing offline reads of private data is deliberate; (2) after
> `signOut()`, `caches.keys()` is empty; (3) sign out, sign in with a **different** Google account,
> go offline, and confirm the first account's contacts are unreadable — the leak v3 exists to
> close. Two smaller gaps: `/tracker` was never re-checked under the global `viewportFit: 'cover'`,
> and `lib/security/rate-limit.ts` was never driven to a live 429 (11 rapid POSTs to
> `/api/intake/<token>` should give ten 201s then a 429 carrying `Retry-After`).

> **VERIFYING IN ISOLATION WHEN OTHER SESSIONS SHARE THIS CHECKOUT.** **`git stash` is unsafe
> here** — it silently captures other sessions' uncommitted work, and a later `pop` either
> conflicts or reverts edits made in the meantime. Learned the hard way: a `--keep-index` snapshot
> swallowed another session's `app/page.tsx` fix, and the `pop` failed because that file had moved
> on. Use a throwaway worktree instead: `git worktree add --detach`, junction `node_modules` from
> the main checkout, and **copy `.env.local` in** — a worktree otherwise reports every credential
> unset. Then run **`next dev --webpack`**: Turbopack rejects a junctioned `node_modules` with
> "Symlink … points out of the filesystem root" and every request hangs. **Warm the routes with
> `curl` before running any diag script** — a cold webpack compile of `/api/auth/csrf` exceeds
> their `AbortSignal.timeout(45000)` and reads as a failure. And **never `npm run build` against a
> `.next` that a dev server is using**: it replaces the route manifest underneath, producing
> phantom 404s on routes that exist (observed: 7 false FAILs in `diag-api-auth.ts` on
> `/api/me/card` and `/api/folders/[id]*`).

### 10. Digest (`lib/notifications/`)

`generateDailyDigest()` assembles new events (24 h), upcoming deadlines, tracker updates, follow-up reminders, and **unhealthy sources** — a source that silently stops producing events is reported rather than quietly shrinking the feed.

### 11. Automation

`.github/workflows/daily-scrape.yml` and `daily-digest.yml` run at 8 AM IST. Secrets: `MONGODB_URI`, optionally `NVIDIA_API_KEY`/`NVIDIA_MODEL`/`ICA_*`/`ANTHROPIC_API_KEY`, and `RESEND_API_KEY`.
