'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Banner, Button, Card, Chip, EmptyState } from '../components/ui';
import { NoRows, Panel, num } from './AdminUI';
import { fullDateIST, relativeTime } from '@/lib/format';

/**
 * The change log — "what did I change last Tuesday".
 *
 * ── WHY A LOG IS THE FIRST THING THE CONTROL ROOM NEEDED ────────────────────────────────────
 *
 * The control plane before this was ~60 scripts run by hand. A script prints to a terminal, the
 * terminal scrolls, and the record is gone. Turning those powers into buttons makes them much faster
 * to reach — which makes an unrecorded mistake both more likely and harder to reconstruct. This panel
 * is what makes the buttons safe to have offered.
 *
 * ── UNDO IS REAL HERE, NOT A LABEL ──────────────────────────────────────────────────────────
 *
 * A delete stores the WHOLE document in the audit row, so restoring re-creates it under the original
 * `_id` — which quietly re-links every `TrackerEntry.eventId` and `Folder.eventId` that had gone
 * dangling. An edit stores the previous values of exactly the fields that changed, so an undo is a
 * `$set` of those and nothing else. What cannot be undone from here says so and explains where to go
 * instead: a submission decision belongs in Submissions, because re-deciding one is a judgement and
 * routing it through a generic undo would skip the review the queue exists to force.
 *
 * ── THE WINDOW DEFAULTS TO 7 DAYS ───────────────────────────────────────────────────────────
 *
 * Not to everything. An unbounded log is the state in which nobody reads it, and the question this
 * panel exists to answer is about the recent past. Longer windows are one tap away.
 */

interface AuditRow {
  id: string;
  at: string;
  actorEmail: string;
  action: string;
  actionLabel: string;
  targetType: string;
  targetId: string | null;
  targetCount: number | null;
  targetLabel: string | null;
  summary: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  impact: Record<string, unknown> | null;
  snapshotTruncated: boolean;
  undoable: boolean;
  undoneAt: string | null;
  undoneBy: string | null;
}

interface AuditResponse {
  rows: AuditRow[];
  pagination: { total: number; skip: number; limit: number; hasMore: boolean };
  facets: {
    actions: Array<{ action: string; label: string; count: number }>;
    actors: Array<{ actorEmail: string; count: number }>;
  };
}

const WINDOWS: Array<[number, string]> = [
  [1, 'Today'],
  [7, '7 days'],
  [30, '30 days'],
  [90, '90 days'],
];

/** A before/after value rendered readably. Objects are JSON; long strings are clipped. */
function renderValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'string') {
    return value.length > 120 ? `${value.slice(0, 120)}…` : value || '(empty)';
  }
  if (Array.isArray(value)) return value.length ? value.join(', ') : '(none)';
  if (typeof value === 'object') return JSON.stringify(value).slice(0, 160);
  return String(value);
}

