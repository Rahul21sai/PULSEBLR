'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Banner, Button, Card, Chip, EmptyState, Well } from '../components/ui';
import { NoRows, Panel, StatCard, StatSkeletons, num } from './AdminUI';
import ImpactDialog from './ImpactDialog';
import { shortDateIST } from '@/lib/format';

/**
 * Feed quality — the corpus problems the diag scripts already find, with the numbers on screen and
 * a button where the fix is safe.
 *
 * ── WHAT IS ACTIONABLE HERE, AND WHAT IS NOT ────────────────────────────────────────────────
 *
 * Every action offered is either reversible in one click (flip the tech flag back, re-pin) or
 * restorable from the audit log (a delete keeps a whole-document snapshot). Two things are
 * deliberately REPORT-ONLY and say so on screen:
 *
 *   · duplicate clusters — collapsing one means choosing the most complete row, repointing
 *     `TrackerEntry` and `Folder.eventId` at the survivor and gap-filling. `cleanup-duplicate-
 *     clusters.ts` does all three and has a dry run; a button with no dry run does not.
 *   · bulk re-tagging — `retag-events.ts --inconsistent` replaces categories via the LLM. It is the
 *     right fix for the disagreement list, it takes minutes, and it is not something to fire from a
 *     serverless request. The command is printed instead.
 *
 * Printing a command where a button would be wrong is not an unfinished panel. An operator console
 * that pretends every fix is one click is how a cleanup with no dry run ends up destroying something.
 *
 * ── COUNTS ARE ALWAYS PAIRED WITH RANK ──────────────────────────────────────────────────────
 *
 * Each list arrives sorted by `connectionScore` descending, and the score is drawn on every row.
 * This repo's most expensive measurement was tech precision at 98% while the first page of the feed
 * was board games and jamming: the default sort is `connections`, so 2% of the corpus can be 10% of
 * what a reader actually sees. A count without a rank under-reports severity.
 */

interface QRow {
  id: string;
  title: string;
  organizer: string | null;
  source: string | null;
  category: string[];
  isTechEvent: boolean;
  connectionScore: number | null;
  startDateTime: string | null;
  signals?: string[];
  offCity?: string;
  offCityField?: string;
  offCityValue?: string;
  spotlightAt?: string;
}

interface FeedQuality {
  corpus: { upcoming: number; tech: number; techShare: number };
  techDisagreement: {
    hidden: { count: number; rows: QRow[] };
    unbacked: { count: number; rows: QRow[] };
    fixWith: string;
  };
  courseAdverts: { count: number; highScoring: number; rows: QRow[] };
  offCity: { count: number; inTechFeed: number; rows: QRow[]; auditWith: string };
  duplicates: {
    groups: number;
    rows: number;
    withoutClusterKey: number;
    sample: Array<{ clusterKey: string; rows: QRow[] }>;
    fixWith: string;
    reportOnly: boolean;
  };
  spotlight: { pinned: number; shown: number; rows: QRow[] };
}

/**
 * One row of a candidate list. Score is always drawn — the rank IS the severity.
 *
 * MODULE SCOPE, not defined inside the panel. A component declared in a render body is a new
 * component type on every render, so React unmounts and remounts every row — which drops keyboard
 * focus from the very action button the operator just pressed.
 */
