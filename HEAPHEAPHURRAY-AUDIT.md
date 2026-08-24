# Audit: events.heapheaphurray.com vs PulseBLR

**Audited** 2026-08-24. **Read-only** — no account created, no data submitted, nothing written to their site.

Every number here is measured, and the script that measured it is named so you can re-derive it:

| Script | What it established |
| --- | --- |
| `scripts/probe-heapheaphurray.ts` | robots.txt, stack, discovery surfaces, whether event data is in the response |
| `scripts/probe-hhh-round2.ts` | full JSON-LD field coverage, upstream hosts, what is gated |
| `scripts/probe-hhh-round3.ts` | their keyword vocabulary, city spread, overlap against our corpus |
| `scripts/probe-hhh-round4.ts` | per-event Luma calendar identity, and why we miss what we miss |
| `scripts/verify-hhh-calendar.ts` | the seed gate applied to the calendars the audit surfaced |
| `scripts/diag-city-spelling-dupes.ts` | a suspected `clusterKey` weakness — **disproved** |
| `scripts/diag-tag-supply.ts` | whether `Event.tags` could back a tag facet — **it cannot** |
| `scripts/diag-meetup-geo-leak.ts` | the off-city leak this audit uncovered as a side effect |

---

## Bottom line

1. **There is no account to create. Do not sign up.** `/login` and `/signup` both return 404, there is no `/api/*`, no RSS, no ICS and no per-event URL. All 20 of their events are already public in the homepage `Event` JSON-LD, uncapped. The email you offered was not needed and was not used.
2. **PulseBLR is substantially ahead of them.** 1,212 upcoming events against their 20; 9 live sources against their 2 upstreams. We carry description, image, organizer, venue, address, lat/lng, price, currency, attendee count and capacity — their JSON-LD has **0% description, 0% image, 0% organizer, and offers on 10%**. This is not a competitor to defend against; it is a small, tidy reference implementation with one or two things to teach.
3. **Do not build an adapter for them.** Their upstreams are Luma (15 of 20) and Devfolio (5 of 20) — both of which PulseBLR already scrapes directly, with far richer fields. Scraping them would be scraping a thinner proxy of sources we already have.
4. **Coverage overlap produced one gap, and it evaporated on inspection.** Of their 5 Bengaluru events we already had 4. The fifth, `JumpStart Bharat: Bengaluru`, was a same-day event now past, on a *touring* calendar with 0 upcoming Bengaluru dates.
5. **The single transferable idea is their AI vocabulary split.** They subdivide AI five ways — `AI/ML`, `Agents`, `GenAI`, `LLM`, `MLOps` — where PulseBLR has one `AI/ML` bucket. `Agents` is on 6 of their 20 events. That is the hottest topic in Bengaluru tech right now and we have no way to filter for it.
6. **The audit's real value was accidental: it found a live bug in PulseBLR.** The Meetup geo guard is **dead code** and cannot reject anything, which has put 19 in-person out-of-city events into the corpus and 9 into the default tech feed. Details in "Defects found" below. This has nothing to do with their site.

---

## What the site actually is

Next.js App Router on Vercel. One page. That is the whole product.

| Property | Measured |
| --- | --- |
| `robots.txt` | `User-Agent: * / Allow: /` — crawling explicitly permitted |
| `sitemap.xml` | exactly **one** `<loc>`: the homepage |
| Event detail pages | **none** — `/about`, `/events`, `/cities`, `/bengaluru`, `/submit`, `/add-event` all 404 |
| Auth | **none** — `/login` and `/signup` both 404 |
| API | none reachable; `/wp-json/*` returns 403 |
| Events on the page | 20, all in JSON-LD, not capped |
| `<title>` | "Tech Events in India — Conferences, Meetups, Workshops & Hackathons" |

Their JSON-LD field coverage, across all 20:

| Field | Coverage |
| --- | --- |
| `name`, `startDate`, `endDate`, `url`, `location`, `eventAttendanceMode`, `eventStatus`, `keywords` | 100% |
| `offers` | 10% |
| `description`, `image`, `organizer`, `performer`, `maximumAttendeeCapacity`, `inLanguage` | **0%** |

Every event's `url` points off-site:

| Upstream | Count |
| --- | --- |
| `lu.ma` | 15 |
| `*.devfolio.co` | 4 |
| `www.wemakedevs.org` | 1 |

They are an aggregator over Luma and Devfolio. So are we — over nine sources, with the fields they don't carry.

---

## Overlap: their 20 events against our corpus

