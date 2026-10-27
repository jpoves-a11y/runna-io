import { Resend } from 'resend';
import type { WorkerStorage } from './storage';
import { sendSmtp } from './smtp';

// gmail: the Gmail account's SMTP server with an app password (free, no own domain needed)
type EmailProvider = 'resend' | 'sendgrid' | 'gmail';

// Public URL of the Worker: email buttons open its /open landing page, which launches the iOS app
// (email clients don't reliably open custom URL schemes such as runnaio://).
export const DEFAULT_WORKER_URL = 'https://runna-io-api.runna-io-api.workers.dev';

export class EmailService {
  private resend?: Resend;
  private provider: EmailProvider = 'resend';
  private apiKey: string;
  private fromEmail = 'onboarding@resend.dev';
  private fromName = 'Runna.io';
  private baseUrl: string;

  constructor(apiKey: string, fromEmail?: string, provider?: EmailProvider, baseUrl?: string) {
    this.apiKey = apiKey;
    this.baseUrl = (baseUrl || DEFAULT_WORKER_URL).replace(/\/+$/, '');
    this.provider = provider || 'resend';
    if (this.provider === 'resend') {
      this.resend = new Resend(apiKey);
    }
    if (fromEmail && fromEmail.trim().length > 0) {
      this.fromEmail = fromEmail.trim();
    }
  }

  private async send(to: string, subject: string, html: string): Promise<void> {
    if (this.provider === 'gmail') {
      await sendSmtp({
        host: 'smtp.gmail.com',
        port: 465,
        username: this.fromEmail,
        // Google shows app passwords in groups of four letters
        password: this.apiKey.replace(/\s+/g, ''),
        fromEmail: this.fromEmail,
        fromName: this.fromName,
        to,
        subject,
        html,
      });
      return;
    }

    if (this.provider === 'sendgrid') {
      const payload = {
        personalizations: [
          {
            to: [{ email: to }],
          },
        ],
        from: { email: this.fromEmail, name: this.fromName },
        subject,
        content: [{ type: 'text/html', value: html }],
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
      subject,
      html,
    });
    if (error) {
      console.error('[EMAIL] Resend send failed:', error.name, error.message);
      throw new Error(`Resend error: ${error.message}`);
    }
  }

  /** Sends a plain message; throws with the provider's error. Used by the admin email test. */
  async sendTestEmail(to: string): Promise<void> {
    await this.send(
      to,
      'Prueba de email de Runna.io',
      `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; padding: 20px;">
        <p>Si lees esto, el servidor de Runna.io puede enviar emails.</p>
      </div>`,
    );
  }

  /** Tells the app owner that someone reported a user or their content (App Store guideline 1.2). */
  async sendReportNotification(
    to: string,
    report: { reporter: string; reported: string; targetType: string; targetId: string; reason: string },
  ): Promise<void> {
    const esc = (value: string) =>
      value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
    await this.send(
      to,
      `🚩 Nueva denuncia en Runna.io (${report.targetType})`,
      `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2 style="margin-top: 0;">🚩 Nueva denuncia</h2>
          <p>Revísala en menos de 24 horas (lo prometen los términos de la app).</p>
          <table style="border-collapse: collapse; width: 100%;">
            <tr><td style="padding: 6px; font-weight: bold;">Denunciante</td><td style="padding: 6px;">${esc(report.reporter)}</td></tr>
            <tr><td style="padding: 6px; font-weight: bold;">Denunciado</td><td style="padding: 6px;">${esc(report.reported)}</td></tr>
            <tr><td style="padding: 6px; font-weight: bold;">Tipo</td><td style="padding: 6px;">${esc(report.targetType)}</td></tr>
            <tr><td style="padding: 6px; font-weight: bold;">ID del contenido</td><td style="padding: 6px;">${esc(report.targetId)}</td></tr>
            <tr><td style="padding: 6px; font-weight: bold;">Motivo</td><td style="padding: 6px;">${esc(report.reason)}</td></tr>
          </table>
          <p style="color: #666; font-size: 13px;">Las denuncias se guardan en la tabla <code>reports</code> de la base de datos.</p>
        </div>
      `,
    );
  }

  async sendFriendRequestEmail(
    recipientEmail: string,
    senderName: string,
    senderUsername: string
  ): Promise<void> {
    try {
      await this.send(
        recipientEmail,
        `¡${senderName} te envió una solicitud de amistad en Runna.io!`,
        `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <div style="text-align: center; margin-bottom: 30px;">
              <h1 style="color: #1a1a1a; margin: 0;">🤝 Nueva Solicitud de Amistad</h1>
            </div>
            
            <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
              <p style="font-size: 16px; color: #555; margin: 0;">
                <strong>${senderName}</strong> (@${senderUsername}) te ha enviado una solicitud de amistad en Runna.io.
              </p>
            </div>

            <div style="text-align: center; margin: 30px 0;">
              <a href="${this.baseUrl}/open?tab=friends" style="display: inline-block; background: #3b82f6; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">
                Ver solicitud
              </a>
            </div>

            <p style="color: #999; font-size: 12px; text-align: center; margin-top: 30px;">
              © 2026 Runna.io. Todos los derechos reservados.
            </p>
          </div>
        `
      );
      console.log('[EMAIL] Friend request sent to', recipientEmail);
    } catch (error) {
      console.error('[EMAIL] Failed to send friend request email:', error);
    }
  }

