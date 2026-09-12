# The UI direction — what was tried, what was refused, and why

Companion to `docs/plan-and-architecture.md`. That file records what the product is and how it is
built; this one records the **rejected options**, because the plan and the architecture can be
re-derived from the code and the rejections cannot. Started 2026-09-12 with Phase 1 of the UI
direction brief.

The rule this file exists to serve: a decision recorded without its alternative reads as the only
thing anyone thought of, and the next person re-litigates it from scratch.

---

## Phase 1 — making styling possible (no visual change intended)

Phase 1 changes nothing a user would call a redesign. It exists because two previous passes did not
stick, and the reason was the substrate: a `className` that primitives silently discarded, and a
palette that lived as ~1,076 raw hex literals across 69 files while the token it was supposed to be
was referenced three times.

### 1. The class-merge helper

**Built:** `lib/cn.ts`, nine lines, applied to all twelve `ui.tsx` primitives.

**Refused: `clsx`.** Two dependencies to replace nine lines, and neither is free — every dependency
is a supply-chain surface, and this repo already re-runs `npm audit` as a matter of policy because a
dated vulnerability claim in a document ages into a false reassurance.

**Refused, and this one is the interesting refusal: `tailwind-merge`.** It is the obvious choice and
it is the wrong behaviour here. It resolves a Tailwind conflict by **dropping the earlier class**, so
a caller fighting a primitive gets a silently-resolved result instead of a visible one. Last-wins in
the cascade is the behaviour to keep, because it is what a reader can predict from the source order.
The whole reason this file exists is that a silent class-composition failure cost weeks; replacing it
with a cleverer silent resolution would be the same mistake wearing a library.

**The ordering is the contract: BASE FIRST, CALLER LAST.** A caller must be able to override, which
is the entire point of accepting the prop.

**What the test asserts, and why the second half is the whole test.** The shipped bug was not that
`className` was ignored — it was that `className` sits in `ButtonHTMLAttributes`, so `...rest`
captured it and `{...rest}` spread *after* the styling, **replacing** the base classes. So a test
looking only for the caller's class **passes on the bug**: the sentinel is present in exactly the
broken rendering. Each case therefore asserts the sentinel AND a class the component contributes
itself.

Proved rather than assumed: reintroducing the bug on `Button` for one run failed the suite
(`Button dropped the caller's class`), and reverting it passed. A detector that has never fired is
not evidence.

**Rendered through `react-dom/server`, not a DOM library.** `ui.tsx` is server-safe by its own
docblock — no hooks, no `'use client'` — so `renderToStaticMarkup` exercises the real components with
no jsdom, no `@testing-library/react`, and no change to `vitest.config.mts`. The file is `.ts` and
uses `createElement` rather than JSX because the config's `include` glob ends in `.test.ts`; a `.tsx`
test would be collected by nothing and would "pass" by never running.

### 2. The palette — three refusals worth keeping

**Refused: a tenth token for destructive actions.** The sweep found the codebase using **three** reds
against a palette declaring one — `#FF3B30` at 15 sites (7 genuinely time-critical, 8 destructive),
and `#C7362D` at 37 more that no document had ever declared. The obvious fix is `--danger`. It was
refused because the brief fixes the palette at nine values and a tenth is a tenth, and because the
two senses **never occupy the same pixel**: a live dot and a validation error are never the same
element, so one red cannot be ambiguous in context. `--live` is re-documented as "urgent OR
destructive" instead. This is the cheaper half of a real trade: the token name now under-describes
its job, and a comment carries the difference.

**Refused: tinted washes, anywhere.** `Banner` had four (`#EBF4FE` info, `#EBF7EF` ok, `amber-50`
warn, `#FFF1F0` error), the danger button had one, the nav active state had a 10% blue. There is no
tint layer in nine values, and inventing four washes to carry four tones is exactly the "one more
grey" move that produced 212 raw hexes across 53 files in the first place. A tone is now **the ink
plus a `border-l-2`** on the paper ground. The `warn` tone became the *quietest* of the four in the
process, which is a correction rather than a side effect — amber had made a routine caution louder
than a failure.

