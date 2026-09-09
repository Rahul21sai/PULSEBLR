# PulseBLR — the events surface

**Date:** 2026-09-09 · **Status:** design · **Companion to:** `2026-09-09-hybrid-events-people-architecture-design.md`

---

## Why

The hybrid has two jobs. **Events acquire; people retain.** A visitor arrives through an event page,
and stays because the app remembers who they met. This spec covers the acquiring half, and its
benchmark is explicit: match B2Bangalore on discovery where it matters, and beat nobody at the things
that are actually their paywall.

**Verified gaps (2026-09-09), not estimates:**

- **The only two pages in the app with `generateMetadata` are `/c/[token]` and `/f/[token]`, and both
  are deliberately `noindex`.** Event pages have no metadata, no OG tags, no OG image. Sharing an
  event link into WhatsApp today produces a bare URL with no preview card.
- **Zero `Event` JSON-LD anywhere.** The scraper *reads* schema.org from other sites; our own pages
  emit none. B2Bangalore emits `Event` + `Place` + `Offer` + `BreadcrumbList` per event.
- **No category routes.** The route list is `add-event, admin, api, c, calendar, card, companies,
  dashboard, events, f, folders, login, people, scan, settings, tracker`. B2Bangalore has 27 SEO
  landing pages.
- **No fields for** audience, perks (only `hasFood: yes|no|unknown`), agenda or speakers. No tier —
  only `spotlightAt`, which is an editorial pin.
- `attendeeCount` exists on **3%** of events, which gates one whole class of shelf (below).

**What we deliberately do NOT copy:** the paywall, credits, flagship gating, the sponsor/venue/swag
marketplaces, and referral credits. Their paid product is *access to gated rooms* — a relationship
business, not software. Competing there is not winnable and not the point.

---

## 1. Findability — the cheapest growth lever, and it compounds

### 1.1 `generateMetadata` + a generated OG image on `/events/[id]`

**Read the Next 16.3 metadata guide in `node_modules/next/dist/docs/` first** — per `AGENTS.md`, this
version differs from training data, and metadata/OG APIs are exactly where that bites.

**The OG image must be GENERATED, not the scraped cover.** Three reasons, and the first is measured:

1. The click-through crawl recorded **39 cover images blocked** by
   `ERR_BLOCKED_BY_RESPONSE.NotSameSite` and `ERR_BLOCKED_BY_ORB` — Snowflake, ClickHouse and
   Meetup CDNs refuse cross-origin embedding. An OG image pointing at those fails silently in the
   scraper that renders the preview.
2. Scraped covers are often posters whose text is illegible at card size.
3. A generated card is branded and consistent, which is the whole point of a shared link.

Generate title + date + venue + the connection meter, using our own bundled font. **Trap:** Next's
`ImageResponse` cannot use arbitrary system fonts and has a constrained runtime — bundle the font file
and keep the template to text and shapes, no remote images.

### 1.2 `Event` JSON-LD

Emit `Event` with `name`, `startDate`, `endDate`, `eventAttendanceMode`, `location` (`Place` +
`PostalAddress`, or `VirtualLocation` for online), `offers` (`Offer` with `price`, `priceCurrency`,
`availability`), `organizer`, `image`, `description`, `url`.

> **TRAP — never emit JSON-LD or indexable metadata for a non-public event.** `visibility: 'private'`
> and `'pending'` events are reachable at `/events/[id]` by their owner. Emitting structured data for
> them would publish another user's private event into Google's index — a disclosure far worse than
> the in-app leak the audit already fixed. Gate on the same `canViewEvent` result the page already
> computes, and set `robots: { index: false }` whenever `visibility` is present.

### 1.3 Topic landing pages — `/topics/[slug]`

Generated from dimensions that already exist and are populated: the 22 categories, resolved areas,
the companies with events, and format/price. `generateStaticParams` + ISR.

> **TRAP — do not generate the full matrix.** 22 categories × areas × companies is hundreds of pages,
> most with nothing on them, and Google treats thin templated pages with a swapped noun as doorway
> pages and penalises the site. **Only emit a page with ≥ 3 upcoming events**, and make each one
> genuinely useful — real listings, a written paragraph, and a "when do these usually happen"
> answer — not a template. Better 25 real pages than 300 empty ones.

