import Foundation
import Security

/// What the home screen widget shows, written by the app and read by the RunnaLive extension.
/// It travels through a keychain item in a shared access group (no App Group needed).
struct RunnaWidgetSnapshot: Codable, Equatable {
    var name: String
    /// Territory colour ("#RRGGBB").
    var colorHex: String
    var totalArea: Double
    /// Monday 00:00 of the week the figures below belong to.
    var weekStart: Date?
    var weekArea: Double = 0
    var weekDistance: Double = 0
    var weekRuns: Int = 0
    /// Position among friends this week (nil when unknown).
    var weekRank: Int?
    var weekPlayers: Int = 0
    /// Who leads the week, when it isn't you.
    var weekLeaderName: String?
    var lastRunAt: Date?
    var updatedAt: Date = Date()
}

extension RunnaWidgetSnapshot {
    private static let spanish = Locale(identifier: "es_ES")

    /// Monday 00:00 (Spain) of the week containing `date`.
    static func weekStart(of date: Date) -> Date {
        var calendar = Calendar(identifier: .iso8601)
        calendar.timeZone = TimeZone(identifier: "Europe/Madrid") ?? .current
        return calendar.dateInterval(of: .weekOfYear, for: date)?.start ?? date
    }

    /// The week's figures still apply (a new week starts at zero until the app updates them).
    func isCurrentWeek(at date: Date = Date()) -> Bool {
        guard let weekStart else { return false }
        return weekStart >= Self.weekStart(of: date).addingTimeInterval(-60)
    }

    /// "1,25 km²" from 0,05 km² up, "3.400 m²" below (same rule as the app).
    static func areaText(_ squareMeters: Double) -> String {
        let km2 = abs(squareMeters) / 1_000_000
        if km2 >= 0.05 {
            return "\(km2.formatted(.number.precision(.fractionLength(2)).locale(spanish))) km²"
        }
        return "\(squareMeters.rounded().formatted(.number.precision(.fractionLength(0)).locale(spanish))) m²"
    }

    /// "12,4 km" or "800 m".
    static func distanceText(_ meters: Double) -> String {
        if meters >= 1000 {
            return "\((meters / 1000).formatted(.number.precision(.fractionLength(1)).locale(spanish))) km"
        }
        return "\(Int(meters.rounded())) m"
    }
}

/// What the widgets need to ask the server by themselves: the session of the logged-in account.
struct WidgetCredentials: Codable, Equatable {
    let token: String
    let userId: String
    let baseURL: String
}

enum WidgetSnapshotStore {
    /// Keychain access group shared by the app and the widget (team prefix added at run time).
    static let groupSuffix = "com.jpoves.runnaio.shared"
    private static let service = "io.runna.widget"
    private static let snapshotAccount = "snapshot"
    private static let credentialsAccount = "credentials"

    static func load() -> RunnaWidgetSnapshot? {
        read(snapshotAccount).flatMap { try? JSONDecoder().decode(RunnaWidgetSnapshot.self, from: $0) }
    }

    @discardableResult
    static func save(_ snapshot: RunnaWidgetSnapshot) -> Bool {
        guard let data = try? JSONEncoder().encode(snapshot) else { return false }
        return write(snapshotAccount, data)
    }

    static func loadCredentials() -> WidgetCredentials? {
        read(credentialsAccount).flatMap { try? JSONDecoder().decode(WidgetCredentials.self, from: $0) }
    }

    @discardableResult
    static func saveCredentials(_ credentials: WidgetCredentials) -> Bool {
        guard let data = try? JSONEncoder().encode(credentials) else { return false }
        return write(credentialsAccount, data)
    }

    /// Logout: the widgets forget the account and go back to "Abre Runna.io".
    static func clear() {
        delete(snapshotAccount)
        delete(credentialsAccount)
    }

    // MARK: Keychain

    private static func baseQuery(_ account: String) -> [String: Any]? {
        guard let group = accessGroup else { return nil }
        return [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessGroup as String: group,
        ]
    }

    private static func read(_ account: String) -> Data? {
        guard var query = baseQuery(account) else { return nil }
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        lastStatus = status
        guard status == errSecSuccess else { return nil }
        return item as? Data
    }

    /// Result of the last keychain read/write (for the "Widgets" diagnosis in the app).
    private(set) static var lastStatus: OSStatus = errSecSuccess

    /// Why the shared keychain can't be used, or nil when it works.
    static var problem: String? {
        guard teamPrefix != nil else { return "no se encuentra el equipo de la app en el llavero" }
        if lastStatus != errSecSuccess && lastStatus != errSecItemNotFound {
            return "llavero compartido: error \(lastStatus)"
        }
        return nil
    }

    private static func write(_ account: String, _ data: Data) -> Bool {
        guard let query = baseQuery(account) else {
            lastStatus = errSecMissingEntitlement
            return false
        }
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            // The widgets refresh while the phone is locked
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]
        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var insert = query
            insert.merge(attributes) { _, new in new }
            status = SecItemAdd(insert as CFDictionary, nil)
        }
        lastStatus = status
        return status == errSecSuccess
    }

    private static func delete(_ account: String) {
        guard let query = baseQuery(account) else { return }
        SecItemDelete(query as CFDictionary)
    }

    private static var accessGroup: String? {
        teamPrefix.map { "\($0).\(groupSuffix)" }
    }

    /// The team ID ("ABCDE12345"), read from the access group the keychain gives a probe item
    /// (the entitlements carry it, but there's no API to read them on iOS).
    private static let teamPrefix: String? = {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "io.runna.team-probe",
            kSecAttrAccount as String: "probe",
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]
        var lookup = query
        lookup[kSecReturnAttributes as String] = true
        lookup[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        var status = SecItemCopyMatching(lookup as CFDictionary, &item)
        if status == errSecItemNotFound {
            var add = query
            add[kSecReturnAttributes as String] = true
            status = SecItemAdd(add as CFDictionary, &item)
        }
        guard status == errSecSuccess,
              let attributes = item as? [String: Any],
              let group = attributes[kSecAttrAccessGroup as String] as? String,
              let prefix = group.split(separator: ".").first else { return nil }
        return String(prefix)
    }()
}
