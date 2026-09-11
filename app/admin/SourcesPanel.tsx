'use client';

import { useMemo, useState } from 'react';
import { Banner, Button, Chip, Well } from '../components/ui';
import { NoRows, Panel, StatCard, num } from './AdminUI';
import ImpactDialog from './ImpactDialog';
import { relativeTime } from '@/lib/format';
import { SOURCE_TYPES } from '@/lib/sources/admin-validate';

/**
 * Sources — 423 rows that were invisible unless you queried the database.
 *
 * ── WHAT THIS PANEL ADDS OVER THE LIST IT REPLACES ──────────────────────────────────────────
 *
 * The old version showed one flat list and four aggregate numbers. The aggregate is the problem: the
 * health is wildly uneven BY KIND, and averaging hides the only thing worth acting on. Measured on
 * this corpus — 86 Luma calendars of which 65 produce nothing, 261 Meetup groups of which 97 produce
 * nothing, and 138 rows with five or more consecutive empty scrapes being re-fetched every night.
 *
 * Those two are not the same finding. A Meetup group with nothing scheduled this fortnight is
 * healthy; a Luma calendar that has never returned an event probably never will. So the kind table
 * comes first, and the row list is filterable to one kind.
 *
 * ── WHY BULK DISABLE SENDS IDS AND NOT A RULE ───────────────────────────────────────────────
 *
 * The tempting design is one button that means "disable everything dead". This repo has already paid
 * for a rule that silently selected rows nobody looked at: a per-run cap of 120 against 200 known
 * Meetup groups dropped the same 80 every night, and the tail contained
 * `microsoft-reactor-bengaluru` (6 events) and the Linux Foundation's group (7) — exactly the
 * coverage that was being written off as a supply gap. So the operator selects, reads the names, and
 * the ids go up explicitly. One audit row covers the batch, so one Undo re-enables all of it.
 *
 * Disabling is never destructive: the row and its discovery state survive, and the pipeline simply
 * stops fetching it. Deleting IS destructive and is steered against — a source currently producing
 * events refuses to delete without an override.
 */

export interface SourceRow {
  id: string;
  kind: string | null;
  handle: string | null;
  name: string;
  url: string | null;
  enabled: boolean;
  lastScrapedAt: string | null;
  lastEventCount: number;
  consecutiveEmptyScrapes: number;
}

export interface KindBucket {
  kind: string;
  total: number;
  producing: number;
  quiet: number;
  never: number;
  dead: number;
  backoffCandidates: number;
  disabled: number;
  events: number;
}

export interface SourcesData {
  total: number;
  producing: number;
  quiet: number;
  never: number;
  dead: number;
  backoffCandidates: number;
  byKind: KindBucket[];
  lastScrapedAt: string | null;
  rows: SourceRow[];
}

