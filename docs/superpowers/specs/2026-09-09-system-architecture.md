# PulseBLR — system architecture

**Date:** 2026-09-09 · **Status:** design · High-level system design for the hybrid product.
Implementation detail lives in the two companion specs (`…hybrid-events-people-architecture-design.md`,
`…events-surface-design.md`).

---

## 0. What we took from the reference brief, and what we did not

The reference brief describes an event **hosting** platform: `Registration`, `Payment`, `TicketType`,
`capacity`, `waitlistEnabled`, check-in, refunds, Razorpay. Those entities only exist if **you own the
event**. It has organisers typing events in, and consequently **no ingestion layer at all**.

PulseBLR does not own events. It discovers them across 423 sources and links out. Its ingestion
pipeline *is* the product's hard part. So the brief is a blueprint for a different business — one with
a payments stack, GST handling and refund liability, competing directly with Luma and Konfhub.

**Core ideas adopted:**

| Idea | Why it fits |
| --- | --- |
| Browse fully without an account; authenticate only to *act* | Already how the app behaves; makes it a shareable, indexable surface |
| URL-driven, shareable filter state | Costs little, fixes the back button, and doubles as distribution |
| Venue / Organizer / Topic as first-class browsable entities | Real SEO surfaces we have none of |
| Onboarding that captures interests → personalised ranking | The only way a 297-event feed feels small enough to act on |
| Saved events → reminders → notifications | The retention loop that does not exist today |
| Organizer self-serve submission behind admin review | Half-built already (`/add-event` + submissions queue) |
| Moderation, reports and an audit log as product features | The operator console we specced |
| SEO discipline: per-page metadata, JSON-LD, sitemap, clean slugs | Cheapest compounding growth lever |

**Rejected:** ticketing, payments, capacity/waitlist, check-in (all imply owning the event) and
PostgreSQL/Prisma (the dedup, geo and text machinery is built on MongoDB; migrating buys nothing).

---

## 1. Context

```
                    ┌──────────────────────────────────────────────┐
   Anonymous  ─────▶│                                              │
   visitor         │                  PulseBLR                    │
                    │   discover events · remember people          │
   Signed-in  ─────▶│                                              │
   professional     └──────────────────────────────────────────────┘
                       │            │             │           │
   Operator   ────────▶│            │             │           │
   (admin)             ▼            ▼             ▼           ▼
                 Event sources   MongoDB      LLM tiers    Resend
                 Luma · Meetup    Atlas       ICA→NVIDIA    email
                 Bevy · District  (bom1)      →Anthropic
                 Devfolio · …                 →keywords
                                                            Google
                                                            OAuth
```

Three actors, and the middle one is the whole business: an anonymous visitor arrives from search or a
shared link, and becomes a signed-in professional at the moment they want to *keep* something — a
saved event, or a person they met.

---

## 2. Containers

```
┌─────────────────────────── Vercel · region bom1 ───────────────────────────┐
│                                                                            │
│   Next.js 16.3.2 app                                                       │
│   ├── public, cacheable    server components + ISR   (SEO surfaces)        │
│   ├── per-user overlays    client islands             (saved, met-here)    │
│   ├── ~40 route handlers   guard-first                                     │
│   └── MCP endpoint         /api/mcp                                        │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
             │                                            ▲
             ▼                                            │
   ┌──────────────────┐                    ┌──────────────────────────────┐
   │  MongoDB Atlas   │◀───────────────────│  GitHub Actions (cron 08:00) │
   │  India region    │                    │  · npm run scrape  5-10 min  │
   └──────────────────┘                    │  · npm run send-digest       │
             ▲                             │  · Playwright render (§2b)   │
             │                             └──────────────────────────────┘
   ┌──────────────────┐
   │ Browser          │  IndexedDB outbox (captures survive offline)
   │ service worker   │  private APIs network-only; static cached
   └──────────────────┘
```

**Why the scraper is not serverless.** A full run is 5–10 minutes and ~700 upstream requests, and the
company-microsite path needs a headless browser. That is past every serverless limit. Running it on a
GitHub runner is what makes hosting the app on serverless viable at all — and it means there is no
shared secret and no API route to protect.

**Why `bom1`.** Every user, the whole corpus and the Atlas cluster are India-region, and all formatting
is pinned to Asia/Kolkata. A US default region adds a round trip to every query for nothing.

---

## 3. Bounded contexts

