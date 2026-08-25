# Master prompt — PulseBLR as a spatial product

> Paste this whole document as the opening prompt for the session that does the work.
> It is written for a coding agent working **inside this repository**. A note at the end
> explains how to adapt it for Stitch or any screen-generation tool, which needs a different
> shape and cannot be trusted with the constraints section.
>
> Everything asserted here was measured on this codebase. Where a number appears, it came
> from a probe, not an estimate — that is the difference between this brief and a wish list.

---

## 1. Your role and the bar

You are the senior product designer and front-end engineer for **PulseBLR**. You own the
visual system end to end, and you are being asked for the top of your range: a spatial,
dimensional, unmistakably premium product — the kind of work a studio charges five figures
for and puts in its portfolio.

The bar is not "has 3D in it". Two things separate a five-figure result from an expensive-looking
template:

1. **Every dimensional choice carries meaning.** Depth encodes hierarchy, motion encodes
   causality, and the one accent encodes "you can act on this". Decoration that means nothing
   is the single clearest tell of generated design.
2. **It survives contact with reality.** A mid-range Android phone on conference wifi, a user
   with reduced-motion on, an event with no cover image, a 56-character URL in a description.
   Beauty that only holds in the happy path is a mock, not a product.

Write like someone who will maintain this for two years. Comments explain *why*, with the
measurement that forced the decision.

---

## 2. The product truth — this is the design thesis

PulseBLR surfaces Bengaluru software and hardware engineering events **worth attending to make
professional connections**, and tracks who you met. It is a PWA. Most use is on a phone.

It has exactly one claim that Luma, Meetup and every other event site cannot make:

> **It ranks by whether you will leave having met someone worth meeting.**

That claim is real code — `connectionScore` (0–100, `lib/events/connection-score.ts`): in-person
weighted heaviest, attendee counts log-scaled, food a bonus, and certification/cohort/webinar
funnels penalised hard because those put you in an audience rather than a room. Measured effect:
practitioner meetups with a company host score 88–99; "Get Google AI Certified … Cohort" and
"Webinar: …" land at 0–2.

**The design's job is to make that claim visible and felt.** Every spatial decision should be
answerable to it. A dimensional treatment that makes the app prettier but says nothing about who
you will meet is decoration; one that makes the network legible is the product.

Corollary, and the most expensive mistake available here: **do not design for data that does not
exist.** An earlier redesign attempt produced a beautiful "Event Intelligence" screen showing
"12,450 Active Attendees", "42 Concurrent Sessions", "84% venue saturation" and "speaker
velocity". PulseBLR collects **none** of that. Meanwhile `connectionScore`, `isTechEvent`, company
attribution, area, source health and the contact graph appeared on **zero** of 27 screens, and the
connection meter — the documented signature element — was absent from all of them. Section 4 is the
authoritative list of what you may design with.

---

## 3. Non-negotiable constraints

Each of these is a rule the codebase already enforces, and each exists because something was
measured and fixed. An audit of 27 generated "3D" screens broke four of the five. Do not
re-break them; if you believe one is wrong, say so explicitly and argue it rather than quietly
violating it.

### 3.1 The four design rules (`app/globals.css`)

1. **Tracking is a function of size.** The ramp spans `-0.042em` at display sizes to `+0.11em`
   on uppercase labels. Display faces use **Inter Tight** (`--font-display`); body uses Inter.
   One `letter-spacing` across a whole ramp is the tell of a default type scale.
   *Audit found: Inter Tight in 0 of 27 files.*
2. **Elevation is a ring PLUS a lift, never one blur.** `--lift-1/2/3` each stack a `0.5px`
   hairline ring for the edge with soft offset shadows for the height. A single diffuse shadow
   reads as fog — no defined edge, barely separated from the page.
   *Audit found: 40 large-blur shadows across 20 files.*
3. **Hairlines are alpha, not solid grey.** `rgba(0,0,0,0.07)`. A solid `#E5E5EA` reads as a
   light line on white and a darker line on the page grey — the same border at two weights.
4. **One accent, rationed.** `--blue` (`#0071E3`) means "you can act on this" — links, focus,
   primary actions, the connection meter. `--live` (`#FF3B30`) marks exactly one state.
   Everything else is greyscale, which is what leaves **cover images as the only colourful thing
   on screen**. Eight category gradients were deleted for this reason, and re-introduced twice
   since; do not bring them back.
   *Audit found: 20 pure-black refs in 8 files, category colour bars back on cards.*
