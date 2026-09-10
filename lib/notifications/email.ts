import { Resend } from 'resend';
import { generateDailyDigest, formatDigestAsText, formatDigestAsHTML } from './digest';

// Lazily construct the Resend client. The constructor throws "Missing API key"
// when RESEND_API_KEY is unset — instantiating at module load would crash the
// production build's page-data collection for any route that imports this file.
// RESEND_API_KEY is optional by design (email degrades gracefully), so defer
// construction until a send actually happens (guarded by the key checks below).
let resendClient: Resend | null = null;
function getResend(): Resend {
  if (!resendClient) {
    resendClient = new Resend(process.env.RESEND_API_KEY);
  }
  return resendClient;
}

export interface EmailConfig {
  to: string;
  /**
   * Whose tracker data the personal half of the digest is built from. Required,
   * because generateDailyDigest without a user id used to return EVERY user's
   * tracked events, contacts and private notes.
   */
  userId: string;
  from?: string;
}

/**
 * Send daily digest email
 */
export async function sendDailyDigestEmail(config: EmailConfig): Promise<boolean> {
  if (!process.env.RESEND_API_KEY) {
    console.warn('⚠️  RESEND_API_KEY not set, skipping email');
    return false;
  }

  try {
    console.log('📧 Generating daily digest...');
    const digest = await generateDailyDigest(config.userId);

    // Check if there's anything to send. A source-health problem alone is worth
    // an email — it means the event feed is silently breaking.
    const hasContent =
      digest.newEvents.length > 0 ||
      digest.upcomingDeadlines.length > 0 ||
      digest.trackerUpdates.length > 0 ||
      digest.followUpReminders.length > 0 ||
      digest.unhealthySources.length > 0;

    if (!hasContent) {
      console.log('📭 No updates to send today');
      return true;
    }

    const htmlContent = formatDigestAsHTML(digest);
    const textContent = formatDigestAsText(digest);

    const { data, error } = await getResend().emails.send({
      from: config.from || process.env.EMAIL_FROM || 'PulseBLR <onboarding@resend.dev>',
      to: config.to,
      subject: `🎯 PulseBLR Daily Digest - ${new Date().toLocaleDateString('en-IN', { month: 'short', day: 'numeric' })}`,
      html: htmlContent,
      text: textContent,
    });

    if (error) {
      console.error('❌ Email send error:', error);
      return false;
    }

    console.log('✅ Daily digest email sent:', data?.id);
    return true;
  } catch (error) {
    console.error('Failed to send daily digest:', error instanceof Error ? error.message : error);
    return false;
  }
}

/**
 * Send custom notification email
 */
export async function sendNotificationEmail(
  config: EmailConfig,
  subject: string,
  html: string,
  text?: string
): Promise<boolean> {
  if (!process.env.RESEND_API_KEY) {
    console.warn('⚠️  RESEND_API_KEY not set, skipping email');
    return false;
  }

  try {
    const { data, error } = await getResend().emails.send({
      from: config.from || process.env.EMAIL_FROM || 'PulseBLR <onboarding@resend.dev>',
      to: config.to,
      subject,
      html,
      text: text || html.replace(/<[^>]*>/g, ''), // Strip HTML tags for text version
    });

    if (error) {
      console.error('❌ Email send error:', error);
      return false;
    }

    console.log('✅ Notification email sent:', data?.id);
    return true;
  } catch (error) {
    console.error('Failed to send notification:', error instanceof Error ? error.message : error);
    return false;
  }
}

/**
 * The outcome of one reminder send.
 *
 * A BOOLEAN IS NOT ENOUGH HERE, unlike the two senders above, and that is why this is a separate
 * function rather than a call to `sendNotificationEmail`. The reminder sender has to write the
 * provider's message id into `ReminderLog` — it is the only handle on a delivered message — and
 * it has to tell "Resend refused this" apart from "Resend is not configured", because those two
 * mean opposite things to the caller: one is a failure to record against a claimed row, the other
 * means no row should ever have been claimed.
 */
export interface ReminderSendResult {
  ok: boolean;
  /** Resend's message id, on success. */
  id?: string;
  /** Set on failure. Safe to store; never shown to a user. */
  error?: string;
  /** True when RESEND_API_KEY is unset — nothing was attempted and nothing failed. */
  notConfigured?: boolean;
}

/**
 * Send one reminder email.
 *
 * TWO UNSUBSCRIBE MECHANISMS, both required, and they are not redundant:
 *
 *   · `List-Unsubscribe` + `List-Unsubscribe-Post` (RFC 8058) put the native "Unsubscribe"
 *     control in Gmail's and Apple Mail's own chrome. That is the one a reader annoyed enough to
 *     complain actually reaches for, and mailbox providers weigh its presence when deciding
 *     whether this domain is sending wanted mail. `One-Click` means the provider POSTs the URL
 *     itself, with no page load — which is why the route below accepts POST and reads its
 *     parameters from the QUERY STRING rather than the body.
 *   · the visible link in the footer, for every client that has neither.
 *
 * The brief's requirement is "an unsubscribe link in every email, working without a login", so
 * the visible link is the non-negotiable half; the headers are what make it work the way a
 * reader expects.
 */
export async function sendReminderEmail(input: {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Absolute, and must resolve with no session. See `buildUnsubscribeUrl`. */
  unsubscribeUrl: string;
  from?: string;
}): Promise<ReminderSendResult> {
  if (!process.env.RESEND_API_KEY) {
    // Not an error. The caller checks this BEFORE claiming any ReminderLog row, so an
    // unconfigured environment must never look like a failed send.
    return { ok: false, notConfigured: true, error: 'RESEND_API_KEY is not set' };
  }

  try {
    const { data, error } = await getResend().emails.send({
      from: input.from || process.env.EMAIL_FROM || 'PulseBLR <onboarding@resend.dev>',
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
      headers: {
        'List-Unsubscribe': `<${input.unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });

    if (error) {
      return { ok: false, error: String(error.message ?? error).slice(0, 500) };
    }
    return { ok: true, id: data?.id };
  } catch (error) {
    return {
      ok: false,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
    };
  }
}

// Made with Bob