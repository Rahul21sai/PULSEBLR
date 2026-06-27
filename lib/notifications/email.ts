import { Resend } from 'resend';
import { generateDailyDigest, formatDigestAsText, formatDigestAsHTML } from './digest';

const resend = new Resend(process.env.RESEND_API_KEY);

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

    // Check if there's anything to send
    const hasContent =
      digest.newEvents.length > 0 ||
      digest.upcomingDeadlines.length > 0 ||
      digest.trackerUpdates.length > 0 ||
      digest.followUpReminders.length > 0;

    if (!hasContent) {
      console.log('📭 No updates to send today');
      return true;
    }

    const htmlContent = formatDigestAsHTML(digest);
    const textContent = formatDigestAsText(digest);

    const { data, error } = await resend.emails.send({
      from: config.from || 'PulseBLR <digest@pulseblr.app>',
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
  } catch (error: any) {
    console.error('❌ Failed to send daily digest:', error.message);
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
    const { data, error } = await resend.emails.send({
      from: config.from || 'PulseBLR <notifications@pulseblr.app>',
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
  } catch (error: any) {
    console.error('❌ Failed to send notification:', error.message);
    return false;
  }
}

// Made with Bob