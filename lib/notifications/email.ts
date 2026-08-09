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
    const digest = await generateDailyDigest();

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

// Made with Bob