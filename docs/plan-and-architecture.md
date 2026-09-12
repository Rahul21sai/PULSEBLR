# PulseBLR — the plan, the idea, and the architecture

Written 2026-09-12, covering the work from the first audit request through to the last push
(`566e279`). It is in three parts: **the idea** (what this product is for, and the decisions that
shaped it), **the architecture** (how it is built, and why each part is that shape), and **what
actually happened** — what was built, what was measured, and what turned out to be wrong.

The third part is the one worth keeping. The idea and the architecture can be re-derived from the
code; the measurements and the corrections cannot.

---

# Part 1 — The idea

## What the product is for

A Bengaluru engineer, on a phone, deciding **"is this event worth my evening and my commute"** —
and afterwards, **"who did I meet there."**

Not a listings site. That distinction is the whole product, and it survived every round of scope
argument in this session.

Audience: technical, 22–35, impatient, one-handed, often standing in a venue with bad signal.

## The competitive read, and what it settled

`b2bangalore.com` was audited against the live site. Positioning: *"Bangalore B2B Event Intelligence
… which of your target accounts will be there … Built for SaaS GTM teams."* Its buyer is sales and
marketing; PulseBLR's user is an engineer. Three tiers, and the free one is the important row:

| Their tier | What is in it |
| --- | --- |
| Community ₹0 | **Every free Luma & Meetup event in Bangalore** · WhatsApp community · weekly Monday digest · **a free MCP server** |
| Plus ₹899/mo | 10 flagship registrations · founder dinners, CXO roundtables · **"see who's attending before you walk in"** |

Four conclusions, and they are the strategy:

1. **Aggregated Luma + Meetup listings are somebody else's loss-leader.** That was PulseBLR's entire
   value proposition, sitting in a competitor's free tier. Open-sourcing it changes nothing, because
   their paid product is *access to gated rooms* — a relationship business you cannot scrape.
2. **PulseBLR already owns two things they do not:** `connectionScore` (ranking events by whether
   you will leave with contacts) and the **scan → people → export loop** (remembering who you met).
   Nobody in this market does post-event relationship memory. **That is the thing to sharpen.**
3. **"Who's attending" is validated at ₹899/mo** — but fill it from public Luma guest data, not from
   our own users, because at 8 accounts it renders empty.
4. **Ship an MCP server.** Their free tier advertises one; it is days of work; it puts the product
   where developers already are. Highest signal-per-hour item on the plan. Now shipped, v1 and v2.

## The hybrid thesis

**Events and people are one product, joined in both directions.**

- *Events → people:* an event page that says "Asha Rao · Razorpay is speaking — you met her at
  IndiaFOSS in July."
- *People → events:* a person page that says "you met her at IndiaFOSS, and at the Kubernetes
  meetup in August."

Neither half is defensible alone. Listings are a commodity; a contact book with no supply has
nothing to attach to. The join is the product.

## Scope decisions, each with the measurement behind it

- **The public feed is `techOnly` unconditionally.** Measured 1158 upcoming events, 297 tech — so
  one toggle turned a sharp product into a listings site that was 74% concerts and treks. The toggle
  was removed and `?techOnly=false` is stripped from the URL, because obeying it while hiding the
  control leaves the hatch open to any old bookmark.
- **No paywall, no credits, no flagship gating.** The competitor's paid tier is access to rooms; that
  is not a thing this product can or should sell.
- **Weekly digest, not daily.** A daily email to engineers gets muted, and once muted it is gone.
  The competitor reached the same answer independently.
- **"Who else is going" from our own users is deferred** — it renders empty below roughly 200 users
  in one city.
- **The score is never printed as a number.** It is a ranking signal, not a measurement, and "83"
  implies a precision it does not have.

---

# Part 2 — The architecture

## Four bounded contexts, and the direction between them

```
   Ingestion  ──▶  Discovery  ──▶  Relationships
   (scrapers)      (the feed)      (people you met)
        │               │                │
        └───────────────┴────────────────┘
                        │
                   Operations
                  (the control room)
```

**The arrow only goes one way.** Discovery may read an event; Relationships may read a folder's
event id. Ingestion never knows a person exists. That is what keeps a scraper change from breaking
a contact record.

## The spine — the join, in two collections

```
Person        one row per HUMAN            contactKeys[], denormalised counters
Interaction   append-only history          kind: met | note | message | merged
Contact       one row per CAPTURE          the scan, with its clientId
```

`Contact` is a capture; `Person` is a human; `Interaction` is what happened. The three-way split is
what lets "met 3×" be a fact rather than a guess.

### Two identity keys, doing two different jobs

- **`Event.clusterKey`** — normalized title + IST calendar day. Frozen at ingest. An event's identity
  does not change.
- **`Contact.contactKey`** — `li:<slug>` > `em:<email>` > `ph:<last 10 digits>` > `nm:<name>`,
  tier-prefixed so two tiers cannot collide. **Recomputed when a source field changes**, because a
  person's identity *sharpens* as you learn their LinkedIn.