5. **Interactive surfaces PRESS, they do not lift.** `.pressable`, `scale(0.978)`. A hover-grow
   has no touch equivalent and most of this app is used on a phone.
   *Audit found: 24 hover-grow transforms.*

### 3.2 Motion and accessibility

- **`prefers-reduced-motion: reduce` must be honoured by construction, not by shortening.**
  Opt IN to motion inside `@media (prefers-reduced-motion: no-preference)`. Do not rely on the
  global `animation-duration: 0.001ms !important` block — it cannot reliably disable a
  timeline-driven animation. Under `reduce`, `animation-name` must resolve to `none`, and 3D
  scenes must render **one static frame**: the depth stays, the drift stops.
  *Audit found: 0 of 27 screens honoured it.*
- One easing curve for everything: `--ease: cubic-bezier(0.32, 0.72, 0, 1)`.
- Motion must serve finding an event faster, never slower. A full-viewport hero that pushes the
  first event below the fold is a regression, measured: five stacked cards once put the first
  ranked row at y=1899 on a 375×812 screen — 2.34 screens of scroll before the feed.

### 3.3 Platform

- **Next.js is pinned to `16.3.2` and has breaking changes from older releases.** Read the
  relevant guide in `node_modules/next/dist/docs/` before writing Next code. Route protection
  lives in `proxy.ts` (no `middleware.ts`); route-handler `params` is a Promise you must `await`.
- **No CDN `<script>` tags, no external asset hosts.** This is a PWA with a service worker.
  *Audit found: 22 of 27 screens pulled CDN scripts and Google Fonts — not implementable here.*
- **Event covers use a plain `<img>`, never `next/image`.** Covers come from a long, growing list
  of third-party CDNs; `remotePatterns` would break every time a source changes host.
- Formatting is pinned to **Asia/Kolkata** via `lib/format.ts`. Never use the ambient locale.
- Restart the dev server after adding a field to an existing Mongoose model, or writes to the new
  path are silently dropped.

### 3.4 Performance budget — hard numbers

- Base-bundle cost of the ambient 3D layer: **≤ 5KB**. It is on every route. `three.js` is
  ~150KB gzipped and is currently loaded **only** on the feed behind `dynamic(ssr:false)` plus a
  capability gate — keep it that way. Raw WebGL for anything site-wide.
- DPR capped at **1.5 desktop / 1.25 mobile**. A 3× phone would otherwise shade 9× the pixels.
- Every WebGL surface must: pause when the tab is hidden, pause when offscreen, refuse to start
  on `saveData` / `deviceMemory < 2` / `hardwareConcurrency ≤ 2`, handle `webglcontextlost` **and**
  `webglcontextrestored`, free its context on unmount (browsers cap live contexts near 16), and
  set `pointer-events: none` if it covers content.
- No layout-thrashing scroll listeners. Prefer CSS `animation-timeline: view()` under
  `@supports`, which needs no JS and cannot jank.

---

## 4. The data contract — design only with these

**Per event** (`lib/models/Event.ts`, served by `/api/events`):
`title`, `startDateTime`, `endDateTime`, `venue`, `address`, `area`, `city`, `format`
(`in-person` | `online`), `imageUrl`, `organizer`, `hostAvatarUrl`, `description`, `price`/`isFree`,
`attendeeCount`, `category[]` (22-value taxonomy), `tags[]` (**effectively empty — 32 of 1212
upcoming events carry any tag, 6 distinct values in the whole corpus; do not design a tag facet**),
`companies[]` (resolved against a ~109-company registry), `isTechEvent`, `connectionScore`,
`spotlightAt` (editorial pin), `source`, `clusterKey`.

**Derived and aggregate signals that are real and under-used:**
- `connectionScore` distribution across the feed — the ranking is the product.
- in-person vs online split (corpus is near-evenly divided; online events post more often and at
  shorter notice, which is why chronological sort selects the worst quartile).
- company attribution and the coverage gap — `/companies` deliberately shows companies with
  **nothing** scheduled and hosts the registry does not recognise.
- area clustering (Koramangala, Indiranagar, HSR, Whitefield, Hebbal…).
- tech-vs-noise ratio (~20% of the corpus is tech; the feed defaults to `techOnly`).
- source health — a source that silently stops producing is reported.
- **the user's own contact graph**: `Contact.contactKey`, folders per event, repeat connections
  (same person across 2+ events), target companies, pending follow-ups.

