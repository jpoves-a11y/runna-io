import Foundation
import Security

/// The session the home-screen widget uses to ask the API for its summary. The app writes it to a
/// keychain group shared with the widget extension (keychain-access-groups in both entitlements) when
/// the user signs in or the app starts, and removes it on sign-out.
enum SharedSession {
    struct Value: Codable {
        let token: String
        let userId: String
        let apiBaseURL: String
    }

    private static let service = "io.runna.shared-session"
    private static let account = "session"
    static let defaultAPIBaseURL = "https://runna-io-api.runna-io-api.workers.dev"

    /// "<team id>.com.jpoves.runnaio.shared". The team id comes from Info.plist ($(AppIdentifierPrefix),
    /// filled in when Xcode signs the build) or, in builds signed later (the TestFlight workflow archives
    /// unsigned), from the access group the keychain gives a probe item.
    static let accessGroup: String? = {
        if let prefix = Bundle.main.object(forInfoDictionaryKey: "AppIdentifierPrefix") as? String,
           prefix.count > 2, !prefix.contains("$(") {
            return "\(prefix)com.jpoves.runnaio.shared"
        }
        guard let team = teamIdFromKeychain() else { return nil }
        return "\(team).com.jpoves.runnaio.shared"
    }()

    private static func teamIdFromKeychain() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "io.runna.team-probe",
            kSecAttrAccount as String: "probe",
            kSecReturnAttributes as String: true,
        ]
        var result: CFTypeRef?
        var status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound {
            var insert = query
            insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            status = SecItemAdd(insert as CFDictionary, &result)
        }
        guard status == errSecSuccess,
              let attributes = result as? [String: Any],
              let group = attributes[kSecAttrAccessGroup as String] as? String,
              let team = group.split(separator: ".").first, team.count >= 10 else { return nil }
        return String(team)
    }

    private static func baseQuery() -> [String: Any]? {
        guard let accessGroup else { return nil }
        return [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessGroup as String: accessGroup,
        ]
    }

    static func save(_ value: Value) {
        guard let query = baseQuery(), let data = try? JSONEncoder().encode(value) else { return }
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            // The widget refreshes in the background, after the first unlock
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var insert = query
            insert.merge(attributes) { _, new in new }
            SecItemAdd(insert as CFDictionary, nil)
        }
    }

    static func load() -> Value? {
        guard var query = baseQuery() else { return nil }
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return try? JSONDecoder().decode(Value.self, from: data)
    }

    static func clear() {
        guard let query = baseQuery() else { return }
        SecItemDelete(query as CFDictionary)
    }
}

/// GET /api/widget/summary (the widget extension can't use the app's APIClient).
struct WidgetSummary: Codable, Equatable {
    struct Steal: Codable, Equatable {
        let by: String
        let area: Double
        let at: String
    }

    struct Competition: Codable, Equatable {
        let rank: Int?
        let participants: Int
        let endsAt: String?
    }

    let name: String
    let color: String
    let area: Double
    let city: String?
    let cityRank: Int?
    let streakDays: Int
    let lastSteal: Steal?
    let phase: String
    let nextChangeAt: String?
    let competition: Competition?

    static func fetch() async throws -> WidgetSummary? {
        guard let session = SharedSession.load(),
              let url = URL(string: session.apiBaseURL)?.appendingPathComponent("api/widget/summary") else { return nil }
        var request = URLRequest(url: url)
        request.timeoutInterval = 20
        request.setValue("Bearer \(session.token)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { return nil }
        if http.statusCode == 401 { return nil }
        guard (200..<300).contains(http.statusCode) else { throw URLError(.badServerResponse) }
        return try JSONDecoder().decode(WidgetSummary.self, from: data)
    }

    static let placeholder = WidgetSummary(
        name: "Runna", color: "#0E8A5F", area: 1_250_000, city: "Zaragoza", cityRank: 12, streakDays: 4,
        lastSteal: Steal(by: "Marta", area: 32_000, at: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-7200))),
        phase: "competition", nextChangeAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(2 * 86_400)),
        competition: Competition(rank: 3, participants: 18, endsAt: nil)
    )
}