export default function AuditPanel({ onChanged }: { onChanged: () => void }) {
  const [data, setData] = useState<AuditResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(7);
  const [action, setAction] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ days: String(days), limit: '100' });
      if (action) params.set('action', action);
      const res = await fetch(`/api/admin/audit?${params}`);
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        setError((json as { error?: string })?.error ?? `Could not load the audit log (HTTP ${res.status}).`);
        return;
      }
      setData((await res.json()) as AuditResponse);
    } catch {
      setError('Could not reach the server.');
    } finally {
      setLoading(false);
    }
  }, [days, action]);

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ days: String(days), limit: '100' });
        if (action) params.set('action', action);
        const res = await fetch(`/api/admin/audit?${params}`);
        if (!active) return;
        if (!res.ok) {
          const json = await res.json().catch(() => null);
          setError((json as { error?: string })?.error ?? `Could not load the audit log (HTTP ${res.status}).`);
          setLoading(false);
          return;
        }
        const json = (await res.json()) as AuditResponse;
        if (!active) return;
        setData(json);
        setLoading(false);
      } catch {
        if (active) {
          setError('Could not reach the server.');
          setLoading(false);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [days, action]);

  async function undo(row: AuditRow) {
    setBusy(row.id);
    setNote(null);
    try {
      const res = await fetch('/api/admin/audit/undo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: row.id }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string; detail?: string; outcome?: string };
      if (!res.ok) {
        setNote({ ok: false, text: [json.error, json.detail].filter(Boolean).join(' ') || `HTTP ${res.status}` });
        return;
      }
      setNote({
        ok: true,
        text:
          json.outcome === 'already-present'
            ? 'It was already back in the corpus — nothing more to do.'
            : `Undone: ${row.summary}`,
      });
      await load();
      onChanged();
    } catch {
      setNote({ ok: false, text: 'Could not reach the server to undo that.' });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-5">
      <Panel
        title="Change log"
        subtitle={
          data
            ? `${num(data.pagination.total)} action${data.pagination.total === 1 ? '' : 's'} in the last ${days} day${days === 1 ? '' : 's'}`
            : 'Every mutating admin action, with what it changed'
        }
        action={
          <Button size="sm" tone="quiet" icon="refresh" onClick={load}>
            Refresh
          </Button>
        }
      >
        <div className="flex flex-wrap items-center gap-1.5 pb-3">
          {WINDOWS.map(([d, label]) => (
            <Chip key={d} pressed={days === d} onClick={() => setDays(d)}>
              {label}
            </Chip>
          ))}
          <span className="mx-1 h-5 w-px bg-[color:var(--hairline)]" />
          <Chip pressed={action === null} onClick={() => setAction(null)}>
            Everything
          </Chip>
          {/* Facet counts are computed with the ACTION dimension dropped, so picking one still shows
              what switching to another would give. Counting with the filter applied shows zero
              everywhere else and makes the chips useless for changing your mind. */}
          {data?.facets.actions.map(f => (
            <Chip
              key={f.action}
              pressed={action === f.action}
              count={f.count}
              onClick={() => setAction(action === f.action ? null : f.action)}
            >
              {f.label}
            </Chip>
          ))}
        </div>

        {note && <Banner tone={note.ok ? 'ok' : 'error'}>{note.text}</Banner>}
        {error && <Banner tone="error">{error}</Banner>}

        {loading && !data ? (
          <div className="space-y-2 py-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="skeleton h-12 rounded-xl bg-[var(--paper)]" />
            ))}
          </div>
        ) : !data || data.rows.length === 0 ? (
          <EmptyState
            icon="history"
            title={action ? 'Nothing matches that filter' : 'No admin changes in this window'}
            body={
              action
                ? 'Try a longer window, or clear the filter.'
                : 'Every edit, delete, pin, and source change made from this console will appear here with a before and after — and most of them can be undone.'
            }
          />
        ) : (
          <ul className="divide-y divide-[var(--rule)]">
            {data.rows.map(row => {
              const isOpen = expanded === row.id;
              const changedFields = row.after ? Object.keys(row.after) : [];
              return (
                <li key={row.id} className="py-3">
                  <div className="flex items-start gap-3">
                    <span
                      aria-hidden="true"
                      className={`mt-1 h-2 w-2 shrink-0 rounded-full ${
                        row.undoneAt
                          ? 'bg-[var(--ink-3)]'
                          : row.action.includes('delete')
                            ? 'bg-[var(--live)]'
                            : 'bg-[var(--accent)]'
                      }`}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-[13.5px] font-semibold text-[var(--ink)]">
                        {row.summary}
                        {row.undoneAt && (
                          <span className="ml-2 rounded bg-[var(--paper)] px-1.5 py-0.5 text-[10.5px] font-bold uppercase tracking-wide text-[var(--ink-2)]">
                            undone
                          </span>
                        )}
                      </p>
                      <p className="text-[12px] text-[var(--ink-2)]">
                        <span title={fullDateIST(row.at)}>{relativeTime(row.at)}</span> ·{' '}
                        <span className="font-mono text-[11.5px]">{row.actorEmail}</span>
                        {row.undoneAt && (
                          <>
                            {' '}
                            · undone by <span className="font-mono text-[11.5px]">{row.undoneBy}</span>
                          </>
                        )}
                      </p>
                    </div>

                    <div className="flex shrink-0 items-center gap-1.5">
                      {/* A link to the row it touched, when there still is one. A delete has no
                          target to visit, which is exactly why the label is stored on the audit row. */}
                      {row.targetType === 'event' && row.targetId && !row.action.includes('delete') && (
                        <Link
                          href={`/events/${row.targetId}`}
                          className="text-[12px] font-semibold text-[var(--accent)] hover:underline"
                        >
                          Open
                        </Link>
                      )}
                      {(row.before || row.after) && (
                        <Button size="sm" tone="quiet" onClick={() => setExpanded(isOpen ? null : row.id)}>
                          {isOpen ? 'Hide' : 'Details'}
                        </Button>
                      )}
                      {row.undoable && (
                        <Button size="sm" tone="quiet" disabled={busy === row.id} onClick={() => undo(row)}>
                          {busy === row.id ? 'Undoing…' : 'Undo'}
                        </Button>
                      )}
                    </div>
                  </div>

                  {isOpen && (
                    <div className="mt-2.5 ml-5 space-y-2">
                      {changedFields.length > 0 ? (
                        <div className="overflow-x-auto rounded-xl bg-[var(--paper)] p-3">
                          <table className="w-full text-[12px]">
                            <thead>
                              <tr className="text-left">
                                {['Field', 'Before', 'After'].map(h => (
                                  <th key={h} className="t-label pb-1.5 pr-3 text-[var(--ink-2)]">
                                    {h}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {changedFields.map(f => (
                                <tr key={f} className="align-top">
                                  <td className="py-1 pr-3 font-mono text-[11.5px] font-semibold text-[var(--ink)]">
                                    {f}
                                  </td>
                                  <td className="py-1 pr-3 text-[var(--live)]">{renderValue(row.before?.[f])}</td>
                                  <td className="py-1 text-[var(--accent)]">{renderValue(row.after?.[f])}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <div className="rounded-xl bg-[var(--paper)] p-3">
                          <p className="t-label text-[var(--ink-2)]">Snapshot kept for restore</p>
                          <p className="mt-1 text-[12px] text-[var(--ink-2)]">
                            {row.targetCount
                              ? `${row.targetCount} rows, restorable together in one undo.`
                              : 'The whole document was stored, so Undo re-creates it under its original id — which re-links anything that was pointing at it.'}
                          </p>
                          {row.snapshotTruncated && (
                            <p className="mt-1 text-[12px] font-semibold text-[var(--ink-2)]">
                              The description was too large to keep and was dropped from the snapshot.
                              Everything else restores exactly.
                            </p>
                          )}
                        </div>
                      )}

                      {row.impact ? (
                        <div className="rounded-xl bg-[var(--paper)] p-3">
                          <p className="t-label text-[var(--ink-2)]">What the preview said at the time</p>
                          <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed text-[var(--ink-2)]">
                            {JSON.stringify(row.impact, null, 2)}
                          </pre>
                        </div>
                      ) : null}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {data?.pagination.hasMore && (
          <NoRows>
            Showing the {data.rows.length} most recent of {num(data.pagination.total)}. Narrow the
            window or pick an action to see further back.
          </NoRows>
        )}
      </Panel>

      <Card padding="tight">
        <p className="text-[12.5px] leading-relaxed text-[var(--ink-2)]">
          <strong>What is not in here:</strong> anything a regular user does. Their tracked events and
          their contacts are their own data and belong in Users &amp; engagement as counts — an
          operator&apos;s change log that also recorded a stranger&apos;s private notes would be a
          different and much worse thing. Scrapes are not logged either: they write hundreds of rows
          per run and their record is the per-source health on the Sources tab.
        </p>
      </Card>
    </div>
  );
}
