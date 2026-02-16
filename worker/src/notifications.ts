import type { WorkerStorage } from './storage';
import { sendPushToUser } from './pushHelper';

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
    const conquerorName = conqueror?.name || conqueror?.username || 'Alguien';

    // Include km² in notification body
    const areaText = stolenAreaM2 
      ? ` ${(stolenAreaM2 / 1000000).toFixed(2)} km² de` 
      : ' parte de';

    // Prepare notification payload
    const payload = {
      title: '🚨 ¡Te han robado territorio!',
      body: `${conquerorName} te ha robado${areaText} tu territorio`,
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
        url: '/amigos',
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
        url: '/amigos',
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