| Outcome | Count | Detail |
| --- | --- | --- |
| Other Indian cities — correctly out of scope | 14 | Mumbai, Noida, Jammu, Visakhapatnam, Ahmedabad, Agra, Surat, Delhi, Kochi, Hyderabad, Kukas |
| Already in our corpus | 5 | `n8n Bangalore: Founders & Builders Mixer`, `AIBoomi Expert Hours`, `Hands-On: Build Agentic Workflows`, `Inception World Model Hackathon II`, `Founders Running Club :: Bengaluru` |
| Genuine gap | **1** | `JumpStart Bharat: Bengaluru` — `lu.ma/9ozcbva9`, calendar `cal-uoe6JLx8HnATkBp` |

Two notes on method, because both changed the answer:

- An exact-title match first reported `Founders Running Club` as missing. We have it via **Meetup**, titled "**Bangalore**" not "Bengaluru". The spelling differed, not the coverage.
- The one genuine gap does not survive scrutiny. `verify-hhh-calendar.ts` shows `cal-uoe6JLx8HnATkBp` has 5 upcoming events and **0 in Bengaluru** — it is a touring series currently in Kolkata, Guwahati, Lucknow and Prayagraj. Its Bengaluru edition was 2026-08-23 and has passed.

**Action taken.** Two touring calendars were seeded anyway, in `lib/scrapers/adapters/luma.ts`, for the reason the existing seeds document — a seed is scraped every run, whereas the city discover feed only shows what it happens to rank that day:

- `cal-uoe6JLx8HnATkBp` — JumpStart Bharat
- `cal-ZEzAGxvFU094YU2` — AIBoomi (we caught its Bengaluru event by luck of the discover feed, not by knowing the calendar)

Deliberately **not** seeded: `cal-3aH7Cvqdyre9u3j` (Founders Running Club) — 50 upcoming events for exactly 1 in Bengaluru, spread across Ho Chi Minh, Tokyo, Singapore, Dubai and Istanbul, and it is a running club so `isTechEvent` is false regardless. We already have its Bengaluru edition via Meetup.

Verified after seeding: 57 Luma calendars scraped (was 55), 2 events inserted, 0 errors.

---

## Their keyword vocabulary — the one artefact worth copying

100% coverage on their side, counts out of 20 events:

| Keyword | n | | Keyword | n |
| --- | --- | --- | --- | --- |
| AI/ML | 12 | | GCP | 1 |
| Startups | 9 | | Developer Tools | 1 |
| **Agents** | **6** | | JavaScript | 1 |
| GenAI | 5 | | Rust | 1 |
| Networking | 4 | | Java | 1 |
| Go-to-Market | 4 | | SaaS | 1 |
| Founders | 4 | | Students | 1 |
| Product Management | 3 | | Ethereum | 1 |
| No-Code | 2 | | Solidity | 1 |
| Python | 2 | | Robotics | 1 |
| Data | 2 | | Investors | 1 |
| MLOps | 2 | | | |
| Hardware | 2 | | | |
| LLM | 2 | | | |
| Web3 | 2 | | | |

**The insight:** five of their 26 values subdivide AI (`AI/ML`, `Agents`, `GenAI`, `LLM`, `MLOps`). PulseBLR has one `AI/ML` category, and the live corpus is saturated with agentic-AI events — the tech feed's first page is almost entirely "Agentic AI", "AI Agents", "Agent Harness". A user who wants agent engineering and a user who wants classical ML get the same filter chip.

**The catch, measured before recommending it.** The obvious fix is "expose the tags we already collect". `scripts/diag-tag-supply.ts` shows there is nothing to expose:

- 32 of 1,212 upcoming events carry any tag at all
- **8 of 334** tech events do
- **6** distinct tag values exist in the entire corpus
- Meetup, our largest source at 881 upcoming, supplies **1**

So a tag facet cannot be harvested — tags would have to be **generated** by the tagger, competing for the same LLM budget as the categories that already work. That makes this medium-value / medium-effort, not the quick win it looks like.

Also worth noting: 24 of those 32 tagged events carried the literal tag `district`, a source marker my own District adapter was appending into a field meant for organiser topic hints. **Fixed** in `lib/scrapers/adapters/district.ts`.

---

## Verdict: should we scrape them?

**No.** Three independent reasons, any one sufficient:

1. **No new supply.** Their upstreams are Luma and Devfolio; we scrape both directly.
2. **Thinner data.** Their JSON-LD has no description, no image, no organizer. Ingesting them would add rows we'd then have to enrich from the same Luma pages we already fetch.
3. **Nothing to gain on coverage.** 19 of their 20 events are already ours or out of scope.

