#!/usr/bin/env tsx
/**
 * MICROSITE EXTRACTION AUDIT — judge every model-extracted event BY EYE.
 *
 * Run: npx tsx scripts/diag-microsite-audit.ts
 *      npx tsx scripts/diag-microsite-audit.ts --chars=2000
 *      npx tsx scripts/diag-microsite-audit.ts --full
 *      npx tsx scripts/diag-microsite-audit.ts --id=68c1f0...       (one row, whole text)
 *      npx tsx scripts/diag-microsite-audit.ts --flagged            (only rows with a finding)
 *
 * READ-ONLY. No `.save()`, no `update`, no `create`, no `delete` anywhere in this file.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS PRINTS EVERY ROW AND REFUSES TO SUMMARISE THEM.
 *
 * `lib/llm/extract-event.ts` has no keyword floor: a throttled or half-parsed extraction yields
 * ZERO events, so everything that reaches the submissions queue is either a real event or a
 * fabrication — and the two arrive with identical status, identical fields and identical
 * confidence. No aggregate can separate them. "12 candidates, 0 rejections" is exactly what a
 * confidently wrong parse looks like from above, which is the failure this codebase keeps
 * re-learning: a count is not a ranking, and an aggregate hides over-matching.
 *
 * So the output is one block per row, naming it, with enough of the retained page text to argue
 * with. The three computed checks below (fingerprint drift, grounding, truncation) are here to
 * direct attention, never to replace reading — a row with no finding is a row worth reading anyway.
 *
 * ── WHAT IT CAN AND CANNOT CONCLUDE ─────────────────────────────────────────────────────────
 *
 * The grounding re-check runs the PRODUCTION predicate (`isGrounded`, imported not copied — the
 * same reason `cleanup-non-bengaluru.ts` imports `offCityReason`) against the RETAINED text. That
 * is a weaker haystack than the one the validator used whenever the page was longer than
 * `EXTRACTION_TEXT_KEEP`, so on a truncated row the answer is "cannot verify", never "not on the
 * page". A checker that reports a false hallucination is a checker somebody switches off.
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 */
import './load-env';
import mongoose from 'mongoose';
import connectDB from '../lib/mongodb';
import Event, { type EventExtraction } from '../lib/models/Event';
import { FINGERPRINT_PREFIX, fingerprintFromSourceEventId, extractionTextIsComplete } from '../lib/scrapers/adapters/microsite';
import { isGrounded } from '../lib/llm/extract-event';
import { fullDateIST, timeIST, relativeTime } from '../lib/format';

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const value = (name: string): string | undefined =>
  argv.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

const FULL = flag('full');
const FLAGGED_ONLY = flag('flagged');
const ONE_ID = value('id');
const TEXT_CHARS = Number(value('chars') ?? (ONE_ID ? 100000 : 900));
const RESPONSE_CHARS = Number(value('response-chars') ?? 700);

/**
 * The shape read back. `extraction` is `select: false` on the schema — that is the leak defence
 * for every read path with no projection — so this is one of the very few places that asks for it,
 * and it has to ask EXPLICITLY. Forgetting the `+` here would report "no row carries a record",
 * which reads as a pipeline that never wrote one.
 */
interface Row {
  _id: mongoose.Types.ObjectId;
  title: string;
  description?: string;
  organizer?: string;
  venue?: string;
  address?: string;
  area?: string;
  city?: string;
  format?: string;
  startDateTime: Date;
  endDateTime?: Date;
  isFree?: boolean;
  price?: number;
  applyLink?: string;
  sourceUrl?: string;
  sourceEventId?: string;
  clusterKey?: string;
  category?: string[];
  isTechEvent?: boolean;
  connectionScore?: number;
  speakers?: Array<{ name: string; title?: string; company?: string }>;
  visibility?: string;
  deletedAt?: Date;
  createdAt?: Date;
  lastSeenAt?: Date;
  extraction?: EventExtraction;
}