  async sendFriendAcceptedEmail(
    recipientEmail: string,
    acceptorName: string,
    acceptorUsername: string
  ): Promise<void> {
    try {
      await this.send(
        recipientEmail,
        `¡${acceptorName} aceptó tu solicitud de amistad!`,
        `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <div style="text-align: center; margin-bottom: 30px;">
              <h1 style="color: #1a1a1a; margin: 0;">✅ ¡Amistad Aceptada!</h1>
            </div>
            
            <div style="background: #f0fdf4; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
              <p style="font-size: 16px; color: #555; margin: 0;">
                <strong>${acceptorName}</strong> (@${acceptorUsername}) aceptó tu solicitud de amistad. ¡Ahora son amigos en Runna.io!
              </p>
            </div>

            <div style="text-align: center; margin: 30px 0;">
              <a href="${this.baseUrl}/open?tab=friends" style="display: inline-block; background: #3b82f6; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">
                Ir a Runna.io
              </a>
            </div>

            <p style="color: #999; font-size: 12px; text-align: center; margin-top: 30px;">
              © 2026 Runna.io. Todos los derechos reservados.
            </p>
          </div>
        `
      );
      console.log('[EMAIL] Friend accepted sent to', recipientEmail);
    } catch (error) {
      console.error('[EMAIL] Failed to send friend accepted email:', error);
    }
  }

  async sendTerritoryConqueredEmail(
    recipientEmail: string,
    conquererName: string,
    conquererUsername: string,
    areaStolen: number
  ): Promise<void> {
    const kmStolen = (areaStolen / 1000000).toFixed(2);
    try {
      await this.send(
        recipientEmail,
        `⚠️ ¡${conquererName} te conquistó ${kmStolen} km² en Runna.io!`,
        `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <div style="text-align: center; margin-bottom: 30px;">
              <h1 style="color: #dc2626; margin: 0;">⚔️ Territorio Conquistado</h1>
            </div>
            
            <div style="background: #fef2f2; border: 2px solid #fca5a5; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
              <p style="font-size: 16px; color: #555; margin: 0;">
                <strong>${conquererName}</strong> (@${conquererUsername}) ha conquistado <strong style="color: #dc2626;">${kmStolen} km²</strong> de tu territorio en Runna.io.
              </p>
            </div>

            <div style="background: #f3f4f6; padding: 15px; border-radius: 6px; margin-bottom: 20px;">
              <p style="color: #666; font-size: 14px; margin: 0;">
                Sigue registrando actividades para reconquistar tu territorio y expandir tu dominio.
              </p>
            </div>

            <div style="text-align: center; margin: 30px 0;">
              <a href="${this.baseUrl}/open?tab=map" style="display: inline-block; background: #3b82f6; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">
                Ver mapa
              </a>
            </div>

            <p style="color: #999; font-size: 12px; text-align: center; margin-top: 30px;">
              © 2026 Runna.io. Todos los derechos reservados.
            </p>
          </div>
        `
      );
      console.log('[EMAIL] Territory conquered sent to', recipientEmail);
    } catch (error) {
      console.error('[EMAIL] Failed to send territory conquered email:', error);
    }
  }

