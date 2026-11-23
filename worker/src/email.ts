import { Resend } from 'resend';
import type { WorkerStorage } from './storage';
import {
  welcomeEmail, signupCodeEmail, passwordResetEmail, verificationCodeEmail, friendRequestEmail,
  friendAcceptedEmail, territoryStolenEmail, reportEmail, testEmail, sampleEmail, type SampleKind, type EmailContent, type TemplateContext,
} from './emailTemplates';

// gmail: the Gmail account's SMTP server with an app password (free, no own domain needed)
type EmailProvider = 'resend' | 'sendgrid' | 'gmail';

// Public URL of the Worker: email buttons open its /open landing page, which launches the iOS app
// (email clients don't reliably open custom URL schemes such as runnaio://).
export const DEFAULT_WORKER_URL = 'https://api.kaemedos.workers.dev';

/** Support address: Reply-To of every email and the footer's "Soporte". */
export const SUPPORT_EMAIL = 'kaeme2.support@gmail.com';

/** Signature of a one-click unsubscribe link (HMAC-SHA256 of the user id with the admin secret). */
export async function unsubscribeToken(secret: string, userId: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`email-unsubscribe:${userId}`));
  let binary = '';
  for (const byte of new Uint8Array(signature)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function isValidUnsubscribeToken(secret: string, userId: string, token: string): Promise<boolean> {
  if (!secret || !userId || !token) return false;
  const expected = await unsubscribeToken(secret, userId);
  if (expected.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

interface SendOptions {
  /** One-click unsubscribe (List-Unsubscribe + List-Unsubscribe-Post); not for account emails */
  unsubscribeUrl?: string;
}

export class EmailService {
  private resend?: Resend;
  private provider: EmailProvider = 'resend';
  private apiKey: string;
  private fromEmail = 'onboarding@resend.dev';
  private fromName = 'KM2';
  private baseUrl: string;
  private unsubscribeSecret?: string;

  constructor(apiKey: string, fromEmail?: string, provider?: EmailProvider, baseUrl?: string, unsubscribeSecret?: string) {
    this.apiKey = apiKey;
    this.baseUrl = (baseUrl || DEFAULT_WORKER_URL).replace(/\/+$/, '');
    this.provider = provider || 'resend';
    this.unsubscribeSecret = unsubscribeSecret?.trim() || undefined;
    if (this.provider === 'resend') {
      this.resend = new Resend(apiKey);
    }
    if (fromEmail && fromEmail.trim().length > 0) {
      this.fromEmail = fromEmail.trim();
    }
  }

  private get context(): TemplateContext {
    return { baseUrl: this.baseUrl, supportEmail: SUPPORT_EMAIL };
  }

  /** Link that stops the non-account emails of a user (null without a user or a secret). */
  async unsubscribeUrl(userId?: string | null): Promise<string | undefined> {
    if (!userId || !this.unsubscribeSecret) return undefined;
    const token = await unsubscribeToken(this.unsubscribeSecret, userId);
    return `${this.baseUrl}/email/unsubscribe?u=${encodeURIComponent(userId)}&t=${token}`;
  }

  /** Extra headers: who to reply to and, for non-account emails, how to unsubscribe. */
  private headers(options: SendOptions): Record<string, string> {
    const headers: Record<string, string> = {};
    if (options.unsubscribeUrl) {
      headers['List-Unsubscribe'] = `<${options.unsubscribeUrl}>, <mailto:${SUPPORT_EMAIL}?subject=Baja>`;
      headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
    }
    return headers;
  }

  private async send(to: string, content: EmailContent, options: SendOptions = {}): Promise<void> {
    const headers = this.headers(options);
    if (this.provider === 'gmail') {
      // Loaded only here: it needs Cloudflare's sockets (and the tests import this module in Node)
      const { sendSmtp } = await import('./smtp');
      await sendSmtp({
        host: 'smtp.gmail.com',
        port: 465,
        username: this.fromEmail,
        // Google shows app passwords in groups of four letters
        password: this.apiKey.replace(/\s+/g, ''),
        fromEmail: this.fromEmail,
        fromName: this.fromName,
        replyTo: SUPPORT_EMAIL,
        to,
        subject: content.subject,
        html: content.html,
        text: content.text,
        headers,
      });
      return;
    }

    if (this.provider === 'sendgrid') {
      const payload = {
        personalizations: [{ to: [{ email: to }] }],
        from: { email: this.fromEmail, name: this.fromName },
        reply_to: { email: SUPPORT_EMAIL },
        subject: content.subject,
        // text/plain must come first
        content: [
          { type: 'text/plain', value: content.text },
          { type: 'text/html', value: content.html },
        ],
        ...(Object.keys(headers).length ? { headers } : {}),
      };
      const resp = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        const text = await resp.text();
        console.error('[EMAIL] SendGrid send failed:', resp.status, text);
        throw new Error(`SendGrid error ${resp.status}`);
      }
      return;
    }

    // Default to Resend. The SDK doesn't throw on API errors: it returns them in `error`.
    if (!this.resend) throw new Error('Resend client not initialized');
    const { error } = await this.resend.emails.send({
      from: `${this.fromName} <${this.fromEmail}>`,
      to,
      replyTo: SUPPORT_EMAIL,
      subject: content.subject,
      html: content.html,
      text: content.text,
      ...(Object.keys(headers).length ? { headers } : {}),
    });
    if (error) {
      console.error('[EMAIL] Resend send failed:', error.name, error.message);
      throw new Error(`Resend error: ${error.message}`);
    }
  }

  /** One of the emails with sample data, to see it in an inbox (admin panel → Correos). Throws on errors. */
  async sendSample(to: string, kind: SampleKind): Promise<void> {
    const content = sampleEmail(this.context, kind, await this.unsubscribeUrl('sample'));
    await this.send(to, { ...content, subject: `[Prueba] ${content.subject}` });
  }

  /** Sends a test email; throws with the provider's error. Used by the admin email test. */
  async sendTestEmail(to: string): Promise<void> {
    await this.send(to, testEmail(this.context));
  }

  /** Tells the app owner that someone reported a user or their content (App Store guideline 1.2). */
  async sendReportNotification(
    to: string,
    report: { reporter: string; reported: string; targetType: string; targetId: string; reason: string },
  ): Promise<void> {
    await this.send(to, reportEmail(this.context, report));
  }

  async sendFriendRequestEmail(recipientEmail: string, senderName: string, senderUsername: string, recipientUserId?: string): Promise<void> {
    try {
      const unsubscribeUrl = await this.unsubscribeUrl(recipientUserId);
      await this.send(recipientEmail, friendRequestEmail(this.context, senderName, senderUsername, unsubscribeUrl), { unsubscribeUrl });
      console.log('[EMAIL] Friend request sent to', recipientEmail);
    } catch (error) {
      console.error('[EMAIL] Failed to send friend request email:', error);
    }
  }

  async sendFriendAcceptedEmail(recipientEmail: string, acceptorName: string, acceptorUsername: string, recipientUserId?: string): Promise<void> {
    try {
      const unsubscribeUrl = await this.unsubscribeUrl(recipientUserId);
      await this.send(recipientEmail, friendAcceptedEmail(this.context, acceptorName, acceptorUsername, unsubscribeUrl), { unsubscribeUrl });
      console.log('[EMAIL] Friend accepted sent to', recipientEmail);
    } catch (error) {
      console.error('[EMAIL] Failed to send friend accepted email:', error);
    }
  }

  async sendTerritoryConqueredEmail(recipientEmail: string, conquererName: string, conquererUsername: string, areaStolen: number, recipientUserId?: string): Promise<void> {
    try {
      const unsubscribeUrl = await this.unsubscribeUrl(recipientUserId);
      await this.send(recipientEmail, territoryStolenEmail(this.context, conquererName, conquererUsername, areaStolen, unsubscribeUrl), { unsubscribeUrl });
      console.log('[EMAIL] Territory conquered sent to', recipientEmail);
    } catch (error) {
      console.error('[EMAIL] Failed to send territory conquered email:', error);
    }
  }

  async sendWelcomeEmail(recipientEmail: string, recipientName: string, recipientUserId?: string): Promise<void> {
    try {
      const unsubscribeUrl = await this.unsubscribeUrl(recipientUserId);
      await this.send(recipientEmail, welcomeEmail(this.context, recipientName, unsubscribeUrl), { unsubscribeUrl });
      console.log('[EMAIL] Welcome sent to', recipientEmail);
    } catch (error) {
      console.error('[EMAIL] Failed to send welcome email:', (error as any)?.message ?? error);
    }
  }

  async recordNotification(
    storage: WorkerStorage,
    userId: string,
    notificationType: 'friend_request' | 'friend_accepted' | 'territory_conquered',
    relatedUserId: string | null,
    subject: string,
    body: string,
    areaStolen?: number
  ): Promise<void> {
    try {
      await storage.recordEmailNotification({
        userId,
        notificationType,
        relatedUserId,
        subject,
        body,
        areaStolen,
      });
    } catch (error) {
      console.error('[EMAIL] Failed to record notification:', error);
    }
  }

  async sendVerificationCode(recipientEmail: string, recipientName: string, code: string): Promise<boolean> {
    try {
      await this.send(recipientEmail, verificationCodeEmail(this.context, recipientName, code));
      console.log('[EMAIL] Verification code sent to', recipientEmail);
      return true;
    } catch (error) {
      console.error('[EMAIL] Failed to send verification code:', error);
      return false;
    }
  }

  /** Sends the 6-digit code that lets the user choose a new password. Throws when it can't be sent. */
  async sendPasswordResetCode(recipientEmail: string, recipientName: string, code: string): Promise<void> {
    await this.send(recipientEmail, passwordResetEmail(this.context, recipientName, code, PASSWORD_RESET_CODE_MINUTES));
    console.log('[EMAIL] Password reset code sent to', recipientEmail);
  }

  /** Sends the 6-digit code that confirms the email of a new account. Throws when it can't be sent. */
  async sendSignupCode(recipientEmail: string, recipientName: string, code: string): Promise<void> {
    await this.send(recipientEmail, signupCodeEmail(this.context, recipientName, code, SIGNUP_CODE_MINUTES));
    console.log('[EMAIL] Sign-up code sent to', recipientEmail);
  }
}

export const PASSWORD_RESET_CODE_MINUTES = 15;
export const SIGNUP_CODE_MINUTES = 15;

interface EmailEnv {
  /** Signs the one-click unsubscribe links */
  UPSTASH_CRON_SECRET?: string;
  EMAIL_PROVIDER?: string;
  GMAIL_USER?: string;
  GMAIL_APP_PASSWORD?: string;
  SENDGRID_API_KEY?: string;
  SENDGRID_FROM?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
}

/** Which provider the Worker uses and how it is configured (no secret values). */
export function emailConfig(env: EmailEnv) {
  const requested = env.EMAIL_PROVIDER
    || (env.GMAIL_APP_PASSWORD ? 'gmail' : env.SENDGRID_API_KEY ? 'sendgrid' : 'resend');
  const provider: EmailProvider = requested === 'gmail' || requested === 'sendgrid' ? requested : 'resend';
  const problems: string[] = [];

  if (provider === 'gmail') {
    const from = env.GMAIL_USER?.trim() || '';
    if (!from) problems.push('Falta la variable GMAIL_USER (la dirección de Gmail que envía).');
    if (!env.GMAIL_APP_PASSWORD) problems.push('Falta el secreto GMAIL_APP_PASSWORD (contraseña de aplicación de esa cuenta de Google).');
    return { provider, apiKey: env.GMAIL_APP_PASSWORD, from, problems };
  }

  const apiKey = provider === 'sendgrid' ? env.SENDGRID_API_KEY : env.RESEND_API_KEY;
  const from = (provider === 'sendgrid' ? (env.SENDGRID_FROM || env.RESEND_FROM) : env.RESEND_FROM) || 'onboarding@resend.dev';
  if (!apiKey) {
    problems.push(`Falta el secreto ${provider === 'sendgrid' ? 'SENDGRID_API_KEY' : 'RESEND_API_KEY'}.`);
  }
  if (/@(gmail|googlemail|hotmail|outlook|live|yahoo|icloud|me)\./i.test(from)) {
    problems.push(`El remitente ${from} es de un proveedor gratuito: Gmail, Outlook y Yahoo rechazan o mandan a spam los emails enviados en su nombre desde ${provider === 'sendgrid' ? 'SendGrid' : 'Resend'} (DMARC). Usa un remitente de un dominio propio verificado.`);
  }
  if (provider === 'resend' && /@resend\.dev$/i.test(from)) {
    problems.push('El remitente onboarding@resend.dev solo puede enviar al email de tu cuenta de Resend. Verifica un dominio propio en Resend y ponlo en RESEND_FROM.');
  }
  return { provider, apiKey, from, problems };
}

/** Email service built from the Worker's variables and secrets. */
export function emailServiceFromEnv(env: EmailEnv, baseUrl?: string): EmailService {
  const { provider, apiKey, from } = emailConfig(env);
  return new EmailService(apiKey || '', from, provider, baseUrl, env.UPSTASH_CRON_SECRET);
}
