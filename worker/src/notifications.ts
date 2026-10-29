import type { WorkerStorage } from './storage';
import { sendPushToUser, type PushNotificationPayload } from './pushHelper';
import { DEFAULT_WORKER_URL } from './email';

// ===== Categories and preferences =====

/**
 * What the user can turn off in the app (Perfil → Notificaciones → Tipos):
 * - conquest: someone stole your territory, someone overtook you in the ranking
 * - runs: your runs imported from Strava / Polar / Suunto / Garmin, with what they conquered
 * - friends: a friend went for a run
 * - social: friend requests, comments, replies, mentions, likes, conquest photos
 * - competition: treasures, nicknames, weekly summary
 * - reminders: "you haven't run in a while"
 */
export const PUSH_CATEGORIES = ['conquest', 'runs', 'friends', 'social', 'competition', 'reminders'] as const;
export type PushCategory = (typeof PUSH_CATEGORIES)[number];

/** iOS notification categories (action buttons), registered by the app's PushManager. */
export const IOS_CATEGORY = {
  territoryLoss: 'TERRITORY_LOSS',
  friendRequest: 'FRIEND_REQUEST',
  runReminder: 'RUN_REMINDER',
  treasure: 'TREASURE',
} as const;

/** Sends to every device of the user unless they turned the category off. True when it was sent. */
export async function pushToUser(
  storage: WorkerStorage,
  env: any,
  userId: string,
  category: PushCategory,
  payload: PushNotificationPayload,
): Promise<boolean> {
  try {
    const settings = await storage.getNotificationSettings(userId);
    if (settings[category] === false) return false;
    const subscriptions = await storage.getPushSubscriptionsByUserId(userId);
    if (subscriptions.length === 0) return false;
    await sendPushToUser(
      subscriptions.map((sub) => ({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } })),
      payload,
      env?.VAPID_PUBLIC_KEY || '',
      env?.VAPID_PRIVATE_KEY || '',
      env?.VAPID_SUBJECT || 'mailto:notifications@runna.io',
    );
    return true;
  } catch (error) {
    console.error(`[PUSH] ${category} notification to ${userId} failed:`, error);
    return false;
  }
}

/** Same notification to several users (one after another). Returns how many got it. */
export async function pushToUsers(
  storage: WorkerStorage,
  env: any,
  userIds: Iterable<string>,
  category: PushCategory,
  payload: PushNotificationPayload,
): Promise<number> {
  let sent = 0;
  for (const userId of new Set(userIds)) {
    if (await pushToUser(storage, env, userId, category, payload)) sent++;
  }
  return sent;
}

// ===== Formatting (Spanish: decimal comma) =====

function decimal(value: number, digits: number): string {
  return value.toFixed(digits).replace('.', ',');
}

/** 350 m² / 0,12 km² */
export function formatArea(squareMeters: number): string {
  const abs = Math.abs(squareMeters);
  if (abs >= 10_000) return `${decimal(abs / 1_000_000, 2)} km²`;
  return `${Math.round(abs)} m²`;
}

/** 8,2 km */
export function formatKm(meters: number): string {
  return `${decimal(Math.max(0, meters) / 1000, 1)} km`;
}

function displayName(user: { name?: string | null; username?: string | null } | undefined | null, fallback = 'Alguien'): string {
  return user?.name || user?.username || fallback;
}

/**
 * The person a notification is about, as the picture on its right: their profile picture
 * (GET /api/users/:id/avatar) or, without one, their initials on their colour.
 */
export function personImage(
  env: any,
  user: { id: string; name?: string | null; username?: string | null; color?: string | null; avatar?: string | null } | undefined | null,
): PushNotificationPayload['image'] {
  if (!user) return undefined;
  const base = String(env?.WORKER_URL || DEFAULT_WORKER_URL).replace(/\/+$/, '');
  // The version changes with the picture, so a cached old one isn't shown
  const version = user.avatar ? `${user.avatar.length}-${user.avatar.slice(-12).replace(/[^A-Za-z0-9]/g, '')}` : '';
  return {
    url: user.avatar ? `${base}/api/users/${encodeURIComponent(user.id)}/avatar?v=${version}` : null,
    name: user.name || user.username || '',
    color: user.color || '#888888',
  };
}

