import type { WorkerStorage } from './storage';
import { sendPushToUser } from './pushHelper';

export const TERRITORY_LOSS_MESSAGES = [
  '{user} se llevo {area} de tu reino. Dejalo pasar? Ni de chiste.',
  '{user} te recorto el mapa con {area}. Hora de la tijera inversa.',
  '{user} se quedo con {area} de tu territorio. Tu orgullo esta en modo venganza.',
  '{user} piso tu patio y se llevo {area}. Sal a poner orden.',
  '{user} se llevo {area} de tu mapa. Hoy no se duerme.',
  '{user} te robo {area}. Tus zapatillas piden justicia.',
  '{user} se llevo {area}. Tu mapa llora, tus piernas no.',
  '{user} marco {area} en tu zona. Responde con kilometros.',
  '{user} se llevo {area} de tu imperio. A correr o a llorar.',
  '{user} te recorto {area}. Tu revancha esta en modo sprint.',
  '{user} se llevo {area} de tu reino. Hoy se corre con rabia fina.',
  '{user} te saco {area} del mapa. Que empiece la persecucion.',
  '{user} se llevo {area}. Tu GPS pide represalias.',
  '{user} te bajo {area} de territorio. Haz que se arrepienta.',
  '{user} se quedo con {area}. Tu ego ya calento.',
  '{user} se llevo {area} de tu zona. Devuelvelo con estilo.',
  '{user} te robo {area}. No eres tu, es el. Corrige eso.',
  '{user} se llevo {area}. Tu cardio tiene asuntos pendientes.',
  '{user} te quito {area} de tu patio. Hoy no hay excusas.',
  '{user} se llevo {area}. La remontada empieza ahora.',
  '{user} te saco {area}. Ponte serio, pero con gracia.',
  '{user} se llevo {area}. Hora de marcar territorio otra vez.',
  '{user} te quito {area}. Tu proxima carrera tiene nombre y apellido.',
  '{user} se llevo {area}. Que tu siguiente run sea venganza elegante.',
  '{user} te robo {area}. Hoy el mapa se recupera a pulso.',
  '{user} se llevo {area}. Dejalo? Ni en tus suenos.',
  '{user} te quito {area}. Te vas a quedar mirando? Corre.',
  '{user} se llevo {area}. A ver si tus piernas tambien saben hablar.',
  '{user} te robo {area}. Tu respuesta no cabe en excusas.',
  '{user} se llevo {area}. Dale una clase de territorio 101.',
  '{user} te recorto {area}. Tu turno de devolver el favor.',
  '{user} se llevo {area}. Que no te lo cuenten, recuperalo.',
  '{user} te quito {area}. Te pico? Entonces sal ya.',
  '{user} se llevo {area}. Tiempo de callar y correr.',
  '{user} te robo {area}. Hoy toca revancha con estilo.',
];

function getRandomTerritoryLossMessage(
  conquerorHandle: string,
  areaText: string,
  lastMessageIndex?: number | null
): { message: string; index: number } {
  let index: number;
  do {
    index = Math.floor(Math.random() * TERRITORY_LOSS_MESSAGES.length);
  } while (index === lastMessageIndex && TERRITORY_LOSS_MESSAGES.length > 1);

  return {
    message: TERRITORY_LOSS_MESSAGES[index]
      .replace('{user}', conquerorHandle)
      .replace('{area}', areaText),
    index,
  };
}

export async function notifyTerritoryLoss(
  storage: WorkerStorage,
  victimUserId: string,
  conquerorUserId: string,
  env: any,
  stolenAreaM2?: number
): Promise<void> {
  try {
    // Get subscriptions for the victim
    const subscriptions = await storage.getPushSubscriptionsByUserId(victimUserId);
    
    if (subscriptions.length === 0) {
      return; // User doesn't have push notifications enabled
    }

    // Get conqueror's name
    const conqueror = await storage.getUser(conquerorUserId);
    const conquerorHandle = conqueror?.username
      ? `@${conqueror.username}`
      : conqueror?.name
        ? `@${conqueror.name}`
        : '@alguien';

    // Include km² in notification body
    const areaText = stolenAreaM2
      ? `${(stolenAreaM2 / 1000000).toFixed(2)} km²`
      : 'algo de';

    const lastNotification = await storage.getLastTerritoryLossNotification(victimUserId);
    const lastIndex = lastNotification?.messageIndex ?? null;
    const { message, index } = getRandomTerritoryLossMessage(conquerorHandle, areaText, lastIndex);

    // Prepare notification payload
    const payload = {
      title: '🚨 ¡Te han robado territorio!',
      body: message,
      tag: 'territory-loss',
      data: {
        url: '/',
        type: 'territory_loss',
        conquerorId: conquerorUserId,
      },
    };

    // Convert subscriptions to push format
    const pushSubs = subscriptions.map((sub) => ({
      endpoint: sub.endpoint,
      keys: {
        p256dh: sub.p256dh,
        auth: sub.auth,
      },
    }));

    // Send notifications
    await sendPushToUser(
      pushSubs,
      payload,
      env.VAPID_PUBLIC_KEY || '',
      env.VAPID_PRIVATE_KEY || '',
      env.VAPID_SUBJECT || 'mailto:notifications@runna.io'
    );

    await storage.saveTerritoryLossNotification(victimUserId, index);

    console.log(`✅ Sent territory loss notification to user ${victimUserId}`);
  } catch (error) {
    console.error('Error sending territory loss notification:', error);
    // Don't throw - notification failure shouldn't break the main flow
  }
}

