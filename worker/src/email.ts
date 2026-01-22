import { Resend } from 'resend';
import type { WorkerStorage } from './storage';

export class EmailService {
  private resend: Resend;
  private fromEmail = 'onboarding@resend.dev';
  private fromName = 'Runna.io';

  constructor(apiKey: string) {
    this.resend = new Resend(apiKey);
  }

  async sendFriendRequestEmail(
    recipientEmail: string,
    senderName: string,
    senderUsername: string
  ): Promise<void> {
    try {
      await this.resend.emails.send({
        from: `${this.fromName} <${this.fromEmail}>`,
        to: recipientEmail,
        subject: `¡${senderName} te envió una solicitud de amistad en Runna.io!`,
        html: `
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
              <a href="https://runna.io/friends" style="display: inline-block; background: #3b82f6; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">
                Ver solicitud
              </a>
            </div>

            <p style="color: #999; font-size: 12px; text-align: center; margin-top: 30px;">
              © 2026 Runna.io. Todos los derechos reservados.
            </p>
          </div>
        `,
      });
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
      await this.resend.emails.send({
        from: `${this.fromName} <${this.fromEmail}>`,
        to: recipientEmail,
        subject: `¡${acceptorName} aceptó tu solicitud de amistad!`,
        html: `
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
              <a href="https://runna.io" style="display: inline-block; background: #3b82f6; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">
                Ir a Runna.io
              </a>
            </div>

            <p style="color: #999; font-size: 12px; text-align: center; margin-top: 30px;">
              © 2026 Runna.io. Todos los derechos reservados.
            </p>
          </div>
        `,
      });
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
      await this.resend.emails.send({
        from: `${this.fromName} <${this.fromEmail}>`,
        to: recipientEmail,
        subject: `⚠️ ¡${conquererName} te conquistó ${kmStolen} km² en Runna.io!`,
        html: `
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
              <a href="https://runna.io" style="display: inline-block; background: #3b82f6; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">
                Ver mapa
              </a>
            </div>

            <p style="color: #999; font-size: 12px; text-align: center; margin-top: 30px;">
              © 2026 Runna.io. Todos los derechos reservados.
            </p>
          </div>
        `,
      });
      console.log('[EMAIL] Territory conquered sent to', recipientEmail);
    } catch (error) {
      console.error('[EMAIL] Failed to send territory conquered email:', error);
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
}