Also add `app/sitemap.ts` and `app/robots.ts`, excluding `/c/`, `/f/`, `/admin`, and every
non-public event.

---

## 2. Card metadata — the two cheapest things worth stealing

### 2.1 `audience` — who the event is for

A controlled vocabulary, not free text: `students`, `juniors`, `senior-engineers`, `founders`,
`leaders`, `product`, `data`, `security`, `sre`, `researchers`.

This answers *"is this for someone like me"* better than any topic tag, and it's the reason
B2Bangalore's blurred cards still create desire — "Founders · Leaders & execs" tells you enough.

> **TRAP — derive it in the SAME LLM call as categories, never a second call.** The audit documented
> that the tagger classifies in batches of 5 because batch-of-8 caused enough wrong-length responses
> that only 8 of 840 events got LLM tags, and that adding output competes for the same budget. A
> second call per event doubles cost and doubles the failure surface. Add fields to the existing
> response shape, keep the batch at 5, and give `audience` a keyword floor like every other derived
> field so it degrades rather than disappears when providers are down.

### 2.2 `perks` — what you actually get

`perks: string[]` from a controlled vocabulary: `breakfast`, `lunch`, `snacks`, `swag`, `certificate`,
`recording`, `drinks`.

> **TRAP — `hasFood` must survive as a derived field.** Two things read it: the `foodOnly` filter in
> `buildEventFilter`, and `connectionScore`'s `hasFood === 'yes'` bonus. Replacing it outright
> silently changes every event's score and breaks a shipped filter. So `hasFood` becomes derived from
> `perks` (`breakfast|lunch|snacks` present ⇒ `'yes'`) and both stay in the schema.

### 2.3 `tier` — flagship vs community vs advert

Derived: `'flagship' | 'community' | 'advert'`, from venue class, host company, attendee count,
category (`Conference`) and price.

> **TRAP — do NOT overload `spotlightAt`.** CLAUDE.md is explicit that `spotlightAt` is **editorial,
> not derived**: a human chose it and nothing may recompute or clear it, which is why `mergeInto`
> uses an allowlist of scraped fields. `tier` is a separate, freely-recomputable field. And it is a
> **browse label, not a second ranking** — `connectionScore` remains the only ordering signal, or the
> two will disagree on the same page.

Useful side effect: `tier: 'advert'` gives the operator console a real handle on the coaching-centre
junk that `connectionScore` buries but does not exclude.

---

## 3. Depth — agenda and speakers, and where the hybrid pays off

```
agenda:   [{ startsAt, title, speakerName?, speakerCompany? }]
speakers: [{ name, title?, company?, linkedin? }]
```

The vLLM event page on B2Bangalore carried five named speakers with their employers (Red Hat, IBM,
AMD, NxtGen) and a timed agenda. That is the content that makes a page worth landing on from search,
and we have nowhere to put it.

**Where it comes from:** mostly not from platform APIs. The realistic sources are the company-microsite
LLM path (agenda is precisely what sits in that rendered text), richer Luma descriptions, and
organiser submissions. Treat it as sparse and render nothing when absent.

### The hybrid feature nobody else can build

Once `speakers` exists and the people spine lands, the event page can say:

```
  SPEAKING
   Asha Rao · Razorpay          you met her at IndiaFOSS, Jul     ← Person match
   Pravein Kannan · IBM
```

That is the events↔people join paying off on the *events* side, and it is unreachable for a product
with no contact layer.

> **TRAP — never auto-create a `Person` from a speaker.** Speakers are not your contacts. Match
> against existing Persons by name + company **for display only**. Creating rows would pollute
> `/people` with people you have never met and corrupt `eventCount`.

---

## 4. Shelves — and the one to skip