export async function notifyFriendRequest(
  storage: WorkerStorage,
  recipientUserId: string,
  senderUserId: string,
  env: any
): Promise<void> {
  try {
    // Get subscriptions for the recipient
    const subscriptions = await storage.getPushSubscriptionsByUserId(recipientUserId);
    
    if (subscriptions.length === 0) {
      return;
    }

    // Get sender's name
    const sender = await storage.getUser(senderUserId);
    const senderName = sender?.name || sender?.username || 'Alguien';

    // Prepare notification payload
    const payload = {
      title: '👋 Nueva solicitud de amistad',
      body: `${senderName} quiere conectar contigo en Runna`,
      tag: 'friend-request',
      data: {
        url: '/friends',
        type: 'friend_request',
        senderId: senderUserId,
      },
    };

    // Convert subscriptions to push format
    const pushSubs = subscriptions.map((sub) => ({
      endpoint: sub.endpoint,
      keys: {
        p256dh: sub.p256dh,
        auth: sub.auth,
      },
    }));

    // Send notifications
    await sendPushToUser(
      pushSubs,
      payload,
      env.VAPID_PUBLIC_KEY || '',
      env.VAPID_PRIVATE_KEY || '',
      env.VAPID_SUBJECT || 'mailto:notifications@runna.io'
    );

    console.log(`✅ Sent friend request notification to user ${recipientUserId}`);
  } catch (error) {
    console.error('Error sending friend request notification:', error);
  }
}

export async function notifyFriendRequestAccepted(
  storage: WorkerStorage,
  originalSenderUserId: string,
  accepterUserId: string,
  env: any
): Promise<void> {
  try {
    // Get subscriptions for the original sender
    const subscriptions = await storage.getPushSubscriptionsByUserId(originalSenderUserId);
    
    if (subscriptions.length === 0) {
      return;
    }

    // Get accepter's name
    const accepter = await storage.getUser(accepterUserId);
    const accepterName = accepter?.name || accepter?.username || 'Alguien';

    // Prepare notification payload
    const payload = {
      title: '✅ Solicitud aceptada',
      body: `${accepterName} aceptó tu solicitud de amistad`,
      tag: 'friend-accepted',
      data: {
        url: '/friends',
        type: 'friend_accepted',
        friendId: accepterUserId,
      },
    };

    // Convert subscriptions to push format
    const pushSubs = subscriptions.map((sub) => ({
      endpoint: sub.endpoint,
      keys: {
        p256dh: sub.p256dh,
        auth: sub.auth,
      },
    }));

    // Send notifications
    await sendPushToUser(
      pushSubs,
      payload,
      env.VAPID_PUBLIC_KEY || '',
      env.VAPID_PRIVATE_KEY || '',
      env.VAPID_SUBJECT || 'mailto:notifications@runna.io'
    );

    console.log(`✅ Sent friend accepted notification to user ${originalSenderUserId}`);
  } catch (error) {
    console.error('Error sending friend accepted notification:', error);
  }
}

// Notify friends when a user uploads a new activity
export async function notifyFriendNewActivity(
  storage: WorkerStorage,
  activityUserId: string,
  distanceKm: number,
  newAreaKm2: number,
  env: any
): Promise<void> {
  try {
    const user = await storage.getUser(activityUserId);
    const userName = user?.name || user?.username || 'Un amigo';

    const friendIds = await storage.getFriendIds(activityUserId);
    if (friendIds.length === 0) return;

    const distanceText = distanceKm.toFixed(1);
    const areaText = newAreaKm2.toFixed(2);

    const payload = {
      title: `🏃 ${userName} ha salido a correr`,
      body: `${distanceText} km recorridos — ${areaText} km² de área nueva`,
      tag: `friend-activity-${activityUserId}`,
      data: {
        url: '/',
        type: 'friend_activity',
        userId: activityUserId,
      },
    };

    // Send to all friends who have push enabled
    for (const friendId of friendIds) {
      try {
        const subscriptions = await storage.getPushSubscriptionsByUserId(friendId);
        if (subscriptions.length === 0) continue;

        const pushSubs = subscriptions.map((sub) => ({
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        }));

        await sendPushToUser(
          pushSubs,
          payload,
          env.VAPID_PUBLIC_KEY || '',
          env.VAPID_PRIVATE_KEY || '',
          env.VAPID_SUBJECT || 'mailto:notifications@runna.io'
        );
      } catch (friendErr) {
        console.error(`Error sending activity notification to friend ${friendId}:`, friendErr);
      }
    }

    console.log(`✅ Sent activity notification to ${friendIds.length} friends of ${activityUserId}`);
  } catch (error) {
    console.error('Error sending friend activity notification:', error);
  }
}