Their `robots.txt` permits crawling, so this is a value judgement rather than a policy one — unlike LinkedIn, which this project refuses on User Agreement grounds. The answer is still no.

---

## What they genuinely do better

1. **Curation over volume.** Their 20 events have zero noise. Our first page is sorted soonest-first, which means a low-value event that happens to be tomorrow outranks a high-value one next week — `connectionScore` exists and is computed for every event, but the **default sort does not use it**. That is the most actionable product lesson here and it costs one line in `lib/events/query.ts`.
2. **Finer AI vocabulary**, as above.
3. **No login for anything.** So does PulseBLR for browsing — worth confirming it stays that way.
4. **Pan-India by default.** For PulseBLR this is a *deliberate non-goal*, not a gap. Widening scope would dilute the stated purpose and every geo guard in the codebase.

## What PulseBLR should deliberately NOT copy

- **Their single-page, no-detail-page model.** It makes every event unshareable — there is no URL for one event. PulseBLR's `/events/[id]` is more useful, not less.
- **Their city filter.** We are one city on purpose.
- **A flat keyword cloud** in place of a structured taxonomy. Our three-group split (tech topic / event type / everything else) exists because a flat list let "Community/Social (335)" outrank every tech topic.
- **Their thin field set.** Coverage is our advantage; don't trade it for their simplicity.

---

## Defects found in PulseBLR (nothing to do with their site)

### 1. The Meetup geo guard is dead code — confirmed, not yet fixed

`lib/scrapers/adapters/meetup.ts`:

```ts
if (isBengaluru({ text: event.description }) === false) continue;
```

commented "reject an event that positively names another city". It cannot. `isBengaluru`'s only text-driven `return false` sits inside `if (location)`, where `location` is built from `venue` + `address` — and that adapter's **own file header** documents that Meetup's ICS emits no `LOCATION`. With only `text` set the function returns `true` or `null`, so `=== false` is never satisfied.

Measured consequence (`scripts/diag-meetup-geo-leak.ts`): of 886 upcoming Meetup events, **23** name another city in title/venue/address without naming Bengaluru — **19 in-person**, **9 in the default tech feed**:

| City | Event | In tech feed |
| --- | --- | --- |
| Los Angeles | KONG API + AI Summit 2026 | yes |
| San Francisco | FounderX Silicon Valley | yes |
| Chennai | Anthropic - Code - Coffee : Chennai Edition | yes |
| Coimbatore | Anthropic - Code - Coffee : Coimbatore Edition | yes |
| Kochi | Umbraco India Festival 2026 | yes |
| Chennai ×6, Hyderabad ×2, Mumbai ×2, New York ×2, Paris | social/wellness meetups | no |

A second, related gap: `OTHER_STATE_HINTS` lists **Indian places only**, so a foreign venue yields `null` rather than `false`. That is why Los Angeles and San Francisco got through even where a venue existed.

**Status: left unfixed on purpose.** The right gate belongs *after* enrichment (which is what fills a real venue for this source) and should serve every adapter, not just Meetup. That work is being done in a separate session. I backed my partial version out rather than leave two competing half-fixes in the tree. `tests/geo.test.ts` (new) pins the tristate contract and deliberately asserts the foreign-city gap as `null`, so whoever closes it sees the test fail and updates it consciously.

### 2. "Best for connections" does not visibly rank anything — CONFIRMED IN THE BROWSER

The highest-value defect found, and it is in the app's flagship differentiator.

`lib/events/query.ts` sorts correctly — `case 'connections': return { connectionScore: -1, startDateTime: 1 }`. The API honours it: `/api/events?techOnly=true&sort=connections` returns

```
score 100  offline  Women In Tech Mixer - Bengaluru Tech Week 2026
score 100  offline  KONG API + AI Summit 2026
score  96  offline  Databricks Campus Hackathon (BMSCE Edition)
score  96  offline  Agents & APIs Bengaluru Developer Meetup
score  95  offline  Space Tech Meetup - Bengaluru
score  94  offline  Building AI Agents using Amazon Bedrock AgentCore
```

**Then `app/page.tsx` throws that order away.** The `days` memo buckets events by IST calendar day and sorts the buckets chronologically, so the rail re-sorts a ranked result by date. Verified in the browser at `/?sort=connections` — the sort control reads `connections`, and the rendered order is:

