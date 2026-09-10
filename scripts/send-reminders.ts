#!/usr/bin/env tsx
/**
 * Send the day's saved-event reminder emails.
 *
 * Usage:
 *   npx tsx scripts/send-reminders.ts            # send
 *   npx tsx scripts/send-reminders.ts --dry      # decide and report, write nothing, send nothing
 *   npx tsx scripts/send-reminders.ts --only=me@example.com
 *   npx tsx scripts/send-reminders.ts --lead=24 --max-emails=1 --max-events=3
 *   npx tsx scripts/send-reminders.ts --retry-failed
 *
 * IDEMPOTENT AND SAFE TO RE-RUN, which is the property the workflow depends on. Every event that
 * has already been mailed carries a `ReminderLog` row, and a second run finds it and sends
 * nothing — so a retried Action, a manual `workflow_dispatch` firing next to the schedule, and an
 * operator running this by hand against the same Atlas database all converge on at most one email
 * per person per event. The guard is a unique index, not a check in this file; see
 * `lib/models/ReminderLog.ts`.
 *
 * IT EXITS 0 WHEN IT IS NOT CONFIGURED, following `send-digest.ts` for the reason recorded there:
 * a hard failure turns the scheduled Action red and emails a failure every single morning, and a
 * cron that cries wolf daily gets muted — after which real breakage goes unnoticed. A genuine
 * send failure DOES exit 1, because that is a fault worth waking up to.
 */

import './load-env'; // MUST be first — populates process.env from .env.local
import { sendEventReminders, type SendRemindersReport } from '../lib/notifications/reminders';

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function value(name: string): string | undefined {
  const hit = process.argv.find(arg => arg.startsWith(`--${name}=`));
  return hit?.split('=').slice(1).join('=') || undefined;
}

function numeric(name: string): number | undefined {
  const raw = value(name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  // A typo must not silently become a different policy: `--lead=twelve` would otherwise parse to
  // NaN and every event would fall outside the window, reported as "nothing due".
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`❌ --${name} must be a positive number (got "${raw}")`);
    process.exit(2);
  }
  return parsed;
}

function summarise(report: SendRemindersReport): void {
  console.log('');
  console.log(`users considered   ${report.usersConsidered}`);
  console.log(`  opted in         ${report.usersOptedIn}`);
  console.log(`  never asked      ${report.neverAsked}`);
  console.log(`  opted out        ${report.optedOut}`);
  console.log(`emails sent        ${report.emailsSent}`);
  console.log(`emails failed      ${report.emailsFailed}`);
  console.log(`events reminded    ${report.eventsReminded}`);

  if (report.perUser.length > 0) {
    console.log('');
    console.log('per user:');
    for (const row of report.perUser) {
      const bits = [
        `due ${row.due}`,
        `already ${row.alreadyLogged}`,
        `claimed ${row.claimed}`,
        row.deferred ? `deferred ${row.deferred}` : null,
        row.raced ? `raced ${row.raced}` : null,
        `emails today ${row.emailsSentToday}`,
      ]
        .filter(Boolean)
        .join(' · ');
      // The address is printed because this is an operator tool run against their own data, and
      // "which account did nothing happen for" is the first question every time.
      console.log(`  ${row.outcome.padEnd(12)} ${row.email.padEnd(32)} ${bits}`);
      if (row.error) console.log(`               ↳ ${row.error}`);
    }
  }

  /*
   * The one state that looks like a bug and is not. Consent requires the user to have BEEN ASKED
   * (`preferences.onboardedAt`), and nothing writes that field yet — no onboarding screen exists.
   * Say so plainly here, or the first person to run this concludes the sender is broken.
   */
  if (report.usersOptedIn === 0 && report.neverAsked > 0) {
    console.log('');
    console.log(
      `ℹ️  ${report.neverAsked} user(s) have never been asked, so nobody is opted in and nothing ` +
        'was sent. That is deliberate: `preferences.remindersEnabled` defaults to true in the ' +
        'schema, so the flag alone is not consent — `preferences.onboardedAt` must also be set, ' +
        'which the onboarding flow will do once it ships. See remindersEnabled() in ' +
        'lib/notifications/reminder-policy.ts.'
    );
  }
}

async function main() {
  const dryRun = flag('dry') || flag('dry-run');

  console.log('='.repeat(60));
  console.log(`PulseBLR Event Reminders${dryRun ? ' — DRY RUN, nothing will be written or sent' : ''}`);
  console.log('='.repeat(60));

  try {
    const report = await sendEventReminders({
      dryRun,
      leadHours: numeric('lead'),
      maxEmailsPerDay: numeric('max-emails'),
      maxEventsPerEmail: numeric('max-events'),
      retryFailed: flag('retry-failed'),
      onlyEmail: value('only'),
    });

    if (report.notConfigured.length > 0) {
      // Skip, not fail. See the header.
      console.log('');
      console.log(
        `ℹ️  Reminders not configured (${report.notConfigured.join(', ')} unset) — skipping, no ` +
          'email sent.'
      );
      console.log(
        '   NEXTAUTH_SECRET is required because it signs the unsubscribe link. An email with no ' +
          'working way off the list is worse than no email, so nothing is sent without it.'
      );
      process.exit(0);
    }

    summarise(report);

    if (report.emailsFailed > 0) {
      console.log('');
      console.log(
        `❌ ${report.emailsFailed} email(s) failed. Their ReminderLog rows are marked 'failed' and ` +
          'are NOT retried automatically — a failure reported by the client does not prove the ' +
          'message was undelivered, and re-sending on a false negative is the duplicate this ' +
          'design refuses. Run with --retry-failed once you have decided.'
      );
      process.exit(1);
    }

    console.log('');
    console.log(dryRun ? '✅ Dry run complete.' : '✅ Reminder run complete.');
    process.exit(0);
  } catch (error) {
    console.error('');
    console.error('❌ Fatal error sending reminders:');
    console.error(error);
    process.exit(1);
  }
}

main();
