/**
 * The submission protocol behind the folder-QR form, kept out of the component so it can be tested
 * without a browser.
 *
 * `IntakeForm.tsx` owns the fields and the screen. Everything that decides whether a tap is a NEW
 * person or a RETRY of the last one lives here, because that decision is the duplicate-contact fix:
 * see `lib/contacts/intake-key.ts` for the defect and for what the server does with the key.
 */

/**
 * The body field the key travels in. MUST equal `INTAKE_KEY_FIELD` in `lib/contacts/intake-key.ts`.
 * Not imported from there, because that module needs `node:crypto`, which has no place in a browser
 * bundle; `tests/intake-key.test.ts` pins the two strings together instead.
 */
export const KEY_FIELD = 'idempotencyKey';

/**
 * How long one send may take before it is treated as lost.
 *
 * There was no ceiling. A hall network that accepts the connection and never answers left "Sending…"
 * on screen with the button disabled — no error, no Retry, and a reload (which forgets the key) as
 * the only way out. Same figure as `SAVE_TIMEOUT_MS` in `lib/scan/outbox.ts`.
 */
export const SEND_TIMEOUT_MS = 15_000;

export interface IntakeDetails {
  name: string;
  company: string;
  role: string;
  linkedin: string;
  phone: string;
  email: string;
  note: string;
}

const DETAIL_FIELDS = ['name', 'company', 'role', 'linkedin', 'phone', 'email', 'note'] as const;

/* ────────────────────────────── the key ────────────────────────────── */

interface RandomSource {
  randomUUID?: () => string;
  getRandomValues?: (array: Uint8Array) => unknown;
}

/** `null`, not `undefined`, for "no Web Crypto": `undefined` would re-trigger the default below. */
function webCrypto(): RandomSource | null {
  return typeof crypto === 'undefined' ? null : crypto;
}

/**
 * A v4 UUID from the best randomness the page has.
 *
 * NOT `newClientId()` from `lib/scan/outbox.ts`, though it looks like the obvious reuse: its fallback
 * for a non-secure context is `cid-<time>-<random>`, which the server's strict check refuses — and a
 * refused key does not fail loudly, it silently costs the submission its replay safety. A stranger's
 * phone is where odd contexts turn up (a plain-http address, such as a dev server opened over the
 * LAN), and `crypto.getRandomValues` exists there even when `randomUUID` does not, so the fallback
 * builds the same v4 shape from it. `Math.random` is the last resort, for a page with no Web Crypto
 * at all: the key is an idempotency handle scoped to one link, not a credential, so a guessable one
 * would let a guesser learn only whether that key had been used.
 */