That difference is deliberate and it is where two of this session's bugs lived. `contactKey` is a
**pointer, not an identity** — and something has to carry an upgrade through to the `Person`.

### Three scores, never conflated

```
Event.connectionScore                      corpus-wide, recomputed by script   "is this worth attending"
relevanceScore                             per-user, computed at query time    "is this for me"
Person.lastInteractionAt / nextActionAt     facts, not a score                  "who needs me next"
```

**No invented relationship-strength number.** A fabricated warmth score is worse than none, and
those two dates answer the real question — *who have I gone quiet on* — with facts.

## The events surface

- **Findability:** `generateMetadata` + a generated OG image, `Event` JSON-LD, and topic landing
  pages at `/topics/[slug]` behind a ≥3-event floor.
- **Card metadata:** `audience`, `perks`, `tier` — controlled vocabularies, not free text.
  `Event.tags` was measured at **six distinct values across the whole corpus**, which is why
  harvested free text cannot back a facet.
- **Depth:** `agenda` and `speakers`, sparse by nature, plus the speaker↔Person join.
- **Shelves:** one built. Two specified shelves were refused on measured grounds (below).
- **Distribution:** MCP v1 public, v2 authed.

## The rules that hold the whole thing together

These recur throughout the codebase because each was learned by breaking something:

- **Absence is load-bearing.** ~1500 documents predate `visibility`, so every filter carries an
  explicit `{ visibility: { $exists: false } }` arm. Omitting it does not narrow the feed, it
  **empties** it.
- **Soft delete reads `{ deletedAt: null }`, never `$exists`** — that predicate matches a null field
  *and* an absent one, and both halves are needed.
- **One filter builder.** The list, its count and the facets share `buildEventFilter`, so a chip
  cannot say 12 and show 9.
- **Guard first, validate second.** An anonymous caller with a bad body gets 401, never 400 — a 400
  tells a stranger their payload parsed far enough to be judged.
- **404, never 403** on anything id-addressable. An ObjectId embeds a timestamp and a counter, so
  neighbours are enumerable.
- **Import the predicate, never restate it.** A copied regex drifts, and a drifted copy is worse than
  none because it is confidently wrong.

---

# Part 3 — What actually happened

## The arc

1. **Audit.** Full security and functional audit across the app.
2. **Fix the criticals** — an SSRF bypass and a filter-reset regression.
3. **Brainstorm** the product direction; the "admin as CRM" idea resolved into a control room.
4. **Design the hybrid** — three specs, 908 lines.
5. **Build it** — six parallel agent streams, then six more, then four for the UI.
6. **Deploy**, fix a red CI, then close the specs' own verification lists.

## What shipped

The spine and `/people` with merge, export and bulk tags · personalisation and onboarding ·
reminders and a weekly digest · follow-up drafting · the operator control room with audit, impact
preview and undo · soft delete · MCP v1 and v2 · the events surface · a Meetup uncap worth ~+950
events · area resolution 52.1% → 63.7% · and a UI pass across four surfaces.

## The measurements that changed a decision

Nearly everything below was believed, then measured, then reversed.

| Belief | Measurement | Outcome |
| --- | --- | --- |
| Meetup's ICS returns every event | It caps at **TEN**; 72 of 285 groups sat on it | +950 events — and it needs **no browser** |
| Company sites yield nothing | True of *index* pages, **false of event microsites** | GIDS and Bengaluru Tech Summit for one HTTP request each |
| Build "Ends soon" | `registrationDeadline` is a date on **0 of 1616** documents | Refused |
| Build "Free this week" | `isFree` **defaults to true**; 88.5% of upcoming tech | Refused as a tautology |
| Add `Conference` to the tech flag | 17 of 20 rows are treks and expos — a trek matches "summit" | Refused |
| Area needs a wider gazetteer | Already widened; the stored value was stale | The backfill was the win |
| `--all` is the right retag flag | 60-row sample: ~55 flag flips against 11 real recall losses | Used `--inconsistent`; 24 → 5 |

## The bugs found, in order of how long they had been shipped

**The app rendered the wrong typeface.** `--font-sans` named the literal `'Inter'`, but `next/font`
registers a *hashed* family — so it fell through to `system-ui`, i.e. **Segoe UI on Windows**. Every
tracking value was calibrated for Inter and applied to something else.

**Merge had never worked, once.** `Interaction` declares `timestamps: { createdAt: true }`, so
Mongoose adds `$setOnInsert: { createdAt }` to every update; the append-only guard walked that
operator and threw on the one update its own docblock calls legitimate. Nothing noticed because
there are 0 tombstones in the corpus. **And the failure manufactured the corruption it was meant to
prevent** — the key union committed before the repoint, leaving two live persons sharing a key.

