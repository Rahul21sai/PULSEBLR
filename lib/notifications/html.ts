/**
 * HTML escaping for values interpolated into an outgoing email.
 *
 * WHY THIS IS ITS OWN FILE. It used to live in `digest.ts`, which imports `connectDB`,
 * `TrackerEntry` and the phase6 helpers — so importing the escaper pulled mongoose and
 * the whole model graph in with it. `reminder-policy.ts` is deliberately pure (it is what
 * `tests/reminders.test.ts` exercises, and the vitest scope is pure functions only), and it
 * needs exactly this one function. One definition, imported by both formatters, rather than
 * a second copy that drifts.
 *
 * Every value that reaches an email body originates somewhere hostile: a scraped event
 * title, a source's error string, a name typed into a QR code by somebody else. Escape all
 * of it.
 */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
