'use client';

import { useCallback, useEffect, useState } from 'react';
import Sheet from '../components/Sheet';
import { Banner, Button } from '../components/ui';
import { SeverityPill } from './AdminUI';

/**
 * "Here is what this will affect." The confirm step in front of every destructive action.
 *
 * ── WHY A DIALOG AND NOT `window.confirm` ───────────────────────────────────────────────────
 *
 * The panel it replaces used `window.confirm("Delete X? It will come back on the next scrape if the
 * source still lists it.")` — a sentence that is true, generic, and silent about the only thing that
 * actually matters: whether a user has tracked that event or scanned people at it. A native confirm
 * cannot show a fetched impact report, so it can only ever restate what the code already assumed.
 *
 * ── IT REUSES `Sheet`, DELIBERATELY ─────────────────────────────────────────────────────────
 *
 * `Sheet.tsx` already has the focus trap re-queried per keypress, focus restore, scroll lock, Escape
 * and an iOS-home-indicator-safe footer. This app already has three modal idioms and the design plan
 * says to converge on one; adding a fourth for the dialog whose whole job is "slow the operator down
 * and be read carefully" would be the worst place to hand-roll focus management.
 *
 * ── THE DIALOG IS A COURTESY, NOT THE BOUNDARY ──────────────────────────────────────────────
 *
 * `DELETE /api/admin/events/[id]` re-computes the same report server-side and answers 409 without
 * `?force=true`. So this cannot be bypassed by disabling JavaScript, and the two cannot disagree —
 * they call the same `classifyEventDelete`. What the dialog adds is that the override is a deliberate
 * second click with the reasons on screen, rather than a flag somebody sets once and forgets.
 */

export interface ImpactWarning {
  code: string;
  message: string;
  blocking: boolean;
}

export interface ImpactReport {
  severity: 'safe' | 'caution' | 'blocked';
  reversible: boolean;
  headline: string;
  warnings: ImpactWarning[];
  counts: { trackerEntries: number; folders: number; contacts: number };
}

interface ImpactResponse {
  rows: Array<{ id: string; label?: string; report: ImpactReport }>;
  summary: ImpactReport;
  missing?: string[];
}

export default function ImpactDialog({
  open,
  type,
  ids,
  title,
  actionLabel,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  type: 'event' | 'source';
  ids: string[];
  /** What is being acted on, in the operator's words. */
  title: string;
  /** The verb on the confirm button, e.g. "Delete event". */
  actionLabel: string;
  onCancel: () => void;
  /** `force` is true when the operator chose to override a blocking verdict. */
  onConfirm: (force: boolean) => void;
}) {
  const [report, setReport] = useState<ImpactResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/impact?type=${type}&ids=${ids.join(',')}`);
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError((data as { error?: string })?.error ?? `Could not check impact (HTTP ${res.status}).`);
        return;
      }
      setReport((await res.json()) as ImpactResponse);
    } catch {
      setError('Could not reach the server to check what this would affect.');
    } finally {
      setLoading(false);
    }
  }, [type, ids]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/admin/impact?type=${type}&ids=${ids.join(',')}`);
        if (!active) return;
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          setError((data as { error?: string })?.error ?? `Could not check impact (HTTP ${res.status}).`);
          setLoading(false);
          return;
        }
        const data = (await res.json()) as ImpactResponse;
        if (!active) return;
        setReport(data);
      } catch {
        if (active) setError('Could not reach the server to check what this would affect.');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
    // `ids` is joined into the dep so re-opening for a different row refetches.
  }, [open, type, ids.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  const summary = report?.summary;
  const blocked = summary?.severity === 'blocked';
  const counts = summary?.counts;

  return (
    <Sheet
      open={open}
      onClose={onCancel}
      title={title}
      subtitle={
        loading
          ? 'Checking what this would affect…'
          : summary
            ? summary.headline
            : 'Impact could not be checked'
      }
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button tone="quiet" onClick={onCancel}>
            Cancel
          </Button>
          {/*
            The confirm button is DISABLED until the report has loaded. Not cosmetic: without it the
            operator can outrun the check and confirm a delete having been shown nothing, which is
            functionally the `window.confirm` this replaced.
          */}
          <Button
            tone="danger"
            disabled={loading || (!summary && !error)}
            onClick={() => onConfirm(Boolean(blocked))}
          >
            {blocked ? `${actionLabel} anyway` : actionLabel}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {error && (
          <>
            <Banner tone="error">{error}</Banner>
            {/*
              A failed impact check must not silently become "no impact". The retry is offered, and the
              confirm button above stays live only because an operator sometimes has to act on a row
              while the check itself is broken — with the failure visible on screen rather than absent.
            */}
            <Button tone="quiet" size="sm" onClick={load}>
              Try the check again
            </Button>
          </>
        )}

        {loading && !report && (
          <div className="space-y-2">
            <div className="skeleton h-4 w-2/3 rounded bg-[var(--paper)]" />
            <div className="skeleton h-4 w-1/2 rounded bg-[var(--paper)]" />
          </div>
        )}

        {summary && (
          <>
            <div className="flex items-center gap-2">
              <SeverityPill severity={summary.severity} />
              {summary.reversible && (
                <span className="text-[12px] text-[var(--ink-2)]">
                  Restorable from the audit log afterwards
                </span>
              )}
            </div>

            {counts && (counts.trackerEntries > 0 || counts.folders > 0 || counts.contacts > 0) && (
              <div className="grid grid-cols-3 gap-2">
                {/* Numbers, not prose, for the three things a person actually did. */}
                {[
                  ['Tracked by', counts.trackerEntries],
                  ['Scan folders', counts.folders],
                  ['People scanned', counts.contacts],
                ].map(([label, n]) => (
                  <div key={String(label)} className="rounded-xl bg-[var(--paper)] px-3 py-2.5">
                    <p className="t-label text-[var(--ink-2)]">{label}</p>
                    <p className="tnum mt-0.5 text-[19px] font-bold text-[var(--ink)]">{String(n)}</p>
                  </div>
                ))}
              </div>
            )}

            <ul className="space-y-2">
              {summary.warnings.map(w => (
                <li
                  key={w.code}
                  className={`rounded-xl px-3.5 py-2.5 text-[12.5px] leading-relaxed ${
                    w.blocking ? 'bg-[var(--paper)] text-[var(--live)]' : 'bg-[var(--paper)] text-[var(--ink-2)]'
                  }`}
                >
                  {w.message}
                </li>
              ))}
            </ul>

            {report && report.rows.length > 1 && (
              <p className="text-[12px] text-[var(--ink-2)]">
                {report.rows.length} rows selected.{' '}
                {report.rows.filter(r => r.report.severity === 'blocked').length} have been acted on by
                a user.
              </p>
            )}

            {report?.missing && report.missing.length > 0 && (
              <Banner tone="warn">
                {report.missing.length} of the selected rows no longer exist — somebody else deleted
                them, or a scrape pruned them. They will be skipped.
              </Banner>
            )}
          </>
        )}
      </div>
    </Sheet>
  );
}