// Notify a user when someone overtakes them in total area
export async function notifyAreaOvertake(
  storage: WorkerStorage,
  overtakerUserId: string,
  victimUserId: string,
  overtakerAreaKm2: number,
  env: any
): Promise<void> {
  try {
    const subscriptions = await storage.getPushSubscriptionsByUserId(victimUserId);
    if (subscriptions.length === 0) return;

    const overtaker = await storage.getUser(overtakerUserId);
    const overtakerName = overtaker?.name || overtaker?.username || 'Alguien';

    const payload = {
      title: '📊 ¡Te han superado en área!',
      body: `${overtakerName} ahora tiene ${overtakerAreaKm2.toFixed(2)} km² y te ha adelantado`,
      tag: `area-overtake-${overtakerUserId}`,
      data: {
        url: '/',
        type: 'area_overtake',
        userId: overtakerUserId,
      },
    };

    const pushSubs = subscriptions.map((sub) => ({
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth },
    }));

    await sendPushToUser(
      pushSubs,
      payload,
      env.VAPID_PUBLIC_KEY || '',
      env.VAPID_PRIVATE_KEY || '',
      env.VAPID_SUBJECT || 'mailto:notifications@runna.io'
    );

    console.log(`✅ Sent area overtake notification to ${victimUserId}`);
  } catch (error) {
    console.error('Error sending area overtake notification:', error);
  }
}

/**
 * Send push notification when someone reacts (like/dislike) to a post or comment.
 */
export async function notifyReaction(
  storage: WorkerStorage,
  reactorUserId: string,
  targetOwnerId: string,
  reactionType: 'like' | 'dislike',
  targetType: 'event' | 'comment',
  env: any
): Promise<void> {
  try {
    // Don't notify yourself
    if (reactorUserId === targetOwnerId) return;

    const subscriptions = await storage.getPushSubscriptionsByUserId(targetOwnerId);
    if (subscriptions.length === 0) return;

    const reactor = await storage.getUser(reactorUserId);
    const reactorName = reactor?.name || 'Alguien';

    const emoji = reactionType === 'like' ? '👍' : '👎';
    const actionText = reactionType === 'like' ? 'le gustó' : 'no le gustó';
    const targetText = targetType === 'event' ? 'tu publicación' : 'tu comentario';

    const payload = {
      title: `${emoji} ${reactorName} reaccionó`,
      body: `A ${reactorName} ${actionText} ${targetText}`,
      tag: `reaction-${targetType}-${reactionType}`,
      data: {
        url: '/',
        type: 'reaction',
        reactorId: reactorUserId,
      },
    };

    const pushSubs = subscriptions.map((sub) => ({
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth },
    }));

    await sendPushToUser(
      pushSubs,
      payload,
      env.VAPID_PUBLIC_KEY || '',
      env.VAPID_PRIVATE_KEY || '',
      env.VAPID_SUBJECT || 'mailto:notifications@runna.io'
    );

    console.log(`✅ Sent reaction notification to ${targetOwnerId} from ${reactorName}`);
  } catch (error) {
    console.error('Error sending reaction notification:', error);
  }
}

/**
 * Send push notification when someone comments on a post.
 */
export async function notifyComment(
  storage: WorkerStorage,
  commenterUserId: string,
  postOwnerId: string,
  commentText: string,
  env: any
): Promise<void> {
  try {
    // Don't notify yourself
    if (commenterUserId === postOwnerId) return;

    const subscriptions = await storage.getPushSubscriptionsByUserId(postOwnerId);
    if (subscriptions.length === 0) return;

    const commenter = await storage.getUser(commenterUserId);
    const commenterName = commenter?.name || 'Alguien';

    const preview = commentText.length > 60 ? commentText.substring(0, 60) + '...' : commentText;

    const payload = {
      title: `💬 ${commenterName} comentó`,
      body: preview,
      tag: 'comment',
      data: {
        url: '/',
        type: 'comment',
        commenterId: commenterUserId,
      },
    };

    const pushSubs = subscriptions.map((sub) => ({
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth },
    }));

    await sendPushToUser(
      pushSubs,
      payload,
      env.VAPID_PUBLIC_KEY || '',
      env.VAPID_PRIVATE_KEY || '',
      env.VAPID_SUBJECT || 'mailto:notifications@runna.io'
    );

    console.log(`✅ Sent comment notification to ${postOwnerId} from ${commenterName}`);
  } catch (error) {
    console.error('Error sending comment notification:', error);
  }
}
