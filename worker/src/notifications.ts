import type { WorkerStorage } from './storage';
import { sendPushToUser } from './pushHelper';

export async function notifyTerritoryLoss(
  storage: WorkerStorage,
  victimUserId: string,
  conquerorUserId: string,
  env: any
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

    // Prepare notification payload
    const payload = {
      title: '🚨 ¡Te han conquistado territorio!',
      body: `${conquerorName} acaba de conquistar parte de tu territorio`,
      tag: 'territory-loss',
      data: {
        url: '/mapa',
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
