import type { WorkerStorage } from './storage';
import { IOS_CATEGORY, formatArea, pushToUser } from './notifications';

/**
 * Days without running after which a reminder is sent: at most three per break, then silence until the
 * user runs again (a reminder every two days forever made people turn notifications off).
 */
export const REMINDER_STAGES_DAYS = [3, 7, 14];

const DAY_MS = 24 * 60 * 60 * 1000;

interface ReminderContext {
  stage: number;
  /** The user never uploaded a run. */
  neverRan: boolean;
  /** m² the user owns. */
  totalArea: number;
  /** The friend who ran most in the last 7 days. */
  activeFriend: { name: string; runs: number } | null;
}

/** Title and body for a reminder, using what is going on around the user. */
export function reminderMessage(context: ReminderContext): { title: string; body: string } {
  const { stage, neverRan, totalArea, activeFriend } = context;
  const friendLine = activeFriend && activeFriend.runs > 0
    ? `${activeFriend.name} ha corrido ${activeFriend.runs} ${activeFriend.runs === 1 ? 'vez' : 'veces'} esta semana`
    : null;

  if (neverRan) {
    if (stage === 0) {
      return { title: '🏁 Tu primera carrera te espera', body: 'Pulsa Correr y empieza a pintar el mapa con tu color.' };
    }
    if (stage === 1) {
      return friendLine
        ? { title: `🏃 ${friendLine}`, body: 'Sal hoy y conquista tu primer trozo de mapa.' }
        : { title: '🗺️ El mapa sigue en blanco', body: 'Una carrera corta basta para conquistar tu primera zona.' };
    }
    return { title: '👟 ¿Te animas?', body: 'Es el último aviso: cuando salgas a correr, aquí estaremos.' };
  }

  if (stage === 0) {
    if (friendLine) return { title: `🏃 ${friendLine}`, body: '¿Sales hoy a por tu territorio?' };
    if (totalArea > 0) return { title: '🗺️ Tu territorio te espera', body: `Tienes ${formatArea(totalArea)}. Una carrera hoy y nadie te lo quita.` };
    return { title: '🏃 ¿Salimos a correr?', body: 'Hace unos días de tu última carrera. Hoy es buen día.' };
  }
  if (stage === 1) {
    if (totalArea > 0) {
      return {
        title: '🛡️ Una semana sin correr',
        body: `Tus ${formatArea(totalArea)} están sin defender.${friendLine ? ` ${friendLine}.` : ' ¿Una vuelta corta hoy?'}`,
      };
    }
    return { title: '🏃 Una semana sin correr', body: friendLine ? `${friendLine}. ¿Te unes?` : 'Una vuelta corta hoy y vuelves al mapa.' };
  }
  return { title: '👟 ¿Volvemos?', body: 'Hace dos semanas de tu última carrera. Es el último aviso: cuando vuelvas, aquí seguimos.' };
}

/**
 * Checks every user with a device and sends the next reminder of their current break, if one is due.
 * Runs at 10:00 and 19:00 (Europe/Madrid) from the cron.
 */
export async function checkAndSendInactivityReminders(
  storage: WorkerStorage,
  env: any
): Promise<{ sent: number; skipped: number; errors: number }> {
  const stats = { sent: 0, skipped: 0, errors: 0 };
  const now = Date.now();
  const allUsers = await storage.getAllUsersWithStats();
  console.log(`[INACTIVITY] Checking ${allUsers.length} users for inactivity...`);

  for (const user of allUsers) {
    try {
      const subscriptions = await storage.getPushSubscriptionsByUserId(user.id);
      if (subscriptions.length === 0) {
        stats.skipped++;
        continue;
      }

      // The break started at the last run (or at sign-up for someone who never ran)
      const lastActivity = await storage.getLastActivityDate(user.id);
      const breakStart = lastActivity ?? user.createdAt;
      const breakStartMs = breakStart ? new Date(breakStart.includes('T') ? breakStart : `${breakStart.replace(' ', 'T')}Z`).getTime() : NaN;
      if (!Number.isFinite(breakStartMs)) {
        stats.skipped++;
        continue;
      }
      const daysIdle = (now - breakStartMs) / DAY_MS;
      const stage = await storage.countInactivityRemindersSince(user.id, new Date(breakStartMs).toISOString());
      if (stage >= REMINDER_STAGES_DAYS.length || daysIdle < REMINDER_STAGES_DAYS[stage]) {
        stats.skipped++;
        continue;
      }

      const activeFriend = await storage.getMostActiveFriendSince(user.id, new Date(now - 7 * DAY_MS).toISOString());
      const { title, body } = reminderMessage({
        stage,
        neverRan: !lastActivity,
        totalArea: user.totalArea ?? 0,
        activeFriend,
      });
      const sent = await pushToUser(storage, env, user.id, 'reminders', {
        title,
        body,
        tag: 'inactivity-reminder',
        threadId: 'reminders',
        category: IOS_CATEGORY.runReminder,
        data: { type: 'inactivity_reminder' },
      });
      if (!sent) {
        stats.skipped++;
        continue;
      }
      // Recorded only when sent: turning reminders off doesn't use up the stages
      await storage.saveInactivityReminder(user.id, stage);
      console.log(`[INACTIVITY] ✅ Sent reminder ${stage + 1}/${REMINDER_STAGES_DAYS.length} to ${user.username}`);
      stats.sent++;
    } catch (userErr) {
      console.error(`[INACTIVITY] Error processing user ${user.id}:`, userErr);
      stats.errors++;
    }
  }

  console.log(`[INACTIVITY] Done. Sent: ${stats.sent}, Skipped: ${stats.skipped}, Errors: ${stats.errors}`);
  return stats;
}
