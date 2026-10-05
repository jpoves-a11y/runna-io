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

    /// Account created but email not verified yet. The registration token is only used to verify it.
    struct PendingVerification: Codable, Equatable {
        let userId: String
        let email: String
        let token: String
        let createdAt: Date
    }

    private(set) var state: State = .loading
    private(set) var user: AppUser?
    private(set) var pendingVerification: PendingVerification?

    private let api = APIClient.shared
    private let tokenKey = "sessionToken"
    private let userIdKey = "sessionUserId"
    private let cachedUserKey = "cachedUser"
    private let pendingKey = "pendingVerification"

    init() {
        api.onUnauthorized = { [weak self] in
            self?.endSession()
        }
        if let data = UserDefaults.standard.data(forKey: pendingKey),
           let pending = try? JSONDecoder().decode(PendingVerification.self, from: data),
           Date().timeIntervalSince(pending.createdAt) < 10 * 60 {
            pendingVerification = pending
        }
    }

    var userId: String? { user?.id }

    // MARK: - Startup

    /// Restores the saved session, if any.
    func bootstrap() async {
        guard let token = KeychainStore.get(tokenKey), let userId = KeychainStore.get(userIdKey) else {
            state = .loggedOut
            return
        }
        api.sessionToken = token
        if let data = UserDefaults.standard.data(forKey: cachedUserKey),
           let cached = try? JSONDecoder().decode(AppUser.self, from: data), cached.id == userId {
            user = cached
            state = .loggedIn
        }
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

    func register(name: String, username: String, email: String, password: String) async throws {
        let response: AppUser = try await api.request(
            "POST", "/api/users",
            body: [
                "name": name.trimmingCharacters(in: .whitespaces),
                "username": username.trimmingCharacters(in: .whitespaces),
                "email": email.trimmingCharacters(in: .whitespaces).lowercased(),
                "password": password,
                "color": AppConfig.userColors.randomElement() ?? "#377EB8",
            ]
        )
        guard let token = response.token else {
            throw APIError(status: 0, message: "El servidor no ha devuelto una sesión. Inténtalo más tarde.")
        }
        if response.requiresVerification == true {
            let pending = PendingVerification(userId: response.id, email: response.email ?? email, token: token, createdAt: Date())
            pendingVerification = pending
            if let data = try? JSONEncoder().encode(pending) {
                UserDefaults.standard.set(data, forKey: pendingKey)
            }
        } else {
            startSession(user: response, token: token)
        }
    }

    func verifyEmail(code: String) async throws {
        guard let pending = pendingVerification else { return }
        try await api.send(
            "POST", "/api/auth/verify-email",
            body: ["code": code.trimmingCharacters(in: .whitespaces)],
            token: pending.token
        )
        let user: AppUser = try await api.request("GET", "/api/current-user/\(pending.userId)", token: pending.token)
        clearPendingVerification()
        startSession(user: user, token: pending.token)
    }

    func resendVerificationCode() async throws {
        guard let pending = pendingVerification else { return }
        try await api.send("POST", "/api/auth/resend-verification", body: [:], token: pending.token)
    }

    func cancelVerification() {
        clearPendingVerification()
    }

    // MARK: - Account

    func refreshUser() async {
        guard let userId else { return }
        if let fresh: AppUser = try? await api.request("GET", "/api/current-user/\(userId)") {
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
        await PushManager.shared.unregisterDevice()
        try? await api.send("POST", "/api/auth/logout")
        endSession()
    }

    /// Permanently deletes the account and all its data (required by the App Store).
    func deleteAccount() async throws {
        guard let userId else { return }
        await PushManager.shared.unregisterDevice()
        try await api.send("DELETE", "/api/users/\(userId)")
        endSession()
    }

    // MARK: - Internals

    private func startSession(user: AppUser, token: String) {
        KeychainStore.set(token, for: tokenKey)
        KeychainStore.set(user.id, for: userIdKey)
        api.sessionToken = token
        setUser(user)
        state = .loggedIn
        Task { await PushManager.shared.registerIfAllowed() }
    }

    private func setUser(_ user: AppUser) {
        var stored = user
        stored.token = nil
        self.user = stored
        if let data = try? JSONEncoder().encode(stored) {
            UserDefaults.standard.set(data, forKey: cachedUserKey)
        }
    }

    /// Forgets the session locally (logout, deleted account, or a token the server rejected).
    func endSession() {
        KeychainStore.delete(tokenKey)
        KeychainStore.delete(userIdKey)
        UserDefaults.standard.removeObject(forKey: cachedUserKey)
        api.sessionToken = nil
        user = nil
        state = .loggedOut
    }

    private func clearPendingVerification() {
        pendingVerification = nil
        UserDefaults.standard.removeObject(forKey: pendingKey)
    }
}
