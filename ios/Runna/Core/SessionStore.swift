import Foundation
import Observation

/// Login state of the app: the session token (kept in the keychain) and the current user.
@MainActor
@Observable
final class SessionStore {
    enum State: Equatable {
        case loading
        case loggedOut
        case loggedIn
    }

    /// Sign-up waiting for the 6-digit code emailed to the address: the account is only created
    /// once the code is confirmed. Kept in the keychain so it survives going to the Mail app.
    struct PendingVerification: Codable, Equatable {
        let email: String
        let createdAt: Date
    }

    /// What older versions kept while the email was unverified (the account already existed then).
    private struct LegacyPendingVerification: Decodable {
        let token: String
    }

    private(set) var state: State = .loading
    private(set) var user: AppUser?
    private(set) var pendingVerification: PendingVerification?

    private let api = APIClient.shared
    private let tokenKey = "sessionToken"
    private let userIdKey = "sessionUserId"
    private let cachedUserKey = "cachedUser"
    private let pendingKey = "pendingSignup"
    private let legacyPendingKey = "pendingVerification"
    /// How long the "verify your email" screen is kept after registering (the server keeps the
    /// sign-up for a day, so a new code can still be requested).
    private let pendingValidity: TimeInterval = 24 * 60 * 60

    init() {
        api.onUnauthorized = { [weak self] in
            self?.endSession()
        }
        // Older versions created the account before the email was verified and kept its token:
        // revoke it (that account can sign in with its password)
        UserDefaults.standard.removeObject(forKey: legacyPendingKey)
        if let text = KeychainStore.get(legacyPendingKey) {
            KeychainStore.delete(legacyPendingKey)
            if let data = text.data(using: .utf8),
               let legacy = try? JSONDecoder().decode(LegacyPendingVerification.self, from: data) {
                Self.revoke(token: legacy.token)
            }
        }
        if let text = KeychainStore.get(pendingKey),
           let data = text.data(using: .utf8),
           let pending = try? JSONDecoder().decode(PendingVerification.self, from: data) {
            if Date().timeIntervalSince(pending.createdAt) < pendingValidity {
                pendingVerification = pending
            } else {
                KeychainStore.delete(pendingKey)
            }
        }
    }

    var userId: String? { user?.id }

    // MARK: - Startup

    /// Restores the saved session, if any.
    func bootstrap() async {
        var savedToken = KeychainStore.get(tokenKey)
        var savedUserId = KeychainStore.get(userIdKey)
        #if DEBUG
        // e2e tests start the app with a session for a seeded test user
        let environment = ProcessInfo.processInfo.environment
        if let token = environment["RUNNA_TEST_TOKEN"], let userId = environment["RUNNA_TEST_USER_ID"] {
            savedToken = token
            savedUserId = userId
        }
        #endif
        guard let token = savedToken, let userId = savedUserId else {
            state = .loggedOut
            return
        }
        api.sessionToken = token
        WidgetSync.storeCredentials(token: token, userId: userId)
        // Cached API responses of another account are never shown
        ResponseCache.shared.setOwner(userId)
        if let data = UserDefaults.standard.data(forKey: cachedUserKey),
           let cached = try? JSONDecoder().decode(AppUser.self, from: data), cached.id == userId {
            user = cached
            state = .loggedIn
        }
        // Register with APNs on every launch (the token can change, and a restored session never went through login)
        Task { await PushManager.shared.registerIfAuthorized() }
        do {
            let fresh: AppUser = try await api.request("GET", "/api/current-user/\(userId)")
            setUser(fresh)
            state = .loggedIn
        } catch let error as APIError where error.status == 401 || error.status == 403 || error.status == 404 {
            endSession()
        } catch {
            // Offline: keep the cached user if we have one
            if user == nil { state = .loggedOut }
        }
    }

    // MARK: - Login / registration

    func login(identifier: String, password: String) async throws {
        let response: AppUser = try await api.request(
            "POST", "/api/auth/login",
            body: ["username": identifier.trimmingCharacters(in: .whitespaces), "password": password]
        )
        guard let token = response.token else {
            throw APIError(status: 0, message: "El servidor no ha devuelto una sesión. Inténtalo más tarde.")
        }
        startSession(user: response, token: token)
    }