/** Absent `visibility` means public, which for one of these rows means APPROVED by a human. */
function decisionOf(row: Row): 'pending' | 'approved' | 'rejected' | 'other' {
  if (row.visibility === 'pending') return 'pending';
  if (row.visibility === undefined) return 'approved';
  if (row.visibility === 'private') return 'rejected';
  return 'other';
}

interface Finding {
  severity: 1 | 2 | 3;
  label: string;
}

/**
 * The three defects a stored candidate can carry that nothing else can see.
 *
 * Ordered by how much they should change what you do, not by how easy they are to compute.
 */
function findingsFor(row: Row): Finding[] {
  const out: Finding[] = [];
  const rec = row.extraction;

  if (!rec || rec.text === undefined) {
    // Not a defect on its own — every row landed before the field existed has no record. It IS a
    // defect for a row written afterwards, and there is no way to tell those apart from here, so
    // it is reported as what it is: unauditable.
    out.push({ severity: 2, label: 'NO RETAINED TEXT — this row cannot be checked at all' });
    return out;
  }

  const rowFingerprint = fingerprintFromSourceEventId(row.sourceEventId);
  if (rowFingerprint && rec.fingerprint && rowFingerprint !== rec.fingerprint) {
    // `sourceEventId` is refreshed on a later run and the retained text is replaced in the same
    // breath. If they disagree, the text on this row is NOT the text that produced it, and every
    // other check below is being run against the wrong input.
    out.push({
      severity: 1,
      label: `FINGERPRINT DRIFT — row says ${rowFingerprint}, retained text says ${rec.fingerprint}`,
    });
  }

  const complete = extractionTextIsComplete(rec);
  if (!complete) {
    out.push({
      severity: 3,
      label: `text truncated (${rec.textLength ?? '?'} chars rendered, ${rec.text.length} kept) — grounding is inconclusive`,
    });
  }

  // Grounding, re-run with the production predicate. Only a COMPLETE retained text can produce a
  // finding here; on a truncated one the absence is explained by the truncation, not by the model.
  if (complete) {
    if (!isGrounded(row.title, rec.text)) {
      out.push({ severity: 1, label: 'TITLE IS NOT IN THE RETAINED TEXT — hallucinated by construction' });
    }
    if (row.venue && !isGrounded(row.venue, rec.text)) {
      out.push({ severity: 1, label: `VENUE "${row.venue}" IS NOT IN THE RETAINED TEXT` });
    }
    for (const speaker of row.speakers ?? []) {
      if (!isGrounded(speaker.name, rec.text)) {
        out.push({ severity: 1, label: `SPEAKER "${speaker.name}" IS NOT IN THE RETAINED TEXT — this names a real person` });
      }
    }
  }

  return out;
}

function indent(text: string, prefix = '    | '): string {
  return text
    .split('\n')
    .map(line => prefix + line)
    .join('\n');
}

