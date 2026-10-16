import UIKit
import UserNotifications

/// Push notifications through APNs: permission, device registration with the API, and cleanup on logout.
@MainActor
final class PushManager {
    static let shared = PushManager()

    private let deviceTokenKey = "apnsDeviceToken"
    private(set) var deviceToken: String?

    private init() {
        deviceToken = UserDefaults.standard.string(forKey: deviceTokenKey)
    }

    func authorizationStatus() async -> UNAuthorizationStatus {
        await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }

    /// Asks for permission (if not decided yet) and registers with APNs. Returns whether notifications are allowed.
    @discardableResult
    func requestPermissionAndRegister() async -> Bool {
        let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        if granted {
            UIApplication.shared.registerForRemoteNotifications()
        }
        return granted
    }

    /// Called after login: registers silently when already allowed, asks when the user hasn't decided yet.
    func registerIfAllowed() async {
        switch await authorizationStatus() {
        case .authorized, .provisional, .ephemeral:
            UIApplication.shared.registerForRemoteNotifications()
        case .notDetermined:
            await requestPermissionAndRegister()
        default:
            break
        }
    }

    /// Registers with APNs without ever showing the permission prompt (app launch, back to foreground).
    /// Apple recommends registering on every launch: the token can change, and permission may have been
    /// granted later in Settings.
    func registerIfAuthorized() async {
        guard APIClient.shared.sessionToken != nil else { return }
        switch await authorizationStatus() {
        case .authorized, .provisional, .ephemeral:
            UIApplication.shared.registerForRemoteNotifications()
        default:
            break
        }
    }

    /// Asks the server to send a test notification to every device of the user.
    func sendTestNotification() async throws {
        try await APIClient.shared.send("POST", "/api/push/test", body: [:])
    }

    func didRegister(deviceToken data: Data) {
        let token = data.map { String(format: "%02x", $0) }.joined()
        deviceToken = token
        UserDefaults.standard.set(token, forKey: deviceTokenKey)
        Task { await sendTokenToServer(token) }
    }

    private func sendTokenToServer(_ token: String) async {
        guard APIClient.shared.sessionToken != nil else { return }
        #if DEBUG
        let environment = "sandbox"
        #else
        let environment = "production"
        #endif
        do {
            try await APIClient.shared.send(
                "POST", "/api/push/apns/register",
                body: ["deviceToken": token, "environment": environment]
            )
        } catch {
            #if DEBUG
            print("APNs registration failed:", error)
            #endif
        }
    }

    /// Stops notifications for this device (before logging out or deleting the account).
    func unregisterDevice() async {
        guard let token = deviceToken else { return }
        try? await APIClient.shared.send("POST", "/api/push/apns/unregister", body: ["deviceToken": token])
    }

    /// Clears the app icon badge and delivered notifications (logout).
    func clearDelivered() {
        let center = UNUserNotificationCenter.current()
        center.removeAllDeliveredNotifications()
        center.setBadgeCount(0, withCompletionHandler: nil)
    }
}