Four domains. The dependency direction between the first two is the single most important rule in the
system.

```
 ┌───────────────────────────────────────────────────────────────────────────┐
 │  INGESTION            write-only · batch · no user in scope               │
 │  Source · adapters · pipeline · normalizer · dedupHash/clusterKey ·       │
 │  LLM tagging · city gate · pruneStale · connectionScore                   │
 │  owns: lib/scrapers/**, lib/llm/**, lib/companies/**                      │
 └───────────────────────────────┬───────────────────────────────────────────┘
                                 │ produces Event rows
                                 ▼
 ┌───────────────────────────────────────────────────────────────────────────┐
 │  DISCOVERY            public · anonymous-first · cacheable                │
 │  Event reads · buildEventFilter · facets · calendar · search ·            │
 │  relevanceScore · SEO surfaces (event/topic/venue/organizer pages,        │
 │  sitemap, JSON-LD)                                                        │
 │  owns: lib/events/**, app/(public)/**                                     │
 └───────────────────────────────┬───────────────────────────────────────────┘
                                 │  ▲
             Interaction.eventId  │  │   NEVER the reverse
                                 ▼  │
 ┌───────────────────────────────────────────────────────────────────────────┐
 │  RELATIONSHIPS        per-user · private · offline-capable                │
 │  Person · Interaction · Contact · Folder · contactKey · capture/outbox ·  │
 │  merge · follow-ups · export                                              │
 │  owns: lib/people/**, lib/contacts/**, lib/scan/**                        │
 └───────────────────────────────────────────────────────────────────────────┘

 ┌───────────────────────────────────────────────────────────────────────────┐
 │  OPERATIONS           admin · low traffic · high blast radius             │
 │  submissions review · source management · feed quality · audit log ·      │
 │  soft delete · metrics                                                    │
 └───────────────────────────────────────────────────────────────────────────┘
```

### The rule: DISCOVERY MUST NOT DEPEND ON RELATIONSHIPS

Relationships references Discovery (an `Interaction` carries an `eventId`). Discovery never imports
from Relationships. One direction, no exceptions.

Three things follow, and they are why this rule is worth stating as architecture rather than style:

1. **The public surface renders with zero user data**, so it can be cached, indexed and shared. The
   moment an event page needs a `Person` lookup to render, it is no longer cacheable.
2. **A failure in the people layer cannot take down discovery.** Different availability requirements:
   discovery is the front door, relationships is a logged-in tool.
3. **"You met 4 people here" is a client-side overlay, not part of the server-rendered page.** Same
   pattern the feed already uses for saved state. This is the one place the architecture visibly
   constrains the product, and it is the correct trade — SEO and shareability are worth more than a
   server-rendered personal detail.

### The join

```
   Event ◀──── eventId ────  Interaction  ────▶ Person
                                  ▲
                             contactId
                                  │
                               Contact  ────▶ Folder ────▶ Event (denormalised)
```

`Interaction.eventId` is the spine. It replaces today's `Contact → Folder → Event` chain, whose second
hop is null in practice — which is why the tracker reports "People met: 0" over a folder holding forty
scans.

---

## 4. Layers, and what may import what

```
  ┌─ Layer 4  client islands        'use client' · interactivity, per-user overlays
  │            ▲ props only
  ├─ Layer 3  server components     data fetch · generateMetadata · JSON-LD
  │            ▲
  ├─ Layer 2  route handlers        guard FIRST, then validate, then act
  │            ▲                    a route NEVER imports another route
  ├─ Layer 1  services              mongoose · resolvePerson · upsertContact · ingest
  │            ▲
  └─ Layer 0  pure functions        NO mongoose, NO I/O — unit-tested
              buildEventFilter · buildPersonFilter · connectionScore ·
              relevanceScore · contactKey · seo · csv · validators
```

**Layer 0 is where correctness lives.** Every rule that must not drift is a pure function shared by its
consumers, so a filter cannot behave differently between a list, its count and its facets. The
existing three builders (`lib/events/query.ts`, `lib/contacts/query.ts`, and `lib/people/query.ts` to
come) are the same pattern three times, deliberately.

**Two invariants that have already cost real time here:**

- **Guard before validate, in every route.** Reversed, an anonymous caller sending a bad body gets
  `400` instead of `401` — which tells a stranger their payload parsed far enough to be judged.