/** Collapse runs of blank lines so 900 characters of a rendered page is 900 useful ones. */
function tidy(text: string): string {
  return text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

async function main() {
  await connectDB();

  const filter: Record<string, unknown> = ONE_ID
    ? { _id: ONE_ID }
    : { source: 'company', sourceEventId: { $regex: `^${FINGERPRINT_PREFIX}` } };

  const rows = await Event.find(filter)
    // `+extraction` is mandatory — see the `Row` docblock.
    .select('+extraction')
    .sort({ createdAt: -1 })
    .lean<Row[]>();

  console.log('PulseBLR — microsite extraction audit');
  console.log('Read-only. Judge each row by eye; the checks only direct attention.\n');

  if (rows.length === 0) {
    console.log(
      ONE_ID
        ? `No event with _id ${ONE_ID}.`
        : 'No microsite-extracted rows stored, and TODAY THAT IS STRUCTURAL RATHER THAN EMPTY.\n\n' +
            'The LLM step is gated behind `PipelineOptions.micrositeCandidates`, which defaults to\n' +
            'false in `pipeline.ts` — and `scripts/scrape.ts` never sets it, so there is currently\n' +
            'NO CLI FLAG that arms it. `npm run scrape` therefore cannot produce a row for this\n' +
            'script to audit; only a caller passing `micrositeCandidates: true` to `runPipeline`\n' +
            'can. Verified by reading both files, not inferred from this empty result.\n\n' +
            'Steps 1 and 2 of the cascade DO run unconditionally. The JSON-LD half lands ordinary\n' +
            'public events with no `microsite:` prefix on `sourceEventId` and no extraction record,\n' +
            'so its output correctly does not appear here — that asymmetry is the safety argument,\n' +
            'not a gap in this listing.'
    );
    await mongoose.disconnect();
    return;
  }

  // ── Totals, stated before the rows so a big listing has a shape ────────────────────────────
  const byDecision = { pending: 0, approved: 0, rejected: 0, other: 0 };
  let withRecord = 0;
  let deleted = 0;
  const allFindings: Array<{ row: Row; findings: Finding[] }> = [];

  for (const row of rows) {
    byDecision[decisionOf(row)]++;
    if (row.extraction?.text !== undefined) withRecord++;
    if (row.deletedAt) deleted++;
    const findings = findingsFor(row);
    if (findings.length) allFindings.push({ row, findings });
  }

  console.log(`Rows: ${rows.length}`);
  console.log(
    `  by decision   pending ${byDecision.pending} · approved ${byDecision.approved} · ` +
      `rejected ${byDecision.rejected}${byDecision.other ? ` · other ${byDecision.other}` : ''}` +
      `${deleted ? ` · soft-deleted ${deleted}` : ''}`
  );
  console.log(`  auditable     ${withRecord} of ${rows.length} carry retained page text`);
  console.log(`  with findings ${allFindings.length}\n`);

  // ── One block per row ──────────────────────────────────────────────────────────────────────
  let printed = 0;
  for (const [index, row] of rows.entries()) {
    const findings = findingsFor(row);
    if (FLAGGED_ONLY && findings.length === 0) continue;
    printed++;
    const rec = row.extraction;
    const decision = decisionOf(row).toUpperCase();

    console.log('─'.repeat(96));
    console.log(`[${index + 1}] "${row.title}"   ${decision}${row.deletedAt ? ' · SOFT-DELETED' : ''}`);
    console.log(`    _id          ${row._id}`);
    console.log(`    page         ${rec?.sourceUrl ?? '(not recorded)'}`);

    const rowFingerprint = fingerprintFromSourceEventId(row.sourceEventId);
    const agree = rowFingerprint && rec?.fingerprint ? rowFingerprint === rec.fingerprint : undefined;
    console.log(
      `    fingerprint  row ${rowFingerprint ?? '(none)'} · record ${rec?.fingerprint ?? '(none)'}` +
        (agree === undefined ? '' : agree ? '  [agree]' : '  [DISAGREE]')
    );
    console.log(
      `    model        ${rec?.model ?? '(not recorded)'}${rec?.provider ? ` via ${rec.provider}` : ''}`
    );
    console.log(
      `    extracted    ${rec?.extractedAt ? `${fullDateIST(rec.extractedAt)} ${timeIST(rec.extractedAt)} IST (${relativeTime(rec.extractedAt)})` : '(not recorded)'}`
    );
    console.log(
      `    landed       ${row.createdAt ? `${fullDateIST(row.createdAt)} (${relativeTime(row.createdAt)})` : '?'}`
    );

    // What the model CLAIMED — the row's own fields, which are the claim after validation.
    console.log('    claims');
    console.log(
      `      when       ${fullDateIST(row.startDateTime)} ${timeIST(row.startDateTime)} IST` +
        (row.endDateTime ? ` → ${fullDateIST(row.endDateTime)} ${timeIST(row.endDateTime)}` : '')
    );
    console.log(
      `      where      ${row.format ?? '?'} · venue ${row.venue ?? '—'} · area ${row.area ?? '—'} · city ${row.city ?? '—'}`
    );
    if (row.address) console.log(`      address    ${row.address}`);
    /*
     * `isFree` AND `price` ARE PRINTED SEPARATELY, AND NEITHER IS COLLAPSED INTO THE WORD "free".
     *
     * `Event.isFree` is `{ type: Boolean, default: true }`, so a row where the model said nothing
     * about price stores `true` — the defect CLAUDE.md §15 records for the "free this week" shelf,
     * a field whose default IS the value you would filter on. An audit that renders that as "free"
     * reports a schema default as a model claim, which is the one thing this script must never do.
     */
    console.log(
      `      price      ${row.price !== undefined ? `₹${row.price}` : 'not stated'} · isFree=${row.isFree}` +
        (row.price === undefined && row.isFree ? '  (schema default — NOT necessarily a claim)' : '')
    );
    console.log(`      organizer  ${row.organizer ?? '—'}`);
    console.log(`      apply      ${row.applyLink ?? '—'}`);
    console.log(
      `      derived    [${(row.category ?? []).join(', ')}] tech=${row.isTechEvent} score=${row.connectionScore}`
    );
    if (row.speakers?.length) {
      console.log(
        `      speakers   ${row.speakers.map(s => s.name + (s.company ? ` (${s.company})` : '')).join(' · ')}`
      );
    }
    if (row.description) {
      console.log(`      blurb      ${tidy(row.description).slice(0, 220).replace(/\n/g, ' ')}`);
    }

    if (rec?.text !== undefined) {
      console.log(
        `    text         ${rec.text.length} chars retained of ${rec.textLength ?? '?'} rendered` +
          (extractionTextIsComplete(rec) ? ' (whole page)' : ' (TRUNCATED)')
      );
    }

    if (findings.length) {
      console.log('    findings');
      for (const f of findings.sort((a, b) => a.severity - b.severity)) {
        console.log(`      ${'!'.repeat(4 - f.severity)} ${f.label}`);
      }
    } else if (rec?.text !== undefined) {
      console.log('    findings     none computed — read the text below anyway');
    }

    // ── The evidence ─────────────────────────────────────────────────────────────────────────
    // `--chars=0` / `--response-chars=0` means "the summary only". Printing an empty quote block
    // for it would be noise dressed as evidence.
    if (rec?.text && (FULL || TEXT_CHARS > 0)) {
      const body = tidy(rec.text);
      const cut = FULL ? body : body.slice(0, TEXT_CHARS);
      console.log(`\n    retained page text${FULL ? '' : ` (first ${cut.length} of ${body.length})`}:`);
      console.log(indent(cut));
      if (!FULL && body.length > cut.length) {
        console.log(`    … ${body.length - cut.length} more — rerun with --id=${row._id} for all of it`);
      }
    }
    if (rec?.response && (FULL || RESPONSE_CHARS > 0)) {
      const cut = FULL ? rec.response : rec.response.slice(0, RESPONSE_CHARS);
      console.log(`\n    verbatim model reply${FULL ? '' : ` (first ${cut.length} of ${rec.response.length})`}:`);
      console.log(indent(cut));
    }
    console.log('');
  }

  if (FLAGGED_ONLY) console.log(`${printed} row(s) with a finding, of ${rows.length}.\n`);

  // ── The findings again, ranked, because the per-row blocks are long ────────────────────────
  if (allFindings.length) {
    console.log('═'.repeat(96));
    console.log('FINDINGS, most serious first\n');
    const ranked = allFindings
      .flatMap(({ row, findings }) => findings.map(f => ({ row, f })))
      .sort((a, b) => a.f.severity - b.f.severity);
    for (const { row, f } of ranked) {
      console.log(`  [sev ${f.severity}] "${row.title.slice(0, 60)}"  ${row._id}`);
      console.log(`            ${f.label}`);
    }
    console.log('');
  }

  await mongoose.disconnect();
}

main().catch(async error => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
