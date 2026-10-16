import UIKit
import UserNotifications

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
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
    }

    // Show notifications while the app is open, and refresh the screens that depend on them
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        let payload = Self.payload(from: notification.request.content.userInfo)
        Task { @MainActor in
            AppRouter.shared.receivedNotificationInForeground(type: payload.type, routeId: payload.routeId)
        }
        completionHandler([.banner, .sound, .list])
    }

    // Tapping a notification opens the matching tab
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let payload = Self.payload(from: response.notification.request.content.userInfo)
        Task { @MainActor in
            AppRouter.shared.openNotification(type: payload.type, routeId: payload.routeId)
        }
        completionHandler()
    }

    /// Reads "type" and data.routeId from the APNs payload ({aps, type, data: {type, url, routeId?, photoId?}}).
    private static func payload(from userInfo: [AnyHashable: Any]) -> (type: String?, routeId: String?) {
        let data = userInfo["data"] as? [String: Any]
        let type = (userInfo["type"] as? String) ?? (data?["type"] as? String)
        var routeId = (data?["routeId"] as? String) ?? (userInfo["routeId"] as? String)
        if routeId == nil, let number = data?["routeId"] as? NSNumber {
            routeId = number.stringValue
        }
        return (type, routeId)
    }
}