| Rendered position | Event | Score |
| --- | --- | --- |
| 1 | Hackathon - Umbraco India Festival 26 (Fri 28 Aug) | — |
| 2 | Snowflake Bangalore User Group (Sat 29 Aug) | 88 |
| **3** | **Women In Tech Mixer (Wed 2 Sept)** | **100** |

Day headings `Fri, 28 Aug`, `Sat, 29 Aug`, `Wed, 2 Sept` … are still rendered under a ranked sort, which is the visible symptom.

CLAUDE.md records that the connection meter was added because "that sort looked arbitrary". This is why it still does: the sort *is* arbitrary as rendered.

`newest` and `popular` have the identical problem, and `relevance` too when there is a search query. Only `soonest` is genuinely chronological.

**The fix** (I implemented it, verified the bug, and then my edit was overwritten by a parallel session — so it is unlanded):

```ts
// after `const total = pagination?.total ?? 0;`
const chronological = sort === 'soonest';
```

then in the render, between the `grid` branch and the day-rail branch:

```tsx
) : !chronological ? (
  <div className="rail">
    {events.map(event => (
      <EventRow key={event._id} event={event} />
    ))}
  </div>
) : (
  // existing days.map(...) rail
```

Note while fixing: `KONG API + AI Summit 2026` scores 100 and is the **Los Angeles** event from defect 1. So the off-city leak also pollutes the top of the *good* sort, which raises its priority.

### 3. `Event.tags` is effectively empty

8 of 334 tech events, 6 distinct values corpus-wide. Any feature planned on the assumption that tag data exists will not work. See `scripts/diag-tag-supply.ts`.

### 3. The default sort ignores `connectionScore`

The app's one genuinely differentiated signal is computed for every event, rendered as the connection meter, and then not used to order the default view. Soonest-first is a reasonable default; it should not be the only one applied.

### 4. `district` leaked into a semantic field

Fixed. The source already lives in `Event.source`.

---

## A suspected bug that turned out not to be one

Worth recording so nobody re-investigates it.

Their listing said "Founders Running Club :: **Bengaluru**"; ours said ":: **Bangalore**". That raised an obvious concern: if `clusterKey` doesn't fold the two spellings, the same event from two sources becomes two cards in the feed.

`scripts/diag-city-spelling-dupes.ts` checked the real generator against the real corpus:

```
Bangalore → founders running club|2026-08-30
Bengaluru → founders running club|2026-08-30
COLLIDE (same key, so dedup works)?  YES
```

The normalizer strips city words entirely. **0** spelling-caused duplicate groups across 1,212 upcoming events. The existing code was better than the hypothesis.

---

## Ranked recommendations

| # | Change | Value | Effort | First step |
| --- | --- | --- | --- | --- |
| 1 | Close the off-city leak with a post-enrichment geo gate serving all adapters | high | medium | in progress in a separate session; start from `scripts/diag-meetup-geo-leak.ts` |
| 2 | Delete the 19 already-stored out-of-city events | high | small | `scripts/cleanup-non-bengaluru.ts` (written, dry-run by default, **not yet run**) |
| 3 | Add foreign cities to the geo rejection list | high | small | `OTHER_STATE_HINTS` in `lib/scrapers/core/geo.ts` is India-only |
| 4 | Offer a ranked default sort using `connectionScore` | high | small | `lib/events/query.ts` |
| 5 | Split `AI/ML` so `Agents` / `GenAI` are filterable | medium | medium | `lib/event-types.ts` + the tagger prompt; note the 3-category budget per event |
| 6 | Emit `schema.org/Event` JSON-LD on our own event pages | medium | small | we *read* JSON-LD from eight sources and publish none |
| 7 | Server-render `/events/[id]` metadata | medium | medium | it currently returns 200 with no content in the HTML, so shared links unfurl blank |

Items 6 and 7 came from the audit's SEO lens and I have **not** independently verified 7 beyond observing that the route's HTML contains none of the event content and hydrates client-side. Treat them as leads, not measurements.

---

## Answering the question you actually asked

> "do I want to take any reference that I need to implement in our PulseBLR"

Two things, and only two:

1. **Their AI vocabulary split** (`Agents`, `GenAI`, `LLM`, `MLOps` as distinct from `AI/ML`). Real, transferable, and it matches what your corpus is actually full of.
2. **Their curation discipline** — expressed in PulseBLR's terms as: use the ranking signal you already compute in the default view.

Everything else they have, you have more of. The audit's larger payoff was the off-city bug, which their site had nothing to do with.
