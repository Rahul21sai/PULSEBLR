# Phase 2 — `/events/[id]`, designed at 390px

The one reference surface, finished completely. Written before the code, as the brief requires, so the
plan can be argued with rather than reverse-engineered from a diff.

---

## 0. What is actually true of the data — measured, not assumed

Sampled 18 upcoming tech events through the detail endpoint on 2026-09-12:

| field | reality |
| --- | --- |
| `agenda`, `speakers` | **false on all 18, including the richest row.** Matches the corpus figure of 0 of 277. |
| `area` | absent on the sparse half; present on the rich pair (`Indiranagar`) |
| `venue` | absent on the sparse half |
| `imageUrl` | present on all 18 — but 79 of 277 corpus-wide have none, so the coverless path is ~29% |
| `description` | 745–3,980 chars; 494 of 1,201 carry markdown that must be stripped |

**So the sparse state is the DEFAULT and is designed first.** The rich variant is: cover + area +
venue + long description. There is no reachable agenda/speaker state — I am not permitted DB writes,
so that path stays **unverified**, which is the same limit CLAUDE.md already records. I will say so
rather than screenshot an absent path and call it covered.

### The baseline, measured

| | 390 | 768 | 1280 |
| --- | --- | --- | --- |
| Register, sparse | **y=942** | **y=1097** | y=669 ✓ |
| Register, rich | **y=1026** | y=1134 | — |
| page height, sparse | 2289px (2.71 screens) | 2389 (2.33) | 1713 (1.90) |
| horizontal overflow | 0 | 0 | 0 |

Two findings the recorded defect does not cover:

- **The 2717px bug is fixed; the action is still 1.1 screens down.** "Not catastrophic" is not the
  bar. The brief's bar is *visible without scrolling*.
- **768 is the worst width, not 390.** The cover grows to 352px there while the layout is still one
  column — the two-column grid starts at `lg`. Nobody measured the tablet, so nobody knew.

---

## 1. Tokens in use

Nine values, two faces, nothing else.

| role on this page | token |
| --- | --- |
| page ground | `--paper` |
| the sticky action bar, and nothing else raised | `--surface` + `--shadow-sticky` |
| title, section headings, primary facts | `--ink` |
| every label, date, count, area, organiser | `--ink-2` |
| the category dot's own colour | `CATEGORY_ACCENTS` (a categorical scale, not palette) |
| decorative icons, the disabled past-event state | `--ink-3` |
| every separator | `--rule`, 1px |
| Register, links, the "worth going" affirmative | `--accent` on `--accent-ink` |
| "Happening now", and a past event's expiry line | `--live` |

Type, by the semantic rule — **serif is the city's content, sans is the product's voice**:

| element | class | why this side of the split |
| --- | --- | --- |
| event title | `.ty-h1` (34/46px serif) | the event is a thing in the world |
| venue name | `.ty-row-title` (20px serif) | so is the venue |
| speaker name *(unreachable)* | `.ty-row-title` | so is a person |
| section headings | `.ty-section` (26px sans 600) | the app labelling its own sections |
| every date, time, count, price, area | `.ty-meta` (13px sans, tnum) | the app describing the thing |
| description prose | `.ty-body` (16px sans, max 68ch) | scraped copy, but read as body |

Geometry: **`--r-touch` (4px) on Register, Save and the chips. `--r-flat` (0) on every container and
row.** That is the single largest visual change on the page — the three rounded `card-shadow` panels
become ruled sections on the page ground. Spacing from the 4px scale; section rhythm `--s-16` (64px)
at 390, `--s-24` (96px) from 768.

---

## 2. The composition, and the one structural decision

**The primary action becomes a sticky bottom bar on mobile, and leaves the flow entirely.**

That is what makes the y-position problem disappear rather than shrink: no amount of reordering gets
Register above 844px on a page that opens with a 195px cover, a 34px title and the facts a reader
needs *before* deciding. A sticky bar is visible from first paint at any scroll position, and it is
the one element the brief already allocates the codebase's single `box-shadow` to.

**Source order at 390**, following the brief and inverting one thing the current page does:

```
back → cover → category → TITLE → when/where → why → description → [agenda/speakers] → similar
                                   ^^^^^^^^^^   ^^^
                                   swapped: facts before verdict
```

The current page puts the verdict (`WorthGoing`) *above* the facts. Inverted, because you cannot
evaluate "worth going" until you know when and where it is — the verdict is supporting argument, and
argument comes after the proposition. It also shortens the distance from the title to the first
actionable fact.

### 390 × 844