**Refused: keeping `var()` out of the email templates by leaving them on the old greys.** The sweep
correctly declined to use custom properties in email HTML, Satori (`next/og`) and the standalone
unsubscribe documents — `globals.css` is not in scope there, so a `var()` resolves to nothing, which
is worse than a hex. But the *consequence* it flagged (four surfaces stranded on the retired Apple
palette, drifting visibly from the app) is fixable without `var()`: use the **literal new values**
and comment each site to say it mirrors a token deliberately, so the next person does not "fix" it
into a variable that resolves to nothing.

**Kept as hexes on purpose, with reasons that are not about effort:** `QrCode.tsx`'s pure white
(scan reliability — the file's own comment predates this work and is right), `lib/format.ts`'s
`CATEGORY_ACCENTS` and `tracker/page.tsx`'s `COLUMNS.tint`. Those last two are **categorical scales,
not palette values**, and migrating part of a categorical scale is actively harmful: mapping two of
seven tracker column tints onto the accent would have made `Interested` collide with `Confirmed`.

### 3. Elevation

**Refused: removing the shadows one call site at a time.** `--lift-1` and `--lift-2` are now `none`,
which neutralises `.card-shadow`, `.card-shadow-lg` and `.raise:hover` in one place. Editing ~30 call
sites to delete a class would have left the tokens alive for the next author to reach for.

What no token could neutralise had to go by hand. `.seg-btn.active`'s `0 1px 6px rgba(0,0,0,.12)`
is done — a second real elevation shadow against a rule allowing one. Still outstanding in `app/**`
at the time of writing: eight Tailwind built-ins (`shadow-lg` ×5, `shadow-sm` ×3) and four bespoke
blurs, all measured, none yet replaced. Each becomes an inset hairline ring — which does the job the
fog shadow was failing at anyway, since the recorded complaint about the old elevation was that it
had **no defined edge**.

**Not refused, deliberately kept:** the focus ring (`shadow-[0_0_0_2px_var(--blue)]`) and the modal
backdrop scrim (`shadow-[0_0_0_100vmax_...]`). Neither is elevation, and visible keyboard focus is a
definition-of-done item, so a blanket "remove every box-shadow" sweep would have deleted an
accessibility affordance to satisfy a geometry rule.

### 4. Verification

**Refused: verifying any of this from the source.** Every failure in this layer is silent:

- A literal family name in `--font-sans` falls through to `system-ui` with no error. This shipped,
  and every tracking value in the file had been calibrated for a face that was not rendering.
- A `.ty-*` rule that did not compile still renders readable text, so a missing step looks
  deliberate.
- An undefined custom property makes its whole declaration invalid at computed-value time, so
  `padding: var(--s-4)` against a missing token computes to `0px` — which reads as "tight spacing".

`scripts/diag-design-tokens.ts` reads all of it out of a real Chromium instead, and is a permanent
diagnostic rather than a scratch probe for one reason: the typeface bug has already happened once.

**Two controls that must fire, because a detector that cannot fail proves nothing when it passes.** A
contrast probe in this repo once returned exactly `1.00` for 22 categories — a parser bug reading as
a clean result, because Chrome resolves `color-mix()` to `color(srgb 0..1)` floats rather than
`rgb()`. A custom property is worse still: it returns its **literal token text**, so an rgb-only
parser reports nothing at all. The palette section therefore carries a paper-on-white pair (1.05:1),
and the type section an undefined `.ty-` class.

**Two bugs in my own probes, both of the same family — a check that silently cannot fail:**

- The type control read a **live** `CSSStyleDeclaration` *after* detaching its element, so every
  property came back `''` and `parseFloat` turned that into `NaN`. It printed `NaN` and asserted
  nothing. Reading before the detach fixed it.
- `console.log` in Node supports `%s` but not `%-6s` width specifiers, so the labels printed
  literally and every value after them shifted one column. The data was right and the report was
  misleading, which is the worse of the two failure modes.

**One honest limit, stated rather than papered over:** `.ty-body` is 16px sans, the same size and face
as an unstyled paragraph, so its *size* cannot prove the rule compiled. Its line-height can (24.8px
against 24px), and that is what the check uses.

### 5. Process notes

**`tsx` compiles these scripts to CJS** (no `"type": "module"` in `package.json`), so top-level
`await` is a transform error — every diag script wraps its body in an async IIFE, and this one now
does too.

**esbuild's `keepNames` breaks `page.evaluate`.** A name-inferred function inside an evaluate callback
(`const widthOf = (f) => {}`) gets wrapped in esbuild's `__name()` helper, and `page.evaluate` ships
the function *source* to a browser where that helper does not exist: `ReferenceError: __name is not
defined`. Arrow functions passed directly as arguments infer no name and are unaffected, which is why
only one of five callbacks broke. Measure through a `.map` rather than a named helper.

**Two agents in one working tree needs explicit ownership, and I got this wrong once.** I copied
`ui.tsx` to a backup, edited it to reintroduce a bug, and restored it — while a sweep agent was
running over the same directory. It happened to be safe (the agent had not reached that file), but
that was luck, not design. Ownership was declared explicitly afterwards: `globals.css`,
`layout.tsx`, `ui.tsx` and `tests/**` are the main session's; everything else in `app/` and `lib/` is
the agent's.

**`tsconfig.json` gets rewritten by the verify server**, which adds `.next-verify-dev/types` to
`include` and reformats the file. It is not an agent's edit and not a real change; restore it from
`HEAD` before committing. This has now happened twice.

### 6. The three sweep rounds, and what each round only found by doing the previous one

The token sweep took three rounds, and the shape of that is the lesson: each round's mapping rules
surfaced a class of site the previous round's rules could not express.

- **Round 1** (~1,031 sites, 60 files) took the 14 named legacy values onto the nine.
- **Round 2** (~565 sites) took the cool-grey ladder, the accent washes, `#C7362D`, `bg-white` /
  `text-white`, and the elevation shadows. It also found `#FFF1F0` — the *error* wash, which the
  brief's list omitted, and leaving it would have kept a pink ground on error banners while `ok` and
  `info` lost theirs.
- **Round 3** (~45 sites) took a long tail that was invisible to both: **lowercase** greys
  (`#e5e5e5`, `#f0f0f0`, `#f7f7f7`, `#efeff2` — the kanban column background), four tone wash/ink
  *pairs*, and `#0060C0`.

**Total across the three: ~1,616 sites, 66 files. Nine raw occurrences of the 54 swept values
remain, every one deliberate** — eight in the two categorical scales, one in `app/layout.tsx`
(below).

**The pair is the unit, not the hex.** A wash and its ink were always two different hex values in
two different files' worth of classes, and converting either alone produces a worse result than
doing nothing: a wash with no ink, or ink on a ground that no longer contrasts. Round 3's brief named
them as pairs for that reason.

### 7. Two costs accepted, and one that was mine

Recorded because a cost that only lives in an agent's report is a cost nobody will find again.

**The tracker's past-vs-upcoming date no longer differs by colour.** It was `#b0b0b5` against
`--ink-2`. Both strings are *read*, so neither may take `--ink-3` — that is settled: 3.09:1 is never
body text, and this is an 11-12px string. With both on `--ink-2` the distinction is carried by
nothing. If it matters it needs a non-colour signal, which is a Phase 3 decision about that row, not
a palette one.

**`SourcesPanel`'s health dot now paints three values for four states.** `#30D158` → `--accent`
(healthy) and `#FF9F0A` → `--live` (unhealthy) were specified; `dead` was *already* `--live`, so
"dead" and "enabled but producing nothing" are now visually identical. The row text still
distinguishes them. A nine-value palette cannot carry a four-state scale in colour alone, and
inventing a fourth would be inventing a tenth token.

**Mine: the PWA `themeColor` was still `#F5F5F7`.** This is the most visible hex that survived all
three rounds, and no sweep would have caught it because it is not CSS — `app/layout.tsx`'s metadata
is serialised into `<meta name="theme-color">`, where a `var()` resolves to nothing. It paints the
browser's own chrome: the Android address bar, an installed PWA's status area, the task-switcher
card. So the app was framed in the retired cool grey around a page that had gone warm. Now
`#FAF9F5`, as a commented literal, with a note that it must be kept in step by hand.

### 8. The decisions the sweep correctly refused to make

An agent that guesses at these produces a diff that is hard to argue with. Each of these came back
as a question, and each was worth asking.

**The follow-ups strip (`#FF9500`, three sites) → `--accent`.** Three candidates:

- `--ink-2` is what round 3's amber rule says, and it is wrong *here* — it turns the strip's
  attention bar into a mid-grey rule. The file's own comment calls this strip "the tracker's reason
  to exist, so it leads". Erasing its signal to satisfy a mapping is the mapping winning over the
  product.
- `--live` is wrong on **rationing**. It means urgent-or-destructive and is spent on things that
  expire imminently. This strip is a permanent fixture for anyone using the tracker, and putting the
  loudest colour on a permanent fixture is precisely how an accent stops meaning anything.
- `--accent` means "you can act on this", which is what a due follow-up *is*.

Note `#FF9500` is *also* `COLUMNS.tint`'s `Applied` value in the same file. Converting only the three
strip uses deliberately splits one hex across two meanings — they were never the same thing, they
collided on a value.

**The daily digest email (`lib/notifications/digest.ts`, 18 hexes) → left alone, for the owner.** A
purple gradient (`#667eea`/`#764ba2`) plus Chakra slate and amber. It has no counterpart in nine
values, an email is not a route the brief scopes, and email clients strip `:root` so it cannot use
tokens anyway. It is also the surface users actually *receive*, which makes it a design decision
rather than a mechanical one.

**`login/page.tsx`'s four Google brand hexes → stay.** A third party's identity is not our palette.

### 9. Two more probe bugs of the same family, both mine

Adding to the two in §4, because the pattern is now four for four: **every one of my probe bugs was a
check that silently could not fail**, never one that reported a false alarm.

- The diag took route arguments and filtered on `startsWith('/')`. Under Git-bash on Windows, MSYS
  rewrites `/tracker` to `C:/Program Files/Git/tracker` — so the filter discarded every route and the
  script checked only the home page while reporting a clean pass for surfaces it had never opened.
- A `subprocess`-based hex classifier returned 8 occurrences where bash measured 151, and I reported
  the 8 before noticing. The pattern had not survived being passed without a shell. Re-measured in
  the shell that had already worked.

The general form, worth keeping: **when a measurement disagrees with an earlier one, the instrument
is the first suspect, not the tree.** That held for the 500 (a cached Turbopack failure, not broken
CSS), for the 25 diag failures (a page that had rendered nothing), and for both of these.

---

## Phase 2 and Phase 3 — the cascade bug, and what three agents found that I had not

### The single most important finding of the whole UI pass

**`globals.css` was UNLAYERED, so every class in it silently outranked every Tailwind utility.** An
unlayered rule beats a layered one regardless of specificity or source order, and Tailwind's utilities
live in `@layer utilities`. Two Phase 3 agents found this independently, from opposite directions, by
probing the served stylesheet and the live DOM rather than reading the source.

Measured on real elements, before the fix:

```
ty-meta font-semibold            ->  weight 500     the utility was DISCARDED
ty-meta text-[var(--ink)]        ->  --ink-2        so was the colour
ty-row-title text-[13px]         ->  20px           so was the size
rounded-full rounded-[4px]       ->  2.2e7px        the pill wins
<h2 class="font-sans">           ->  Newsreader     the element default cannot be overridden
```

**This broke Phase 1's own premise.** `lib/cn.ts` exists so a caller's class reaches a primitive, and
its docblock states the contract as "BASE FIRST, CALLER LAST — a caller must be able to override".
The class arrived and then lost. The helper was necessary and not sufficient, and nothing anywhere
said so.

**The damage was real and spread across three surfaces, all of which read correctly in source:**

- the feed's row clock rendered grey and unbolded;
- "Happening now" rendered `--ink-2` instead of `--live`;
- the category links I added under `/events/[id]`'s description rendered **grey where the code asks
  for `--accent`** — my own Phase 2 work, and I would not have found it, because I verified that page
  by screenshot at a size where a grey-vs-green 13px link is not obviously wrong.

**The fix is scoped, not global.** The `.ty-*` scale moved into `@layer components` and the
`h1, h2, h3` face default into `@layer base`. Wrapping the whole 1,400-line file would silently
re-rank ~130 rules at once, and any rule that currently beats a utility *on purpose* would start
losing with nothing to announce it. `scripts/diag-design-tokens.ts` now asserts composability with
four override cases plus a control — the control is the important half: with no utility present the
step must still apply, or the "fix" has broken the scale instead of freeing it.

### Six probe bugs, all of one kind

Every instrument failure this pass was **a check that silently could not fail**. None was a false
alarm. Recording the set, because the pattern is more useful than any single instance:

1. A contrast control read a live `CSSStyleDeclaration` *after* detaching its element — every property
   came back `''`, `parseFloat` made it `NaN`, and it asserted nothing.
2. `console.log` in Node ignores `%-6s` width specifiers, so labels printed literally and every value
   shifted one column. The data was right and the report was misleading.
3. A route filter used `startsWith('/')`. Under Git-bash, MSYS rewrites `/tracker` to
   `C:/Program Files/Git/tracker`, so the filter discarded every route and the diagnostic checked only
   the home page **while reporting a clean pass** for surfaces it had never opened.
4. A `subprocess`-based hex classifier returned 8 occurrences where bash measured 151, and I reported
   the 8 before noticing.
5. **The sticky action bar measured "ON SCREEN" and was completely covered by the mobile bottom nav.**
   `document.elementFromPoint()` at the bar's own Register centre returned a *nav link* — the tap went
   to the wrong control. A bounding box cannot answer occlusion. Only a screenshot found it.
6. An agent's occlusion probe asked for a point *below the fold*, where `elementFromPoint` returns
   `null` — which reads exactly like "nothing is covering it". It now scrolls the target into view
   first. That is an improvement on the method I had handed it.

The general form, and the rule to keep: **when a measurement disagrees with an earlier one, the
instrument is the first suspect, not the tree.** That held for the 500 on the dev server (a cached
Turbopack failure), for 25 simultaneous diag failures (a page that had rendered nothing), and for
every item above.

### Three briefs of mine were stale, one self-blockingly

Recorded because CLAUDE.md already logs this twice and it has now happened three more times:

- I told an agent to delete `AdminDashboard`'s local `Card`/`Stat`/`Banner`/`Empty` copies and import
  from `ui.tsx`. They had been imported since `54a80fb`. There was nothing to delete.
- I told an agent to unify `/people`'s local `FilterRail`/`Toggle` — already extracted into
  `FacetRail.tsx` by an earlier session, **and that file was in the same brief's do-not-touch list**.
  The instruction could not be carried out as written.
- I told two agents to sweep Tailwind palette colours from files that had none left.

Each agent checked the code and said so instead of inventing work. That is the behaviour the "verify
against the code and a query, never against the plan" rule exists to produce.

### Decisions taken against the codebase's own documentation

- **`.meter` is gone from `/events/[id]` and from `EventRow`.** CLAUDE.md §7 calls it "the signature
  element" and argues it renders as three bars *rather than* the number, because a ranking signal
  printed as "83" implies precision it does not have. That reasoning is right, and the direction
  extends it: a bar chart of a ranking signal asserts three distinguishable levels, which is the same
  claim to resolution drawn instead of written. Row order is now the only expression. **§7 is stale on
  this point.**
- **A count is sans, not `--font-display`.** `ui.tsx`'s `Stat` set its value in `--font-display`, which
  after the token rewiring resolves to Newsreader — so every count in the app rendered as *the city's
  content* when a count is nothing but the app speaking. The semantic rule inverted on the one element
  that is purely a number.

### Invented content removed

`/people`'s empty state rendered a real `PersonRow` for a fabricated *"Asha Rao · Razorpay · Staff
Engineer, payments"*, with a fabricated note about pinging her after Diwali. The agent that inherited
the surface flagged rather than deleted it — the right call, since it is argued for at length, dimmed,
`aria-hidden` and inert, and it does teach the shape of a row. Removed anyway, for two reasons that
tip it past "a labelled illustration": it names a **real company**, so at 70% opacity it reads as the
first row of somebody's actual contact list (an `aria-hidden` attribute is not visible), and an empty
state's job is to invite an action — this one competed with its own two buttons by putting a richer
object beneath them. One sentence now says what a row holds and invents nobody.

### Costs and gaps, stated rather than smoothed

- **The admin console was never seen.** `/admin` `redirect()`s a non-admin, and signing in as the
  owner's allowlisted address would upsert their `User` row — a DB write that was out of scope. Those
  screenshots show the real signed-out path, not the console.
- **The tracker's 7-column board never rendered**, because the reachable account has zero tracked
  entries. Its documented "opens on an empty column at 2126px scrollWidth" behaviour is still
  unverified; the board sits in `overflow-x-auto`, so the *document* measured 0 overflow at all widths.
- **`agenda` and `speakers` remain unverified** — false on all 18 sampled events and 0 of 277
  corpus-wide. Only the absent path is reachable without a database write.
- **The 768 two-column facts/verdict band from the Phase 2 plan was not built.** The measured goal was
  met without it and I have not measured a benefit. An unimplemented plan item, not a silent omission.
- **`app/components/Sheet.tsx` still carries `rounded-t-[22px]`, `card-shadow-lg` and `bg-black/40`**,
  and `app/digest/page.tsx` still wraps the new flat `EventRow` in a rounded, shadowed surface. Both
  were outside every agent's file set. Two surfaces disagree with the system until they migrate.
- **`FacetRail`'s chips are still `rounded-full`** at 36px beside 4px inputs on `/people`.
- **Eight controls on `/people` paint under 44px** — all `ui.tsx` buttons at `sm` (32px) and `md`
  (40px). `TAP_44` exists but the required gap is per-layout arithmetic no shared primitive can do for
  its callers, which is why `Button` deliberately does not blanket-apply the overlay.
- **A `0x01` byte sat in `app/scan/page.tsx`'s comment in HEAD**, standing in for a line break after an
  em-dash. Harmless where it was, and precisely the corruption that once turned `keywordTagging()`
  into silently dead code. Repaired; the tree is now clean of `0x00`, `0x01` and `0x08`.

---

## Refusals inherited from earlier work, restated because a redesign is exactly when they get undone

These are already recorded in `CLAUDE.md` with their measurements. They are repeated here because
each is a thing a designer would naturally add back.

- **No "Free" pill.** `isFree` is `{ type: Boolean, default: true }` — 88.5% of upcoming tech events.
  A label on nine rows in ten carries no information, and the old one failed AA at 4.00:1. Mark a
  price only when there is one; absence means free.
- **No "Ends soon".** `registrationDeadline` is a date on **0 of 1616** documents.
- **No tag clouds or tag facets.** `Event.tags` has six distinct values in the entire corpus.
- **Nothing personal.** Eight user accounts, all on the identical factory seed. A "for you" shelf is
  a global shelf wearing a false label.
- **`connectionScore` is never a number, bar, meter, star or percentage.** It is a ranking signal, not
  a measurement; "83" implies a precision it does not have. It may express itself as row order plus
  at most one factual clause derived from the event's own fields.
- **No tech toggle.** The public feed is `techOnly` unconditionally, and `?techOnly=false` is stripped
  from the URL rather than merely ignored.
- **A tracked ALL-CAPS eyebrow is a measured bug here, not just a cliché.** One set 243px where
  sentence case set 170px and pushed the home page to a right edge of x=485 in a 390px viewport.
