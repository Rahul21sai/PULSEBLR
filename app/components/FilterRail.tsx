'use client';

import { useState } from 'react';
import { CATEGORY_GROUPS, Facets } from '@/lib/event-types';

/**
 * `Facets` plus the three card-metadata dimensions `GET /api/events/facets` now returns.
 *
 * DECLARED HERE RATHER THAN IN `lib/event-types.ts` because that module is not this agent's to
 * edit. It is a widening only — every existing key keeps its type — so a caller passing a plain
 * `Facets` still type-checks, and folding these three into the shared interface later is a
 * delete-this-block change with no call-site churn.
 *
 * OPTIONAL, NOT REQUIRED, and that is not laziness: a facet response served from a cache written
 * before these keys existed has to keep rendering the rest of the rail rather than throwing.
 */
export type FacetsWithCardMeta = Facets & {
  audience?: Record<string, number>;
  perks?: Record<string, number>;
  tier?: Record<string, number>;
};

/**
 * A controlled-vocabulary value as a reader should see it: `senior-engineers` -> `Senior engineers`.
 *
 * Sentence case, not Title Case — the vocabularies are plain descriptions of people and things
 * (`students`, `lunch`, `swag`), and Title-Casing them would make them read like proper nouns.
 * Only the first letter is raised, so `sre` stays `Sre` rather than becoming a shouted acronym in
 * a rail where every other row is sentence case; the alternative is an acronym exception list,
 * which is more machinery than one row of the shortest facet deserves.
 */
