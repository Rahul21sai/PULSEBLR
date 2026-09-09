import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongodb';
import Contact from '@/lib/models/Contact';
import Folder from '@/lib/models/Folder';
import { requireUser } from '@/lib/api-auth';
import { isValidId } from '@/lib/contacts/service';
import { buildContactFilter, buildContactSort, parseContactQuery, type ContactSort } from '@/lib/contacts/query';
import { CONTACT_CSV_COLUMNS } from '@/lib/contacts/export-columns';
import { toCsv, exportFilename, type CsvColumn } from '@/lib/scan/csv';
import { buildVCardFile } from '@/lib/contacts/vcf';
import type { IContact } from '@/lib/models/Contact';

/**
 * Export EVERY person the current filter matches, across all folders.
 *
 * Uses the same `buildContactFilter()` as the People list, so what downloads is exactly what was on
 * screen — an export that quietly ignores the active filters is worse than no export, because it
 * looks like it worked.
 *
 * `CONTACT_CSV_COLUMNS` is shared with the per-folder export rather than redeclared. That keeps `Tags` and
 * `Known companies` as two separate columns, which is the distinction the whole feature rests on:
 * one is what the user typed, the other is what the registry could justify. A second copy of the
 * list would eventually merge them, or lose the formula escaping — and both fields originate in free
 * text and QR payloads, so `lib/scan/csv.ts` escaping every cell is not optional. A cell beginning
 * `=`, `+`, `-` or `@` is executed as a formula by Excel and Sheets.
 *
 * `Cache-Control: no-store`, for the same reason the folder export sets it and a stronger one: this
 * is a bulk PII export of a user's ENTIRE contact list, and `sw.js` caches successful GETs.
 *
 * `?format=vcf` IMPORTS STRAIGHT INTO A PHONE'S ADDRESS BOOK, and its absence here was backwards.
 * The PER-FOLDER export has honoured it from the start, so a user could put one event's people into
 * their contacts app and not everyone they had ever met — when the complete list is obviously the
 * one you want in an address book. Same branch, same `buildVCardFile`, same headers discipline.
 *
 * The `note` field carries the FOLDER NAME, exactly as the per-folder export does: "where did this
 * person come from" is the one piece of context a vCard has room for and an address book has no
 * other column for. It matters more here than there, because a combined export has no filename to
 * carry it. The folder join below already exists to serve the CSV's `Folder` column, so this costs
 * no extra query.
 */

/** No cap on the folder export, but this one can span every folder, so it needs a ceiling. */
const MAX_ROWS = 5000;

export async function GET(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  try {
    await connectDB();
    const search = request.nextUrl.searchParams;
    const params = parseContactQuery(search);

    if (params.folderId && !isValidId(params.folderId)) {
      return NextResponse.json({ error: 'Invalid folder id' }, { status: 400 });
    }

    const filter = buildContactFilter(gate.userId, params);
    const sort = buildContactSort((search.get('sort') as ContactSort) ?? 'recent');

    const contacts = await Contact.find(filter).sort(sort).limit(MAX_ROWS);

    /**
     * A `Folder` column, because "where did I meet them" is the one piece of context a combined
     * export needs and the per-folder export gets for free from its filename.
     *
     * One `Folder.find` over the distinct ids, then an in-memory join — the same discipline
     * `listFolders()` uses. Archived folders are included deliberately: excluding them would drop
     * the location for people met at an event the user has since tidied away.
     */
    const folderIds = [...new Set(contacts.map(c => String(c.folderId)))];
    const folders = await Folder.find({ _id: { $in: folderIds } })
      .select('name')
      .lean();
    const folderName = new Map(folders.map(f => [String(f._id), f.name]));

    // Anything that is not exactly `vcf` is CSV — the same defaulting the folder export uses, so a
    // typo downloads a spreadsheet rather than a 400.
    const format = search.get('format') === 'vcf' ? 'vcf' : 'csv';

    if (format === 'vcf') {
      const body = buildVCardFile(
        contacts.map(c => ({
          name: c.name,
          role: c.role,
          company: c.company,
          email: c.email,
          phone: c.phone,
          urls: [
            c.linkedin,
            c.website,
            c.github && `https://github.com/${c.github}`,
            c.x && `https://x.com/${c.x}`,
          ],
          note: [folderName.get(String(c.folderId)), c.note].filter(Boolean).join(' — '),
        }))
      );
      return new NextResponse(body, {
        status: 200,
        headers: {
          'Content-Type': 'text/vcard; charset=utf-8',
          'Content-Disposition': `attachment; filename="${exportFilename('people', 'vcf')}"`,
          'Cache-Control': 'no-store',
        },
      });
    }

    const columns: CsvColumn<IContact>[] = [
      ...CONTACT_CSV_COLUMNS,
      {
        label: 'Folder',
        // "Folder deleted" rather than blank: a dangling folderId is a normal state here, and a
        // blank cell reads as missing data rather than as a folder that is genuinely gone.
        value: c => folderName.get(String(c.folderId)) ?? 'Folder deleted',
      },
    ];

    return new NextResponse(toCsv(contacts, columns), {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${exportFilename('people', 'csv')}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    console.error('Error exporting contacts:', error);
    return NextResponse.json({ error: 'Failed to export' }, { status: 500 });
  }
}
