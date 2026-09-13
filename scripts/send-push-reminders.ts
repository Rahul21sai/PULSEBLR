#!/usr/bin/env tsx
/**
 * Send the day's saved-event reminders as WEB PUSH notifications.
 *
 * Usage:
 *   npx tsx scripts/send-push-reminders.ts            # send
 *   npx tsx scripts/send-push-reminders.ts --dry      # decide and report, write nothing, send nothing
 *   npx tsx scripts/send-push-reminders.ts --only=me@example.com
 *   npx tsx scripts/send-push-reminders.ts --lead=24 --max-per-day=1 --max-per-run=1
 *   npx tsx scripts/send-push-reminders.ts --retry-failed
 *
 * THIS IS A SIBLING OF `send-reminders.ts`, NOT A REPLACEMENT. The two channels write `ReminderLog`
 * rows under different `kind` values, so running both on the same morning is correct: neither
 * suppresses the other's at-most-once row, and — since the daily-cap query is scoped by kind — neither
 * spends the other's frequency budget. That scoping was missing until this feature landed and is the
 * one thing to re-check if a channel ever reports `daily-cap` with an empty log.
 *
 * IDEMPOTENT AND SAFE TO RE-RUN. Every event already notified carries a row, and a second run finds
 * it and sends nothing. The guard is a unique index, not a check in this file.
 *
 * IT EXITS 0 WHEN IT IS NOT CONFIGURED, following `send-digest.ts` and `send-reminders.ts` for the
 * reason recorded there: a hard failure turns the scheduled Action red every single morning, and a
 * cron that cries wolf daily gets muted — after which real breakage goes unnoticed. A genuine send
 * failure DOES exit 1.
 */

import './load-env'; // MUST be first — populates process.env from .env.local
import { sendPushReminders, type SendPushRemindersReport } from '../lib/notifications/push';

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
  // A typo must not silently become a different policy: `--lead=twelve` would parse to NaN and every
  // event would fall outside the window, reported as "nothing due".
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`❌ --${name} must be a positive number (got "${raw}")`);
    process.exit(2);
  }
  return parsed;
}

function summarise(report: SendPushRemindersReport): void {
  console.log('');
  console.log(`accounts with a subscription   ${report.usersWithSubscriptions}`);
  // "considered", not "reached": this is the count at load time, before any 410 pruning. The
  // per-account `devices` figure below is the count still live when the run finished, so after a
  // prune the two legitimately disagree.
  console.log(`devices considered             ${report.subscriptions}`);
  console.log(`notifications sent             ${report.notificationsSent}`);
  console.log(`notifications failed           ${report.notificationsFailed}`);
  console.log(`endpoints pruned (404/410)     ${report.endpointsPruned}`);

  if (report.perUser.length > 0) {
    console.log('');
    console.log('per account:');
    for (const row of report.perUser) {
      const bits = [
        `devices ${row.devices}`,
        `due ${row.due}`,
        `already ${row.alreadyLogged}`,
        `claimed ${row.claimed}`,
        row.deferred ? `deferred ${row.deferred}` : null,
        row.raced ? `raced ${row.raced}` : null,
        `delivered ${row.delivered}`,
        row.deviceFailures ? `device-fail ${row.deviceFailures}` : null,
        row.pruned ? `pruned ${row.pruned}` : null,
        `today ${row.pushesSentToday}`,
      ]
        .filter(Boolean)
        .join(' · ');
      // The address is printed because this is an operator tool run against their own data, and
      // "which account did nothing happen for" is the first question every time.
      console.log(`  ${row.outcome.padEnd(16)} ${row.email.padEnd(32)} ${bits}`);
      if (row.error) console.log(`                   ↳ ${row.error}`);
    }
  }

  /*
   * The state that looks like a bug and is not. Consent for push is the EXISTENCE of a
   * `PushSubscription` row — a click plus an OS permission grant — so before anybody has visited
   * Settings and turned notifications on, there is nothing to send and nothing is wrong. Say so
   * plainly, or the first person to run this concludes the sender is broken.
   */
  if (report.usersWithSubscriptions === 0) {
    console.log('');
    console.log(
      'ℹ️  No account has a push subscription yet, so there is nobody to notify. That is not a ' +
        'misconfiguration: for push, consent IS the subscription row, which only exists after ' +
        'somebody opens Settings, taps the notifications toggle and grants the browser permission. ' +
        '`preferences.remindersEnabled` deliberately has no bearing on this channel — see the header ' +
        'of lib/notifications/reminder-policy.ts.'
    );
  }
}

async function main() {
  const dryRun = flag('dry') || flag('dry-run');

  console.log('='.repeat(62));
  console.log(
    `PulseBLR Push Reminders${dryRun ? ' — DRY RUN, nothing will be written or sent' : ''}`
  );
  console.log('='.repeat(62));

  try {
    const report = await sendPushReminders({
      dryRun,
      leadHours: numeric('lead'),
      maxPushesPerDay: numeric('max-per-day'),
      maxEventsPerRun: numeric('max-per-run'),
      retryFailed: flag('retry-failed'),
      onlyEmail: value('only'),
    });

    if (report.notConfigured.length > 0) {
      // Skip, not fail. See the header.
      console.log('');
      console.log(
        `ℹ️  Push is not configured (${report.notConfigured.join(', ')} unset) — skipping, nothing sent.`
      );
      console.log('   Mint a key pair with: npx tsx scripts/generate-vapid-keys.ts');
      console.log(
        '   VAPID_SUBJECT is required by RFC 8292 and is not decorative: Mozilla rejects a JWT with ' +
          'no `sub` claim, so without it Firefox users silently get nothing while Chrome works.'
      );
      process.exit(0);
    }

    summarise(report);

    if (report.notificationsFailed > 0) {
      console.log('');
      console.log(
        `❌ ${report.notificationsFailed} notification(s) failed. Their ReminderLog rows are marked ` +
          "'failed' and are NOT retried automatically — a failure reported by this side does not " +
          'prove the message was undelivered, and re-sending on a false negative is the duplicate ' +
          'this design refuses (and the fastest way to have a notification permission revoked). Run ' +
          'with --retry-failed once you have decided.'
      );
      process.exit(1);
    }

    console.log('');
    console.log(dryRun ? '✅ Dry run complete.' : '✅ Push reminder run complete.');
    process.exit(0);
  } catch (error) {
    console.error('');
    console.error('❌ Fatal error sending push reminders:');
    console.error(error);
    process.exit(1);
  }
}

main();
