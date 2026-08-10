# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

> **Next.js version warning (from AGENTS.md, repeated because it governs almost every change here):** This repo pins Next.js `16.2.9`, which has breaking changes from older releases. Before writing any Next.js code, read the relevant guide in `node_modules/next/dist/docs/` and heed deprecation notices. Notably, route protection lives in **`proxy.ts`** at the repo root (this version's middleware equivalent) — there is no `middleware.ts`.

## Commands

```bash
npm run dev          # start dev server (http://localhost:3000)
npm run build        # production build
npm run start        # serve the production build
npm run lint         # eslint (flat config: eslint.config.mjs)
npm run scrape       # full pipeline → MongoDB (~5-10 min, ~700 upstream requests)
npm run send-digest  # generate + email the daily digest via Resend
```

`npm run scrape` flags: `--no-llm` (keyword tagging only, fast), `--fast` (skip Eventbrite + the company-page sweep), `--no-prune`.

There is **no test runner** configured — no `test` script and no test files exist. Do not assume a testing framework; if asked to add tests, choose and wire one up explicitly. What exists instead is a set of read-only diagnostic scripts (below), which is how every claim in this document was verified.

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
| `retag-events.ts` | Re-tag stored events with the LLM, **replacing** categories. `--ongoing`, `--all`, `--limit N`, `--dry`. |
| `migrate-events.ts` | Backfill documents written before `clusterKey` / `lastSeenAt` / `isTechEvent` existed. |
| `cleanup-implausible.ts` | Delete evergreen adverts and impossible date ranges. |
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

`scrape.ts`, `send-digest.ts` and `seed.ts` back the npm scripts; `load-env.ts` is the
shared `.env.local` loader every script imports first. `generate-icons.js` is plain
JS: `node scripts/generate-icons.js`.

## Environment

Copy `.env.example` → `.env.local`. Required: `MONGODB_URI` (defaults to `mongodb://localhost:27017/pulseblr`), `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL`. `RESEND_API_KEY` is optional (email digests).

LLM tagging cascades **IBM ICA → NVIDIA NIM → Anthropic → keyword heuristics**, and every tier is optional — with no key at all the pipeline still runs on keywords.

> **`NVIDIA_MODEL` matters more than it looks.** Verified 2026-08-09: `z-ai/glm-5.2` and `meta/llama-3.3-70b-instruct` are both listed by `GET /models` on a valid key but never respond (>25 s timeout), while `meta/llama-3.1-8b-instruct` answers in ~376 ms. Classification is a small task, so the 8B model is the right fit. Run `scripts/check-nvidia-models.ts` before changing it. The tagger also fails over to a known-good model on its own and trips a circuit breaker after 3 consecutive provider failures, so a bad config degrades to keywords in seconds rather than adding ~46 s per batch.

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
- **`connectionScore`** (0-100, `lib/events/connection-score.ts`) — a deterministic
  ranking signal for "will I leave with useful contacts", powering the
  **"Best for connections"** sort. In-person is the biggest term; attendee counts are
  log-scaled; and titles matching certification/cohort/webinar/course are penalised
  hard, because those put you in an audience rather than a room. Measured effect: real
  practitioner meetups with food and a company host score 88-99, while
  "Get Google AI Certified … Cohort" and "Webinar: …" land at 0-2.

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

> Keyword regexes are load-bearing when the LLM is unavailable, and loose ones do real damage: a bare `\bpm\b` matched the "PM" in "6 PM" and tagged a fifth of the corpus `Product/Design`. Keep them specific.

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

NextAuth v5 (Auth.js) config lives in the root `auth.ts`, imported as `@/auth`. Strategy is **JWT** (no DB session): the `jwt` callback stashes the Google `sub`/email/name/picture into the token *and* upserts the `User` doc by `googleId` on first sign-in; `session` surfaces `token.sub` as `session.user.id`. Server code uses `getCurrentUserId()` (`lib/auth-helpers.ts`). Protection is two-layered: `proxy.ts` redirects `/dashboard`, `/tracker`, `/add-event` to `/login`, and API routes filter by `userId`. **Everything user-owned must be scoped by `userId`** — `TrackerEntry` has a compound-unique index `{ userId, eventId }`.

### 7. App layer

- `lib/format.ts` — all date/label formatting, **pinned to Asia/Kolkata**. Never format event times with the ambient locale; a server in UTC would put a 9 PM IST event on the wrong day.
- `lib/event-types.ts` — the client-side event shape (dates are ISO **strings** over JSON, not `Date`).
- Feed (`app/page.tsx`) is a date-grouped **time rail** with a "Happening now" bucket pinned above the day groups, plus a grid view, faceted filters with live counts, debounced search, and infinite scroll.
- Event covers use a plain `<img>`, not `next/image`, on purpose: covers come from a long and growing list of third-party CDNs, and `remotePatterns` would break every time a source changes host. The fallback is a category-tinted monogram.
- Tracker (`app/tracker/page.tsx`) is a drag-and-drop kanban with optimistic updates and rollback, a list view, and a "follow-ups due" strip on top.

### 8. Career intelligence (`lib/helpers/phase6.ts`)

Pending follow-ups, repeat-connection detection (same person across 2+ events), target-company/recruiter detection (`DEFAULT_TARGET_COMPANIES` is hardcoded — **not yet DB-backed**), and `getStats(userId)`. Surfaced via `app/api/phase6/*`.

### 9. Digest (`lib/notifications/`)

`generateDailyDigest()` assembles new events (24 h), upcoming deadlines, tracker updates, follow-up reminders, and **unhealthy sources** — a source that silently stops producing events is reported rather than quietly shrinking the feed.

### 10. Automation

`.github/workflows/daily-scrape.yml` and `daily-digest.yml` run at 8 AM IST. Secrets: `MONGODB_URI`, optionally `NVIDIA_API_KEY`/`NVIDIA_MODEL`/`ICA_*`/`ANTHROPIC_API_KEY`, and `RESEND_API_KEY`.
