import type { WorkerStorage } from './storage';
import { sendPushToUser } from './pushHelper';

/**
 * Banco de 27 mensajes motivacionales para recordatorios de inactividad.
 * Se seleccionan aleatoriamente para cada usuario.
 */
export const INACTIVITY_REMINDER_MESSAGES = [
  // 1-15: Originales
  "¡Oye! Tu sofá se está quejando. Vamos, sal a correr 🏃",
  "2 días sin subir actividad... ¿Dónde está tu competidor interno? 💪",
  "¡Es hora de conquistar nuevos territorios! ¿Listo para salir?",
  "Tus pulmones: 'Me extrañas, ¿verdad?' Sal a trotar ya 😂",
  "Recuerdo cuando podías subir una actividad cada día... ¡Vuelve! 👟",
  "¿Sabías que alguien más está conquistando territorio AHORA? No te quedes atrás 🗺️",
  "Tu último rival: 'Pensé que te habías retirado' 😏 ¡Demuéstrale que no!",
  "Cada paso cuenta. Cada carrera suma. ¡Vamos a hacer historia hoy! 🏆",
  "¡Eh! Hace 2 días no te vemos. ¿Necesitas un empujón? Aquí está 🚀",
  "Mientras tú descansas, otros están ganando territorio. ¿Qué esperas? 🏃‍♀️",
  "¡Vamos! Sabemos que tienes energía. ¡Sal y demuéstrale a todos de qué estás hecho!",
  "Nuestros mapas te extrañan. Tú sabes, esos territorios no van a conquistarse solos 🗺️",
  "Es miércoles (o el día que sea). Es hora de una buena carrera. ¡Tú puedes! 💨",
  "¡Alerta! Se detectó inactividad. Prescrip... digo, ¡actívate ya! 🔔",
  "La leyenda dice que apareces cada 2 días... ¿Es hora de escribir tu siguiente capítulo? ✨",

  // 16-25: Nuevos bromistas
  "Tu colchón está pidiendo un descanso de ti. ¡Vete a correr! 😴🏃",
  "Advertencia: Estás a punto de convertirte en legendario (perezoso) 🦥",
  "Los píxeles del mapa extrañan tus coordenadas. ¡Vuelve! 📍",
  "Spoiler: Sí, puedes. Ahora corre y demuéstramelo 🎬",
  "Tu cardio: 'Eyyy, ¿me olvidaste?' No seas malo 💔",
  "Ranking de inactividad: #1 (en mi lista de preocupaciones) 📊",
  "Cuando corriste por última vez, la IA aún no sabía qué era un 'vago'... ahora ya lo sabe 🤖",
  "Noticia de último momento: Usuario desaparece sin dejar rastro 🚨",
  "Tu cuerpo te da 2 días para descansar, no 2 semanas. ¡A mover! 🔥",
  "Diccionario: Runna - sustantivo. Sinónimo de aventura. Tú: no has tenido una en 2 días 📖",

  // 26-27: Extras
  "Hace 2 días que no corres. En ese tiempo surgieron 47 nuevas modas de TikTok que ya se fueron 📱",
  "Dicen que correr alarga la vida... tú ya estarías en los 200 años 🧓",
];

/**
 * Selecciona un mensaje aleatorio del banco, evitando el último enviado al usuario.
 */
export function getRandomMessage(lastMessageIndex?: number | null): { message: string; index: number } {
  let index: number;
  do {
    index = Math.floor(Math.random() * INACTIVITY_REMINDER_MESSAGES.length);
  } while (index === lastMessageIndex && INACTIVITY_REMINDER_MESSAGES.length > 1);

  return {
    message: INACTIVITY_REMINDER_MESSAGES[index],
    index,
  };
}

/**
 * Chequea todos los usuarios y envía recordatorios push a los que llevan 2+ días sin actividad.
 * Se llama desde el cron job (Upstash) cada 12 horas.
 */
export async function checkAndSendInactivityReminders(
  storage: WorkerStorage,
  env: any
): Promise<{ sent: number; skipped: number; errors: number }> {
  const stats = { sent: 0, skipped: 0, errors: 0 };

  try {
    // 1. Get all users
    const allUsers = await storage.getAllUsersWithStats();
    console.log(`[INACTIVITY] Checking ${allUsers.length} users for inactivity...`);

    const now = new Date();
    const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000); // 48 hours

    for (const user of allUsers) {
      try {
        // 2. Check if user has push subscriptions
        const subscriptions = await storage.getPushSubscriptionsByUserId(user.id);
        if (subscriptions.length === 0) {
          stats.skipped++;
          continue;
        }

        // 3. Check last activity date
        const lastActivity = await storage.getLastActivityDate(user.id);
        if (lastActivity && new Date(lastActivity) > twoDaysAgo) {
          // User has recent activity, skip
          stats.skipped++;
          continue;
        }

        // 4. Check if we already sent a reminder in the last 2 days
        const lastReminder = await storage.getLastInactivityReminder(user.id);
        if (lastReminder) {
          const lastSentAt = new Date(lastReminder.sentAt);
          const twoDaysSinceReminder = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
          if (lastSentAt > twoDaysSinceReminder) {
            // Already sent a reminder within 2 days, skip
            stats.skipped++;
            continue;
          }
        }

        // 5. Pick a random message (avoid repeating the last one)
        const lastIndex = lastReminder?.messageIndex ?? null;
        const { message, index } = getRandomMessage(lastIndex);

        // 6. Send push notification
        const payload = {
          title: '🏃 ¡Te echamos de menos!',
          body: message,
          tag: 'inactivity-reminder',
          data: {
            url: '/',
            type: 'inactivity_reminder',
          },
        };

        const pushSubs = subscriptions.map((sub) => ({
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.p256dh,
            auth: sub.auth,
          },
        }));

        await sendPushToUser(
          pushSubs,
          payload,
          env.VAPID_PUBLIC_KEY || '',
          env.VAPID_PRIVATE_KEY || '',
          env.VAPID_SUBJECT || 'mailto:notifications@runna.io'
        );

        // 7. Record the reminder in the database
        await storage.saveInactivityReminder(user.id, index);

        console.log(`[INACTIVITY] ✅ Sent reminder to ${user.username} (message #${index})`);
        stats.sent++;
      } catch (userErr) {
        console.error(`[INACTIVITY] Error processing user ${user.id}:`, userErr);
        stats.errors++;
      }
    }

    console.log(`[INACTIVITY] Done. Sent: ${stats.sent}, Skipped: ${stats.skipped}, Errors: ${stats.errors}`);
  } catch (error) {
    console.error('[INACTIVITY] Fatal error in checkAndSendInactivityReminders:', error);
    throw error;
  }

  return stats;
}