**Per user:** tracker entries with kanban status, folders, contacts, target companies, digest
preferences.

If a design needs a number, it must come from this list or from a query you can actually write.
**Never invent a metric to fill a card.** If a surface would be better with data that does not
exist, say so and propose the query — do not fabricate and do not silently drop the surface.

---

## 5. The spatial system to build

### 5.1 The organising idea: light app, dark stages

The client's pinned design system is a **light glass** world — `#F5F5F7` canvas, white cards,
`#1D1D1F`/`#86868B` ink tiers, one blue accent, minimalist glassmorphism. Do not retire it for a
dark theme; it is the pinned direction and it is 80% of what the app already is.

The premium move is not "go dark". It is a **two-register system**:

- **The app register is light.** Glass cards on a live, near-monochrome depth field. Calm,
  editorial, content-forward. This is where reading and scanning happen.
- **3D scenes live on dark stages inset into it.** The connection graph already does this — a
  near-black band with the blue network in it. A dark stage reads as a window into depth, and the
  contrast between the light page and the dark stage is what makes the depth feel *real* rather
  than like a texture on paper.

This is already the app's instinct; make it a system. Every genuine 3D scene sits on a dark
stage with a defined edge and a caption that says what you are looking at. Everything else is
light glass over the ambient field.

### 5.2 The four depth registers

Build these as tokens and utilities, not per-component one-offs.

| Register | What it is | Rule |
| --- | --- | --- |
| **Ambient** | One persistent WebGL field behind the whole app | Never interactive. `pointer-events: none`. Carries no data. Continuous across route changes. |
| **Stage** | A dark inset panel containing a real 3D scene | Interactive, carries data, always captioned. |
| **Surface** | Glass cards over the ambient field | Translucent so depth reads *through* them. Ring-plus-lift elevation. |
| **Object** | Something resting on a surface — a cover, the meter | Its own plane, its own contact shadow. |

The distinction between **Ambient** and **Stage** is the one to get right, and it was got wrong
once already on this branch: a decorative procedural field was built for the feed hero and
deleted because the feed already had a real data-driven graph there — then reinstated as an
app-wide ambient layer, which is a different job. Foreground carries data; background does not.
Both can exist. Neither substitutes for the other.

### 5.3 Motion vocabulary

Four kinds of motion, each with a job. Anything that is not one of these is decoration.

1. **Arrival** — content rising and resolving as it enters, finishing before it is read.
   Scroll-driven (`animation-timeline: view()`), 14–26px, `entry 3%` → `entry 50%`.
2. **Parallax** — differential movement between depth planes. Nearer planes move further per
   pixel of scroll. *Equal movement is not parallax, it is a transition.*
3. **Response** — press on tap (`scale(0.978)`), ring-plus-lift on hover, node-and-its-edges
   lighting together on the graph.
4. **Continuity** — route transitions that carry the spatial position across a navigation, so the
   app reads as one space. `framer-motion@13.1.1` is already a dependency and currently unused;
   this is what it is for.

Ambient drift is the fifth thing and is deliberately excluded from the list: it is the only
motion allowed to mean nothing, it belongs to the ambient register alone, and it stops entirely
under reduced-motion.

---

## 6. Surface-by-surface brief

For each: what the page is *for*, and what the spatial treatment should therefore do. Do not
apply a uniform treatment — that is how a system becomes a template.

**`/` Feed** — the front door; scanning a ranked list. *Already has:* the connection graph on a
dark stage, glass cards, ambient field, spotlight. *Do:* make the graph the anchor it deserves to
be — larger, orbit-on-drag, and clicking a node scrolls its row into view (the spatial view and
the list must be one dataset, not two features). Keep the first event row above the fold at
375×812. The time rail is the page's spine; give it depth without making it decoration.

**`/events/[id]` Event detail** — deciding whether to go. *Already has:* the cover as an ambient
halo behind a floating crisp copy. *Do:* make `connectionScore` the second thing you see after the
title — this is the page where "will I meet anyone" is actually decided. The "Worth going?" panel
is the right idea; give it dimensional weight. Venue could earn a small dark stage if and only if
you can render area context from real data.

**`/tracker` Kanban** — moving events through a personal pipeline. *Still flat.* Columns are
depth planes; a dragged card should genuinely lift out of its column and settle into the next.
This is the surface where physical response matters most, because the user is manipulating
objects. Note: moving to Confirmed/Attended auto-creates a folder — surface that as a real,
visible consequence rather than a silent side effect.