| Shelf | Data it needs | Status |
| --- | --- | --- |
| Happening now | `startDateTime` | **exists** |
| Spotlight (pinned) / Curated by us | `spotlightAt`, `source: 'manual'` | **exists** |
| **Hosted by a company you follow** | `Event.companies` × `User.targetCompanies` | **buildable today** — both fields exist and are populated |
| Free this week | `isFree` (84% coverage) | buildable today |
| Near you | `area` (52%, `Other` on 201) | gated on the area-resolution fix |
| Ends soon | `registrationDeadline` | buildable today |
| ~~Filling up fast~~ | `attendeeCount` — **3% coverage** | **skip** |

> **Do not copy "Filling up fast".** It is their best shelf and our worst: `attendeeCount` exists on
> 38 of 1158 events because only Luma supplies it, so the shelf would render nearly empty and read as
> a broken feature. **"Hosted by a company you follow"** is the better shelf and it uses data already
> in the database — it is also closer to this product's thesis than a popularity signal is.

---

## 5. Distribution — the MCP server

Their free tier advertises an MCP server with 16 tiered tools. Ours should ship, and it should lead
with the half they cannot match.

**v1, no auth, read-only public data:** `search_events`, `get_event`, `events_near`, `trending_topics`.
Nothing user-specific, so there is no OAuth to build and no data to leak.

**v2, authed:** `my_saved_events`, and then the differentiator — `my_people`, `who_did_i_meet_at`,
`my_follow_ups`. *"Who do I know at Razorpay?"* answered inside Claude is something no competitor can
offer, and it is on-brand for a codebase built in Claude Code.

> **TRAP — v2 needs per-user OAuth on the MCP endpoint, which is real work.** Ship v1 first; do not
> block a two-day public-search server on an auth flow.

Also cheap and already half-built: the **weekly Monday digest** (`lib/notifications/` exists and is
unused for this) and a public digest page that doubles as an indexable weekly summary.

---

## Not building

Paywall, credits, flagship gating · sponsor / venue / swag marketplaces · referral credits · native
app · Chrome extension · a second ranking system competing with `connectionScore` · "who's going"
sourced from our own users.

---

## Risks

- **Thin landing pages are a penalty, not a neutral.** The ≥3-events floor and real per-page content
  are load-bearing, not polish.
- **Tagger budget.** `audience` and `perks` ride the existing call or they degrade the classification
  that already works. Re-measure with `diag-retag-preview.ts` before and after — its rule is that
  FIXED must clearly exceed BROKE with no control regressing.
- **`hasFood` and `connectionScore` are coupled.** Changing how food is stored changes every score;
  re-run `backfill-connection-score.ts` and diff the distribution.
- **JSON-LD on a non-public event is a Google-indexed privacy leak**, strictly worse than an in-app
  one.
- **`ImageResponse` runtime limits** — bundled fonts only, no remote images.

## Verification

- Google Rich Results test passes on a public event page; **fails to find `Event` markup on a private
  one** — assert both directions.
- OG preview renders in a link debugger for a shared event URL; the image is our generated card, not a
  third-party CDN.
- `app/sitemap.ts` contains no `/c/`, `/f/`, `/admin`, or non-public event URL — assert with a script.
- A new `diag-landing-pages.ts` reporting any generated topic page below the 3-event floor.
- `diag-tech-fp.ts` and `diag-retag-preview.ts` re-run after the tagger change; `foodOnly` filter and
  score distribution unchanged except where `perks` genuinely adds information.
- `npm test`, `npx tsc --noEmit`, `npm run lint`, `npm run build` clean before each commit.

---

## How this sequences against the people spine

Both specs are live at once, and they interleave rather than queue:

```
  Supply (Phase 0)     ──▶  everything else is worth more after this
  Events §1 findability──▶  acquisition; independent of the spine
  People spine (Plan A)──▶  the moat; independent of events §1
  Events §2 metadata   ──▶  needs the tagger change
  Events §3 speakers   ──▶  needs BOTH the spine and §2
  Events §5 MCP v1     ──▶  independent, two days, high signal
  Nav restructure (B)  ──▶  last; needs the spine
```

Only §3 and the nav restructure have hard dependencies. Everything else can ship in any order, which
is what makes this safe to do alongside a full-time job.
