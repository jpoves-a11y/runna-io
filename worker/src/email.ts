import { Resend } from 'resend';
import type { WorkerStorage } from './storage';

type EmailProvider = 'resend' | 'sendgrid';

// URL base de la aplicación
const APP_URL = 'https://runna-io.pages.dev';

export class EmailService {
  private resend?: Resend;
  private provider: EmailProvider = 'resend';
  private apiKey: string;
  private fromEmail = 'onboarding@resend.dev';
  private fromName = 'Runna.io';

  constructor(apiKey: string, fromEmail?: string, provider?: EmailProvider) {
    this.apiKey = apiKey;
    this.provider = provider || 'resend';
    if (this.provider === 'resend') {
      this.resend = new Resend(apiKey);
    }
    if (fromEmail && fromEmail.trim().length > 0) {
      this.fromEmail = fromEmail.trim();
    }
  }

  private async send(to: string, subject: string, html: string): Promise<void> {
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
              <a href="${APP_URL}/friends" style="display: inline-block; background: #3b82f6; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">
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
              <a href="${APP_URL}" style="display: inline-block; background: #3b82f6; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">
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
              <a href="${APP_URL}" style="display: inline-block; background: #3b82f6; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">
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
              <a href="${APP_URL}" style="display: inline-block; background: #2563eb; color: white; padding: 14px 22px; border-radius: 10px; text-decoration: none; font-weight: 700; box-shadow: 0 10px 30px rgba(37, 99, 235, 0.25);">
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
}