    /// Step 1 of sign-up: the server checks that the email and username are free and emails a code.
    /// No account exists until `verifyEmail(code:)`.
    func register(name: String, username: String, email: String, password: String) async throws {
        let response: SignupStartResponse = try await api.request(
            "POST", "/api/auth/register/start",
            body: [
                "name": name.trimmingCharacters(in: .whitespaces),
                "username": username.trimmingCharacters(in: .whitespaces),
                "email": email.trimmingCharacters(in: .whitespaces).lowercased(),
                "password": password,
                "color": AppConfig.userColors.randomElement() ?? "#377EB8",
            ]
        )
        let pending = PendingVerification(
            email: response.email ?? email.trimmingCharacters(in: .whitespaces).lowercased(),
            createdAt: Date()
        )
        pendingVerification = pending
        if let data = try? JSONEncoder().encode(pending), let text = String(data: data, encoding: .utf8) {
            KeychainStore.set(text, for: pendingKey)
        }
    }

    /// Step 2 of sign-up: the code from the email creates the account and signs in.
    func verifyEmail(code: String) async throws {
        guard let pending = pendingVerification else { return }
        let response: AppUser = try await api.request(
            "POST", "/api/auth/register/confirm",
            body: ["email": pending.email, "code": code.trimmingCharacters(in: .whitespaces)]
        )
        guard let token = response.token else {
            throw APIError(status: 0, message: "El servidor no ha devuelto una sesión. Inicia sesión con tu email y contraseña.")
        }
        clearPendingVerification()
        startSession(user: response, token: token)
    }

    // MARK: - Forgot password

    /// Step 1: the server emails a 6-digit code to the account (email or username).
    /// Returns the server's message, which doesn't tell whether the account exists.
    func requestPasswordReset(identifier: String) async throws -> String {
        let response: PasswordResetRequestResponse = try await api.request(
            "POST", "/api/auth/password-reset/request",
            body: ["email": identifier.trimmingCharacters(in: .whitespaces)]
        )
        return response.message ?? "Si hay una cuenta con ese email o usuario, te hemos enviado un código."
    }

    /// Step 2: the code and the new password. Signs in; the account's other sessions are closed.
    func resetPassword(identifier: String, code: String, newPassword: String) async throws {
        let response: AppUser = try await api.request(
            "POST", "/api/auth/password-reset/confirm",
            body: [
                "email": identifier.trimmingCharacters(in: .whitespaces),
                "code": code.trimmingCharacters(in: .whitespaces),
                "password": newPassword,
            ]
        )
        guard let token = response.token else {
            throw APIError(status: 0, message: "El servidor no ha devuelto una sesión. Inicia sesión con tu nueva contraseña.")
        }
        clearPendingVerification()
        startSession(user: response, token: token)
    }

    func resendVerificationCode() async throws {
        guard let pending = pendingVerification else { return }
        try await api.send("POST", "/api/auth/register/resend", body: ["email": pending.email])
    }

    /// Back to the sign-up form (e.g. a mistyped email): nothing was created on the server.
    func cancelVerification() {
        clearPendingVerification()
    }

    /// Called when the app comes back to the foreground.
    func appBecameActive() {
        guard state == .loggedIn else { return }
        // Permission may have been granted in Settings meanwhile
        Task { await PushManager.shared.registerIfAuthorized() }
    }

    // MARK: - Account

    /// - Parameter force: false skips the request when the account was fetched moments ago
    ///   (switching tabs) and nothing changed since.
    func refreshUser(force: Bool = true) async {
        guard let userId else { return }
        let path = "/api/current-user/\(userId)"
        if !force && api.isCacheFresh(path) { return }
        if let fresh: AppUser = try? await api.request("GET", path) {
            // The account may have changed while waiting
            guard self.userId == userId else { return }
            setUser(fresh)
        }
    }

    func updateProfile(name: String? = nil, color: String? = nil) async throws {
        guard let userId else { return }
        var body: [String: Any] = [:]
        if let name { body["name"] = name }
        if let color { body["color"] = color }
        let _: AppUser = try await api.request("PATCH", "/api/users/\(userId)", body: body)
        await refreshUser()
    }

