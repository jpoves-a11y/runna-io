import { Resend } from 'resend';
import type { WorkerStorage } from './storage';
import type { Env } from './index';

type EmailProvider = 'resend' | 'sendgrid' | 'gmail';

/** OAuth client + refresh token of the Gmail account that sends the emails (scope gmail.send). */
export interface GmailCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

const GMAIL_FROM_DEFAULT = 'runna.io.service@gmail.com';

/** Picks the provider from env: EMAIL_PROVIDER, else Gmail / SendGrid / Resend, whichever has credentials. */
function emailProvider(env: Env): EmailProvider {
  if (env.EMAIL_PROVIDER) return env.EMAIL_PROVIDER;
  if (env.GMAIL_REFRESH_TOKEN) return 'gmail';
  return env.SENDGRID_API_KEY ? 'sendgrid' : 'resend';
}

/** True when the configured provider has its credentials (otherwise sends throw). */
export function isEmailConfigured(env: Env): boolean {
  switch (emailProvider(env)) {
    case 'gmail': return Boolean(env.GMAIL_CLIENT_ID && env.GMAIL_CLIENT_SECRET && env.GMAIL_REFRESH_TOKEN);
    case 'sendgrid': return Boolean(env.SENDGRID_API_KEY);
    case 'resend': return Boolean(env.RESEND_API_KEY);
  }
}

/** EmailService configured from the Worker environment. */
export function createEmailService(env: Env, baseUrl?: string): EmailService {
  const provider = emailProvider(env);
  if (provider === 'gmail') {
    return new EmailService('', env.GMAIL_FROM || GMAIL_FROM_DEFAULT, 'gmail', baseUrl, {
      clientId: env.GMAIL_CLIENT_ID || '',
      clientSecret: env.GMAIL_CLIENT_SECRET || '',
      refreshToken: env.GMAIL_REFRESH_TOKEN || '',
    });
  }
  if (provider === 'sendgrid') {
    return new EmailService(env.SENDGRID_API_KEY || '', env.SENDGRID_FROM || env.RESEND_FROM, 'sendgrid', baseUrl);
  }
  return new EmailService(env.RESEND_API_KEY || '', env.RESEND_FROM, 'resend', baseUrl);
}

// Gmail access tokens last 1 hour: reuse one per isolate until shortly before it expires
let gmailAccessToken: { value: string; expiresAt: number; refreshToken: string } | null = null;

async function getGmailAccessToken(credentials: GmailCredentials): Promise<string> {
  const now = Date.now();
  if (gmailAccessToken && gmailAccessToken.refreshToken === credentials.refreshToken && gmailAccessToken.expiresAt - 60_000 > now) {
    return gmailAccessToken.value;
  }
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      refresh_token: credentials.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    console.error('[EMAIL] Gmail token refresh failed:', resp.status, text);
    throw new Error(`Gmail token error ${resp.status}`);
  }
  const data = (await resp.json()) as { access_token: string; expires_in: number };
  gmailAccessToken = { value: data.access_token, expiresAt: now + data.expires_in * 1000, refreshToken: credentials.refreshToken };
  return data.access_token;
}

function base64Utf8(value: string): string {
  let binary = '';
  for (const b of new TextEncoder().encode(value)) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** RFC 2047 encoded header value (subjects and names with accents or emoji). */
function encodeHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${base64Utf8(value)}?=`;
}

/** MIME message for the Gmail API `raw` field (base64url). */
function buildGmailRaw(fromName: string, fromEmail: string, to: string, subject: string, html: string): string {
  const body = base64Utf8(html).replace(/.{76}/g, '$&\r\n');
  const message = [
    `From: ${encodeHeader(fromName)} <${fromEmail}>`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
  ].join('\r\n');
  return base64Utf8(message).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

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
  private gmail?: GmailCredentials;

  constructor(apiKey: string, fromEmail?: string, provider?: EmailProvider, baseUrl?: string, gmail?: GmailCredentials) {
    this.apiKey = apiKey;
    this.gmail = gmail;
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
      if (!this.gmail?.clientId || !this.gmail.clientSecret || !this.gmail.refreshToken) {
        throw new Error('Gmail credentials not configured');
      }
      const accessToken = await getGmailAccessToken(this.gmail);
      const resp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw: buildGmailRaw(this.fromName, this.fromEmail, to, subject, html) }),
      });
      if (!resp.ok) {
        const text = await resp.text();
        console.error('[EMAIL] Gmail send failed:', resp.status, text);
        throw new Error(`Gmail error ${resp.status}`);
      }
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

    // Default to Resend
    if (!this.resend) throw new Error('Resend client not initialized');
    await this.resend.emails.send({
      from: `${this.fromName} <${this.fromEmail}>`,
      to,
      subject,
      html,
    });
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
  /** "Forgot password" code. Throws if the email can't be sent. */
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
              El código expira en 15 minutos
            </p>
          </div>

          <p style="color: #666; font-size: 14px; text-align: center;">
            Si no has pedido cambiar la contraseña, ignora este email: tu contraseña actual sigue funcionando.
          </p>

          <p style="color: #999; font-size: 12px; text-align: center; margin-top: 30px;">
            © 2026 Runna.io. Todos los derechos reservados.
          </p>
        </div>
      `,
    );
    console.log('[EMAIL] Password reset code sent to', recipientEmail);
  }
}