  async sendWelcomeEmail(
    recipientEmail: string,
    recipientName: string
  ): Promise<void> {
    try {
      await this.send(
        recipientEmail,
        'Bienvenido a Runna.io 🚀',
        `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; max-width: 640px; margin: 0 auto; padding: 24px;">
            <div style="text-align: center; margin-bottom: 28px;">
              <h1 style="color: #0f172a; margin: 0; font-size: 26px;">¡Bienvenido a Runna.io, ${recipientName}!</h1>
              <p style="color: #475569; margin: 8px 0 0; font-size: 15px;">Empieza a conquistar territorio mientras corres.</p>
            </div>

            <div style="background: linear-gradient(135deg, #ecfeff 0%, #e0f2fe 100%); padding: 18px 20px; border-radius: 12px; border: 1px solid #bae6fd; margin-bottom: 18px;">
              <p style="margin: 0; color: #0f172a; font-size: 15px; line-height: 1.5;">
                📍 Corre, registra tus rutas y conquista el mapa. Compite con amigos y defiende tu territorio.
              </p>
            </div>

            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-bottom: 22px;">
              <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 14px;">
                <p style="margin: 0; color: #0f172a; font-weight: 600;">1) Crea tu primera ruta</p>
                <p style="margin: 4px 0 0; color: #475569; font-size: 14px;">Activa el tracking y conquista tu primera zona.</p>
              </div>
              <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 14px;">
                <p style="margin: 0; color: #0f172a; font-weight: 600;">2) Invita amigos</p>
                <p style="margin: 4px 0 0; color: #475569; font-size: 14px;">Reta a tus amigos para ver quién domina la ciudad.</p>
              </div>
              <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 14px;">
                <p style="margin: 0; color: #0f172a; font-weight: 600;">3) Sube al ranking</p>
                <p style="margin: 4px 0 0; color: #475569; font-size: 14px;">Gana territorio y escala posiciones.</p>
              </div>
            </div>

            <div style="text-align: center; margin: 24px 0;">
              <a href="${this.baseUrl}/open" style="display: inline-block; background: #2563eb; color: white; padding: 14px 22px; border-radius: 10px; text-decoration: none; font-weight: 700; box-shadow: 0 10px 30px rgba(37, 99, 235, 0.25);">
                Abrir Runna.io
              </a>
            </div>

            <p style="color: #94a3b8; font-size: 12px; text-align: center; margin-top: 28px;">
              © 2026 Runna.io. Todo listo para conquistar el mapa.
            </p>
          </div>
        `
      );
      console.log('[EMAIL] Welcome sent to', recipientEmail);
    } catch (error) {
      // Log structured error to help debug Resend responses
      console.error('[EMAIL] Failed to send welcome email:', JSON.stringify({
        message: (error as any)?.message,
        status: (error as any)?.status,
        name: (error as any)?.name,
        stack: (error as any)?.stack,
      }, null, 2));
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

  async sendVerificationCode(
    recipientEmail: string,
    recipientName: string,
    code: string
  ): Promise<boolean> {
    try {
      await this.send(
        recipientEmail,
        `Tu código de verificación: ${code}`,
        `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <div style="text-align: center; margin-bottom: 30px;">
              <h1 style="color: #1a1a1a; margin: 0;">✨ Verifica tu cuenta</h1>
            </div>
            
            <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 20px; text-align: center;">
              <p style="font-size: 16px; color: #555; margin: 0 0 15px 0;">
                Hola <strong>${recipientName}</strong>, usa este código para verificar tu email:
              </p>
              <div style="background: #1a1a1a; color: white; font-size: 32px; font-weight: bold; letter-spacing: 8px; padding: 20px 30px; border-radius: 12px; display: inline-block;">
                ${code}
              </div>
              <p style="font-size: 14px; color: #888; margin: 15px 0 0 0;">
                El código expira en 10 minutos
              </p>
            </div>

            <p style="color: #666; font-size: 14px; text-align: center;">
              Si no solicitaste este código, ignora este email.
            </p>

            <p style="color: #999; font-size: 12px; text-align: center; margin-top: 30px;">
              © 2026 Runna.io. Todos los derechos reservados.
            </p>
          </div>
        `
      );
      console.log('[EMAIL] Verification code sent to', recipientEmail);
      return true;
    } catch (error) {
      console.error('[EMAIL] Failed to send verification code:', error);
      return false;
    }
  }

  /** Sends the 6-digit code that lets the user choose a new password. Throws when it can't be sent. */
  async sendPasswordResetCode(recipientEmail: string, recipientName: string, code: string): Promise<void> {
    const esc = (value: string) =>
      value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
    await this.send(
      recipientEmail,
      `Tu código para cambiar la contraseña: ${code}`,
      `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="text-align: center; margin-bottom: 30px;">
            <h1 style="color: #1a1a1a; margin: 0;">🔑 Cambia tu contraseña</h1>
          </div>

          <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 20px; text-align: center;">
            <p style="font-size: 16px; color: #555; margin: 0 0 15px 0;">
              Hola <strong>${esc(recipientName)}</strong>, escribe este código en la app para elegir una contraseña nueva:
            </p>
            <div style="background: #1a1a1a; color: white; font-size: 32px; font-weight: bold; letter-spacing: 8px; padding: 20px 30px; border-radius: 12px; display: inline-block;">
              ${code}
            </div>
            <p style="font-size: 14px; color: #888; margin: 15px 0 0 0;">
              El código expira en ${PASSWORD_RESET_CODE_MINUTES} minutos
            </p>
          </div>

          <p style="color: #666; font-size: 14px; text-align: center;">
            Si no has pedido cambiar la contraseña, ignora este email: tu contraseña sigue siendo la misma.
          </p>
        </div>
      `
    );
    console.log('[EMAIL] Password reset code sent to', recipientEmail);
  }
}

export const PASSWORD_RESET_CODE_MINUTES = 15;

interface EmailEnv {
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
  return new EmailService(apiKey || '', from, provider, baseUrl);
}