    func uploadAvatar(jpegData: Data) async throws {
        struct AvatarResponse: Decodable { let avatar: String? }
        let _: AvatarResponse = try await api.upload(
            "/api/user/avatar", fileField: "avatar", fileName: "avatar.jpg", mimeType: "image/jpeg", fileData: jpegData
        )
        await refreshUser()
    }

    func removeAvatar() async throws {
        try await api.send("DELETE", "/api/user/avatar", body: [:])
        await refreshUser()
    }

    func logout() async {
        // Last chance to upload runs recorded offline (they're deleted from the device on logout)
        if PendingRuns.pendingCount > 0 {
            _ = await PendingRuns.uploadAll()
        }
        await PushManager.shared.unregisterDevice()
        try? await api.send("POST", "/api/auth/logout")
        AppRouter.shared.pendingInviteToken = nil
        endSession(clearDeviceData: true)
    }

    /// Permanently deletes the account and all its data (required by the App Store).
    func deleteAccount() async throws {
        guard let userId else { return }
        await PushManager.shared.unregisterDevice()
        try await api.send("DELETE", "/api/users/\(userId)")
        AppRouter.shared.pendingInviteToken = nil
        endSession(clearDeviceData: true)
    }

    // MARK: - Internals

    private func startSession(user: AppUser, token: String) {
        ResponseCache.shared.setOwner(user.id)
        KeychainStore.set(token, for: tokenKey)
        KeychainStore.set(user.id, for: userIdKey)
        api.sessionToken = token
        WidgetSync.storeCredentials(token: token, userId: user.id)
        setUser(user)
        state = .loggedIn
        Task {
            // Before the onboarding is done, its last page asks for permission in context
            if UserDefaults.standard.bool(forKey: OnboardingView.doneKey) {
                await PushManager.shared.registerIfAllowed()
            } else {
                await PushManager.shared.registerIfAuthorized()
            }
        }
    }

    private func setUser(_ user: AppUser) {
        var stored = user
        stored.token = nil
        // Assigning an identical user would redraw every screen that shows it
        guard self.user != stored else { return }
        self.user = stored
        WidgetSync.update(user: stored)
        if let data = try? JSONEncoder().encode(stored) {
            UserDefaults.standard.set(data, forKey: cachedUserKey)
        }
    }

    /// Forgets the session locally (logout, deleted account, or a token the server rejected).
    /// - Parameter clearDeviceData: also deletes the runs waiting to be uploaded and the unfinished run
    ///   (explicit logout or account deletion). When the server rejects the token they are kept: they are tagged
    ///   with their owner, so another account never uploads them, and the same user gets them back after logging in.
    func endSession(clearDeviceData: Bool = false) {
        KeychainStore.delete(tokenKey)
        KeychainStore.delete(userIdKey)
        UserDefaults.standard.removeObject(forKey: cachedUserKey)
        api.sessionToken = nil
        user = nil
        state = .loggedOut

        if clearDeviceData {
            PendingRuns.forgetAll()
        }
        // Cached screens and API responses belong to this account
        ResponseCache.shared.removeAll()
        ResponseCache.shared.clearOwner()
        TabPrefetcher.reset()
        MapModel.shared.reset()
        RankingsModel.shared.reset()
        FeedModel.shared.reset()
        MyRoutesModel.shared.reset()
        FriendsModel.shared.reset()
        ProfileModel.shared.reset()
        CompetitionStore.shared.clear()
        ActivityMapSnapshots.removeAll()
        RemoteImageCache.shared.removeAll()
        ConquestInbox.shared.reset()
        // Apple Health auto-import is a device setting: the next account must opt in again,
        // otherwise the device owner's workouts would be uploaded to it.
        HealthImporter.shared.autoImport = false
        HealthImporter.shared.saveRuns = false
        WidgetSync.clear()
        AppRouter.shared.reset()
        PushManager.shared.clearDelivered()
    }

    private func clearPendingVerification() {
        pendingVerification = nil
        KeychainStore.delete(pendingKey)
    }

    /// Revokes a session token on the server (abandoned registration), without waiting.
    private static func revoke(token: String) {
        Task {
            try? await APIClient.shared.send("POST", "/api/auth/logout", token: token)
        }
    }
}

private struct PasswordResetRequestResponse: Decodable {
    let message: String?
}

private struct SignupStartResponse: Decodable {
    let email: String?
    let message: String?
}