```
┌──────────────────────────────────────┐
│ ← All events                         │  44px target, --ink-2
├──────────────────────────────────────┤
│                                      │
│        C O V E R   (full bleed)      │  2:1, -mx-4, no radius
│   [● Happening now]                  │  --live pill, only when live
│                                      │
├──────────────────────────────────────┤
│ ● AI/ML   ● Hackathon                │  13px sans --ink-2, dot = category
│                                      │
│ Lossfunk Research                    │  .ty-h1 — 34px SERIF
│ Mixers, Vol. 4                       │  the hero. nothing competes.
│                                      │
├──────────────────────────────────────┤  ← rule
│ Sat 4 Oct · 6:30 PM                  │  .ty-meta, tnum
│ Binnamangala                         │  .ty-row-title SERIF 20px
│ Indiranagar                          │  .ty-meta --ink-2
├──────────────────────────────────────┤  ← rule
│ ₹1,500                               │  ONLY when a price exists
├──────────────────────────────────────┤  ← rule
│                                      │
│ Why this event                        │  .ty-section 26px sans
│ In person, 40 going, food, hosted     │  measured from the scorer.
│ by Razorpay.                          │  no number, no bar, no meter.
│                                      │
├──────────────────────────────────────┤  ← rule
│ Lossfunk is a research collective…   │  .ty-body 16px, max 68ch
│                                      │
│ …                                    │
├──────────────────────────────────────┤  ← rule
│ Similar events                        │  .ty-section
│ ─────────────────────────────────    │
│ 6:30 PM  Kubernetes Bengaluru #42    │  time sans/tnum, title serif
│          Indiranagar                 │
│ ─────────────────────────────────    │
└──────────────────────────────────────┘
╔══════════════════════════════════════╗
║  [    Register    ]        [ Save ]  ║  STICKY. --surface + the ONE
╚══════════════════════════════════════╝  shadow. 4px radius. 48px tall.
```

The sparse variant differs in exactly three places, and each is a **designed absence**, not a gap:

```
│ Sat 4 Oct · 6:30 PM                  │
│ Online                               │  ← .ty-row-title serif, where the
├──────────────────────────────────────┤    venue name would be. Not an
                                           empty slot, not a dangling "·".
   (no price row at all — absence means free, per the measured refusal
    that `isFree` defaults true on 88.5% of rows)

│ Why this event                        │
│ This is a paid course being sold, not │  ← the scorer's negative verdict,
│ a meetup. You would be in an audience.│    stated. NOT hidden.
```

### 768 × 1024

Still one column — but the cover is capped, because 352px of photograph is what pushes Register to
1097 here.

```
┌────────────────────────────────────────────────────┐
│ ← All events                                       │
├────────────────────────────────────────────────────┤
│         C O V E R    16:6, max-height 260px        │  capped, was 352
├────────────────────────────────────────────────────┤
│ ● AI/ML  ● Hackathon                               │
│ Lossfunk Research Mixers, Vol. 4                   │  .ty-h1 → 46px serif
├──────────────────────────┬─────────────────────────┤
│ Sat 4 Oct · 6:30 PM      │  Why this event          │  two columns from 768,
│ Binnamangala             │  In person, 40 going,    │  so facts and verdict
│ Indiranagar              │  food, hosted by…        │  share one band
├──────────────────────────┴─────────────────────────┤
│ Lossfunk is a research collective…    (max 68ch)   │
└────────────────────────────────────────────────────┘
╔════════════════════════════════════════════════════╗
║  [ Register ]   [ Save ]                           ║  sticky until ≥1024
╚════════════════════════════════════════════════════╝
```

### 1280 × 900

The sticky bar is gone — Register already measures y=669, well above the fold, so a fixed bar would
be chrome earning nothing. Two columns, the left one holding a real measure.

```
┌───────────────────────────────────────────────────────────────────┐
│ ← All events                                                      │
├───────────────────────────────────────────────┬───────────────────┤
│                                               │ Sat 4 Oct         │
│   C O V E R      (max-h 380, 2:1)             │ 6:30 PM           │
│                                               │ Binnamangala      │
│                                               │ Indiranagar       │
│ ● AI/ML   ● Hackathon                         │                   │
│                                               │ [   Register   ]  │  y≈500
│ Lossfunk Research Mixers,                     │ [     Save     ]  │
│ Vol. 4                                        │                   │
│                        .ty-h1 46px serif      │ ─────────────     │
├───────────────────────────────────────────────┤ Why this event    │  rail is
│ Lossfunk is a research collective that…       │ In person, 40     │  sticky
│                                               │ going, food,      │
│                    max 68ch — one measure     │ hosted by…        │
│                                               │                   │
├───────────────────────────────────────────────┴───────────────────┤
│ Similar events                                                     │
└───────────────────────────────────────────────────────────────────┘
```

