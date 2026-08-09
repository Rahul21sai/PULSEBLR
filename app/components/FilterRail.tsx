'use client';

import { Facets } from '@/lib/event-types';

export interface FilterState {
  categories: string[];
  areas: string[];
  format: string;
  freeOnly: boolean;
  foodOnly: boolean;
  techOnly: boolean;
}

export const EMPTY_FILTERS: FilterState = {
  categories: [],
  areas: [],
  format: '',
  freeOnly: false,
  foodOnly: false,
  techOnly: false,
};

export function countActive(filters: FilterState): number {
  return (
    filters.categories.length +
    filters.areas.length +
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
  const toggleIn = (list: string[], value: string) =>
    list.includes(value) ? list.filter(v => v !== value) : [...list, value];

  const categories = Object.entries(facets?.categories || {}).sort((a, b) => b[1] - a[1]);
  const areas = Object.entries(facets?.areas || {}).sort((a, b) => b[1] - a[1]);
  const formats = facets?.formats || {};
  const totals = facets?.totals;

  return (
    <div className="flex flex-col gap-6">
      {/* Quick toggles */}
      <section>
        <h3 className="text-label-sm uppercase tracking-widest text-[#86868B] mb-2.5">Quick filters</h3>
        <div className="flex flex-wrap gap-2">
          <Toggle
            label="Tech only"
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

      {/* Format */}
      <section>
        <h3 className="text-label-sm uppercase tracking-widest text-[#86868B] mb-2.5">Format</h3>
        <div className="seg-control">
          {(['', 'offline', 'online', 'hybrid'] as const).map(value => (
            <button
              key={value || 'any'}
              type="button"
              onClick={() => onChange({ ...filters, format: value })}
              className={`seg-btn capitalize ${filters.format === value ? 'active' : ''}`}
            >
              {value === '' ? 'Any' : value === 'offline' ? 'In person' : value}
              {value !== '' && formats[value] !== undefined && (
                <span className="text-[#a1a1a6] ml-1 tnum">{formats[value]}</span>
              )}
            </button>
          ))}
        </div>
      </section>

      {/* Categories */}
      <section>
        <div className="flex items-center justify-between mb-2.5">
          <h3 className="text-label-sm uppercase tracking-widest text-[#86868B]">Category</h3>
          {filters.categories.length > 0 && (
            <button
              type="button"
              onClick={() => onChange({ ...filters, categories: [] })}
              className="text-[11px] font-semibold text-[#0071E3] hover:underline"
            >
              Clear
            </button>
          )}
        </div>
        {loading && categories.length === 0 ? (
          <SkeletonList rows={8} />
        ) : (
          <div className="flex flex-col gap-0.5 max-h-[320px] overflow-y-auto pr-1">
            {categories.map(([name, count]) => (
              <CheckRow
                key={name}
                label={name}
                count={count}
                checked={filters.categories.includes(name)}
                onToggle={() =>
                  onChange({ ...filters, categories: toggleIn(filters.categories, name) })
                }
              />
            ))}
          </div>
        )}
      </section>

      {/* Areas */}
      <section>
        <div className="flex items-center justify-between mb-2.5">
          <h3 className="text-label-sm uppercase tracking-widest text-[#86868B]">Area</h3>
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
