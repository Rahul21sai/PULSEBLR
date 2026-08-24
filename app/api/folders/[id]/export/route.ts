import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongodb';
import Contact from '@/lib/models/Contact';
import { requireUser } from '@/lib/api-auth';
import { findOwnedFolder } from '@/lib/contacts/service';
import { toCsv, exportFilename, type CsvColumn } from '@/lib/scan/csv';
import { buildVCardFile } from '@/lib/contacts/vcf';
import { fullDateIST, timeIST } from '@/lib/format';
import type { IContact } from '@/lib/models/Contact';

/**
 * Export one folder — "the sheet".
 *
 * `?format=csv` (default) opens in Excel, Numbers or Google Sheets. `?format=vcf` imports
 * straight into a phone's address book.
 *
 * THIS IS A BULK PII EXPORT, so it is not only an auth question:
 *
 *   - `Cache-Control: no-store`. Do NOT copy the ICS route's `public, max-age=3600`: that
 *     is a shared calendar, this is one person's private contact list, and the service
 *     worker caches successful GETs into an origin-wide cache.
 *   - Cells are escaped against spreadsheet formula injection by `lib/scan/csv.ts`, because
 *     every value here originates in a QR code somebody else generated.
 *   - The filename is sanitised, since folder names are user-supplied and land in a
 *     `Content-Disposition` header.
 */

/** Dates are formatted in IST via lib/format.ts — never the ambient locale. */
function scannedAtLabel(contact: IContact): string {
  return `${fullDateIST(contact.scannedAt)} ${timeIST(contact.scannedAt)}`;
}

const COLUMNS: CsvColumn<IContact>[] = [
  { label: 'Name', value: c => c.name },
  { label: 'Headline', value: c => c.headline },
  { label: 'Role', value: c => c.role },
  { label: 'Company', value: c => c.company },
  { label: 'LinkedIn', value: c => c.linkedin },
  { label: 'Phone', value: c => c.phone },
  { label: 'Email', value: c => c.email },
  { label: 'X', value: c => c.x },
  { label: 'GitHub', value: c => c.github },
  { label: 'Website', value: c => c.website },
  { label: 'How we met', value: c => c.note },
  { label: 'Tags', value: c => c.tags?.join(', ') },
  { label: 'Follow up', value: c => (c.followUpAt ? fullDateIST(c.followUpAt) : '') },
  { label: 'Followed up', value: c => (c.followedUp ? 'yes' : 'no') },
  { label: 'Target company', value: c => (c.isTargetCompany ? 'yes' : '') },
  { label: 'Known companies', value: c => c.companies?.join(', ') },
  { label: 'Captured via', value: c => c.capturedVia },
  { label: 'Scanned at (IST)', value: c => scannedAtLabel(c) },
];

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  try {
    await connectDB();
    const { id } = await params;
    const folder = await findOwnedFolder(gate.userId, id);
    if (!folder) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const contacts = await Contact.find({ userId: gate.userId, folderId: folder._id }).sort({
      scannedAt: 1,
    });

    const format = request.nextUrl.searchParams.get('format') === 'vcf' ? 'vcf' : 'csv';

    const body =
      format === 'vcf'
        ? buildVCardFile(
            contacts.map(c => ({
              name: c.name,
              role: c.role,
              company: c.company,
              email: c.email,
              phone: c.phone,
              urls: [c.linkedin, c.website, c.github && `https://github.com/${c.github}`, c.x && `https://x.com/${c.x}`],
              // The folder name is the useful context in an address book: "where did this
              // person come from".
              note: [folder.name, c.note].filter(Boolean).join(' — '),
            }))
          )
        : toCsv(contacts, COLUMNS);

    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type':
          format === 'vcf' ? 'text/vcard; charset=utf-8' : 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${exportFilename(folder.name, format)}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    console.error('Error exporting folder:', error);
    return NextResponse.json({ error: 'Failed to export folder' }, { status: 500 });
  }
}
