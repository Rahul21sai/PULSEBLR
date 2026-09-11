# PulseBLR — design direction

Binding on every UI change. Four agents work from this so the app reads as one product rather
than four dialects. **Where this document and a component disagree, this document wins; where this
document and `app/globals.css`'s four settled rules disagree, globals.css wins.**

---

## What this product is

A Bengaluru engineer, on a phone, deciding **"is this event worth my evening and my commute"** —
and afterwards, **"who did I meet there."** Not a listings site. The competitor gives aggregated
Luma and Meetup listings away free; the two things nobody else has are the **connection score** and
the **people you met**. The design's job is to make those two things feel like the product.

Audience: 22–35, technical, impatient, one-handed, often standing in a venue with bad signal.

---

## What stays. Do not rebuild these.

`app/globals.css`'s four rules are settled and correct, and each is documented with the failure it
prevents:

1. **Tracking is a function of size** — `.t-display` −0.035em, `.t-body` −0.008em.
2. **Elevation is a ring plus a lift**, never one blur. A single diffuse shadow reads as fog.
3. **Hairlines are alpha**, never solid grey — a solid border reads as two different weights
   depending on what it sits on.
4. **One accent, rationed.** `--blue` means "you can act on this" and is never decoration.

Also settled: `--ease: cubic-bezier(0.32, 0.72, 0, 1)` everywhere, `.pressable` not hover-lift
(most of this app is a phone), and `prefers-reduced-motion` as a real kill-switch.

---

## The problem this pass exists to fix

**The system's premise is "covers are the only colour" and 40% of the first page has no cover.**
Measured. So the feed's visual identity is, in practice, whatever the fallback does — and the
fallback is a letter in a pale wash. A letter carries no information, so the page reads flat and
undesigned exactly where it matters most.

**And the stated signature is not delivered.** CLAUDE.md: *"The signature element is the connection
meter… the app's one signal that Luma and Meetup cannot show."* It renders as three small bars,
unlabelled. The product's whole thesis is invisible.

---

## Spend the boldness in ONE place: the connection meter

Everything else stays quiet. The meter is the memorable object, and it earns it because it is the
only thing here no competitor can show.

It must read as a **judgement with a reason**, not a gauge. `lib/events/score-reason.ts` already
produces the clauses, measured from the scorer itself so they cannot drift — use it.

Two constraints from CLAUDE.md that are not negotiable:
- **Never print the number.** The score is a ranking signal, not a measurement, and "83" implies a
  precision it does not have. This was already removed once from a tooltip.
- The reason must come from `score-reason.ts`. A restated copy is exactly how `/events/[id]`'s old
  panel drifted behind `FUNNEL_PATTERN` and explained a coaching advert without mentioning its
  penalty. **FOUR entries, not eight** — `demo class`, `trial class`, `placement`, `\d+% off`. An
  earlier version of this document said eight; `lib/events/score-reason.ts` and
  `tests/score-reason.test.ts` both say four, and they are the source. The number does not change the
  lesson, but a document that invents a figure is the thing this repo has already been bitten by
  twice.

---

## The card: date-forward, because the fallback should carry information

When there is no cover, show **the date**, set in the display face, in the category tint — not a
monogram. Rationale: the date is the first thing the reader needs, the fallback then carries real
information instead of a letter, and typography becomes an active part of the design rather than a
placeholder. It also gives the feed rhythm without adding colour, because the tint is already
category-derived.

Keep `EventCover`'s existing discipline: a **flat** wash, never a 135° two-tone gradient — a
saturated diagonal made every fallback shout louder than the real photographs beside it.

**Category colour is structural, never a fill.** It may tint a date block or carry a thin spine. It
may not become a badge, a chip background, or a gradient. `--blue` remains the only accent that
means "act on this".

---

## Three patterns to remove, because they read as generated

These are named defaults, and the app currently uses two of them heavily:

1. **Tracked-out ALL-CAPS labels.** `.t-label` at +0.055em is the app's eyebrow pattern and it
   appears above content that does not need announcing. Sentence case, or delete the label — most of
   them describe what the content below already says.

   **This is a LAYOUT defect as much as a stylistic one, and that is the stronger argument.**
   Measured: the following shelf's heading set **243px in uppercase where 13px sentence case sets
   ~170px**, and with `shrink-0` on both heading and caption, 433px sat in a 358px column — the home
   page scrolled sideways at 390px. A +0.055em uppercase label on a phone column is a liability, not
   a taste question.

   **AND THIS DOCUMENT PREVIOUSLY CONTRADICTED ITSELF HERE.** `globals.css` bakes
   `text-transform: uppercase` into `.t-label`, so ~175 call sites cannot drop the caps without also
   abandoning the tracking — this document told every agent to remove a pattern only the owner of
   `globals.css` can actually remove, and the precedence rule at the top did not resolve it because
   the caps are not one of the four settled rules, they are an implementation detail of a type-scale
   entry. **Resolution: the token gets split by whoever owns `globals.css`** (`.t-label` sentence
   case, `.t-label-caps` for anything that genuinely wants caps). Until that lands, replace the class
   at your own call sites and report it — do not add a competing token.