function Row({ row, actions }: { row: QRow; actions?: ReactNode }) {
  return (
    <li className="flex items-start gap-3 py-2.5">
      {/*
        TWO STATES, TWO VALUES — collapsed from three branches on purpose.

        This was a three-way: accent above 70, `bg-amber-50 text-amber-900` for 50-69, ink-2 below.
        The amber pair had no home in nine values, and converting it to the `warn` tone (`--ink-2`,
        the quietest of the four) made the middle branch byte-identical to the low one — a live
        ternary testing a threshold that could no longer change the output. Rather than leave a
        condition that reads as meaningful and is not, the pill says the one thing it can support:
        this row ranks well enough to reach a reader, or it does not. The exact number is beside it.
      */}
      <span
        title="Connection score — where this sits in the default feed's sort"
        className={`tnum mt-0.5 w-9 shrink-0 rounded-[var(--r-flat)] px-1.5 py-0.5 text-center text-[11px] font-bold ${
          (row.connectionScore ?? 0) >= 70
            ? 'bg-[var(--paper)] text-[var(--accent)]'
            : 'bg-[var(--paper)] text-[var(--ink-2)]'
        }`}
      >
        {row.connectionScore ?? '—'}
      </span>
      <div className="min-w-0 flex-1">
        <Link
          href={`/events/${row.id}`}
          className="block truncate text-[13.5px] font-semibold text-[var(--ink)] hover:text-[var(--accent)]"
        >
          {row.title}
        </Link>
        <p className="truncate text-[12px] text-[var(--ink-2)]">
          {[
            row.startDateTime ? shortDateIST(row.startDateTime) : null,
            row.source,
            row.organizer,
            row.category.length ? row.category.join(', ') : 'no categories',
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
        {row.offCityField && (
          <p className="mt-0.5 text-[11.5px] text-[var(--live)]">
            {row.offCity} — matched on <strong>{row.offCityField}</strong>:{' '}
            <span className="font-mono">{row.offCityValue}</span>
          </p>
        )}
        {row.signals && row.signals.length > 0 && (
          <p className="mt-0.5 truncate font-mono text-[11px] text-[var(--ink-2)]" title={row.signals.join('  ')}>
            {row.signals.length} advert signature{row.signals.length === 1 ? '' : 's'}: {row.signals[0]}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">{actions}</div>
    </li>
    );
}

type Section = 'tech' | 'adverts' | 'offcity' | 'duplicates' | 'spotlight';

export default function FeedQualityPanel({ onChanged }: { onChanged: () => void }) {
  const [data, setData] = useState<FeedQuality | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [section, setSection] = useState<Section>('tech');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string; auditId?: string | null } | null>(null);
  const [confirming, setConfirming] = useState<QRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/feed-quality');
      if (!res.ok) {
        setError(`Could not scan the corpus (HTTP ${res.status}).`);
        return;
      }
      setData((await res.json()) as FeedQuality);
    } catch {
      setError('Could not reach the server.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch('/api/admin/feed-quality');
        if (!active) return;
        if (!res.ok) {
          setError(`Could not scan the corpus (HTTP ${res.status}).`);
          setLoading(false);
          return;
        }
        const json = (await res.json()) as FeedQuality;
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
  }, []);

  /** Every mutation goes through the AUDITED admin route, so the change log is complete. */
  async function patch(row: QRow, body: Record<string, unknown>, what: string) {
    setBusy(row.id);
    setNote(null);
    try {
      const res = await fetch(`/api/admin/events/${row.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
      setNote({ ok: true, text: `${what} — “${row.title}”.`, auditId: (json as { auditId?: string }).auditId });
      await load();
      onChanged();
    } catch (err) {
      setNote({ ok: false, text: `Could not update “${row.title}” (${err instanceof Error ? err.message : 'failed'}).` });
    } finally {
      setBusy(null);
    }
  }

  async function destroy(row: QRow, force: boolean) {
    setConfirming(null);
    setBusy(row.id);
    setNote(null);
    try {
      const res = await fetch(`/api/admin/events/${row.id}${force ? '?force=true' : ''}`, {
        method: 'DELETE',
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
      setNote({
        ok: true,
        text: `Deleted “${row.title}”. It is restorable from the audit log.`,
        auditId: (json as { auditId?: string }).auditId,
      });
      await load();
      onChanged();
    } catch (err) {
      setNote({ ok: false, text: `Could not delete (${err instanceof Error ? err.message : 'failed'}).` });
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
      await load();
      onChanged();
    } catch (err) {
      setNote({ ok: false, text: `Could not undo (${err instanceof Error ? err.message : 'failed'}).` });
    } finally {
      setBusy(null);
    }
  }

  if (loading && !data) return <StatSkeletons count={4} />;
  if (error) return <Banner tone="error">{error}</Banner>;
  if (!data) return <Banner tone="error">The corpus scan returned nothing.</Banner>;

  const problems =
    data.techDisagreement.hidden.count +
    data.techDisagreement.unbacked.count +
    data.courseAdverts.count +
    data.offCity.count +
    data.duplicates.groups;

  const techButton = (row: QRow) => (
    <Button
      size="sm"
      tone={row.isTechEvent ? 'quiet' : 'secondary'}
      disabled={busy === row.id}
      onClick={() => patch(row, { isTechEvent: !row.isTechEvent }, row.isTechEvent ? 'Removed from tech' : 'Marked as tech')}
    >
      {row.isTechEvent ? 'Not tech' : 'Mark tech'}
    </Button>
  );

  const deleteButton = (row: QRow) => (
    <Button size="sm" tone="danger" disabled={busy === row.id} onClick={() => setConfirming(row)}>
      Delete
    </Button>
  );

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          label="Upcoming in the feed"
          value={num(data.corpus.tech)}
          sub={`${data.corpus.techShare}% of ${num(data.corpus.upcoming)} stored`}
        />
        <StatCard
          label="Problems found"
          value={num(problems)}
          sub="across all five checks"
          tone={problems > 0 ? 'warn' : undefined}
        />
        <StatCard
          label="Adverts in the tech feed"
          value={num(data.courseAdverts.count)}
          sub={`${data.courseAdverts.highScoring} score 50+`}
          tone={data.courseAdverts.count > 0 ? 'warn' : undefined}
        />
        <StatCard
          label="Spotlight pins"
          value={num(data.spotlight.pinned)}
          sub={data.spotlight.pinned > 2 ? `only ${data.spotlight.shown} render` : 'on the home page'}
        />
      </div>

      <div className="flex flex-wrap gap-1.5">
        {(
          [
            ['tech', 'Mis-tagged', data.techDisagreement.hidden.count + data.techDisagreement.unbacked.count],
            ['adverts', 'Course adverts', data.courseAdverts.count],
            ['offcity', 'Off-city', data.offCity.count],
            ['duplicates', 'Duplicates', data.duplicates.groups],
            ['spotlight', 'Spotlight', data.spotlight.pinned],
          ] as Array<[Section, string, number]>
        ).map(([id, label, count]) => (
          <Chip key={id} pressed={section === id} count={count} onClick={() => setSection(id)}>
            {label}
          </Chip>
        ))}
      </div>

      {note && (
        <Banner tone={note.ok ? 'ok' : 'error'}>
          <span className="flex flex-wrap items-center gap-2">
            {note.text}
            {/* Undo, offered right where the change happened. The audit panel has it too, but the
                moment somebody notices a mistake is the moment they just made it. */}
            {note.ok && note.auditId && (
              <Button size="sm" tone="quiet" disabled={busy === note.auditId} onClick={() => undo(note.auditId!)}>
                Undo
              </Button>
            )}
          </span>
        </Banner>
      )}

      {/* ── Mis-tagged ─────────────────────────────────────────────────────────── */}
      {section === 'tech' && (
        <>
          <Panel
            title={`Hidden from the feed (${data.techDisagreement.hidden.count})`}
            subtitle="Tech categories, but the flag is off — so no reader can reach them. This is how IndiaFOSS 2026 disappeared."
          >
            {data.techDisagreement.hidden.rows.length === 0 ? (
              <NoRows>Nothing is hidden. Every event with tech categories is flagged tech.</NoRows>
            ) : (
              <ul className="divide-y divide-[var(--rule)]">
                {data.techDisagreement.hidden.rows.map(r => (
                  <Row key={r.id} row={r} actions={techButton(r)} />
                ))}
              </ul>
            )}
          </Panel>

          <Panel
            title={`In the feed on a flag alone (${data.techDisagreement.unbacked.count})`}
            subtitle="Flagged tech with no tech category to back it. Precision risk — read the titles before acting."
          >
            {data.techDisagreement.unbacked.rows.length === 0 ? (
              <NoRows>Every flagged event has a tech category behind it.</NoRows>
            ) : (
              <ul className="divide-y divide-[var(--rule)]">
                {data.techDisagreement.unbacked.rows.map(r => (
                  <Row key={r.id} row={r} actions={<>{techButton(r)}{deleteButton(r)}</>} />
                ))}
              </ul>
            )}
          </Panel>

          <Card padding="tight">
            <p className="text-[12.5px] leading-relaxed text-[var(--ink-2)]">
              <strong>Fixing these in bulk is a script, not a button.</strong> Re-tagging replaces
              categories through the LLM and takes minutes — longer than a serverless request lives —
              and <code className="font-mono">--inconsistent</code> is almost always the right flag:
              a blanket <code className="font-mono">--all</code> was measured returning FEWER
              categories, losing correct Event-type tags the filter rail depends on.
            </p>
            <Well className="mt-2">
              <code className="font-mono">{data.techDisagreement.fixWith}</code>
              <br />
              <span className="text-[var(--ink-2)]">
                Preview it first with{' '}
                <code className="font-mono">npx tsx scripts/diag-retag-preview.ts</code> — it writes
                nothing, and the controls matter more than the broken rows.
              </span>
            </Well>
          </Card>
        </>
      )}

      {/* ── Course adverts ─────────────────────────────────────────────────────── */}
      {section === 'adverts' && (
        <Panel
          title={`Course adverts inside the tech feed (${data.courseAdverts.count})`}
          subtitle="Lead generation for paid courses, advertised as free demos. A sales pitch puts you in an audience — the opposite of what this feed is for."
        >
          {data.courseAdverts.rows.length === 0 ? (
            <EmptyState
              icon="verified"
              title="No course adverts in the tech feed"
              body="The advert signatures matched nothing. Note the detector under-reports — its phrase list misses a few real adverts, so read the first page of the feed occasionally too."
            />
          ) : (
            <>
              <Banner tone="warn">
                {data.courseAdverts.highScoring} of these score 50 or more, which means the default
                sort puts them where readers actually look. Removing one is restorable; flipping it to
                non-tech is the gentler correction and keeps the row for the record.
              </Banner>
              <ul className="mt-3 divide-y divide-[var(--rule)]">
                {data.courseAdverts.rows.map(r => (
                  <Row key={r.id} row={r} actions={<>{techButton(r)}{deleteButton(r)}</>} />
                ))}
              </ul>
            </>
          )}
        </Panel>
      )}

      {/* ── Off-city ───────────────────────────────────────────────────────────── */}
      {section === 'offcity' && (
        <Panel
          title={`Not in Bengaluru (${data.offCity.count})`}
          subtitle={`${data.offCity.inTechFeed} of them are in the tech feed. Judged on city, venue, address and title — never the description.`}
        >
          {data.offCity.rows.length === 0 ? (
            <EmptyState
              icon="location_on"
              title="Nothing off-city in the corpus"
              body="The ingest gate is holding. Events added before the gate existed have drained."
            />
          ) : (
            <>
              <Banner tone="info">
                Hand-entered events are excluded from this list on purpose — a user&apos;s own event may
                legitimately be elsewhere, and nothing could re-create it. Anything a user tracked or
                built a folder for will refuse to delete without an explicit override.
              </Banner>
              <ul className="mt-3 divide-y divide-[var(--rule)]">
                {data.offCity.rows.map(r => (
                  <Row key={r.id} row={r} actions={deleteButton(r)} />
                ))}
              </ul>
              <Well className="mt-3">
                Cross-check the whole predicate, spares included, with{' '}
                <code className="font-mono">{data.offCity.auditWith}</code>
              </Well>
            </>
          )}
        </Panel>
      )}

      {/* ── Duplicates (report-only) ───────────────────────────────────────────── */}
      {section === 'duplicates' && (
        <Panel
          title={`Duplicate clusters (${data.duplicates.groups})`}
          subtitle={`${data.duplicates.rows} documents share a cluster key with another, so the feed shows them twice.`}
        >
          {data.duplicates.withoutClusterKey > 0 && (
            <Banner tone="warn">
              <strong>{data.duplicates.withoutClusterKey}</strong> upcoming events have no cluster key
              at all. That is a different fault with a different fix — usually the daily cron running an
              older default branch — and those documents cannot de-duplicate at ingest. Run{' '}
              <code className="font-mono">scripts/migrate-events.ts</code> first.
            </Banner>
          )}

          <Banner tone="info">
            <strong>Report-only, deliberately.</strong> Collapsing a cluster means picking the most
            complete row, repointing every <code className="font-mono">TrackerEntry</code> and{' '}
            <code className="font-mono">Folder.eventId</code> at the survivor, and gap-filling. The
            script does all three and has a dry run; a button here would have neither.
          </Banner>

          {data.duplicates.sample.length === 0 ? (
            <NoRows>No duplicate clusters. Cross-source dedup is working.</NoRows>
          ) : (
            <div className="mt-3 space-y-3">
              {data.duplicates.sample.map(g => (
                <div key={g.clusterKey} className="rounded-xl bg-[var(--paper)] p-3">
                  <p className="truncate font-mono text-[11.5px] text-[var(--ink-2)]">{g.clusterKey}</p>
                  <ul className="mt-1 divide-y divide-[var(--rule)]">
                    {g.rows.map(r => (
                      <Row key={r.id} row={r} actions={deleteButton(r)} />
                    ))}
                  </ul>
                </div>
              ))}
              <Well>
                <code className="font-mono">{data.duplicates.fixWith}</code>
              </Well>
            </div>
          )}
        </Panel>
      )}

      {/* ── Spotlight ──────────────────────────────────────────────────────────── */}
      {section === 'spotlight' && (
        <Panel
          title={`Spotlight pins (${data.spotlight.pinned})`}
          subtitle="Editorial — a human chose these, and nothing recomputes or clears them. The two most recently pinned render on the home page."
        >
          {data.spotlight.rows.length === 0 ? (
            <EmptyState
              icon="star"
              title="Nothing pinned"
              body="The home page Spotlight falls back to the top of the connection-score ranking and says “Best for connections right now”. That is the normal state, not a misconfiguration."
            />
          ) : (
            <>
              {data.spotlight.pinned > 2 && (
                <Banner tone="warn">
                  Only the {data.spotlight.shown} most recently pinned appear on the home page. The rest
                  are pinned and simply do not show.
                </Banner>
              )}
              <ul className="mt-3 divide-y divide-[var(--rule)]">
                {data.spotlight.rows.map((r, i) => (
                  <Row
                    key={r.id}
                    row={r}
                    actions={
                      <>
                        {i < 2 && (
                          <span className="rounded-full bg-[var(--ink)] px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-wide text-[var(--accent-ink)]">
                            live
                          </span>
                        )}
                        <Button
                          size="sm"
                          tone="quiet"
                          disabled={busy === r.id}
                          // An explicit null, never a delete of the key: `$set` cannot express
                          // `$unset`, and the home page matches `{ $type: 'date' }` so a stored null
                          // reads correctly as unpinned.
                          onClick={() => patch(r, { spotlightAt: null }, 'Unpinned')}
                        >
                          Unpin
                        </Button>
                      </>
                    }
                  />
                ))}
              </ul>
            </>
          )}
        </Panel>
      )}

      {confirming && (
        <ImpactDialog
          open
          type="event"
          ids={[confirming.id]}
          title={`Delete “${confirming.title}”?`}
          actionLabel="Delete event"
          onCancel={() => setConfirming(null)}
          onConfirm={force => destroy(confirming, force)}
        />
      )}
    </div>
  );
}
