'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { newClientId, queueContact } from '@/lib/scan/outbox';
import type { FolderDTO, PublicCardDTO } from '@/lib/contacts/types';

/**
 * The two-way swap, for a visitor who is also signed in to PulseBLR.
 *
 * WHY THERE IS NO CROSS-USER WRITE HERE. The obvious design — "one tap and we each appear in
 * the other's contacts" — means one user's action writing a row owned by another user, which
 * needs a consent model, an accept step, and a way to refuse. Instead:
 *
 *   - "Save to a folder" creates a row owned by the VISITOR, about the card's owner.
 *   - "Show them my code" opens the VISITOR's own card screen for the other person to scan.
 *
 * Both halves are self-owned writes, the exchange is still one tap each, and nobody can put
 * anything into anybody else's data. A true one-tap mutual exchange would need a pending
 * request the other party accepts, and that is deliberately not built.
 */
export default function SaveToFolder({ card }: { card: PublicCardDTO }) {
  const [folders, setFolders] = useState<FolderDTO[]>([]);
  const [saving, setSaving] = useState(false);
  const [savedTo, setSavedTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/folders')
      .then(res => (res.ok ? res.json() : null))
      .then(data => {
        if (!cancelled && data) setFolders(data.folders ?? []);
      })
      .catch(() => {
        /* Offline: the save path below still queues locally. */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function save(folder: FolderDTO) {
    setSaving(true);
    setError(null);

    const record = {
      clientId: newClientId(),
      folderId: folder._id,
      name: card.displayName,
      headline: card.headline ?? undefined,
      company: card.company ?? undefined,
      role: card.role ?? undefined,
      linkedin: card.linkedin ?? undefined,
      x: card.x ?? undefined,
      github: card.github ?? undefined,
      website: card.website ?? undefined,
      email: card.email ?? undefined,
      phone: card.phone ?? undefined,
      capturedVia: 'card-page' as const,
      scannedAt: new Date().toISOString(),
    };

    try {
      const res = await fetch('/api/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(record),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSavedTo(folder.name);
    } catch {
      // Same guarantee as the scanner: queued locally rather than lost.
      await queueContact(record);
      setSavedTo(`${folder.name} (on this device)`);
    } finally {
      setSaving(false);
    }
  }

  if (savedTo) {
    return (
      <section className="mt-4 rounded-[22px] bg-white p-5 text-center card-shadow">
        <span className="material-symbols-outlined text-[28px] text-[#1D8A44]">check_circle</span>
        <p className="mt-1.5 text-[14px] font-semibold text-[#1D1D1F]">
          Saved to {savedTo}
        </p>
        <p className="mt-1 text-[12.5px] text-[#6E6E73]">
          Now let them scan yours, so you are in their list too.
        </p>
        <Link
          href="/card"
          className="mt-4 inline-flex h-11 items-center justify-center gap-2 rounded-full bg-[#0071E3] px-6 text-[14px] font-semibold text-white hover:bg-[#0061C3] pressable"
        >
          <span className="material-symbols-outlined text-[18px]">qr_code_2</span>
          Show them my code
        </Link>
      </section>
    );
  }

  return (
    <section className="mt-4 rounded-[22px] bg-white p-5 card-shadow">
      <h2 className="t-label text-[#8E8E93]">Save them to</h2>

      {error && (
        <p className="mt-2 rounded-xl bg-[#FFF1F0] px-3 py-2 text-[12.5px] text-[#C7362D]" role="alert">
          {error}
        </p>
      )}

      {folders.length === 0 ? (
        <p className="mt-2 text-[13px] leading-relaxed text-[#6E6E73]">
          You have no folders yet.{' '}
          <Link href="/folders" className="font-semibold text-[#0071E3] hover:underline">
            Make one
          </Link>{' '}
          and come back to this link.
        </p>
      ) : (
        <div className="mt-2 flex flex-col gap-1.5">
          {folders.slice(0, 6).map(folder => (
            <button
              key={folder._id}
              type="button"
              disabled={saving}
              onClick={() => save(folder)}
              className="flex items-center justify-between gap-3 rounded-xl bg-[#F7F7F9] px-4 py-3 text-left hover:bg-[#EEEEF0] disabled:opacity-50 pressable"
            >
              <span className="min-w-0">
                <span className="block truncate text-[13.5px] font-semibold text-[#1D1D1F]">
                  {folder.name}
                </span>
                <span className="block text-[12px] text-[#6E6E73]">
                  {folder.contactCount ?? 0} {folder.contactCount === 1 ? 'person' : 'people'}
                </span>
              </span>
              <span className="material-symbols-outlined shrink-0 text-[18px] text-[#0071E3]">
                add_circle
              </span>
            </button>
          ))}
        </div>
      )}

      <Link
        href="/card"
        className="mt-3 flex h-11 items-center justify-center gap-2 rounded-full bg-[#F5F5F7] text-[13.5px] font-semibold text-[#1D1D1F] hover:bg-[#EEEEF0] pressable"
      >
        <span className="material-symbols-outlined text-[18px]">qr_code_2</span>
        Show them my code instead
      </Link>
    </section>
  );
}