2. **Middle-dot meta strings** (`in person · 40 going · food`). Used everywhere. Keep at most one
   per surface, where the sequence genuinely is a list of equals; otherwise give the two facts that
   matter room and drop the rest.
3. **`→` appended to link and button text.** A button says what happens; an arrow is decoration.

Also: no numbered markers (01 / 02 / 03) unless the content really is a sequence.

---

## Copy rules

- Active voice, sentence case, plain verbs. A button names what happens: **Save**, not Submit — and
  the toast then says **Saved**, the same word.
- **An empty screen is an invitation, not a mood.** Say what to do next.
- **A failure states what happened and what to do**, in the interface's voice. Never a confident
  factual claim on a failed fetch — the calendar rendering "No events this month" for a 500 is the
  pattern this app has already been burned by.
- Name things as the user understands them. "People you've met", not "Contacts collection".

---

## Density and hierarchy

- **Two levels of emphasis per card, not four.** The current cards give roughly equal weight to
  title, time, venue, pills, meter and save button, which is why they read as a wall.
- Line length under 80 characters.
- 44px hit areas, painted size unchanged. `TAP_44` / `TAP_44_SQUARE` in
  `app/components/scan/ContactFields.tsx` are the idiom for an **inline** control — **and read its
  warning first**: a 44px overlay on a smaller control overhangs `(44 − h) / 2` per side, so two
  neighbours contest the band and the later one in the DOM wins the tap. Adjacent controls need
  `44 − h` between them, not half. Measured on `/people`: 25.3px chips inside a 44px band overhang
  9.4px per side against `gap-y-2`'s 8px, so two chip rows genuinely stole each other's taps.

  **THE OVERLAY IS THE WRONG TOOL FOR A FULL-WIDTH BLOCK, and this document said otherwise.** A band
  on a 100%-width row can only grow vertically, so it overhangs into the rows above and below with no
  horizontal escape — it converts one small target into three overlapping ones. For those, **paint the
  height** (`min-h-11`). Found on a thin person card — a LinkedIn QR with no role or employer, which
  is the commonest capture — painting 40px.
- Skeletons, never spinners. `.skeleton` and `Skeleton` already exist.
- Reserve image space with a fixed aspect-ratio box so the feed does not reflow as covers land.

---

## Motion

One orchestrated moment beats scattered effects. Fade-and-slide-up on every section, and a hover
transition on every card, are the generic default.

Motion that answers a user action — opening, expanding, confirming, saving — is always welcome
because it shows what changed. Motion nobody asked for is decoration. One curve, one duration.

---

## How to see your work, since there is no dev server

A stream this session built a **static harness** and it caught a bug that computation missed. Reuse
the technique: serve a plain HTML file on a high port with `python -m http.server`, containing the
**verbatim class strings** from the real components, styled by **this project's own `globals.css`
compiled through the installed `@tailwindcss/postcss`** — swap its `@import` line, never copy the
file. Probe it in a browser at 390×844 and 1440×900.

**PUT THE HARNESS OUTSIDE THE REPO.** An untracked `.harness/` was wiped twice by sibling agents'
working trees, and `.playwright-mcp/` once. Build it in a temp directory with a `node_modules`
junction back to this checkout — `@import "tailwindcss"` then resolves — and delete it when done.

**DO NOT HARDCODE A TYPEFACE OR A HEX IN THE HARNESS. THIS DOCUMENT USED TO SAY "with the same Inter
faces" AND THAT INSTRUCTION BROKE A MEASUREMENT MID-SESSION.** The display face changed to Familjen
Grotesk behind `--font-display-face` while agents were running, so a harness naming Inter silently
fell back to `system-ui` and then reported that as the app's typography. A face or a colour written
into a probe is the same trap as a dated `npm audit` claim in a document: it is a snapshot presented
as a fact. **Read the resolved value off the page instead** — `getComputedStyle` for a token, and
compute contrast from the resolved colour rather than from a hex you typed.

One more parser trap, found the same way: Chrome resolves `color-mix()` to
`color(srgb r g b)` with 0–1 floats, **not** `rgb()` 0–255. A contrast probe that assumes `rgb()`
returns exactly `1.00` for every pair — a parser bug that reads as a clean result.

It measures **components in isolation, not the assembled page.** Say which of your numbers are
measured in the harness and which are computed from the source. Never present a computed figure as a
measured one. Delete the harness before reporting.

---

## The quality floor, unannounced

Responsive to 390px. Visible keyboard focus. Reduced motion respected. Contrast that passes at the
sizes actually used. No horizontal scroll on the page body — only a table, a diagram or a shelf may
scroll, each in its own container.

---

## Chanel's rule

Before you finish, take one thing off. If two elements are competing for the same attention on a
screen, one of them is decoration.