Left-aligned throughout. No centred body text at any width.

---

## 3. The states, each designed rather than defaulted

| state | design |
| --- | --- |
| **sparse** (default) | above. Venue slot reads `Online` or the format; no price row; no agenda/speaker sections at all — not empty headings. |
| **rich** | identical skeleton, three more filled rows. The layout must not *improve* when data arrives; it must stay still. |
| **loading** | `Skeleton` at the cover's exact reserved height, a 2-line title block, and 3 fact rows. The sticky bar renders **disabled with the label `Register`**, not absent — a bar that appears late shifts the reader's thumb target. |
| **fetch failure** | the page keeps its title if it has one, and the body says what happened and offers Retry. **No count and no fact is rendered from a null** — the recorded home-page defect was "0 upcoming" during every request. |
| **past** | the sticky bar's action is replaced by the sentence `This event has ended` in `--live`, and Similar events is promoted directly under the title, because that is the only useful thing left on the page. |

Copy: sentence case, active voice. `Register` stays `Register` through the flow. The failure state
does not apologise.

---

## 4. Self-critique — what would I have produced for ANY events site?

The honest answer for four of the decisions above is *this exact thing*, and naming them is the point
of the exercise.

**(a) "Sticky bottom bar for the primary action on mobile" is the single most generic mobile-commerce
pattern there is.** Every ticketing site, every food-delivery app, every listing. I would have
produced it from the phrase "the action is too far down" without reading a line of this codebase.

*Revision:* keep the bar — it is correct, and the brief specifies it — but **change what it contains
so it is this product's bar, not a checkout bar.** Register alone is a ticketing site. The bar carries
`Register` **and `Save`**, because this app's thesis is that you decide by *whether you will leave
with contacts* and then *track who you met*; saving to the tracker is the action that starts that
loop, and it is the only action a signed-in reader can take that the event's own site cannot offer.
A ticketing site has no equivalent second button.

**(b) The date/venue/area stack is a generic listing block.** "Time, place, price" in a ruled list is
what any events site does.

*Revision, and it is the one I would defend hardest:* the **serif/sans split** does work here that no
generic block does. `Binnamangala` in Newsreader beside `Sat 4 Oct · 6:30 PM` in tabular Jakarta says
*this is a real place in the world, and this is the app telling you when* — without a label, an icon,
or a word. That is not decoration; it is the information architecture made visible, and it is
specific to a brief whose central rule is that split. I keep the block and let the typography carry
it.

**(c) "Why this event" is a heading I would write for any recommender.** And the content under it is
this product's only defensible feature.

*Revision:* the heading goes. It is a label that says what the sentence below it already says — the
same rule that correctly left the description headingless on the current page. The clause stands on
its own under a rule, in `--ink`, at body size. **What I refuse to add here, and would have added
anywhere else:** a score, a bar, a meter, a five-star rating, a "94% match". The brief bans it and the
codebase records why — `connectionScore` is a ranking signal and "83" implies precision it does not
have. A recommender that shows its number *feels* more intelligent and is lying about its resolution.

**(d) Capping the cover at 768 is a fix, not a design.** True, and I nearly filed it as one.

*Revision:* the cap has a reason worth stating, which makes it a decision. 79 of 277 events have no
cover at all, so a third of the time this box is holding space for a *tinted fallback with a date in
it* — and a 352px tinted block is the loudest thing on a page whose hero is meant to be the title.
The cap is sized to the widest useful photograph, not to a breakpoint convention.

**One thing I am removing, per the brief's "remove one accessory" rule:** the **category dot row above
the title**. Reasons: the categories are a taxonomy the *app* assigned, so by this page's own semantic
rule they are chrome, not content — yet they sit in the hero position, above the event's own name.
They are also the only element on the page drawing from a colour scale outside the nine. A reader who
opened this page from a search or a WhatsApp link does not need to be told which bucket we filed it
in before being told what it is. The categories survive as links **at the foot of the description**,
where "more like this" is a genuine next step rather than a preamble.

**What I am NOT doing, and why each would be a mistake here:**

- No countdown timer. `registrationDeadline` is a date on **0 of 1616** documents.
- No "12 people are viewing this". Fabricated, and there are 8 accounts.
- No attendee avatars. Same reason, plus the brief bans invented content outright.
- No map embed. It is a third-party script and a second colour system on a page whose only colour is
  the cover. The venue name links out instead.
- No breadcrumb trail. The commonest entry to this page is a shared link with no history behind it.
