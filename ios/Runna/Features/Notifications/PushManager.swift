import UIKit
import UserNotifications

/// Push notifications through APNs: permission, device registration with the API, and cleanup on logout.
@MainActor
final class PushManager {
    static let shared = PushManager()

    private let deviceTokenKey = "apnsDeviceToken"
    private(set) var deviceToken: String?
    /// Why iOS couldn't give us a device token, or why the server didn't accept it (diagnostics).
    private(set) var registrationError: String?

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

    /// Asks the server to send a test notification to every device of the user. When nothing could
    /// be delivered the server answers with an error whose message explains why (APNs not configured
    /// on the server, this iPhone not registered, Apple's rejection reason…).
    func sendTestNotification() async throws {
        try await APIClient.shared.send("POST", "/api/push/test", body: [:])
    }

    /// GET /api/push/status: whether the server can send notifications and which devices it knows.
    func fetchStatus() async throws -> PushServerStatus {
        try await APIClient.shared.request("GET", "/api/push/status", as: PushServerStatus.self)
    }

    /// True when the server lists this iPhone's current device token.
    func isRegistered(in status: PushServerStatus) -> Bool {
        guard let token = deviceToken else { return false }
        return status.devices.contains { device in
            guard let suffix = device.tokenSuffix, !suffix.isEmpty else { return false }
            return token.hasSuffix(suffix)
        }
    }

    /// Registers again with APNs and, if a token is already known, sends it to the server right
    /// away. Returns whether the server accepted it.
    @discardableResult
    func retryRegistration() async -> Bool {
        switch await authorizationStatus() {
        case .authorized, .provisional, .ephemeral:
            UIApplication.shared.registerForRemoteNotifications()
        case .notDetermined:
            await requestPermissionAndRegister()
        default:
            registrationError = "Las notificaciones están desactivadas para Runna.io en Ajustes."
            return false
        }
        guard let token = deviceToken else { return false }
        return await sendTokenToServer(token)
    }

    func didRegister(deviceToken data: Data) {
        let token = data.map { String(format: "%02x", $0) }.joined()
        deviceToken = token
        UserDefaults.standard.set(token, forKey: deviceTokenKey)
        Task { await sendTokenToServer(token) }
    }

    func didFailToRegister(_ error: Error) {
        registrationError = "iOS no ha podido registrar el iPhone para notificaciones: \(error.localizedDescription)"
    }

    @discardableResult
    private func sendTokenToServer(_ token: String) async -> Bool {
        guard APIClient.shared.sessionToken != nil else { return false }
        do {
            try await APIClient.shared.send(
                "POST", "/api/push/apns/register",
                body: ["deviceToken": token, "environment": Self.apnsEnvironment]
            )
            registrationError = nil
            return true
        } catch {
            registrationError = "El servidor no ha aceptado el registro de este iPhone: \(error.localizedDescription)"
            return false
        }
    }

    /// APNs environment the device token belongs to. It follows the aps-environment entitlement the
    /// app was *signed* with, not the build configuration: Xcode development builds are "sandbox",
    /// while TestFlight and App Store builds (re-signed with a distribution profile, which changes the
    /// entitlement to production) are "production". The embedded provisioning profile says which one;
    /// App Store builds have none (production). Should we still guess wrong, the server retries on
    /// the other environment and moves the device.
    nonisolated static let apnsEnvironment: String = {
        #if targetEnvironment(simulator)
        return "sandbox"
        #else
        if let value = provisioningApsEnvironment() {
            return value == "development" ? "sandbox" : "production"
        }
        if Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision") == nil {
            return "production"
        }
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
        #endif
    }()

    /// "development" / "production" from embedded.mobileprovision (a signed plist), or nil.
    nonisolated private static func provisioningApsEnvironment() -> String? {
        guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
              let data = try? Data(contentsOf: url),
              let raw = String(data: data, encoding: .isoLatin1),
              let start = raw.range(of: "<?xml"),
              let end = raw.range(of: "</plist>", range: start.upperBound..<raw.endIndex) else { return nil }
        let plistText = String(raw[start.lowerBound..<end.upperBound])
        guard let plistData = plistText.data(using: .isoLatin1),
              let plist = try? PropertyListSerialization.propertyList(from: plistData, options: [], format: nil) as? [String: Any],
              let entitlements = plist["Entitlements"] as? [String: Any],
              let environment = entitlements["aps-environment"] as? String else { return nil }
        return environment
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

/// GET /api/push/status
struct PushServerStatus: Decodable {
    struct Device: Decodable {
        let environment: String
        let registeredAt: String?
        let tokenSuffix: String?
        let lastError: String?

        enum CodingKeys: String, CodingKey { case environment, registeredAt, tokenSuffix, lastError }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            environment = (try? c.decodeIfPresent(String.self, forKey: .environment)) ?? "production"
            registeredAt = try? c.decodeIfPresent(String.self, forKey: .registeredAt)
            tokenSuffix = try? c.decodeIfPresent(String.self, forKey: .tokenSuffix)
            lastError = try? c.decodeIfPresent(String.self, forKey: .lastError)
        }
    }

    let apnsConfigured: Bool
    let apnsTopic: String?
    let devices: [Device]
    let lastError: String?

    enum CodingKeys: String, CodingKey { case apnsConfigured, apnsTopic, devices, lastError }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        apnsConfigured = (try? c.decodeIfPresent(Bool.self, forKey: .apnsConfigured)) ?? false
        apnsTopic = try? c.decodeIfPresent(String.self, forKey: .apnsTopic)
        devices = (try? c.decodeIfPresent([Device].self, forKey: .devices)) ?? []
        lastError = try? c.decodeIfPresent(String.self, forKey: .lastError)
    }
}