**`/folders`, `/folders/[id]`** — the people you met. *Still flat, and thin on features.* This is
the app's most valuable data and its weakest surface. Repeat connections (`contactKey` across 2+
events) are computed and shown **nowhere** in this UI. A contact who recurs should be visibly
distinguished. Folder rename/delete/archive and move-contact-between-folders all have working
endpoints and no UI.

**`/companies`** — coverage and the gap in it. *Still flat.* The honest thing this page does is
show companies with nothing scheduled and hosts the registry does not recognise. Encode presence
vs absence in *form* as well as number, and consider a dark stage showing attribution as a real
network — that is genuine data.

**`/people`** — cross-folder contact view. `GET /api/contacts` serves it and nothing consumes it;
"who do I know at Razorpay" is currently unanswerable in the product. Build the surface.

**`/calendar`** — time, not ranking. Depth should read as *time* here: a month is a plane, days
are cells with occupancy. Note it already has the app's one deliberate full-bleed dark band.

**`/scan`, `/card`, `/c/<token>`, `/f/<token>`** — capture, at an event, on a phone, possibly
offline, one-handed. **Restraint is the premium choice here.** These are full-bleed and need real
safe-area insets (`viewportFit: 'cover'` is set globally). Do not put an ambient field behind a
camera viewfinder. `/c/` and `/f/` are public and seen by strangers with no account — they are the
product's first impression, so they get craft, not effects.

**`/dashboard`, `/settings`, `/admin`** — operator and account surfaces. Quiet. `/admin` is the
operator console; it should look competent and dense, not marketed at. Do not give `/dashboard`
its own nav or its own hero — it had both, and that is exactly why it read as a different app.

---

## 7. Anti-patterns — the specific failures to avoid

Every one of these actually happened on this project. This list is most of the value of this brief.

1. **A marketing landing page where the product goes.** "Join the Pulse", "Enter the Ecosystem"
   — for an app whose home is a signed-in feed. Do not design a storefront.
2. **A hero that pushes content off the screen.** Measured: 2.34 screens of scroll before the
   first event on a phone.
3. **Fabricated metrics.** See §4. This is the one that wastes the most work, because the screen
   looks finished and cannot be built.
4. **Naming something 3D that is a flat gradient.** Of 27 screens tagged "(3D)", only 5 of 22
   rendered ever initialised a WebGL context; the flagship was CSS.
5. **A working fallback hiding a dead primary.** The graph's SVG fallback rendered perfectly
   while the WebGL path drew **no nodes at all** — for as long as it took someone to complain
   about a screenshot. If you build a graceful degradation, you must separately verify the
   primary path renders.
6. **Trusting an abstraction you have not seen render.** drei's `<Instances>` renders nothing
   against this version set (`drei@10.7.8` / `fiber@9.7.0` / `three@0.185.1`). Isolate with a
   deliberate experiment — a plain core `<mesh>` with a magenta material — before assuming your
   geometry, camera, colours or sizes are wrong.
7. **Unit-space mismatches between renderers.** The same `r` field was pixels×105 in SVG and raw
   world units in WebGL, so nodes were 3–6px. Convert explicitly, derive the constant from the
   camera, and write the derivation in a comment.
8. **Framing that clips the content.** 36% of the graph sat outside the camera frustum.
9. **Long unbreakable words.** A bare URL in a scraped description pushed the document to 88px of
   horizontal scroll on a 390px viewport. `break-words` on every field that carries scraped text.
10. **Three different logos across three screens.** One mark, one wordmark, one lockup.
11. **A second copy of the navigation.** It will go stale. There is one `DesktopNav` and one
    `MobileBottomNav`.
12. **Silent truncation.** If a design caps a list, log or label what was dropped.

---

## 8. What already exists — read before building

Do not rebuild these. Extend them.

- `app/globals.css` — the token system, the four rules, the glass layer, `--lift-1/2/3`,
  `--contact`, `--inset-1`, `.stage`/`.plane-*`, `.spatial-rise`/`-settle`/`-recede`,
  `.glass-card`, `.cover-halo`, `.ambient-field`, `.ambient-above`, `.meter`.
- `app/components/spatial/AmbientField.tsx` — the app-wide WebGL depth field, mounted once in the
  root layout. Three parallaxed planes, all guards implemented. `intensity` is the one dial.
- `app/components/graph/` — `EventGraphHero` (capability gate + SVG-first), `ConnectionGraph`
  (the WebGL scene, now on core `<instancedMesh>`), `GraphFallback` (SVG).
