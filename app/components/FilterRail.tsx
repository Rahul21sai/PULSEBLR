'use client';

import { useState } from 'react';
import { CATEGORY_GROUPS, Facets } from '@/lib/event-types';

export interface FilterState {
  categories: string[];
  areas: string[];
  companies: string[];
  format: string;
  freeOnly: boolean;
  foodOnly: boolean;
  techOnly: boolean;
}

export const EMPTY_FILTERS: FilterState = {
  categories: [],
  areas: [],
  companies: [],
  format: '',
  freeOnly: false,
  foodOnly: false,
  techOnly: false,
};

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
    (filters.format ? 1 : 0) +
    (filters.freeOnly ? 1 : 0) +
    (filters.foodOnly ? 1 : 0) +
    (filters.techOnly ? 1 : 0)
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
}: {
  facets: Facets | null;
  filters: FilterState;
  onChange: (next: FilterState) => void;
  loading?: boolean;
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

  return (
    <div className="flex flex-col gap-6">
      {/* Quick toggles */}
      <section>
        <h2 className="text-label-sm uppercase tracking-widest text-[#86868B] mb-2.5">Quick filters</h2>
        <div className="flex flex-wrap gap-2">
          {/* On by default. Labelled as the thing it lets you do — see everything —
              because a toggle that is already active reads as a filter you can drop. */}
          <Toggle
            label={filters.techOnly ? 'Tech only' : 'Show all events'}
            count={totals?.tech}
            active={filters.techOnly}
            onClick={() => onChange({ ...filters, techOnly: !filters.techOnly })}
          />
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
        <h2 className="text-label-sm uppercase tracking-widest text-[#86868B] mb-2.5">Format</h2>
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
                className={`flex items-center justify-center gap-1.5 h-9 px-2 rounded-lg text-[12.5px] font-semibold border transition-colors ${
                  active
                    ? 'bg-[#1D1D1F] text-white border-[#1D1D1F]'
                    : empty
                      ? 'bg-[#f7f7f9] text-[#c7c7cc] border-[#f0f0f2] cursor-not-allowed'
                      : 'bg-white text-[#1D1D1F] border-[#e5e5ea] hover:bg-[#f3f3f5]'
                }`}
              >
                <span className="truncate">{label}</span>
                {count !== undefined && (
                  <span className={`tnum shrink-0 ${active ? 'text-white/60' : 'text-[#a1a1a6]'}`}>
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
      <section>
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-label-sm uppercase tracking-widest text-[#86868B]">Category</h2>
          {filters.categories.length > 0 && (
            <button
              type="button"
              onClick={() => onChange({ ...filters, categories: [] })}
              className="text-[11px] font-semibold text-[#0071E3] hover:underline"
            >
              Clear {filters.categories.length}
            </button>
          )}
        </div>

        {loading && categories.length === 0 ? (
          <SkeletonList rows={8} />
        ) : (
          <div className="flex flex-col gap-3.5">
            {CATEGORY_GROUPS.map(group => {
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
                      className={`w-2.5 h-2.5 shrink-0 text-[#a1a1a6] transition-transform ${
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
                    <span className="text-[12px] font-semibold text-[#1D1D1F]">{group.label}</span>
                    {selectedHere > 0 && (
                      <span className="tnum rounded-full bg-[#0071E3] px-1.5 text-[10px] font-bold leading-[15px] text-white">
                        {selectedHere}
                      </span>
                    )}
                    <span className="tnum ml-auto truncate pl-2 text-[11px] text-[#a1a1a6]">
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

      {/* Companies — the "whose event is this" axis */}
      {companies.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-2.5">
            <h2 className="text-label-sm uppercase tracking-widest text-[#86868B]">Company</h2>
            {filters.companies.length > 0 && (
              <button
                type="button"
                onClick={() => onChange({ ...filters, companies: [] })}
                className="text-[11px] font-semibold text-[#0071E3] hover:underline"
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

      {/* Areas */}
      <section>
        <div className="flex items-center justify-between mb-2.5">
          <h2 className="text-label-sm uppercase tracking-widest text-[#86868B]">Area</h2>
          {filters.areas.length > 0 && (
            <button
              type="button"
              onClick={() => onChange({ ...filters, areas: [] })}
              className="text-[11px] font-semibold text-[#0071E3] hover:underline"
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

      {countActive(filters) > 0 && (
        <button
          type="button"
          onClick={() => onChange(EMPTY_FILTERS)}
          className="text-label-md font-semibold text-[#0071E3] hover:underline text-left"
        >
          Reset all filters
        </button>
      )}
    </div>
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
      className={`px-3.5 py-1.5 rounded-full text-[12.5px] font-semibold border transition-colors ${
        active
          ? 'bg-[#0071E3] text-white border-[#0071E3]'
          : 'bg-white text-[#1D1D1F] border-[#e5e5ea] hover:bg-[#f3f3f5]'
      }`}
    >
      {label}
      {count !== undefined && (
        <span className={`tnum ml-1.5 ${active ? 'text-white/70' : 'text-[#a1a1a6]'}`}>{count}</span>
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
      className={`flex items-center gap-2.5 py-1.5 px-2 -mx-2 rounded-lg text-[13.5px] ${
        empty ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer hover:bg-white'
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={empty}
        onChange={onToggle}
        className="w-4 h-4 accent-[#0071E3] shrink-0"
      />
      <span className={`flex-1 truncate ${checked ? 'font-semibold text-[#1D1D1F]' : 'text-[#3a3a3c]'}`}>
        {label}
      </span>
      <span className="tnum text-[12px] text-[#a1a1a6]">{count}</span>
    </label>
  );
}

function SkeletonList({ rows }: { rows: number }) {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton h-4 rounded" style={{ width: `${60 + ((i * 13) % 35)}%` }} />
      ))}
    </div>
  );
}