export function newSubmissionKey(source: RandomSource | null = webCrypto()): string {
  if (source?.randomUUID) {
    try {
      return source.randomUUID();
    } catch {
      // Fall through and build one by hand.
    }
  }

  const bytes = new Uint8Array(16);
  if (source?.getRandomValues) {
    source.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 9562 variant

  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** One version of the details, as the server will see it: it trims every field, so this does too. */
export function detailsSignature(details: IntakeDetails): string {
  return JSON.stringify(DETAIL_FIELDS.map(field => details[field].trim()));
}

export function intakeRequestBody(details: IntakeDetails, key: string) {
  return { ...details, [KEY_FIELD]: key };
}

/* ────────────────────────────── one send ────────────────────────────── */

/**
 * Why a send did not end in a confirmed save.
 *
 *   network     No answer, or none in time. It may well have landed.
 *   unreadable  A 2xx that is not this API — a captive portal's sign-in page. Treated as unknown.
 *   server      5xx. It may have landed before the failure.
 *   busy        429. Refused before anything was written; the same request works shortly.
 *   rejected    Any other 4xx. Refused before anything was written.
 *   gone        404/410: the link expired or was switched off. Retrying cannot help.
 */
export type IntakeFailure = 'network' | 'unreadable' | 'server' | 'busy' | 'rejected' | 'gone';

export type SendResult =
  | { kind: 'saved'; created: boolean }
  | { kind: 'failed'; failure: IntakeFailure };

/**
 * What an answer MEANS. `status` is null when there was no answer at all.
 *
 * A 2xx is not proof the API answered — the rule `lib/scan/outbox.ts` learned from captive-portal
 * Wi-Fi, which answers every request with 200 and an HTML sign-in page. The old form called any 2xx
 * a success, so behind a portal it showed "You're in" for a person who was never saved. Success must
 * be EVIDENCED by the API's own `{ ok: true }`. A replay's `created: false` is a success like any
 * other: the person is on the list exactly once.
 */
export function classifyIntakeResponse(status: number | null, body: unknown): SendResult {
  if (status === null) return { kind: 'failed', failure: 'network' };
  if (status >= 200 && status < 300) {
    if (body && typeof body === 'object' && (body as { ok?: unknown }).ok === true) {
      return { kind: 'saved', created: (body as { created?: unknown }).created !== false };
    }
    return { kind: 'failed', failure: 'unreadable' };
  }
  if (status === 429) return { kind: 'failed', failure: 'busy' };
  if (status === 404 || status === 410) return { kind: 'failed', failure: 'gone' };
  if (status >= 500) return { kind: 'failed', failure: 'server' };
  return { kind: 'failed', failure: 'rejected' };
}

/** Could the request behind this failure have written the row anyway? */
export function mayHaveLanded(failure: IntakeFailure): boolean {
  return failure === 'network' || failure === 'unreadable' || failure === 'server';
}

/**
 * An abort signal that fires after `ms`, plus a way to cancel it.
 *
 * `AbortController` + `setTimeout` rather than `AbortSignal.timeout`, which is missing before iOS 16:
 * calling it there throws synchronously, every send would read as a network failure, and that phone
 * could never submit at all. With no `AbortController` either, the send simply has no ceiling.
 */
export function withTimeout(ms: number): { signal: AbortSignal | undefined; done: () => void } {
  if (typeof AbortController === 'undefined') return { signal: undefined, done: () => {} };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

/** Post one submission. Never throws: every way it can end is a `SendResult`. */
export async function sendIntake(token: string, details: IntakeDetails, key: string): Promise<SendResult> {
  const timeout = withTimeout(SEND_TIMEOUT_MS);
  try {
    const response = await fetch(`/api/intake/${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(intakeRequestBody(details, key)),
      signal: timeout.signal,
    });
    // Read INSIDE the timeout: a body that stalls mid-stream is as lost as a request that never left.
    const body: unknown = await response.json().catch(() => null);
    return classifyIntakeResponse(response.status, body);
  } catch {
    return classifyIntakeResponse(null, null);
  } finally {
    timeout.done();
  }
}

/* ────────────────────────────── one submission, across its retries ────────────────────────────── */

export type SettleOutcome =
  | { kind: 'done'; created: boolean; editedAfterFirstTry: boolean }
  | { kind: 'problem'; failure: IntakeFailure; earlierMayHaveLanded: boolean };

export interface IntakeSubmission {
  /** The key for this send: minted on the first, then the SAME one for every retry. */
  keyFor(details: IntakeDetails): string;
  /** How a send ended, translated into what the person should be told. */
  settle(result: SendResult): SettleOutcome;
  /** "Add someone else": forget the key, so the next person is a new submission. */
  reset(): void;
}

/**
 * The key's lifecycle — the part of the duplicate fix that lives on the phone.
 *
 * THE KEY SURVIVES EDITS. After a failure nobody knows whether the first request landed, and a second
 * row is the one outcome this exists to prevent, so a retry reuses the key even when a field changed
 * in between. The cost is stated rather than hidden: if the first request DID land, the endpoint can
 * only create and first write wins, so the edit is not applied. `editedAfterFirstTry` exists so the
 * success screen can say that, instead of letting a corrected email look saved.
 *
 * THE KEY SURVIVES A SUCCESS TOO, until `reset()`. A stray send after "You're in" is then a harmless
 * replay rather than a second person.
 */
export function createIntakeSubmission(mint: () => string = newSubmissionKey): IntakeSubmission {
  let key: string | null = null;
  const versionsSent = new Set<string>();
  let earlierMayHaveLanded = false;

  return {
    keyFor(details) {
      if (key === null) key = mint();
      versionsSent.add(detailsSignature(details));
      return key;
    },

    settle(result) {
      if (result.kind === 'saved') {
        return {
          kind: 'done',
          created: result.created,
          // created:true means THIS send wrote the row, so what is stored is what was just sent.
          editedAfterFirstTry: !result.created && versionsSent.size > 1,
        };
      }
      // Judged on the EARLIER sends: that is what "you may already be on the list" is about.
      const outcome: SettleOutcome = { kind: 'problem', failure: result.failure, earlierMayHaveLanded };
      if (mayHaveLanded(result.failure)) earlierMayHaveLanded = true;
      return outcome;
    },

    reset() {
      key = null;
      versionsSent.clear();
      earlierMayHaveLanded = false;
    },
  };
}