- **A route module must never import another route module.** Doing it once put *every* `/api/*` path
  into a 404, including `/api/auth/csrf`, because a route file is a framework entry point and importing
  one puts it in a second module graph. Shared code goes to Layer 0 or 1.

---

## 5. Key flows

**Ingestion (nightly, no user).**
```
Actions cron → discover handles → scrape per source (isolated try/catch)
  → normalize → city gate → LLM tag (batch 5, cascade ICA→NVIDIA→Anthropic→keywords)
  → derive clusterKey + dedupHash + connectionScore + companies
  → upsert-and-merge (gap-fill only) → pruneStale
```
Every source is isolated: one dead feed contributes zero events and can never fail a run.

**Discovery (anonymous).**
```
GET /events/[id]  → server component → visibilityClause + canViewEvent
                  → generateMetadata + JSON-LD (public only)  → ISR cache
                  → client island hydrates: saved state, "you met here"
```

**Capture (offline-first).**
```
scan/type → IndexedDB FIRST → POST /api/contacts (idempotent on clientId, 200 on replay)
  → pickWritable allowlist → Contact.save() → pre('validate') derives contactKey
  → resolvePerson → recordInteraction('met', eventId)
```
The client never resolves identity — it is offline and cannot see the corpus. The server assigns it.

**Recall.**
```
GET /people → buildPersonFilter → Person list (one card per human, history inside)
GET /people/[id] → Person + Interaction timeline + merge suggestions
```

**Operations.**
```
admin action → requireAdmin → impact preview (what this affects, who tracked it)
  → soft delete / mutate → AuditLog row → undo available
```

---

## 6. Cross-cutting concerns

| Concern | Where it lives | The rule |
| --- | --- | --- |
| **Identity** | `auth.ts`, `lib/api-auth.ts` | Two tiers only: `requireUser` for per-user data, `requireAdmin` for anything global. Admin fails **closed** — unset allowlist means 503, never "any signed-in user" |
| **Visibility** | `lib/events/query.ts`, `lib/events/visibility.ts` | `visibilityClause` for list/aggregate reads, `canViewEvent` for id-addressable reads. Every filter carries the `{$exists:false}` arm — ~1500 documents predate the field, and omitting it does not narrow the feed, it **empties** it |
| **Offline** | `lib/scan/outbox.ts` | IndexedDB first, then post. App-level, not the service worker — `sw.js` returns early for non-GET and deletes non-current caches on activate, so a queue there would be lost on a version bump |
| **Caching** | ISR on public pages; network-only for private APIs in `sw.js` | Public is cacheable *because* Discovery has no user dependency. Private data is never cached — that was a real cross-account leak in v2 |
| **Notifications** | `lib/notifications/**` | Event-triggered beats scheduled. Weekly rhythm by default, daily opt-in. Email first: iOS web push needs a PWA install nobody does |
| **Rate limiting** | `lib/security/rate-limit.ts` | Per-instance memory on serverless, so it is a nuisance filter, not a control. Anything that must actually be bounded needs shared state |
| **Outbound fetch** | `lib/security/safe-fetch.ts` | Every user-supplied URL. Decide on the **expanded address**, never on its spelling |
| **Observability** | diag scripts + admin metrics | Measurements, not impressions. A metric that cannot fall is not a metric |

---

## 7. What we deliberately do not build

Ticketing, payments, capacity and waitlists, attendee check-in — all of them presume owning the event.
No relationship-strength score (a fabricated warmth number is worse than none). No unified search
collection (federate the two builders instead; Mongo permits one text index per collection and events
carry a privacy predicate that must not be routed around). No "who's going" from our own users until
there are enough of them to fill it. No native app yet — the API is REST, so a native client stays
additive whenever it happens.

---

## 8. The architectural bet, stated plainly

Discovery is a **commodity with distribution economics** — someone with a team, a Play Store listing
and weekly SEO output will out-list a solo developer, and one already is. Relationships is a **data
asset with switching costs** — the record of who you met is worth more the longer you use it, and
nobody in this market keeps it.

So the architecture deliberately makes discovery *cheap, cacheable and indexable* — a front door built
for search engines and shared links — and makes relationships *private, offline-capable and
durable*. The one-directional dependency between them is what lets each be optimised for a different
thing without either compromising the other.

The risk in this bet is concentration: if the ingestion pipeline degrades, the front door closes and
the people layer never gets used, because nobody arrives. That is why supply work stays ahead of
everything else in sequencing despite not being the differentiator.