function preview(text: string, length = 100): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length > length ? `${trimmed.slice(0, length - 1)}…` : trimmed;
}

/** "Ana", "Ana y Luis", "Ana, Luis y 2 más" */
function namesList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} y ${names[1]}`;
  return `${names[0]}, ${names[1]} y ${names.length - 2} más`;
}

// ===== Territory lost =====

/** Short taunts under "⚔️ Ana te ha robado 0,12 km²" (the facts are in the title). */
export const TERRITORY_LOSS_MESSAGES = [
  '¿Lo vas a dejar así? Tus zapatillas dicen que no.',
  'Tu mapa pide revancha.',
  'Hora de salir a recuperarlo.',
  'Responde con kilómetros.',
  'Tu próxima carrera ya tiene nombre y apellido.',
  'La remontada empieza en tu próxima carrera.',
  'Tu orgullo está en modo venganza.',
  'Que no te lo cuenten: recupéralo.',
  'Hoy no hay excusas.',
  'Tu GPS pide represalias.',
  'Tu cardio tiene asuntos pendientes.',
  'Devuélveselo con estilo.',
  'Te ha pisado el patio. Sal a poner orden.',
  '¿Te ha picado? Entonces sal ya.',
  'Tiempo de callar y correr.',
  'Haz que se arrepienta.',
  'Hoy el mapa se recupera a pulso.',
  'Tu imperio necesita refuerzos.',
  'Ponte las zapatillas: toca contraataque.',
  'Un buen rodaje y aquí no ha pasado nada.',
];

function pickTaunt(lastIndex?: number | null): { message: string; index: number } {
  let index: number;
  do {
    index = Math.floor(Math.random() * TERRITORY_LOSS_MESSAGES.length);
  } while (index === lastIndex && TERRITORY_LOSS_MESSAGES.length > 1);
  return { message: TERRITORY_LOSS_MESSAGES[index], index };
}

/** At most one "te ha robado" per attacker and victim in this window. */
const TERRITORY_LOSS_WINDOW_MS = 6 * 60 * 60 * 1000;
/**
 * Smaller thefts aren't notified (they still change the map): someone running again the streets they
 * already took nibbles a few hundred m² each time because of GPS drift.
 */
const MIN_NOTIFIED_STOLEN_M2 = 1_000;

export async function notifyTerritoryLoss(
  storage: WorkerStorage,
  victimUserId: string,
  conquerorUserId: string,
  env: any,
  stolenAreaM2?: number,
  options: { routeId?: string; center?: { lat: number; lng: number } | null } = {},
): Promise<void> {
  try {
    if (stolenAreaM2 !== undefined && stolenAreaM2 < MIN_NOTIFIED_STOLEN_M2) return;
    // One notification per attacker and victim every 6 hours: several runs processed together
    // (a backlog imported from a watch, a retried run) don't send the same news again and again
    if (!(await storage.takePushThrottle(`territory_loss:${conquerorUserId}:${victimUserId}`, TERRITORY_LOSS_WINDOW_MS))) return;
    const conqueror = await storage.getUser(conquerorUserId);
    const name = displayName(conqueror);
    const lastNotification = await storage.getLastTerritoryLossNotification(victimUserId);
    const { message, index } = pickTaunt(lastNotification?.messageIndex ?? null);
    const sent = await pushToUser(storage, env, victimUserId, 'conquest', {
  image: personImage(env, conqueror),
      title: stolenAreaM2 ? `⚔️ ${name} te ha robado ${formatArea(stolenAreaM2)}` : `⚔️ ${name} te ha robado territorio`,
      body: message,
      tag: `territory-loss-${conquerorUserId}`,
      threadId: 'territory',
      category: IOS_CATEGORY.territoryLoss,
      data: {
        type: 'territory_loss',
        conquerorId: conquerorUserId,
        routeId: options.routeId ?? null,
        lat: options.center?.lat ?? null,
        lng: options.center?.lng ?? null,
      },
    });
    if (sent) await storage.saveTerritoryLossNotification(victimUserId, index);
  } catch (error) {
    console.error('Error sending territory loss notification:', error);
  }
}

// ===== Ranking =====

export async function notifyAreaOvertake(
  storage: WorkerStorage,
  overtakerUserId: string,
  victimUserId: string,
  overtakerAreaM2: number,
  victimAreaM2: number,
  env: any,
): Promise<void> {
  const overtaker = await storage.getUser(overtakerUserId);
  const name = displayName(overtaker);
  const lead = Math.max(0, overtakerAreaM2 - victimAreaM2);
  await pushToUser(storage, env, victimUserId, 'conquest', {
    image: personImage(env, overtaker),
    title: `🥇 ${name} te ha adelantado en el ranking`,
    body: `Tiene ${formatArea(overtakerAreaM2)} y te saca ${formatArea(lead)}. ¿Lo recuperas?`,
    tag: `area-overtake-${overtakerUserId}`,
    threadId: 'ranking',
    category: IOS_CATEGORY.runReminder,
    data: { type: 'area_overtake', userId: overtakerUserId },
  });
}

// ===== Your imported runs =====

const SOURCE_NAMES: Record<string, string> = { strava: 'Strava', polar: 'Polar', suunto: 'Suunto', garmin: 'Garmin' };

/**
 * A run imported from a connected service, sent once its territory has been processed so it can say
 * what it conquered. data.routeId lets the app show the conquest animation.
 */
export async function notifyImportedRun(
  storage: WorkerStorage,
  env: any,
  run: { userId: string; routeId: string; source: string; distance: number; newArea: number; victimNames: string[] },
): Promise<void> {
  const parts = [formatKm(run.distance)];
  if (run.newArea >= 1) parts.push(`+${formatArea(run.newArea)} conquistados`);
  if (run.victimNames.length > 0) parts.push(`robados a ${namesList(run.victimNames)}`);
  if (parts.length === 1) parts.push('sin territorio nuevo esta vez');
  await pushToUser(storage, env, run.userId, 'runs', {
    title: `✅ Carrera de ${SOURCE_NAMES[run.source] ?? 'tu reloj'} importada`,
    body: parts.join(' · '),
    tag: `import-${run.routeId}`,
    threadId: 'runs',
    data: { type: `${run.source}_auto_import`, routeId: run.routeId },
  });
}

/** Fallback when the territory couldn't be queued: the run is there, the conquest comes later. */
export async function notifyImportedRunPending(
  storage: WorkerStorage,
  env: any,
  run: { userId: string; routeId: string; source: string; distance: number },
): Promise<void> {
  await pushToUser(storage, env, run.userId, 'runs', {
    title: `✅ Carrera de ${SOURCE_NAMES[run.source] ?? 'tu reloj'} importada`,
    body: `${formatKm(run.distance)} · Entra para ver lo que has conquistado`,
    tag: `import-${run.routeId}`,
    threadId: 'runs',
    data: { type: `${run.source}_auto_import`, routeId: run.routeId },
  });
}

// ===== Friends =====

/** Friends' runs: at most one notification per runner every 6 hours. */
const FRIEND_ACTIVITY_WINDOW_MS = 6 * 60 * 60 * 1000;

export async function notifyFriendNewActivity(
  storage: WorkerStorage,
  activityUserId: string,
  distanceMeters: number,
  newAreaM2: number,
  env: any,
  options: { excludeUserIds?: string[]; routeId?: string; eventId?: string } = {},
): Promise<void> {
  try {
    const friendIds = await storage.getFriendIds(activityUserId);
    const excluded = new Set(options.excludeUserIds ?? []);
    const recipients = friendIds.filter((id) => !excluded.has(id));
    if (recipients.length === 0) return;
    if (!(await storage.takePushThrottle(`friend_activity:${activityUserId}`, FRIEND_ACTIVITY_WINDOW_MS))) return;

    const user = await storage.getUser(activityUserId);
    const name = displayName(user, 'Un amigo');
    await pushToUsers(storage, env, recipients, 'friends', {
      image: personImage(env, user),
      title: `🏃 ${name} ha corrido ${formatKm(distanceMeters)}`,
      body: newAreaM2 >= 1 ? `Y ha conquistado ${formatArea(newAreaM2)}` : 'Mira su carrera en el feed',
      tag: `friend-activity-${activityUserId}`,
      threadId: 'friends',
      passive: true,
      data: { type: 'friend_activity', userId: activityUserId, routeId: options.routeId ?? null, eventId: options.eventId ?? null },
    });
  } catch (error) {
    console.error('Error sending friend activity notification:', error);
  }
}

export async function notifyFriendRequest(
  storage: WorkerStorage,
  recipientUserId: string,
  senderUserId: string,
  env: any,
  requestId?: string,
): Promise<void> {
  const sender = await storage.getUser(senderUserId);
  await pushToUser(storage, env, recipientUserId, 'social', {
    image: personImage(env, sender),
    title: `👋 ${displayName(sender)} quiere ser tu amigo`,
    body: 'Acepta para ver sus carreras y competir por el territorio',
    tag: `friend-request-${senderUserId}`,
    threadId: 'friends',
    category: requestId ? IOS_CATEGORY.friendRequest : undefined,
    data: { type: 'friend_request', senderId: senderUserId, requestId: requestId ?? null },
  });
}

export async function notifyFriendRequestAccepted(
  storage: WorkerStorage,
  originalSenderUserId: string,
  accepterUserId: string,
  env: any,
): Promise<void> {
  const accepter = await storage.getUser(accepterUserId);
  await pushToUser(storage, env, originalSenderUserId, 'social', {
    image: personImage(env, accepter),
    title: `🤝 ${displayName(accepter)} ha aceptado tu solicitud`,
    body: 'Ya podéis veros en el mapa y en el ranking',
    tag: `friend-accepted-${accepterUserId}`,
    threadId: 'friends',
    data: { type: 'friend_accepted', friendId: accepterUserId },
  });
}

// ===== Feed: likes and comments =====

/** Likes only (a "no le gustó" notification brings nothing), grouped per post or comment. */
export async function notifyReaction(
  storage: WorkerStorage,
  reactorUserId: string,
  targetOwnerId: string,
  reactionType: 'like' | 'dislike',
  targetType: 'event' | 'comment',
  env: any,
  options: { targetId?: string; likeCount?: number } = {},
): Promise<void> {
  try {
    if (reactionType !== 'like' || reactorUserId === targetOwnerId) return;
    const reactor = await storage.getUser(reactorUserId);
    const name = displayName(reactor);
    const others = Math.max(0, (options.likeCount ?? 1) - 1);

    let target = targetType === 'event' ? 'tu publicación' : 'tu comentario';
    let eventId: string | null = null;
    if (options.targetId && targetType === 'event') {
      eventId = options.targetId;
      const event = await storage.getFeedEvent(options.targetId);
      if (event?.eventType === 'activity' && event.distance) target = `tu carrera de ${formatKm(event.distance)}`;
    } else if (options.targetId) {
      const comment = await storage.getFeedCommentById(options.targetId);
      eventId = comment?.feedEventId ?? null;
    }

    await pushToUser(storage, env, targetOwnerId, 'social', {
      image: personImage(env, reactor),
      title: others > 0 ? `👍 ${name} y ${others} más` : `👍 ${name}`,
      body: `${others > 0 ? 'Les ha gustado' : 'Le ha gustado'} ${target}`,
      // The newest count replaces the previous notification for the same post
      tag: `like-${targetType}-${options.targetId ?? 'unknown'}`,
      threadId: eventId ? `feed-${eventId}` : 'feed',
      passive: true,
      data: { type: 'reaction', reactorId: reactorUserId, eventId },
    });
  } catch (error) {
    console.error('Error sending reaction notification:', error);
  }
}

/**
 * A new comment: tells the post's owner, the author of the comment it replies to, and the friends
 * mentioned with @name (each person at most once).
 */
export async function notifyFeedComment(
  storage: WorkerStorage,
  env: any,
  comment: { commenterId: string; eventId: string; parentId?: string | null; content: string },
): Promise<void> {
  try {
    const commenter = await storage.getUser(comment.commenterId);
    const name = displayName(commenter);
    const body = preview(comment.content);
    const notified = new Set<string>([comment.commenterId]);
    const base = { threadId: `feed-${comment.eventId}`, image: personImage(env, commenter) };

    const event = await storage.getFeedEvent(comment.eventId);
    if (event && !notified.has(event.userId)) {
      notified.add(event.userId);
      const target = event.eventType === 'activity' ? 'tu carrera' : 'tu publicación';
      await pushToUser(storage, env, event.userId, 'social', {
        ...base,
        title: `💬 ${name} ha comentado ${target}`,
        body,
        data: { type: 'feed_comment', eventId: comment.eventId },
      });
    }

    if (comment.parentId) {
      const parent = await storage.getFeedCommentById(comment.parentId);
      if (parent && !notified.has(parent.userId)) {
        notified.add(parent.userId);
        await pushToUser(storage, env, parent.userId, 'social', {
          ...base,
          title: `💬 ${name} ha respondido a tu comentario`,
          body,
          data: { type: 'feed_reply', eventId: comment.eventId },
        });
      }
    }

    const mentions = [...comment.content.matchAll(/@([\wÀ-ɏ]+(?:\s[\wÀ-ɏ]+)?)/g)].map((m) => m[1].toLowerCase());
    if (mentions.length > 0) {
      for (const friendId of await storage.getFriendIds(comment.commenterId)) {
        if (notified.has(friendId)) continue;
        const friend = await storage.getUser(friendId);
        if (!friend) continue;
        const names = [friend.name?.toLowerCase() ?? '', friend.username?.toLowerCase() ?? ''].filter(Boolean);
        // The pattern also captures the next word ("@Ana hola" -> "ana hola"): try the first word too
        const mentioned = mentions.some((m) => names.includes(m) || names.includes(m.split(/\s/)[0]));
        if (!mentioned) continue;
        notified.add(friendId);
        await pushToUser(storage, env, friendId, 'social', {
          ...base,
          title: `📣 ${name} te ha mencionado`,
          body,
          data: { type: 'feed_mention', eventId: comment.eventId },
        });
      }
    }
  } catch (error) {
    console.error('Error sending comment notifications:', error);
  }
}

// ===== Competition =====

const RARITY: Record<string, { emoji: string; label: string }> = {
  legendary: { emoji: '💎', label: 'legendario' },
  epic: { emoji: '✨', label: 'épico' },
  rare: { emoji: '🔵', label: 'raro' },
  common: { emoji: '🟤', label: 'común' },
};

/** "14:05" in Spanish local time. */
function madridClock(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
}

/** Users taking part in the competition (they ran at least once since it started). */
export async function competitionParticipantIds(storage: WorkerStorage, competitionId: string): Promise<string[]> {
  const leaderboard = await storage.getCompetitionLeaderboard(competitionId);
  return leaderboard.map((entry) => entry.user.id);
}

/** A treasure appeared (or is still waiting): to the competition's participants. */
export async function notifyTreasure(
  storage: WorkerStorage,
  env: any,
  competitionId: string,
  treasure: { id: string; name: string; rarity: string; zone?: string | null; lat: number; lng: number; expiresAt: string },
  options: { reminder?: boolean } = {},
): Promise<number> {
  const rarity = RARITY[treasure.rarity] ?? RARITY.common;
  const zone = treasure.zone ? ` en ${treasure.zone}` : '';
  const until = madridClock(treasure.expiresAt);
  const expiresTomorrow = new Date(treasure.expiresAt).getTime() - Date.now() > 12 * 60 * 60 * 1000;
  const deadline = until ? `Disponible hasta ${expiresTomorrow ? 'mañana ' : ''}a las ${until}` : 'Corre a por él antes de que desaparezca';
  return pushToUsers(storage, env, await competitionParticipantIds(storage, competitionId), 'competition', {
    title: options.reminder
      ? `${rarity.emoji} Sigue ahí: tesoro ${rarity.label}${zone}`
      : `${rarity.emoji} Tesoro ${rarity.label}${zone}`,
    body: `${treasure.name}. ${deadline}.`,
    tag: `treasure-${treasure.id}`,
    threadId: 'competition',
    category: IOS_CATEGORY.treasure,
    data: { type: 'treasure_spawned', treasureId: treasure.id, lat: treasure.lat, lng: treasure.lng },
  });
}

/** A nickname power: to the person who got it and to their friends. */
export async function notifyNickname(
  storage: WorkerStorage,
  env: any,
  nickname: { attackerName: string; attackerId: string; targetName: string; targetUserId: string; nickname: string },
): Promise<void> {
  const [attacker, target] = await Promise.all([storage.getUser(nickname.attackerId), storage.getUser(nickname.targetUserId)]);
  await pushToUser(storage, env, nickname.targetUserId, 'competition', {
    image: personImage(env, attacker),
    title: `🎭 ${nickname.attackerName} te ha puesto un apodo`,
    body: `Durante 48 h todos te verán como «${nickname.nickname}»`,
    tag: `nickname-${nickname.targetUserId}`,
    threadId: 'competition',
    data: { type: 'nickname_changed', targetUserId: nickname.targetUserId },
  });
  const friendIds = (await storage.getFriendIds(nickname.targetUserId)).filter((id) => id !== nickname.attackerId);
  await pushToUsers(storage, env, friendIds, 'competition', {
    image: personImage(env, target),
    title: `🎭 ${nickname.targetName} ahora se llama «${nickname.nickname}»`,
    body: `Cortesía de ${nickname.attackerName}, durante 48 h`,
    tag: `nickname-${nickname.targetUserId}`,
    threadId: 'competition',
    passive: true,
    data: { type: 'nickname_changed', targetUserId: nickname.targetUserId },
  });
}

/** The weekly summary, personalised: your position, area and distance, and the award you won. */
export async function notifyWeeklySummary(
  storage: WorkerStorage,
  env: any,
  summary: {
    weekNumber: number;
    ranking: Array<{ userId: string; totalArea: number; totalDistance: number }>;
    awardsByUser: Map<string, string[]>;
  },
): Promise<void> {
  const total = summary.ranking.length;
  for (const [index, entry] of summary.ranking.entries()) {
    const awards = summary.awardsByUser.get(entry.userId) ?? [];
    const parts = [`Vas ${index + 1}.º de ${total}`, formatArea(entry.totalArea), formatKm(entry.totalDistance)];
    const award = awards.length > 0 ? ` ¡Has ganado «${awards[0]}»!` : '';
    await pushToUser(storage, env, entry.userId, 'competition', {
      title: `🏆 Tu semana ${summary.weekNumber} en la competición`,
      body: `${parts.join(' · ')}.${award}`,
      tag: `weekly-summary-${summary.weekNumber}`,
      threadId: 'competition',
      data: { type: 'weekly_summary', weekNumber: summary.weekNumber },
    });
  }
}
