import UIKit
import UserNotifications

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        NotificationAction.registerCategories()
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { @MainActor in
            PushManager.shared.didRegister(deviceToken: deviceToken)
        }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        #if DEBUG
        print("Remote notification registration failed:", error)
        #endif
        Task { @MainActor in
            PushManager.shared.didFailToRegister(error)
        }
    }

    // Show notifications while the app is open, and refresh the screens that depend on them
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        let payload = NotificationPayload(userInfo: notification.request.content.userInfo)
        Task { @MainActor in
            AppRouter.shared.receivedNotificationInForeground(payload)
        }
        completionHandler([.banner, .sound, .list])
    }

    // Tapping a notification opens the matching tab (or runs the button that was pressed)
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let payload = NotificationPayload(userInfo: response.notification.request.content.userInfo)
        let action = response.actionIdentifier
        Task { @MainActor in
            if action == UNNotificationDefaultActionIdentifier || action == UNNotificationDismissActionIdentifier {
                AppRouter.shared.openNotification(payload)
            } else {
                await AppRouter.shared.handleNotificationAction(action, payload: payload)
            }
            completionHandler()
        }
    }
}