function vocabLabel(value: string): string {
  const spaced = value.replace(/-/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * `techOnly` IS DELIBERATELY NOT A MEMBER OF THIS TYPE.
 *
 * It used to be, defaulting to `false` in `EMPTY_FILTERS` — and both whole-reset paths pass
 * `EMPTY_FILTERS` straight through (the rail's own Reset button, and the empty state's "Clear
 * filters" in `app/page.tsx`). So one tap on Reset flipped the feed from 297 tech events to all
 * 1158: concerts, treks, comedy and book clubs, i.e. exactly the listings site that commit
 * 7cd13b6 removed the toggle to prevent. It was worse than the old toggle, because `countActive`
 * (correctly) does not count `techOnly`, so with no other filter left the Reset button unmounted
 * and there was NO control on screen to undo it — only a reload.
 *
 * Making it unrepresentable is the fix. `buildParams` in `app/page.tsx` now sets
 * `techOnly=true` unconditionally, so no reset path, no URL parameter and no future state
 * mutation can express `false`. If tech-only ever becomes a user choice again, it belongs in
 * this type WITH a control in the rail — never in the state without one.
 */
export interface FilterState {
  categories: string[];
  areas: string[];
  companies: string[];
  format: string;
  freeOnly: boolean;
  foodOnly: boolean;
  /**
   * Card metadata — `audience`, `perks`, `tier`.
   *
   * THEIR CONTROLS DO NOT RENDER TODAY, AND THAT IS THE POINT. Measured 2026-09-10, the keys are
   * absent on all 1616 documents: the schema landed and no tagger run has written them. So each
   * facet map comes back `{}` and each section below is gated on a non-empty map, which means a
   * reader is never offered a chip that cannot match — the mistake that got the "Everything else"
   * category group deleted, and the reason the events spec refuses a "Filling up fast" shelf.
   *
   * They live in the state anyway so the whole path — URL, `buildParams`, `buildEventFilter`,
   * facet counting, rendering — is complete and tested before the data arrives. When the tagger
   * backfills, the sections appear on their own.
   */
  audience: string[];
  perks: string[];
  tier: string[];
}

export const EMPTY_FILTERS: FilterState = {
  categories: [],
  areas: [],
  companies: [],
  format: '',
  freeOnly: false,
  foodOnly: false,
  audience: [],
  perks: [],
  tier: [],
};

/**
 * One class for every section heading in the rail.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * IT WAS `text-label-sm uppercase tracking-widest` IN A DECORATIVE GREY, EIGHT TIMES, IN A 248px
 * COLUMN.
 *
 * `docs/design-direction.md` names tracked-out ALL-CAPS labels as a pattern to remove, and this file
 * held the densest concentration of them in the app. Two independent problems on top of the look:
 *
 *  · That grey measured **3.30:1** against the page grey of the retired Apple-grey palette. At
 *    11.5px that is under the 4.5:1 floor, so the labels that tell a reader what each control group
 *    IS were the least legible text in the rail. `--ink` is 16.4:1 on paper.
 *  · `tracking-widest` is +0.1em, which is nearly double `.t-label`'s +0.055em. At 248px wide,
 *    `Kind of event` set in tracked caps is ~124px — half the rail — for three words that could be
 *    read at half that.
 *
 * Sentence case at 12px semibold in ink. The group labels inside Category dropped to `font-medium
 * text-[var(--ink-2)]` in the same change, because a section heading has to outrank the groups nested
 * under it and previously both were `font-semibold` in full ink.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
const RAIL_HEADING = 'text-[13px] leading-[1.4] font-semibold text-[var(--ink)]';

/**
 * The count beside a row or a chip.
 *
 * The grey this used to carry measured 2.58:1 on white and 2.35:1 on the page grey — the numbers that
 * make this rail a faceted rail rather than a list of guesses were the closest thing on it to
 * invisible. `--ink-2` clears the 4.5:1 floor and still reads as secondary to the label beside it.
 */
const RAIL_COUNT = 'text-[color:var(--ink-2)]';

/** Format options, in the order they matter for meeting people in person. */
const FORMAT_OPTIONS: Array<{ value: '' | 'offline' | 'online' | 'hybrid'; label: string }> = [
  { value: '', label: 'Any' },
  { value: 'offline', label: 'In person' },
  { value: 'online', label: 'Online' },
  { value: 'hybrid', label: 'Hybrid' },
];

export function countActive(filters: FilterState): number {
  return (
    filters.categories.length +
    filters.areas.length +
    filters.companies.length +
    filters.audience.length +
    filters.perks.length +
    filters.tier.length +
    (filters.format ? 1 : 0) +
    (filters.freeOnly ? 1 : 0) +
    (filters.foodOnly ? 1 : 0)
    // `techOnly` is not counted because it is no longer part of `FilterState` at all — see the
    // note above the interface. Counting it would have shown "1 filter active" on a completely
    // unfiltered feed, next to a Clear button that could not clear it.
  );
}

/**
 * Faceted filters with live counts.
 *
 * Counts come from /api/events/facets computed under the current filter set, so
 * every option shows how many events selecting it would actually give you. An
 * option with zero matches is disabled rather than hidden — hiding it makes the
 * list jump around as you type, and users lose track of what exists.
 */
export default function FilterRail({
  facets,
  filters,
  onChange,
  loading,
  onRetry,
}: {
  facets: FacetsWithCardMeta | null;
  filters: FilterState;
  onChange: (next: FilterState) => void;
  loading?: boolean;
  /**
   * Re-run the feed request, including the facet aggregation this rail is built from.
   *
   * Needed because a facet failure is SILENT and leaves most of the rail non-functional — see
   * `countsUnavailable` below. Optional so a caller that has nothing to retry with still compiles.
   */
  onRetry?: () => void;
}) {
  // Per-group disclosure state. Undefined means "use the group's own default",
  // which is why this is a sparse record rather than a fully-populated one.
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});

  const toggleIn = (list: string[], value: string) =>
    list.includes(value) ? list.filter(v => v !== value) : [...list, value];

  const counts = facets?.categories || {};
  const categories = Object.entries(counts);
  const companies = Object.entries(facets?.companies || {}).sort((a, b) => b[1] - a[1]);
  const areas = Object.entries(facets?.areas || {}).sort((a, b) => b[1] - a[1]);
  const formats = facets?.formats || {};
  const totals = facets?.totals;
  /*
   * Each is `[]` until the tagger writes the field, which is what keeps its section unrendered.
   * Sorted by count like `companies` and `areas`, NOT by the vocabulary's declaration order: the
   * vocabularies are written to read sensibly in `lib/event-types.ts` (students -> juniors ->
   * senior-engineers is a seniority ramp), but a rail is for finding what exists, and a fixed order
   * would put a 40-event bucket below an empty one.
   */
  const audience = Object.entries(facets?.audience || {}).sort((a, b) => b[1] - a[1]);
  const perks = Object.entries(facets?.perks || {}).sort((a, b) => b[1] - a[1]);
  const tier = Object.entries(facets?.tier || {}).sort((a, b) => b[1] - a[1]);

  /**
   * THE FACET REQUEST FAILED, AND IT USED TO FAIL SILENTLY AND INVISIBLY.
   *
   * `app/page.tsx` only ever calls `setFacets` on an ok response — correctly, because a facet failure
   * must not blank the feed. But `facets` then stays `null`, and this rail derives Category, Company
   * and Area entirely from it: every row is filtered on `count > 0`, so all of them vanish and the
   * reader is left looking at two headings with nothing underneath. Nothing anywhere said the counts
   * had not arrived, so the honest reading of that screen — "this city has no categories and no
   * venues" — was wrong, and the three axes a reader actually filters on were quietly gone.
   *
   * `!facets && !loading` is exactly "no facet response has ever succeeded": the value starts null,
   * is only ever assigned on ok, and `loading` covers the in-flight case. Format, Free and Food are
   * unaffected — their options are fixed — so the rail degrades to the part that still works and says
   * which part does not.
   */
  const countsUnavailable = !facets && !loading;

  return (
    <div className="flex flex-col gap-6">
      {/* The rail's own landmark. Its sections used to be eight `<h2>`s, siblings of the page's own
          section headings, so a screen-reader outline interleaved "Spotlight, Category, Added by hand,
          Company…" as though the filters were content. They are `<h3>` under this now. Visually
          hidden because the desktop rail has no room for a title and the mobile sheet already shows
          one. */}
      <h2 className="sr-only">Filters</h2>

      {/* ── THE "Quick filters" HEADING IS GONE. ────────────────────────────────────────────────
          It announced two chips reading `Free` and `Food`. `docs/design-direction.md`: "delete the
          label — most of them describe what the content below already says", and this was the clearest
          case of it on the page. The section keeps an accessible name so nothing is lost to a screen
          reader; what goes is a line of type telling a sighted reader that the two words below are
          filters, in a column whose every element is a filter. */}
      <section aria-label="Quick filters">
        <div className="flex flex-wrap gap-2">
          {/*
            THE "SHOW ALL EVENTS" TOGGLE IS GONE, AND `techOnly` IS NOW UNCONDITIONAL.
            ─────────────────────────────────────────────────────────────────────────────────────
            This app is for finding Bengaluru software and hardware engineering events worth
            attending to make professional connections. The scraper still ingests the whole city,
            because one broad pass is cheaper than many narrow ones and the classifier sorts it
            out — but the RESULT of that pass is not something a reader should be offered.
            Measured on the live corpus: 1158 upcoming events, 297 of them tech. So the escape
            hatch led to a view that was 74% concerts, treks, comedy and book clubs.

            A toggle is not neutral. Offering it says the product is unsure what it is about, and
            it was the one control that could turn a sharp product into a general listings site in
            a single tap.

            NOTHING WAS DELETED. The 861 non-tech events are still stored, still scraped and still
            listed in /admin — where they are needed, both to correct a mis-tag and because
            non-tech is where the junk to remove lives. `techOnly` also stays in the API and in
            `buildEventFilter`: /admin uses it, and removing a query parameter to express a UI
            decision would be the wrong layer.
            ─────────────────────────────────────────────────────────────────────────────────────
          */}
          <Toggle
            label="Free"
            count={totals?.free}
            active={filters.freeOnly}
            onClick={() => onChange({ ...filters, freeOnly: !filters.freeOnly })}
          />
          <Toggle
            label="Food"
            count={totals?.withFood}
            active={filters.foodOnly}
            onClick={() => onChange({ ...filters, foodOnly: !filters.foodOnly })}
          />
        </div>
      </section>

      {/* Format
          A 4-way segmented control could not hold "In person 4 / Online 6 / Hybrid"
          inside the 248px rail — the labels collided with each other and with their
          counts. A 2x2 grid of buttons gives each option a full half-width, so the
          label and count always fit and nothing overlaps at any rail width. */}
      <section>
        <h3 className={`${RAIL_HEADING} mb-2.5`}>Format</h3>
        <div className="grid grid-cols-2 gap-1.5">
          {FORMAT_OPTIONS.map(({ value, label }) => {
            const active = filters.format === value;
            const count = value ? formats[value] : undefined;
            // An option with no matching events is disabled rather than hidden, so
            // the grid never reflows while you change other filters.
            const empty = value !== '' && count === 0 && !active;
            return (
              <button
                key={value || 'any'}
                type="button"
                disabled={empty}
                aria-pressed={active}
                onClick={() => onChange({ ...filters, format: value })}
                className={`pressable r-touch flex h-9 items-center justify-center gap-1.5 border px-2 text-[13px] font-semibold transition-colors ${
                  active
                    ? 'bg-[var(--ink)] text-[var(--accent-ink)] border-[var(--ink)]'
                    : empty
                      ? 'bg-[var(--paper)] text-[var(--ink-3)] border-[var(--rule)] cursor-not-allowed'
                      : 'bg-[var(--surface)] text-[var(--ink)] border-[var(--rule)] hover:bg-[var(--paper)]'
                }`}
              >
                <span className="truncate">{label}</span>
                {count !== undefined && (
                  <span className={`tnum shrink-0 ${active ? 'text-[var(--accent-ink)]/60' : RAIL_COUNT}`}>
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </section>

      {/* Categories, grouped by the two axes the taxonomy actually mixes.
          A single count-sorted list put "Community/Social (335)" and
          "Health/Fitness (143)" above every tech topic, so the one thing this
          product is for sat below the fold. Grouping fixes the ordering without
          hiding anything: topic first, then kind of gathering, then the non-tech
          tail folded away behind a disclosure. */}
      {/* States what happened and what to do, in place of three sections that would otherwise render
          as bare headings. Not an apology and not a spinner: the counts are a separate request from
          the feed, so the feed beside this is fine and the reader needs to know that too. */}
      {countsUnavailable && (
        <section
          aria-label="Filter counts"
          className="border-l-2 border-l-[var(--ink-2)] bg-[var(--paper)] px-3.5 py-3"
        >
          <p className="text-[13px] leading-[1.4] font-semibold text-[var(--ink)]">Filter counts didn’t load</p>
          <p className="ty-meta mt-1">
            Category, company and area need them. Format, free and food still work, and the events
            beside this are unaffected.
          </p>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="mt-2 text-[13px] leading-[1.4] font-semibold text-[color:var(--accent)] hover:underline"
            >
              Try again
            </button>
          )}
        </section>
      )}

      {!countsUnavailable && (
      <section>
        <div className="flex items-center justify-between mb-1">
          <h3 className={RAIL_HEADING}>Category</h3>
          {filters.categories.length > 0 && (
            <button
              type="button"
              onClick={() => onChange({ ...filters, categories: [] })}
              className="text-[13px] leading-[1.4] font-semibold text-[color:var(--accent)] hover:underline"
            >
              Clear {filters.categories.length}
            </button>
          )}
        </div>

        {loading && categories.length === 0 ? (
          <SkeletonList rows={8} />
        ) : (
          <div className="flex flex-col gap-3.5">
            {/*
              `other` ("Everything else") is filtered out: with `techOnly` unconditional, none of
              its categories can ever match, so the group could only ever render empty or — worse —
              show a count that clicking would not honour.
            */}
            {CATEGORY_GROUPS.filter(group => group.id !== 'other').map(group => {
              // Facet counts decide what to show; the group supplies only order and
              // grouping. A category with no events is omitted entirely here —
              // unlike the format grid, where a fixed 2x2 must not reflow — because
              // 22 permanently-visible rows is what made this rail unusable.
              const rows = group.names
                .map(name => [name, counts[name] ?? 0] as const)
                .filter(([name, count]) => count > 0 || filters.categories.includes(name));
              if (rows.length === 0) return null;

              const selectedHere = rows.filter(([name]) =>
                filters.categories.includes(name)
              ).length;
              // A collapsed group opens itself when it holds a selection; otherwise
              // an active filter would be invisible.
              const open = openGroups[group.id] ?? (!group.collapsed || selectedHere > 0);
              const groupTotal = rows.reduce((sum, [, count]) => sum + count, 0);

              return (
                <div key={group.id}>
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => setOpenGroups(prev => ({ ...prev, [group.id]: !open }))}
                    className="flex w-full items-center gap-1.5 py-1 text-left"
                  >
                    <svg
                      viewBox="0 0 12 12"
                      aria-hidden="true"
                      className={`w-2.5 h-2.5 shrink-0 text-[var(--ink-3)] transition-transform ${
                        open ? 'rotate-90' : ''
                      }`}
                    >
                      <path
                        d="M4 2l4 4-4 4"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    {/* `font-medium text-[var(--ink-2)]`, not `font-semibold text-[var(--ink)]`: a group
                        nested inside the Category section cannot be set heavier and darker than the
                        section heading above it, which is what both being ink-semibold produced. */}
                    <span className="ty-meta">{group.label}</span>
                    {selectedHere > 0 && (
                      <span className="tnum r-touch bg-[var(--accent)] px-1.5 text-[10px] font-bold leading-[15px] text-[var(--accent-ink)]">
                        {selectedHere}
                      </span>
                    )}
                    <span className={`ty-meta ml-auto truncate pl-2 ${RAIL_COUNT}`}>
                      {open ? group.hint : groupTotal}
                    </span>
                  </button>

                  {open && (
                    <div className="flex flex-col gap-0.5 mt-0.5">
                      {rows.map(([name, count]) => (
                        <CheckRow
                          key={name}
                          label={name}
                          count={count}
                          checked={filters.categories.includes(name)}
                          onToggle={() =>
                            onChange({
                              ...filters,
                              categories: toggleIn(filters.categories, name),
                            })
                          }
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
      )}

      {/* Companies — the "whose event is this" axis */}
      {companies.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-2.5">
            <h3 className={RAIL_HEADING}>Company</h3>
            {filters.companies.length > 0 && (
              <button
                type="button"
                onClick={() => onChange({ ...filters, companies: [] })}
                className="text-[13px] leading-[1.4] font-semibold text-[color:var(--accent)] hover:underline"
              >
                Clear
              </button>
            )}
          </div>
          <div className="flex flex-col gap-0.5 max-h-[240px] overflow-y-auto pr-1">
            {companies.map(([name, count]) => (
              <CheckRow
                key={name}
                label={name}
                count={count}
                checked={filters.companies.includes(name)}
                onToggle={() =>
                  onChange({ ...filters, companies: toggleIn(filters.companies, name) })
                }
              />
            ))}
          </div>
        </section>
      )}

      {/* CARD METADATA — who it is for, what you get, and what kind of event it is.
          ─────────────────────────────────────────────────────────────────────────────────────
          ALL THREE RENDER NOTHING TODAY. `rows.length === 0` returns null, and every map is empty
          because the fields existed on no document yet (measured 2026-09-10: 0 of 1616) — and that
          is NO LONGER TRUE. Re-measured 2026-09-12 after the tagger backfill: of 277 upcoming tech
          events, `audience` 123 (44.4%), `tier` 132 (47.7%), `perks` 28 (10.1%). All three sections
          now render. The gate below is driven by the facet counts rather than by a hardcoded flag,
          which is why they lit up on their own — that is the property to keep, and the reason this
          comment was the only thing that needed changing. So this is
          three sections' worth of markup that a reader currently never sees — deliberately, and it
          is the same gate the Company section above uses, for the same reason. A chip that cannot
          match anything is the defect that removed the "Everything else" category group.

          Placed between Company and Area because that is the order of a reader's questions: what
          it's about (Category), whose it is (Company), whether it's for me (Audience), what I get
          (Perks), how big a deal it is (Tier), then where (Area). Tier last of the three because it
          is the only one that judges rather than describes. */}
      <VocabSection
        heading="Audience"
        rows={audience}
        selected={filters.audience}
        onToggle={name => onChange({ ...filters, audience: toggleIn(filters.audience, name) })}
        onClear={() => onChange({ ...filters, audience: [] })}
      />
      <VocabSection
        heading="Perks"
        rows={perks}
        selected={filters.perks}
        onToggle={name => onChange({ ...filters, perks: toggleIn(filters.perks, name) })}
        onClear={() => onChange({ ...filters, perks: [] })}
      />
      <VocabSection
        heading="Kind of event"
        rows={tier}
        selected={filters.tier}
        onToggle={name => onChange({ ...filters, tier: toggleIn(filters.tier, name) })}
        onClear={() => onChange({ ...filters, tier: [] })}
      />

      {/* Areas */}
      {!countsUnavailable && (
      <section>
        <div className="flex items-center justify-between mb-2.5">
          <h3 className={RAIL_HEADING}>Area</h3>
          {filters.areas.length > 0 && (
            <button
              type="button"
              onClick={() => onChange({ ...filters, areas: [] })}
              className="text-[13px] leading-[1.4] font-semibold text-[color:var(--accent)] hover:underline"
            >
              Clear
            </button>
          )}
        </div>
        {loading && areas.length === 0 ? (
          <SkeletonList rows={6} />
        ) : (
          <div className="flex flex-col gap-0.5 max-h-[280px] overflow-y-auto pr-1">
            {areas.map(([name, count]) => (
              <CheckRow
                key={name}
                label={name}
                count={count}
                checked={filters.areas.includes(name)}
                onToggle={() => onChange({ ...filters, areas: toggleIn(filters.areas, name) })}
              />
            ))}
          </div>
        )}
      </section>
      )}

      {countActive(filters) > 0 && (
        <button
          type="button"
          onClick={() => onChange(EMPTY_FILTERS)}
          className="text-left text-[13px] leading-[1.4] font-semibold text-[color:var(--accent)] hover:underline"
        >
          Reset all filters
        </button>
      )}
    </div>
  );
}

/**
 * One controlled-vocabulary facet, or NOTHING AT ALL when the vocabulary has no events behind it.
 *
 * The early return is the whole reason this is a component rather than three inline blocks: the
 * "render only when non-empty" rule has to be stated once, where it cannot be forgotten for one of
 * the three. A row is kept when it has events OR when it is currently selected — the same rule the
 * Category groups use, so narrowing to a value that then falls to zero does not make the chip you
 * are standing on vanish and leave the filter unremovable.
 *
 * No `loading` skeleton, unlike Category and Area. Those two are always present, so a skeleton
 * reserves space that is about to be filled; this one may legitimately never appear, and a skeleton
 * for a section that then does not exist is a promise of content that is not coming.
 */
function VocabSection({
  heading,
  rows,
  selected,
  onToggle,
  onClear,
}: {
  heading: string;
  rows: Array<readonly [string, number]>;
  selected: string[];
  onToggle: (name: string) => void;
  onClear: () => void;
}) {
  const visible = rows.filter(([name, count]) => count > 0 || selected.includes(name));
  if (visible.length === 0) return null;

  return (
    <section>
      <div className="flex items-center justify-between mb-2.5">
        <h3 className={RAIL_HEADING}>{heading}</h3>
        {selected.length > 0 && (
          <button
            type="button"
            onClick={onClear}
            className="text-[13px] leading-[1.4] font-semibold text-[color:var(--accent)] hover:underline"
          >
            Clear
          </button>
        )}
      </div>
      <div className="flex flex-col gap-0.5">
        {visible.map(([name, count]) => (
          <CheckRow
            key={name}
            label={vocabLabel(name)}
            count={count}
            checked={selected.includes(name)}
            onToggle={() => onToggle(name)}
          />
        ))}
      </div>
    </section>
  );
}

function Toggle({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`pressable r-touch border px-3.5 py-1.5 text-[13px] font-semibold transition-colors ${
        active
          ? 'bg-[var(--accent)] text-[var(--accent-ink)] border-[var(--accent)]'
          : 'bg-[var(--surface)] text-[var(--ink)] border-[var(--rule)] hover:bg-[var(--paper)]'
      }`}
    >
      {label}
      {count !== undefined && (
        <span className={`tnum ml-1.5 ${active ? 'text-[var(--accent-ink)]/70' : RAIL_COUNT}`}>{count}</span>
      )}
    </button>
  );
}

function CheckRow({
  label,
  count,
  checked,
  onToggle,
}: {
  label: string;
  count: number;
  checked: boolean;
  onToggle: () => void;
}) {
  const empty = count === 0 && !checked;
  return (
    <label
      className={`ty-meta -mx-2 flex items-center gap-2.5 r-touch px-2 py-1.5 ${
        empty ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer hover:bg-[var(--surface)]'
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={empty}
        onChange={onToggle}
        className="w-4 h-4 accent-[var(--accent)] shrink-0"
      />
      <span className={`flex-1 truncate ${checked ? 'font-semibold text-[var(--ink)]' : 'text-[var(--ink-2)]'}`}>
        {label}
      </span>
      <span className={`tnum ${RAIL_COUNT}`}>{count}</span>
    </label>
  );
}

function SkeletonList({ rows }: { rows: number }) {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton h-4" style={{ width: `${60 + ((i * 13) % 35)}%` }} />
      ))}
    </div>
  );
}