/** Register a source discovery cannot reach — a community that publishes only an .ics, or a verified Bevy tenant. */
function NewSourceForm({ onCreated }: { onCreated: (name: string) => void }) {
  const [form, setForm] = useState({ name: '', type: 'ical', url: '', kind: '', handle: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function submit() {
    setSaving(true);
    setError(null);
    setFieldErrors({});
    try {
      const res = await fetch('/api/sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        if (Array.isArray(data?.fields)) {
          const next: Record<string, string> = {};
          for (const f of data.fields as Array<{ field: string; message: string }>) next[f.field] = f.message;
          setFieldErrors(next);
        }
        setError(data?.error || `Could not create (HTTP ${res.status}).`);
        return;
      }
      onCreated(form.name.trim() || 'source');
      setForm({ name: '', type: 'ical', url: '', kind: '', handle: '' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create source.');
    } finally {
      setSaving(false);
    }
  }

  const input = (key: keyof typeof form, placeholder: string) => (
    <label className="block">
      <span className="sr-only">{placeholder}</span>
      <input
        value={form[key]}
        onChange={e => setForm(prev => ({ ...prev, [key]: e.target.value }))}
        placeholder={placeholder}
        className={`h-10 w-full rounded-xl bg-white px-3 text-[13px] text-[#1D1D1F] focus:outline-none ${
          fieldErrors[key]
            ? 'shadow-[inset_0_0_0_1px_#C7362D]'
            : 'shadow-[inset_0_0_0_1px_var(--hairline-strong)] focus:shadow-[inset_0_0_0_2px_#0071E3]'
        }`}
      />
      {fieldErrors[key] && <span className="mt-1 block text-[12px] text-[#C7362D]">{fieldErrors[key]}</span>}
    </label>
  );

  return (
    <div className="mb-3 rounded-2xl bg-[#fbfbfd] p-4 shadow-[inset_0_0_0_1px_var(--hairline)]">
      <div className="grid gap-3 sm:grid-cols-2">
        {input('name', 'Name, e.g. Bengaluru Python User Group')}
        <label className="block">
          <span className="sr-only">Type</span>
          <select
            value={form.type}
            onChange={e => setForm(prev => ({ ...prev, type: e.target.value }))}
            className="h-10 w-full rounded-xl bg-white px-3 text-[13px] text-[#1D1D1F] shadow-[inset_0_0_0_1px_var(--hairline-strong)] focus:outline-none"
          >
            {SOURCE_TYPES.map(t => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="mt-3">{input('url', 'Feed URL, https://…')}</div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {input('kind', 'Kind (optional), e.g. meetup')}
        {input('handle', 'Handle (optional), e.g. blr-python')}
      </div>
      <p className="mt-2 text-[11.5px] leading-relaxed text-[#8E8E93]">
        Kind and handle are the dedup identity and must be given together, or not at all. The scraper
        will fetch this URL on its next run, so http(s) only.
      </p>
      {error && (
        <p role="alert" className="mt-2 rounded-xl bg-[#FFF1F0] px-3 py-2 text-[12.5px] text-[#C7362D]">
          {error}
        </p>
      )}
      {/*
        Wrapped for the margin rather than passing `className` to `Button`: `ui.tsx` spreads `...rest`
        AFTER its own `className`, so a caller-supplied one replaces the computed tone and size and
        the button renders unstyled. Worth knowing before "tidying" this into a prop.
      */}
      <div className="mt-3">
        <Button disabled={saving} onClick={submit}>
          {saving ? 'Registering…' : 'Register source'}
        </Button>
      </div>
    </div>
  );
}

type Health = 'all' | 'producing' | 'quiet' | 'never' | 'dead' | 'disabled';

export default function SourcesPanel({
  sources,
  onChanged,
}: {
  sources: SourcesData;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string; auditId?: string | null } | null>(null);
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState('');
  const [kind, setKind] = useState<string>('all');
  const [health, setHealth] = useState<Health>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmingDelete, setConfirmingDelete] = useState<SourceRow | null>(null);

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return sources.rows.filter(r => {
      if (kind !== 'all' && (r.kind ?? 'built-in') !== kind) return false;
      if (health === 'producing' && r.lastEventCount <= 0) return false;
      if (health === 'quiet' && !(r.lastScrapedAt && r.lastEventCount === 0)) return false;
      if (health === 'never' && r.lastScrapedAt) return false;
      if (health === 'dead' && r.consecutiveEmptyScrapes < 6) return false;
      if (health === 'disabled' && r.enabled) return false;
      if (!q) return true;
      return `${r.name} ${r.handle ?? ''} ${r.kind ?? ''}`.toLowerCase().includes(q);
    });
  }, [sources.rows, filter, kind, health]);

  const toggleSelected = (id: string) =>
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function setEnabled(row: SourceRow, enabled: boolean) {
    setBusy(row.id);
    setNote(null);
    try {
      const res = await fetch(`/api/admin/sources/${row.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
      setNote({
        ok: true,
        text: `${row.name} ${enabled ? 'enabled' : 'disabled'}.`,
        auditId: (json as { auditId?: string }).auditId,
      });
      onChanged();
    } catch (err) {
      setNote({ ok: false, text: `Could not update ${row.name} (${err instanceof Error ? err.message : 'failed'}).` });
    } finally {
      setBusy(null);
    }
  }

  async function bulk(enabled: boolean) {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBusy('bulk');
    setNote(null);
    try {
      const res = await fetch('/api/admin/sources/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, enabled }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        changed?: number;
        skipped?: number;
        auditId?: string | null;
        detail?: string;
      };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setNote({
        ok: true,
        text:
          json.detail ??
          `${json.changed} source${json.changed === 1 ? '' : 's'} ${enabled ? 'enabled' : 'disabled'}` +
            (json.skipped ? ` (${json.skipped} already were)` : '') +
            '.',
        auditId: json.auditId,
      });
      setSelected(new Set());
      onChanged();
    } catch (err) {
      setNote({ ok: false, text: `Bulk change failed (${err instanceof Error ? err.message : 'failed'}).` });
    } finally {
      setBusy(null);
    }
  }

  async function destroy(row: SourceRow, force: boolean) {
    setConfirmingDelete(null);
    setBusy(row.id);
    setNote(null);
    try {
      const res = await fetch(`/api/admin/sources/${row.id}${force ? '?force=true' : ''}`, {
        method: 'DELETE',
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
      setNote({
        ok: true,
        text: `${row.name} deleted. Restorable from the audit log.`,
        auditId: (json as { auditId?: string }).auditId,
      });
      onChanged();
    } catch (err) {
      setNote({ ok: false, text: `Could not delete ${row.name} (${err instanceof Error ? err.message : 'failed'}).` });
    } finally {
      setBusy(null);
    }
  }

  async function undo(auditId: string) {
    setBusy(auditId);
    try {
      const res = await fetch('/api/admin/audit/undo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: auditId }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
      setNote({ ok: true, text: 'Undone.' });
      onChanged();
    } catch (err) {
      setNote({ ok: false, text: `Could not undo (${err instanceof Error ? err.message : 'failed'}).` });
    } finally {
      setBusy(null);
    }
  }

  /** Select everything currently visible — so a bulk action can only ever hit what is on screen. */
  const selectVisible = () => setSelected(new Set(rows.map(r => r.id)));

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Sources tracked" value={num(sources.total)} sub={`${sources.producing} producing`} />
        <StatCard
          label="Producing nothing"
          value={num(sources.quiet + sources.never)}
          sub={`${sources.never} never scraped`}
          tone={sources.quiet + sources.never > 0 ? 'warn' : undefined}
        />
        <StatCard
          label="Dead (6+ empty runs)"
          value={num(sources.dead)}
          sub="still fetched every night"
          tone={sources.dead > 0 ? 'warn' : undefined}
        />
        <StatCard
          label="Last scrape"
          value={sources.lastScrapedAt ? relativeTime(sources.lastScrapedAt) : 'never'}
          sub={`${sources.backoffCandidates} could be backed off`}
        />
      </div>

      <Panel
        title="Health by kind"
        subtitle="The aggregate hides this: a Meetup group with nothing scheduled is fine, a Luma calendar that has never produced probably never will."
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-[12.5px]">
            <thead>
              <tr className="border-b border-[color:var(--hairline)] text-left">
                {['Kind', 'Total', 'Producing', 'Quiet', 'Never', 'Dead', 'Off', 'Events'].map(h => (
                  <th key={h} className="t-label whitespace-nowrap py-2 pr-3 text-[#8E8E93]">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sources.byKind.map(k => (
                <tr key={k.kind} className="border-b border-[#f0f0f2] last:border-0">
                  <td className="py-2.5 pr-3">
                    <button
                      type="button"
                      onClick={() => setKind(kind === k.kind ? 'all' : k.kind)}
                      className={`font-mono text-[12px] font-semibold hover:underline ${
                        kind === k.kind ? 'text-[#0071E3]' : 'text-[#1D1D1F]'
                      }`}
                    >
                      {k.kind}
                    </button>
                  </td>
                  <td className="tnum py-2.5 pr-3 font-semibold">{k.total}</td>
                  <td className="tnum py-2.5 pr-3 text-[#166B35]">{k.producing}</td>
                  <td className="tnum py-2.5 pr-3 text-[#6E6E73]">{k.quiet}</td>
                  <td className="tnum py-2.5 pr-3 text-[#6E6E73]">{k.never}</td>
                  <td className={`tnum py-2.5 pr-3 ${k.dead > 0 ? 'font-semibold text-[#C7362D]' : 'text-[#6E6E73]'}`}>
                    {k.dead}
                  </td>
                  <td className="tnum py-2.5 pr-3 text-[#6E6E73]">{k.disabled}</td>
                  <td className="tnum py-2.5 pr-3">{k.events}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-[12px] leading-relaxed text-[#6E6E73]">
          Nothing retires a dead source automatically yet, so all of them are still requested on every
          run. Disabling one is reversible and frees requests — which is what pays for a second pass
          over the sources that do produce.
        </p>
      </Panel>

      <Panel
        title={`Sources (${rows.length} of ${sources.total})`}
        subtitle={kind === 'all' ? undefined : `Filtered to ${kind}`}
        action={
          <Button size="sm" tone={adding ? 'quiet' : 'secondary'} onClick={() => setAdding(v => !v)}>
            {adding ? 'Cancel' : 'Add source'}
          </Button>
        }
      >
        <div className="flex flex-wrap items-center gap-2 pb-3">
          <label className="relative min-w-[180px] flex-1">
            <span className="sr-only">Filter sources</span>
            <span
              aria-hidden="true"
              className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[18px] text-[#a1a1a6]"
            >
              search
            </span>
            <input
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder="Filter by name, handle or kind"
              className="h-10 w-full rounded-full bg-white pl-10 pr-4 text-[13px] text-[#1D1D1F] shadow-[inset_0_0_0_1px_var(--hairline-strong)] focus:outline-none focus:shadow-[inset_0_0_0_2px_#0071E3]"
            />
          </label>
          {(
            [
              ['all', 'All'],
              ['producing', 'Producing'],
              ['quiet', 'Quiet'],
              ['never', 'Never scraped'],
              ['dead', 'Dead'],
              ['disabled', 'Off'],
            ] as Array<[Health, string]>
          ).map(([id, label]) => (
            <Chip key={id} pressed={health === id} onClick={() => setHealth(id)}>
              {label}
            </Chip>
          ))}
        </div>

        {adding && (
          <NewSourceForm
            onCreated={created => {
              setAdding(false);
              setNote({ ok: true, text: `Registered “${created}”.` });
              onChanged();
            }}
          />
        )}

        {note && (
          <Banner tone={note.ok ? 'ok' : 'error'}>
            <span className="flex flex-wrap items-center gap-2">
              {note.text}
              {note.ok && note.auditId && (
                <Button size="sm" tone="quiet" disabled={busy === note.auditId} onClick={() => undo(note.auditId!)}>
                  Undo
                </Button>
              )}
            </span>
          </Banner>
        )}

        {/*
          The bulk bar only appears with a selection, and it always states the COUNT it will act on.
          "Disable 138 sources" is a sentence somebody can refuse; a rule that quietly picks them is
          not.
        */}
        {selected.size > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl bg-[#1D1D1F] px-4 py-3">
            <span className="text-[12.5px] font-semibold text-white">{selected.size} selected</span>
            <span className="flex-1" />
            <Button size="sm" tone="quiet" disabled={busy === 'bulk'} onClick={() => bulk(false)}>
              Disable {selected.size}
            </Button>
            <Button size="sm" tone="quiet" disabled={busy === 'bulk'} onClick={() => bulk(true)}>
              Enable {selected.size}
            </Button>
            <Button size="sm" tone="quiet" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          </div>
        )}

        {rows.length === 0 ? (
          <NoRows>No sources match.</NoRows>
        ) : (
          <>
            <div className="flex items-center justify-between py-2 text-[12px] text-[#6E6E73]">
              <button type="button" onClick={selectVisible} className="font-semibold text-[#0071E3] hover:underline">
                Select all {rows.length} shown
              </button>
              <span>events on the last run</span>
            </div>
            <div className="max-h-[560px] overflow-y-auto">
              <ul className="divide-y divide-[#f0f0f2]">
                {rows.map(row => {
                  const dead = row.consecutiveEmptyScrapes >= 6;
                  return (
                    <li key={row.id} className="flex items-center gap-3 py-2.5">
                      <input
                        type="checkbox"
                        checked={selected.has(row.id)}
                        onChange={() => toggleSelected(row.id)}
                        aria-label={`Select ${row.name}`}
                        className="h-4 w-4 shrink-0 accent-[#0071E3]"
                      />
                      <span
                        aria-hidden="true"
                        className={`h-2 w-2 shrink-0 rounded-full ${
                          !row.enabled
                            ? 'bg-[#c7c7cc]'
                            : row.lastEventCount > 0
                              ? 'bg-[#30D158]'
                              : dead
                                ? 'bg-[#FF3B30]'
                                : 'bg-[#FF9F0A]'
                        }`}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13.5px] font-semibold text-[#1D1D1F]">
                          {row.name}
                          {!row.enabled && (
                            <span className="ml-2 rounded bg-[#f3f3f5] px-1.5 py-0.5 text-[10.5px] font-bold uppercase tracking-wide text-[#8E8E93]">
                              off
                            </span>
                          )}
                        </p>
                        <p className="truncate text-[12px] text-[#6E6E73]">
                          {row.kind ?? 'built-in'} ·{' '}
                          {row.lastScrapedAt ? `scraped ${relativeTime(row.lastScrapedAt)}` : 'never scraped'}
                          {dead && (
                            <span className="font-semibold text-[#C7362D]">
                              {' '}
                              · {row.consecutiveEmptyScrapes} empty runs
                            </span>
                          )}
                        </p>
                      </div>
                      <span className="tnum shrink-0 text-[12.5px] font-semibold text-[#1D1D1F]">
                        {row.lastEventCount}
                      </span>
                      <Button
                        size="sm"
                        tone="quiet"
                        disabled={busy === row.id}
                        onClick={() => setEnabled(row, !row.enabled)}
                      >
                        {row.enabled ? 'Disable' : 'Enable'}
                      </Button>
                      <Button
                        size="sm"
                        tone="danger"
                        disabled={busy === row.id}
                        onClick={() => setConfirmingDelete(row)}
                      >
                        Delete
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </div>
          </>
        )}

        <Well className="mt-3">
          Most sources arrive through auto-discovery — Luma calendar ids harvested from the city feed,
          Meetup group slugs from the keyword fan-out — and that is the design. Hand-verified seeds are
          ordered first in the pipeline so a per-run cap can never drop them.
        </Well>
      </Panel>

      {confirmingDelete && (
        <ImpactDialog
          open
          type="source"
          ids={[confirmingDelete.id]}
          title={`Delete “${confirmingDelete.name}”?`}
          actionLabel="Delete source"
          onCancel={() => setConfirmingDelete(null)}
          onConfirm={force => destroy(confirmingDelete, force)}
        />
      )}
    </div>
  );
}
