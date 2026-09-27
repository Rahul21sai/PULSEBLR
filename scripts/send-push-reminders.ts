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
 *   npx tsx scripts/send-push-reminders.ts --no-followups       # reminders only
 *   npx tsx scripts/send-push-reminders.ts --max-nudges=1        # follow-up nudges per account per run
 *
 * TWO PASSES, ONE PROCESS. First the saved-event reminders; then the MORNING-AFTER FOLLOW-UP NUDGE
 * (`lib/notifications/followup-nudge.ts`): "You met 4 people at GIDS. Draft follow-ups?" for an event
 * that ended yesterday with people still to follow up. A second pass here rather than a second
 * workflow, because it needs exactly the same four secrets, the same preflight and the same 09:00 IST
 * slot, and because the two share one daily budget per phone (`PUSH_CHANNEL_KINDS`) — running the
 * reminders first in the same process is what lets them spend it first. A failure or crash in one
 * pass does not stop the other; either failing exits 1.
 *
 * `--max-per-day` is the shared phone budget and applies to both passes; `--max-per-run` and `--lead`
 * are the reminder pass's; `--max-nudges` is the follow-up pass's. `--only`, `--dry` and
 * `--retry-failed` apply to both.
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
import {
  sendFollowUpNudges,
  type SendFollowUpNudgesReport,
} from '../lib/notifications/followup-nudge';
import { toLogLine } from '../lib/security/control-chars';

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
      //
      // BOTH STRINGS GO THROUGH `toLogLine` AT PRINT TIME, although `sendToDevice` already sanitises
      // every `error` it produces. `row.error` can hold a push service's response body, and the
      // endpoint that answered is a URL any signed-in user registered, so it may be the attacker's
      // own server (CWE-117). Printed raw, a CR/LF forged report lines, ESC drove this terminal, and
      // `::` or `##[` became a workflow command if this ever runs in Actions. Sanitising where the
      // text is BORN only holds while every writer remembers to do it. This is the last point
      // before a terminal, so it holds regardless. 500 and 254 are the `ReminderLog.error` cap and
      // the longest valid address, so neither cuts a legitimate value.
      const email = toLogLine(row.email, 254);
      console.log(`  ${row.outcome.padEnd(16)} ${email.padEnd(32)} ${bits}`);
      if (row.error) console.log(`                   ↳ ${toLogLine(row.error, 500)}`);
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

/**
 * The follow-up pass's report. Its labels deliberately do NOT begin "accounts with a subscription":
 * the workflow preflight reads the FIRST line with that label to count subscribers, and a second
 * matching line would be a second number for one question.
 */
function summariseNudges(report: SendFollowUpNudgesReport): void {
  console.log('');
  console.log('── Morning-after follow-up nudges ──');
  console.log(`follow-up accounts considered  ${report.usersWithSubscriptions}`);
  console.log(`follow-up opted out            ${report.optedOut}`);
  console.log(`follow-up nudges sent          ${report.notificationsSent}`);
  console.log(`follow-up nudges failed        ${report.notificationsFailed}`);
  console.log(`follow-up endpoints pruned     ${report.endpointsPruned}`);

  const active = report.perUser.filter(row => row.outcome !== 'nothing-due' || row.candidates > 0);
  if (active.length === 0) return;
  console.log('');
  console.log('follow-ups per account:');
  for (const row of active) {
    const bits = [
      `devices ${row.devices}`,
      `candidates ${row.candidates}`,
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
    const email = toLogLine(row.email, 254);
    console.log(`  ${row.outcome.padEnd(16)} ${email.padEnd(32)} ${bits}`);
    // A folder name is text the user typed, so it is sanitised like every other printed string.
    for (const nudge of row.nudges) {
      console.log(
        `                   · ${toLogLine(nudge.title, 80)} — met ${nudge.metCount}, to do ${nudge.pendingCount}`
      );
    }
    if (row.error) console.log(`                   ↳ ${toLogLine(row.error, 500)}`);
  }
}

async function main() {
  const dryRun = flag('dry') || flag('dry-run');

  console.log('='.repeat(62));
  console.log(
    `PulseBLR Push Reminders${dryRun ? ' — DRY RUN, nothing will be written or sent' : ''}`
  );
  console.log('='.repeat(62));

  /*
   * The follow-up pass, run after the reminder pass has reported. Its own try, so a crash in one pass
   * is reported without hiding the other's result. Returns the number of failed notifications, or -1
   * for a crash.
   */
  async function followUpPass(): Promise<number> {
    if (flag('no-followups')) return 0;
    try {
      const nudges = await sendFollowUpNudges({
        dryRun,
        maxPushesPerDay: numeric('max-per-day'),
        maxNudgesPerRun: numeric('max-nudges'),
        retryFailed: flag('retry-failed'),
        onlyEmail: value('only'),
      });
      summariseNudges(nudges);
      return nudges.notificationsFailed;
    } catch (error) {
      console.error('');
      console.error('❌ Fatal error sending follow-up nudges:');
      console.error(error);
      return -1;
    }
  }

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

    const nudgeFailures = await followUpPass();

    if (report.notificationsFailed > 0 || nudgeFailures !== 0) {
      const failed = report.notificationsFailed + Math.max(0, nudgeFailures);
      console.log('');
      console.log(
        (failed > 0
          ? `❌ ${failed} notification(s) failed${nudgeFailures < 0 ? ', and the follow-up pass crashed (above)' : ''}. Their ReminderLog rows are marked 'failed' `
          : "❌ The follow-up pass crashed (above). Any row it claimed stays 'pending' ") +
          'and is NOT retried automatically — a failure reported by this side does not ' +
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
    // The reminder pass crashed; the follow-up pass is independent and still gets its morning.
    await followUpPass();
    process.exit(1);
  }
}

main();
