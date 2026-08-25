/**
 * What an admin may supply when registering a scrape source.
 *
 * `POST /api/sources` did `Source.create(body)` on the raw request body. Its own header comment
 * already flagged the risk — "an attacker could inject a handle that the NEXT scrape run will
 * fetch" — which is the part that makes this different from an ordinary validation gap: a `Source`
 * row is not inert data, it is an INSTRUCTION to the scraper. Whatever lands in `url` / `handle`
 * gets fetched on the next run by a job with no user in front of it.
 *
 * So this allowlists the four fields a human actually fills in and drops the rest. The dropped
 * ones matter:
 *
 *   · `lastScrapedAt`, `lastEventCount`, `consecutiveEmptyScrapes`, `lastError`, `lastErrorAt` are
 *     the scraper's own HEALTH BOOKKEEPING. `consecutiveEmptyScrapes` in particular feeds the
 *     unhealthy-source report in the digest and the ordering in `loadDiscovered()`, so a seeded
 *     value would either hide a dead feed or push a good one to the back of the queue.
 *   · `discoveredAt` records how a source was found. Hand-setting it misattributes auto-discovery.
 *
 * `url` is http(s)-only for the same reason the event validator is: the scraper will dereference
 * it. A `file://` value would point the job at the runner's own disk.
 *
 * Pure — no database — so `tests/source-admin-validate.test.ts` pins it without a server.
 */

/** The transport the adapter should use. Mirrors the schema enum, which is the source of truth. */
export const SOURCE_TYPES = ['ical', 'rss', 'api', 'scrape'] as const;

export interface SourceFieldIssue {
  field: string;
  message: string;
}

export interface SourceValidationResult {
  doc: Record<string, unknown>;
  issues: SourceFieldIssue[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateNewSource(body: unknown): SourceValidationResult {
  const issues: SourceFieldIssue[] = [];
  const doc: Record<string, unknown> = {};

  if (!isPlainObject(body)) {
    return { doc, issues: [{ field: 'body', message: 'must be a JSON object' }] };
  }

  // ── name (required) ──────────────────────────────────────────────────────────
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) {
    issues.push({ field: 'name', message: 'is required' });
  } else if (name.length > 200) {
    issues.push({ field: 'name', message: 'must be 200 characters or fewer' });
  } else {
    doc.name = name;
  }

  // ── type (required, enum) ────────────────────────────────────────────────────
  if (typeof body.type !== 'string' || !(SOURCE_TYPES as readonly string[]).includes(body.type)) {
    issues.push({ field: 'type', message: `must be one of ${SOURCE_TYPES.join(', ')}` });
  } else {
    doc.type = body.type;
  }

  // ── url (required, http/https only — the scraper WILL fetch this) ────────────
  const rawUrl = typeof body.url === 'string' ? body.url.trim() : '';
  if (!rawUrl) {
    issues.push({ field: 'url', message: 'is required' });
  } else {
    let parsed: URL | null = null;
    try {
      parsed = new URL(rawUrl);
    } catch {
      parsed = null;
    }
    if (!parsed) {
      issues.push({ field: 'url', message: 'must be a full URL including https://' });
    } else if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      // file:// would point the scrape job at the runner's own filesystem.
      issues.push({ field: 'url', message: 'must be http or https' });
    } else {
      doc.url = parsed.toString();
    }
  }

  // ── kind / handle (optional; together they are the dedup identity) ───────────
  // `Source.index({ kind, handle }, { unique: true, sparse: true })` — see the compound-sparse
  // warning in CLAUDE.md §9. Supplying one without the other is what eventually collides, so
  // require them as a pair rather than letting a half-identified row in.
  const kind = typeof body.kind === 'string' ? body.kind.trim() : '';
  const handle = typeof body.handle === 'string' ? body.handle.trim() : '';
  if (kind && !handle) {
    issues.push({ field: 'handle', message: 'is required when a kind is given' });
  } else if (handle && !kind) {
    issues.push({ field: 'kind', message: 'is required when a handle is given' });
  } else if (kind && handle) {
    if (kind.length > 60) issues.push({ field: 'kind', message: 'must be 60 characters or fewer' });
    if (handle.length > 200) issues.push({ field: 'handle', message: 'must be 200 characters or fewer' });
    if (!issues.some(i => i.field === 'kind' || i.field === 'handle')) {
      doc.kind = kind;
      doc.handle = handle;
    }
  }

  // ── enabled (optional) ───────────────────────────────────────────────────────
  if ('enabled' in body) {
    if (typeof body.enabled !== 'boolean') {
      issues.push({ field: 'enabled', message: 'must be true or false' });
    } else {
      doc.enabled = body.enabled;
    }
  }

  return { doc, issues };
}

/** The 400 body: names every bad field, and leaks no Mongoose wording. */
export function sourceValidationError(issues: SourceFieldIssue[]) {
  return {
    error:
      issues.length === 1
        ? `${issues[0].field} ${issues[0].message}`
        : `${issues.length} fields are invalid`,
    fields: issues,
  };
}