- `app/components/EventHeroCover.tsx` — the event-detail cover with its ambient halo.
- `app/components/EventRow.tsx` / `EventGridCard.tsx` — the feed's two card types, glass, with
  the connection meter.
- `lib/graph/build-graph.ts` — nodes and edges from real events; edges are a *checkable* reason
  two events put you in front of the same people (same host, shared company, same topic).
- `scripts/diag-spatial-layer.mjs` — the verification harness (below).

---

## 9. Definition of done

Do not report the work as finished without these. State the actual output, not a claim.

**Automated**
- `npx tsc --noEmit` clean.
- `npm run lint` — 0 errors.
- `npm test` — all tests pass (currently 530 across 22 files).
- `npm run build` succeeds.
- `node scripts/diag-spatial-layer.mjs <url>` passes: 0 content-only overlaps at 1440×900 and
  390×844 at scroll-top **and** scrolled (clip-aware, excluding fixed/sticky ancestors), no
  horizontal overflow on any route, reduced-motion resolving to `animation-name: none`, elevation
  resolving to multiple stacked shadow layers rather than one blur.
- Extend that harness for every new surface you touch. A spatial change with no probe is unverified.

**Manual, and required**
- Every WebGL surface: confirm a **live context** and **distinct frames over time** — not merely
  that a canvas element exists. Screenshot the canvas specifically, not the first `<canvas>, <svg>`
  in the document.
- Reduced-motion on: all drift stops, all scroll animation off, depth still legible, 3D stages
  render one static frame.
- 390×844: no horizontal scroll, first event above the fold, safe-area insets correct on
  `/scan` and `/card`.
- Throttled CPU (6×) and a simulated low-end profile: the ambient field refuses to start and the
  CSS fallback shows.
- An event with **no cover image**: the halo is suppressed, the monogram fallback reads as designed.
- Sign out, sign in as a different Google account, go offline: no data from the first account.

**Verification hygiene** — two traps that cost real time on this branch:
- Rebuilding while a `next start` server is running serves **stale HTML referencing a CSS chunk
  that 404s**, which looks exactly like your CSS being broken. Restart the server after every
  build and confirm the referenced CSS returns 200.
- Warm every route with `curl` before running a headless probe; a cold compile reads as a failure.

---

## 10. How to work

1. **Read before writing.** `CLAUDE.md`, `AGENTS.md`, `app/globals.css`, and the components in §8.
   The comments carry measurements you cannot re-derive cheaply.
2. **Measure, then design.** If you are about to assert something about the corpus, run a query.
   The `scripts/diag-*.ts` family exists for this.
3. **One surface at a time, verified, committed.** Feed → event detail → tracker → folders/people
   → companies → calendar → capture flows. A reviewable diff per surface beats a rewrite.
4. **Show your work.** Screenshot at both viewports, in both motion states, and say what you
   measured. "Looks good" is not a report.
5. **When a rule and the brief conflict, say so and argue it.** Do not resolve it silently in
   either direction.

---

## Appendix — adapting this for Stitch or another screen generator

A screen generator cannot be trusted with §3 or §4: it has no access to the codebase, so it will
invent navigation, invent metrics, and produce CSS that breaks the four rules. It was measured
doing exactly that 27 times. Use it for **composition exploration only**, and constrain it hard:

- Give it §2 (the product truth), §5.1–5.2 (the two-register system and depth registers), §6
  (the surface briefs), and §7 (anti-patterns). Withhold nothing from §7 — it is the half that works.
- Give it the **real navigation** explicitly: Events, Companies, Calendar, Tracker, People, Add,
  Settings. Nothing else. No "Ecosystem", no "Speakers", no "Sign In" CTA (auth is Google-only).
- Give it the **real data list** from §4 and tell it plainly that inventing a metric makes the
  screen unusable.
- Pin the type roles: **Inter Tight** for display, Inter for body, tracking varying with size.
- Forbid: pure-black full-bleed sections, hover-grow, single large-blur shadows, category colour
  bars or gradients on cards, CDN scripts.
- **Then fix its output before implementing it.** Treat generated screens as composition
  references, never as an implementation source. Its design-system document currently *prescribes*
  four of the defects above (`scale(1.02)` on hover, "pure black `#000000`" hero sections, a
  "10% opacity, 30–40px blur" shadow, one font family for all three roles) — so the highest-leverage
  single action is to rewrite that document before generating anything else.
