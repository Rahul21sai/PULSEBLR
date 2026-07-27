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
npm run scrape       # run all scrapers → normalize → LLM-tag → dedup-ingest into MongoDB
npm run send-digest  # generate + email the daily digest via Resend
```

There is **no test runner** configured — no `test` script and no test files exist. Do not assume a testing framework; if asked to add tests, choose and wire one up explicitly.

Scripts under `scripts/` run through `tsx`, not `node` (except `generate-icons.js`, which is plain JS run with `node scripts/generate-icons.js`). Useful ad-hoc scripts: `npx tsx scripts/seed.ts` (seed data), `npx tsx scripts/scrape.ts` (same as `npm run scrape`).

## Environment

Copy `.env.example` → `.env.local`. Required: `MONGODB_URI` (defaults to `mongodb://localhost:27017/pulseblr` if unset), `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL`. LLM tagging degrades gracefully: `NVIDIA_API_KEY` (primary) → `ANTHROPIC_API_KEY` (fallback) → keyword heuristics (no key needed). `RESEND_API_KEY` is optional (email digests).

> Note: `README.md` predates the current LLM setup and describes Anthropic Claude as *the* tagging engine. The code now uses **NVIDIA NIM as primary and Anthropic as fallback** (see commit `5d527c8`). Trust the code / this file over the README where they disagree.

## Architecture

PulseBLR aggregates Bengaluru tech events and layers a per-user career/networking tracker on top. It's a PWA (service worker + `manifest.json`, share-target support). Several concerns interlock:

### 1. Ingestion pipeline (`lib/scrapers/`)
`runAllScrapers()` (`lib/scrapers/index.ts`) orchestrates: **scrape** (Meetup RSS + Luma calendars → `RawEvent`) → **normalize** (`normalizer.ts`: area/format/food heuristics, Bengaluru neighborhood detection) → **LLM-tag** → **dedup-ingest** (`ingestion.ts`). Dedup is the linchpin: `Event.generateDedupHash(title, startDateTime, venue, source)` produces a SHA-256 hash stored in the unique-indexed `dedupHash` field, so re-scraping is idempotent (duplicates are counted, not inserted). Types flow `RawEvent` → `NormalizedEvent` (adds `dedupHash` + tags) in `lib/scrapers/types.ts`.

### 2. LLM tagging (`lib/llm/tagger.ts`)
`tagEventWithLLM` classifies each event into one of 12 categories (see the `category` enum in `lib/models/Event.ts`) plus format/food/etc. Three-tier fallback: **NVIDIA NIM** (`tagWithNvidia`, OpenAI-compatible REST) → **Anthropic Claude** (`tagWithAnthropic`, `claude-3-5-sonnet-20241022`) → **keyword `fallbackTagging`**. The SYSTEM_PROMPT enumerates the exact category taxonomy — keep it in sync with the schema enum if you change categories.

### 3. Auth & per-user scoping
NextAuth v5 (Auth.js) config lives in the root `auth.ts`, imported everywhere as `@/auth` (exports `handlers`, `signIn`, `signOut`, `auth`). Strategy is **JWT** (no DB session): the `jwt` callback stashes the Google `sub`/email/name/picture into the token *and* upserts the `User` doc by `googleId` on first sign-in; the `session` callback surfaces `token.sub` as `session.user.id`. Server code gets the current user via `getCurrentUserId()` (`lib/auth-helpers.ts`). Route protection is two-layered: `proxy.ts` redirects unauthenticated requests to `/dashboard`, `/tracker`, `/add-event` → `/login`, and API routes filter by `userId` themselves. **Everything user-owned must be scoped by `userId`** — `TrackerEntry` has a compound-unique index `{ userId, eventId }`.

### 4. Data model (`lib/models/`)
Mongoose models with a cached global connection singleton (`connectDB` in `lib/mongodb.ts`, `bufferCommands: false`). `Event` is the shared, deduped event corpus (source enum, 12-category enum, area/format/food enums, Phase 6 fields `isTargetCompany`/`recruiterMentioned`/`guestCount`). `TrackerEntry` is per-user application/networking state (status pipeline `New→…→Attended/Rejected`, embedded `connections[]` subdocs with follow-up dates). `Source` tracks scraper configs; `User` mirrors the Google identity.

### Phase 6 analytics (`lib/helpers/phase6.ts`)
Career-intelligence layer over `TrackerEntry`: pending follow-ups, repeat-connection detection (same person across 2+ events), target-company/recruiter detection (`DEFAULT_TARGET_COMPANIES` is a hardcoded list — **not yet DB-backed**), and `getStats(userId)` for the dashboard. Surfaced via `app/api/phase6/*` routes.

### Digest (`lib/notifications/`)
`generateDailyDigest()` (`digest.ts`) assembles new events (24h), upcoming deadlines, tracker updates, and follow-up reminders, then `formatDigestAsText`/`formatDigestAsHTML` render it. Footer links are hardcoded to `http://localhost:3000` — update for production.

### App layer
App Router pages in `app/` follow a "Stitch" design system (`app/components/`). REST API under `app/api/**/route.ts` (`events`, `tracker`, `sources`, `scrape`, `scrape-url`, `notifications`, `phase6/*`, and the `auth` catch-all). Path alias `@/*` maps to the repo root.

### Automation
`.github/workflows/daily-scrape.yml` and `daily-digest.yml` run the scraper and digest on a schedule (8 AM IST). They need `MONGODB_URI`, `NVIDIA_API_KEY`/`ANTHROPIC_API_KEY`, and `RESEND_API_KEY` set as GitHub secrets.
