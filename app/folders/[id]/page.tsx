'use client';

import Link from 'next/link';
import { use, useCallback, useEffect, useMemo, useState } from 'react';
import AppShell from '../../components/AppShell';
import Sheet from '../../components/Sheet';
import QrCode from '../../components/QrCode';
import ContactFields, { type ContactDraft } from '../../components/scan/ContactFields';
import { Banner, Button, ButtonLink, Card, EmptyState, PageHeader } from '../../components/ui';
import { dayHeading, fullDateIST, relativeTime, timeIST } from '@/lib/format';
import { newClientId, pendingContacts, subscribe } from '@/lib/scan/outbox';
import type { ContactDTO, FolderDTO } from '@/lib/contacts/types';

/**
 * One folder, as a table — "the sheet".
 *
 * A real `<table>` on a wide screen because that is what the data is, and stacked cards on a
 * phone because a 16-column table on 390px is unreadable. Same rows, same order, one source.
 */
export default function FolderPage({ params }: { params: Promise<{ id: string }> }) {
  // A client component cannot be `async`, so params is unwrapped with React's `use()` —
  // the same approach app/events/[id]/page.tsx takes.
  const { id } = use(params);

  const [folder, setFolder] = useState<FolderDTO | null>(null);
  const [contacts, setContacts] = useState<ContactDTO[]>([]);
  const [pendingRows, setPendingRows] = useState<ContactDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<ContactDTO | null>(null);
  const [addingManually, setAddingManually] = useState(false);
  const [showQr, setShowQr] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/folders/${id}`);
      if (res.status === 404) {
        setError('That folder does not exist, or is not yours.');
        setLoading(false);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setFolder(data.folder);
      setContacts(data.contacts ?? []);
      setError(null);
    } catch {
      setError('Could not load this folder. Nothing has been lost — try again.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    const timer = setTimeout(load, 0);
    return () => clearTimeout(timer);
  }, [load]);

  /**
   * Merge in anything still sitting in the outbox for this folder, flagged `pending`.
   *
   * Without this a scan made offline would simply not appear, which reads as "the scanner
   * didn't work" — the single worst thing this feature could communicate.
   */
  const refreshPending = useCallback(async () => {
    const queued = await pendingContacts();
    setPendingRows(
      queued
        .filter(record => record.folderId === id)
        .map(record => ({
          _id: `pending:${record.clientId}`,
          folderId: id,
          clientId: record.clientId,
          name: record.name,
          headline: record.headline ?? null,
          role: record.role ?? null,
          company: record.company ?? null,
          linkedin: record.linkedin ?? null,
          linkedinSlug: record.linkedinSlug ?? null,
          x: record.x ?? null,
          github: record.github ?? null,
          website: record.website ?? null,
          email: record.email ?? null,
          phone: record.phone ?? null,
          note: record.note ?? null,
          tags: record.tags ?? [],
          followUpAt: record.followUpAt ?? null,
          followedUp: false,
          capturedVia: record.capturedVia ?? 'manual',
          scannedAt: record.scannedAt ?? new Date(record.queuedAt).toISOString(),
          contactKey: '',
          companies: [],
          isTargetCompany: false,
          createdAt: new Date(record.queuedAt).toISOString(),
          updatedAt: new Date(record.queuedAt).toISOString(),
          pending: true,
        }))
    );
  }, [id]);

  useEffect(() => {
    // Deferred by a tick so the effect does not setState synchronously — the same pattern the
    // feed and tracker pages use.
    const timer = setTimeout(() => void refreshPending(), 0);
    const unsubscribe = subscribe(() => {
      void refreshPending();
      void load();
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [refreshPending, load]);

  // Deduped by clientId: once a queued row syncs, the server copy is authoritative.
  const rows = useMemo(() => {
    const synced = new Set(contacts.map(c => c.clientId));
    return [...pendingRows.filter(p => !synced.has(p.clientId)), ...contacts];
  }, [contacts, pendingRows]);

  const due = useMemo(
    () => rows.filter(c => c.followUpAt && !c.followedUp && new Date(c.followUpAt) <= new Date()),
    [rows]
  );

  async function saveContact(contact: ContactDTO, draft: ContactDraft) {
    // Optimistic, matching the tracker's house pattern: apply locally, roll back only on a
    // hard rejection. A network failure is not a rejection — it means "not yet".
    const previous = contacts;
    setContacts(current =>
      current.map(c => (c._id === contact._id ? { ...c, ...draft, tags: draft.tags ?? c.tags } : c))
    );
    setEditing(null);

    try {
      const res = await fetch(`/api/contacts/${contact._id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await load();
    } catch {
      setContacts(previous);
      setError('Could not save that change. Your edit was undone, nothing else.');
      setTimeout(() => setError(null), 4000);
    }
  }

  async function deleteContact(contact: ContactDTO) {
    const previous = contacts;
    setContacts(current => current.filter(c => c._id !== contact._id));
    setEditing(null);
    try {
      const res = await fetch(`/api/contacts/${contact._id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      setContacts(previous);
      setError('Could not delete that person.');
      setTimeout(() => setError(null), 4000);
    }
  }

  async function markFollowedUp(contact: ContactDTO) {
    setContacts(current =>
      current.map(c => (c._id === contact._id ? { ...c, followedUp: true } : c))
    );
    try {
      await fetch(`/api/contacts/${contact._id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ followedUp: true }),
      });
    } catch {
      await load();
    }
  }

  function copyLinkedIns() {
    const urls = rows.map(c => c.linkedin).filter(Boolean).join('\n');
    if (!urls) {
      setNotice('Nobody in this folder has a LinkedIn URL yet.');
      setTimeout(() => setNotice(null), 3000);
      return;
    }
    void navigator.clipboard
      ?.writeText(urls)
      .then(() => {
        setNotice(`Copied ${rows.filter(c => c.linkedin).length} LinkedIn URLs.`);
        setTimeout(() => setNotice(null), 3000);
      })
      .catch(() => setNotice('Could not copy — your browser blocked clipboard access.'));
  }

  if (error && !folder) {
    return (
      <AppShell title="People">
        <div className="mx-auto max-w-[900px] px-4 pt-6 md:px-8">
          <EmptyState
            icon="folder_off"
            title="Folder not found"
            body={error}
            action={<ButtonLink href="/folders">Back to folders</ButtonLink>}
          />
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell title="People">
      <div className="mx-auto max-w-[1240px] px-4 pt-4 md:px-8">
        <Link
          href="/folders"
          className="mb-3 inline-flex items-center gap-1 text-[13px] font-semibold text-[#0071E3] hover:underline"
        >
          <span className="material-symbols-outlined text-[16px]">arrow_back</span>
          All folders
        </Link>

        <PageHeader
          eyebrow={folder?.eventDate ? dayHeading(folder.eventDate) : undefined}
          title={folder?.name ?? (loading ? 'Loading…' : 'Folder')}
          subtitle={
            folder
              ? `${rows.length} ${rows.length === 1 ? 'person' : 'people'}${
                  folder.venue ? ` · ${folder.venue}` : ''
                }`
              : undefined
          }
          action={
            <div className="flex flex-wrap items-center gap-2">
              <ButtonLink href={`/scan?folder=${id}`} tone="primary" icon="qr_code_scanner">
                Scan
              </ButtonLink>
              <Button tone="quiet" icon="person_add" onClick={() => setAddingManually(true)}>
                Add by hand
              </Button>
            </div>
          }
        />

        {notice && (
          <div className="mb-4">
            <Banner tone="ok">{notice}</Banner>
          </div>
        )}
        {error && (
          <div className="mb-4">
            <Banner tone="error">{error}</Banner>
          </div>
        )}

        {due.length > 0 && (
          <div className="mb-4">
            <Card padding="tight">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="t-label text-[#A85B00]">
                  {due.length} follow-up{due.length === 1 ? '' : 's'} due
                </h2>
              </div>
              <div className="flex flex-col gap-2">
                {due.map(contact => (
                  <div
                    key={contact._id}
                    className="flex items-center justify-between gap-3 rounded-xl bg-[#FFF9F0] px-3 py-2.5"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-[13.5px] font-semibold text-[#1D1D1F]">
                        {contact.name}
                      </p>
                      <p className="text-[12px] text-[#6E6E73]">
                        due {relativeTime(contact.followUpAt!)}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {contact.linkedin && (
                        <ButtonLink
                          href={contact.linkedin}
                          external
                          size="sm"
                          tone="secondary"
                          icon="open_in_new"
                        >
                          Message
                        </ButtonLink>
                      )}
                      <Button size="sm" tone="quiet" onClick={() => markFollowedUp(contact)}>
                        Done
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        )}

        {/* ── Export row ─────────────────────────────────────────────────── */}
        {rows.length > 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <ButtonLink
              href={`/api/folders/${id}/export?format=csv`}
              size="sm"
              tone="quiet"
              icon="table_view"
            >
              Export CSV
            </ButtonLink>
            <ButtonLink
              href={`/api/folders/${id}/export?format=vcf`}
              size="sm"
              tone="quiet"
              icon="contact_page"
            >
              Export contacts
            </ButtonLink>
            <Button size="sm" tone="quiet" icon="content_copy" onClick={copyLinkedIns}>
              Copy LinkedIn URLs
            </Button>
            <Button size="sm" tone="quiet" icon="qr_code_2" onClick={() => setShowQr(true)}>
              Sign-up QR
            </Button>
          </div>
        )}

        {loading ? (
          <Card>
            <div className="h-4 w-1/3 rounded bg-[#EEEEF0]" />
            <div className="mt-3 h-3 w-1/2 rounded bg-[#F3F3F5]" />
          </Card>
        ) : rows.length === 0 ? (
          <EmptyState
            icon="qr_code_scanner"
            title="Nobody here yet"
            body="Point the scanner at somebody's LinkedIn QR, or add them by hand if they'd rather just tell you."
            action={
              <ButtonLink href={`/scan?folder=${id}`} tone="primary" icon="qr_code_scanner">
                Open the scanner
              </ButtonLink>
            }
          />
        ) : (
          <>
            <ContactTable rows={rows} onEdit={setEditing} />
            <ContactCards rows={rows} onEdit={setEditing} />
          </>
        )}

        <div className="h-8" />
      </div>

      {editing && (
        <EditContactSheet
          contact={editing}
          onClose={() => setEditing(null)}
          onSave={draft => saveContact(editing, draft)}
          onDelete={() => deleteContact(editing)}
        />
      )}

      {addingManually && folder && (
        <ManualAddSheet
          folderId={id}
          onClose={() => setAddingManually(false)}
          onAdded={async () => {
            setAddingManually(false);
            await load();
          }}
        />
      )}

      {showQr && folder && (
        <FolderQrSheet folder={folder} onClose={() => setShowQr(false)} onChanged={load} />
      )}
    </AppShell>
  );
}

/* ────────────────────────────── table (desktop) ────────────────────────────── */

function ContactTable({
  rows,
  onEdit,
}: {
  rows: ContactDTO[];
  onEdit: (contact: ContactDTO) => void;
}) {
  return (
    <div className="hidden overflow-hidden rounded-[18px] bg-white card-shadow md:block">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-[color:var(--hairline)]">
              {['Name', 'Company', 'How you met', 'Links', 'Scanned', ''].map(header => (
                <th key={header} className="t-label px-4 py-3 text-[#8E8E93]">
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(contact => (
              <tr
                key={contact._id}
                className="border-b border-[color:var(--hairline)] last:border-0 hover:bg-[#FAFAFC]"
              >
                <td className="px-4 py-3 align-top">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0">
                      <p className="text-[13.5px] font-semibold text-[#1D1D1F]">{contact.name}</p>
                      {(contact.role || contact.headline) && (
                        <p className="text-[12px] text-[#6E6E73]">
                          {contact.role || contact.headline}
                        </p>
                      )}
                    </div>
                    {contact.pending && <PendingDot />}
                  </div>
                </td>
                <td className="px-4 py-3 align-top">
                  <span className="text-[13px] text-[#1D1D1F]">{contact.company || '—'}</span>
                  {contact.isTargetCompany && <TargetBadge />}
                </td>
                <td className="max-w-[280px] px-4 py-3 align-top">
                  <p className="line-clamp-2 text-[12.5px] leading-relaxed text-[#6E6E73]">
                    {contact.note || '—'}
                  </p>
                </td>
                <td className="px-4 py-3 align-top">
                  <ContactLinks contact={contact} />
                </td>
                <td className="whitespace-nowrap px-4 py-3 align-top text-[12px] text-[#8E8E93]">
                  {/* IST, via lib/format.ts. */}
                  {timeIST(contact.scannedAt)}
                </td>
                <td className="px-4 py-3 align-top text-right">
                  <button
                    type="button"
                    onClick={() => onEdit(contact)}
                    className="rounded-full px-3 py-1.5 text-[12.5px] font-semibold text-[#0071E3] hover:bg-[#EBF4FE]"
                  >
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ────────────────────────────── cards (mobile) ────────────────────────────── */

function ContactCards({
  rows,
  onEdit,
}: {
  rows: ContactDTO[];
  onEdit: (contact: ContactDTO) => void;
}) {
  return (
    <div className="flex flex-col gap-2 md:hidden">
      {rows.map(contact => (
        <div key={contact._id} className="rounded-[18px] bg-white p-4 card-shadow">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="flex items-center gap-2 text-[15px] font-semibold text-[#1D1D1F]">
                <span className="truncate">{contact.name}</span>
                {contact.pending && <PendingDot />}
              </p>
              <p className="mt-0.5 text-[12.5px] text-[#6E6E73]">
                {[contact.role || contact.headline, contact.company].filter(Boolean).join(' · ') ||
                  'No details yet'}
              </p>
              {contact.isTargetCompany && <TargetBadge />}
            </div>
            <button
              type="button"
              onClick={() => onEdit(contact)}
              aria-label={`Edit ${contact.name}`}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[#F5F5F7] text-[#6E6E73]"
            >
              <span className="material-symbols-outlined text-[18px]">edit</span>
            </button>
          </div>

          {contact.note && (
            <p className="mt-2.5 text-[13px] leading-relaxed text-[#3a3a3c]">{contact.note}</p>
          )}

          <div className="mt-3 flex items-center justify-between gap-2">
            <ContactLinks contact={contact} />
            <span className="text-[11.5px] text-[#8E8E93]">{timeIST(contact.scannedAt)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function ContactLinks({ contact }: { contact: ContactDTO }) {
  const links: Array<{ href: string; icon: string; label: string }> = [];
  if (contact.linkedin) {
    links.push({ href: contact.linkedin, icon: 'person', label: 'LinkedIn' });
  }
  if (contact.phone) links.push({ href: `tel:${contact.phone}`, icon: 'call', label: 'Call' });
  if (contact.email) links.push({ href: `mailto:${contact.email}`, icon: 'mail', label: 'Email' });
  if (contact.x) links.push({ href: `https://x.com/${contact.x}`, icon: 'alternate_email', label: 'X' });
  if (contact.github) {
    links.push({ href: `https://github.com/${contact.github}`, icon: 'code', label: 'GitHub' });
  }

  if (!links.length) return <span className="text-[12.5px] text-[#8E8E93]">—</span>;

  return (
    <span className="flex items-center gap-1.5">
      {links.map(link => (
        <a
          key={link.label}
          href={link.href}
          target={link.href.startsWith('http') ? '_blank' : undefined}
          rel="noopener noreferrer"
          aria-label={link.label}
          title={link.label}
          className="grid h-8 w-8 place-items-center rounded-full bg-[#F5F5F7] text-[#3a3a3c] hover:bg-[#EBF4FE] hover:text-[#0071E3]"
        >
          <span className="material-symbols-outlined text-[17px]">{link.icon}</span>
        </a>
      ))}
    </span>
  );
}

/** Not synced yet. Greyscale, because `--live` means exactly one thing in this app. */
function PendingDot() {
  return (
    <span
      title="Saved on this device, not uploaded yet"
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[#F5F5F7] px-2 py-0.5 text-[10.5px] font-bold text-[#6E6E73]"
    >
      <span className="material-symbols-outlined text-[12px]">cloud_off</span>
      local
    </span>
  );
}

function TargetBadge() {
  return (
    <span className="mt-1 inline-block rounded-full bg-[#EBF7EF] px-2 py-0.5 text-[10.5px] font-bold text-[#1D8A44]">
      Target company
    </span>
  );
}

/* ────────────────────────────── sheets ────────────────────────────── */

function draftFrom(contact: ContactDTO): ContactDraft {
  return {
    name: contact.name,
    headline: contact.headline ?? undefined,
    company: contact.company ?? undefined,
    role: contact.role ?? undefined,
    linkedin: contact.linkedin ?? undefined,
    phone: contact.phone ?? undefined,
    email: contact.email ?? undefined,
    x: contact.x ?? undefined,
    github: contact.github ?? undefined,
    website: contact.website ?? undefined,
    note: contact.note ?? undefined,
    tags: contact.tags,
    followUpAt: contact.followUpAt ?? null,
  };
}

function EditContactSheet({
  contact,
  onClose,
  onSave,
  onDelete,
}: {
  contact: ContactDTO;
  onClose: () => void;
  onSave: (draft: ContactDraft) => void;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState<ContactDraft>(() => draftFrom(contact));
  const [showAll, setShowAll] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <Sheet
      open
      onClose={onClose}
      title={contact.name}
      subtitle={contact.pending ? 'Not uploaded yet' : `Added ${fullDateIST(contact.createdAt)}`}
      labelledBy="edit-contact-title"
      footer={
        <div className="flex items-center gap-2">
          <Button tone="primary" full onClick={() => onSave(draft)}>
            Save
          </Button>
          {confirmDelete ? (
            <Button tone="danger" onClick={onDelete}>
              Really delete
            </Button>
          ) : (
            <Button tone="quiet" icon="delete" onClick={() => setConfirmDelete(true)} aria-label="Delete">
              Delete
            </Button>
          )}
        </div>
      }
    >
      {contact.pending && (
        <div className="mb-4">
          <Banner tone="warn">
            This one is still only on this device, so it cannot be edited on the server yet. It will
            upload on its own.
          </Banner>
        </div>
      )}

      {contact.linkedin && (
        <div className="mb-4">
          <ButtonLink href={contact.linkedin} external tone="secondary" full icon="open_in_new">
            Open on LinkedIn
          </ButtonLink>
        </div>
      )}

      <ContactFields
        draft={draft}
        onChange={setDraft}
        showAll={showAll}
        onToggleShowAll={() => setShowAll(true)}
      />

      {contact.companies.length > 0 && (
        <p className="mt-4 text-[12px] text-[#8E8E93]">
          Matched to {contact.companies.join(', ')} in the company registry.
        </p>
      )}
    </Sheet>
  );
}

function ManualAddSheet({
  folderId,
  onClose,
  onAdded,
}: {
  folderId: string;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [draft, setDraft] = useState<ContactDraft>({ name: '' });
  const [showAll, setShowAll] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!draft.name.trim()) {
      setError('A name is the one thing this needs.');
      return;
    }
    setSaving(true);
    setError(null);
    const clientId = newClientId();
    try {
      const res = await fetch('/api/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...draft, clientId, folderId, capturedVia: 'manual' }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onAdded();
    } catch {
      // Queue it rather than lose it — same path a scan takes.
      const { queueContact } = await import('@/lib/scan/outbox');
      await queueContact({ ...draft, clientId, folderId, capturedVia: 'manual' });
      onAdded();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title="Add somebody"
      subtitle="For when they'd rather just tell you"
      labelledBy="manual-add-title"
      footer={
        <Button tone="primary" full onClick={submit} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      }
    >
      {error && (
        <div className="mb-4">
          <Banner tone="error">{error}</Banner>
        </div>
      )}
      <ContactFields
        draft={draft}
        onChange={setDraft}
        showAll={showAll}
        onToggleShowAll={() => setShowAll(true)}
      />
    </Sheet>
  );
}

/**
 * The folder's public sign-up QR.
 *
 * For a booth, or five people at once: they scan, fill in three fields, and land here. Off by
 * default and expiring by default, because it is the one unauthenticated write path in the app.
 */
function FolderQrSheet({
  folder,
  onClose,
  onChanged,
}: {
  folder: FolderDTO;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  /**
   * Seeded from whatever the server already has, as a lazy initial value rather than an effect.
   * This component is mounted only while the sheet is open, so there is nothing to re-sync — and
   * setting state inside an effect for a value derivable from props causes a cascading render.
   */
  const [url, setUrl] = useState<string | null>(() =>
    folder.intakeEnabled && folder.intakeToken && typeof window !== 'undefined'
      ? `${window.location.origin}/f/${folder.intakeToken}`
      : null
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function call(action: 'enable' | 'rotate' | 'disable') {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/folders/${folder._id}/intake`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setUrl(data.url ?? null);
      await onChanged();
    } catch {
      setError('Could not change the link. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title="Sign-up QR"
      subtitle={folder.name}
      labelledBy="folder-qr-title"
      footer={
        url ? (
          <div className="flex items-center gap-2">
            <Button tone="quiet" full onClick={() => call('rotate')} disabled={busy}>
              New link
            </Button>
            <Button tone="danger" full onClick={() => call('disable')} disabled={busy}>
              Turn off
            </Button>
          </div>
        ) : (
          <Button tone="primary" full onClick={() => call('enable')} disabled={busy}>
            {busy ? 'Creating…' : 'Create a sign-up link'}
          </Button>
        )
      }
    >
      {error && (
        <div className="mb-4">
          <Banner tone="error">{error}</Banner>
        </div>
      )}

      {url ? (
        <div className="flex flex-col items-center text-center">
          <QrCode value={url} size={240} ariaLabel={`Sign-up QR for ${folder.name}`} />
          <p className="mt-4 text-[13px] leading-relaxed text-[#6E6E73]">
            Anyone who scans this adds themselves to <strong>{folder.name}</strong>. Works with any
            phone camera — they don&apos;t need this app.
          </p>
          <code className="mt-3 block w-full break-all rounded-xl bg-[#F7F7F9] px-3 py-2 text-[11.5px] text-[#3a3a3c]">
            {url}
          </code>
          {folder.intakeExpiresAt && (
            <p className="mt-3 text-[12px] text-[#8E8E93]">
              Stops working on {fullDateIST(folder.intakeExpiresAt)} at{' '}
              {timeIST(folder.intakeExpiresAt)}.
            </p>
          )}
        </div>
      ) : (
        <div>
          <p className="text-[13.5px] leading-relaxed text-[#3a3a3c]">
            Show one code and let people add themselves — useful at a booth, or when five people
            want to swap details at once.
          </p>
          <ul className="mt-3 flex flex-col gap-1.5 text-[12.5px] text-[#6E6E73]">
            <li>· Expires after 12 hours, so a photographed code stops working after the event.</li>
            <li>· Anyone with the link can add a row, but nobody can read the folder.</li>
            <li>· You can turn it off or replace it at any time.</li>
          </ul>
        </div>
      )}
    </Sheet>
  );
}