**An upgraded `contactKey` never reached the `Person`.** Only `resolvePerson()` appends to
`Person.contactKeys`, and no edit path called it. So adding a LinkedIn later left the contact on
`li:…` and the person on `nm:…`, and the next scan made a **second Person** — silent, because the
rows share no key, so the spine check passes *and* suggestions return nothing. **This produced the
duplicate pair in the live database**, which had been described three times as "a merge suggestion"
and measures as zero suggestions.

**CI had been red since 2026-09-08.** `/topics/[slug]` prerenders and queries Mongo, so a build with
no database died. It passed locally because `.env.local` supplies `MONGODB_URI`. The workflow's own
comment predicted it: *"if that ever changes this step is where it will surface."*

**The home page scrolled sideways at 390px** — right edge at x=485 — because a tracked-caps label set
243px where sentence case sets 170px.

**The home page asserted false facts on a failed fetch.** `total` is `pagination?.total ?? 0` and
`load()` nulls pagination, so the hero read **"0 upcoming"** during every request and permanently
after a 500, while the readout blamed the reader's filters for a request that never returned.

**The event page put Register at 2717px on a phone**, below six competing events, because
`flex-col lg:flex-row` stacked the action rail last.

**`/events/[id]` explained a coaching advert without mentioning its penalty** — its panel had
*copied* the funnel regex and the copy had drifted four entries behind.

**`ui.tsx`'s `Button` silently discarded a passed `className`** — it sat in `...rest`, spread *after*
the styling, so it replaced rather than appended. `Chip` had the identical defect.

**A diagnostic reported a pending event as `IN FEED`** — it queried two of the four clauses the real
feed requires, omitting precisely the two that *hide* a row.

**Every "Free" pill failed AA at 4.00:1**, and the deeper problem behind it: `var(--ink-2)` is
referenced 3 times while its raw hex appears **212 times across 53 files**.

## Corrections to my own claims, recorded because they were repeated

- I said the funnel regex had drifted **eight** entries behind. It is **four**.
- I called the database's duplicate pair **a merge suggestion**. It is an invisible duplicate — zero
  suggestions — and it is the signature of a bug, not of a design working.
- I said arming the microsite LLM would make the speaker join fire. It did not: those pages are
  conference *landing* pages, and the model returned `"speakers": null`.
- I read a candidate's date as **10-06** from its UTC value. It is `18:30Z` = **00:00 IST on the
  7th** — which is what makes it a same-day duplicate of an existing row.
- My `TAP_44` guidance was wrong for a full-width block: a band there can only grow vertically,
  turning one small target into three overlapping ones.
- My harness recipe said "the same Inter faces", which broke a measurement mid-session when the
  display face changed underneath it.
- My direction doc told every agent to remove a pattern only the owner of `globals.css` could remove.
- I told agents a second dev server was impossible; `scripts/start-verify.js --dev` exists for
  exactly that.

## Method notes that paid for themselves

- **Zero rows exercise nothing.** `diag-people-spine.ts` passed 9 checks over live data while merge
  was broken. Only a write-then-delete fixture reached it.
- **A static harness beats computing.** It caught a hairline drawn 30px up an image that six
  fixtures hid, a sticky rail clipped for its whole descent, and `capitalize` rendering *"Meetup And
  On Luma"* — which `textContent` cannot reveal because `text-transform` is paint-time.
- **Verify the detector can fire.** A contrast probe returned exactly `1.00` for 22 categories
  because Chrome resolves `color-mix()` to floats, not `rgb()`. A parser bug reading as a clean
  result.
- **A dated claim in a document ages into a false reassurance.** CLAUDE.md said "npm audit is now 0
  vulnerabilities"; 18 days later it was 5, one a critical RCE in `next` itself.
- **Never write source through a shell heredoc.** Backslash escapes are decoded before the shell sees
  them; it put a literal `0x08` byte into a file, reproducing a documented catastrophe.

## Where it stands

**Done:** `tsc` exit 0, lint 0 errors, **1672 tests across 47 suites**, build clean at 88 static
pages, `npm audit` 0 vulnerabilities, CI green, and all 67 auth assertions passing over real HTTP
— including the 27 routes built in this session.

**The honest gap is not code.**

- **8 user accounts**, all carrying the identical factory seed. That is why "From companies you
  follow" is a global shelf wearing a personal label.
- **`agenda` and `speakers` are on 0 of 277 events.** The spec's own "hybrid feature nobody else can
  build" is coded, tested, and has never rendered once. It needs a per-event microsite or an
  organiser submission — not more code.
- **A collision detected at capture time is shown to nobody.** The state the merge UI needs is one
  only a *failed* merge produces.
- **Bengaluru Tech Summit is in the corpus and hidden**, `isTechEvent: false`. The tagger applied the
  documented rule correctly to a government trade expo. Whether the city's largest technology summit
  belongs in an engineering feed is a scope decision, and it is now on screen every run.
- **Approving the pending Open Source India submission puts two cards on 7 October.**

**Deferred deliberately:** native app · a paywall · "who's attending" from our own users · an
`Agents`/`GenAI` split of `AI/ML` · structured extraction from company *index* pages, measured dead
twice.
