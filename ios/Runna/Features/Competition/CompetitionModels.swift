import Foundation
import CoreLocation
import Observation
import SwiftUI

// MARK: - Rarity

/// Colours, labels and chest images for treasure / power rarities.
/// Muted, adaptive tones: rarity is a quiet detail (a label colour, a marker ring), never a big fill.
enum Rarity {
    private static let common = Color.adaptive(light: 0x6B7280, dark: 0x9CA3AF)
    private static let rare = Color.adaptive(light: 0x3F6EA8, dark: 0x86A8D6)
    private static let epic = Color.adaptive(light: 0x6A5AA6, dark: 0xA99BDB)

    static func color(_ rarity: String) -> Color {
        switch rarity {
        case "rare": return rare
        case "epic": return epic
        case "legendary": return Color.gold
        default: return common
        }
    }

    static func label(_ rarity: String) -> String {
        switch rarity {
        case "rare": return "Raro"
        case "epic": return "Épico"
        case "legendary": return "Legendario"
        default: return "Común"
        }
    }

    /// Legacy: renders as the flat rarity colour (no gradients in the current direction).
    static func gradient(_ rarity: String) -> LinearGradient {
        let base: Color = color(rarity)
        return LinearGradient(colors: [base, base], startPoint: .top, endPoint: .bottom)
    }

    /// Asset catalogue image (chest_common, chest_rare, chest_epic, chest_legendary).
    static func chestImage(_ rarity: String) -> String {
        switch rarity {
        case "rare", "epic", "legendary": return "chest_\(rarity)"
        default: return "chest_common"
        }
    }
}

/// Rarity as a small uppercase text label in the (muted) rarity colour. No capsule fill.
struct RarityPill: View {
    let rarity: String

    var body: some View {
        Text(Rarity.label(rarity))
            .font(Font.statLabel)
            .textCase(.uppercase)
            .tracking(DS.Tracking.label)
            .foregroundStyle(Rarity.color(rarity))
            .lineLimit(1)
    }
}

/// SF Symbol for each power type (used instead of the API's emoji in our UI chrome).
enum PowerSymbol {
    static func name(_ powerType: String?) -> String {
        switch powerType ?? "" {
        case "shield": return "shield"
        case "double_area": return "plus.square.on.square"
        case "nickname": return "pencil"
        case "steal_boost": return "bolt"
        case "invisibility": return "eye.slash"
        case "time_bomb": return "timer"
        case "magnet": return "magnet"
        case "reveal": return "eye"
        case "bulldozer": return "hammer"
        case "battering_ram": return "burst"
        case "wall": return "square.stack.3d.up"
        case "sentinel": return "bell"
        default: return "sparkle"
        }
    }
}

// MARK: - Powers

/// A power won from a treasure (GET /api/users/:userId/powers).
struct UserPower: Decodable, Identifiable, Hashable {
    let id: String
    let powerType: String
    /// "available", "active", "used" or "expired".
    let status: String
    let activatedAt: String?
    let usedAt: String?
    let expiresAt: String?
    let createdAt: String?
    let definition: PowerDefinition?

    enum CodingKeys: String, CodingKey { case id, powerType, status, activatedAt, usedAt, expiresAt, createdAt, definition }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        powerType = c.string(.powerType) ?? ""
        status = c.string(.status) ?? "available"
        activatedAt = c.string(.activatedAt)
        usedAt = c.string(.usedAt)
        expiresAt = c.string(.expiresAt)
        createdAt = c.string(.createdAt)
        definition = try? c.decodeIfPresent(PowerDefinition.self, forKey: .definition)
    }

    var expiresDate: Date? { APIDate.parse(expiresAt) }
    var name: String { definition?.name ?? powerType }
    var emoji: String { definition?.emoji ?? "✨" }
    var rarity: String { definition?.rarity ?? "common" }

    /// An "active" power whose time limit has passed counts as used.
    var isActive: Bool {
        guard status == "active" else { return false }
        if let expires = expiresDate { return expires > Date() }
        return true
    }

    var isAvailable: Bool { status == "available" }

    /// What an active power is doing right now.
    var activeLabel: String {
        switch powerType {
        case "shield": return "Protegido 24h"
        case "time_bomb": return "Bomba armada 24h"
        case "invisibility": return "Invisible 24h"
        case "wall": return "Fortificación doble 24h"
        case "sentinel": return "Vigilando 24h"
        case "double_area": return "Próxima carrera ×2"
        case "steal_boost": return "Próxima carrera +50% robo"
        case "magnet": return "Próxima carrera +25% absorción"
        case "bulldozer": return "Próxima carrera ignora fortalezas"
        case "battering_ram": return "Próxima carrera fuerza ×3"
        default: return "Activo"
        }
    }
}

struct UserPowersResponse: Decodable {
    let powers: [UserPower]

    enum CodingKeys: String, CodingKey { case powers }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        powers = (try? c.decodeIfPresent([UserPower].self, forKey: .powers)) ?? []
    }
}

/// POST /api/powers/:powerId/activate
struct PowerActivationResponse: Decodable {
    let success: Bool?
    let message: String?
    let expiresAt: String?

    enum CodingKeys: String, CodingKey { case success, message, expiresAt }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        success = c.bool(.success)
        message = c.string(.message)
        expiresAt = c.string(.expiresAt)
    }
}

/// GET /api/competition/participants
struct ParticipantsResponse: Decodable {
    let participants: [UserRef]

    enum CodingKeys: String, CodingKey { case participants }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        participants = (try? c.decodeIfPresent([UserRef].self, forKey: .participants)) ?? []
    }
}

// MARK: - Fortifications

/// GET /api/territories/fortifications
struct FortificationsResponse: Decodable {
    struct Group: Decodable {
        let userId: String
        let layers: Int
        let records: [Record]

        enum CodingKeys: String, CodingKey { case userId, layers, records }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            userId = c.string(.userId) ?? ""
            records = (try? c.decodeIfPresent([Record].self, forKey: .records)) ?? []
            layers = c.int(.layers) ?? records.count
        }
    }

    struct Record: Decodable {
        /// Polygons (outer ring first, then holes) in map coordinates.
        let polygons: [[[CLLocationCoordinate2D]]]
        let area: Double

        enum CodingKeys: String, CodingKey { case geometry, area }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            polygons = GeoJSON.polygons(from: c.jsonObject(.geometry))
            area = c.double(.area) ?? 0
        }
    }

    let fortifications: [Group]

    enum CodingKeys: String, CodingKey { case fortifications }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        fortifications = (try? c.decodeIfPresent([Group].self, forKey: .fortifications)) ?? []
    }
}

// MARK: - Leaderboard

/// Competition leaderboard entry (GET /api/competition/leaderboard).
struct CompetitionEntry: Decodable, Identifiable {
    let user: UserRef
    let totalArea: Double
    let totalDistance: Double
    let activitiesCount: Int
    let treasuresCollected: Int
    let areaStolen: Double
    var id: String { user.id }

    enum CodingKeys: String, CodingKey { case user, totalArea, totalDistance, activitiesCount, treasuresCollected, areaStolen }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        user = try c.decode(UserRef.self, forKey: .user)
        totalArea = c.double(.totalArea) ?? 0
        totalDistance = c.double(.totalDistance) ?? 0
        activitiesCount = c.int(.activitiesCount) ?? 0
        treasuresCollected = c.int(.treasuresCollected) ?? 0
        areaStolen = c.double(.areaStolen) ?? 0
    }
}

struct CompetitionLeaderboardResponse: Decodable {
    let leaderboard: [CompetitionEntry]

    enum CodingKeys: String, CodingKey { case leaderboard }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        leaderboard = (try? c.decodeIfPresent([CompetitionEntry].self, forKey: .leaderboard)) ?? []
    }
}

// MARK: - Weekly summary

/// GET /api/competition/weekly-summary/:weekNumber
struct WeeklySummaryResponse: Decodable {
    let summary: WeeklySummary?
    let weekNumber: Int?

    enum CodingKeys: String, CodingKey { case summary, weekNumber }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        summary = try? c.decodeIfPresent(WeeklySummary.self, forKey: .summary)
        weekNumber = c.int(.weekNumber)
    }
}

struct WeeklySummary: Decodable, Identifiable, Hashable {
    let weekNumber: Int
    let competitionName: String?
    let participantCount: Int?
    let awards: [String: WeeklyAward]
    let ranking: [WeeklyRankEntry]
    var id: Int { weekNumber }

    enum CodingKeys: String, CodingKey { case weekNumber, competitionName, participantCount, awards, ranking }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        weekNumber = c.int(.weekNumber) ?? 1
        competitionName = c.string(.competitionName)
        participantCount = c.int(.participantCount)
        awards = (try? c.decodeIfPresent([String: WeeklyAward].self, forKey: .awards)) ?? [:]
        let entries = (try? c.decodeIfPresent([WeeklyRankEntry].self, forKey: .ranking)) ?? []
        ranking = entries.filter { $0.user != nil }
    }

    /// Awards in display order (the server sends a dictionary).
    static let awardOrder = ["mvp", "territory_king", "conqueror", "marathon", "consistent", "treasure_hunter", "precise", "social"]

    var orderedAwards: [(key: String, award: WeeklyAward)] {
        let known = Self.awardOrder.compactMap { key -> (key: String, award: WeeklyAward)? in
            guard let award = awards[key] else { return nil }
            return (key: key, award: award)
        }
        let others = awards.keys.filter { !Self.awardOrder.contains($0) }.sorted().compactMap { key -> (key: String, award: WeeklyAward)? in
            guard let award = awards[key] else { return nil }
            return (key: key, award: award)
        }
        return known + others
    }
}

struct WeeklyAward: Decodable, Hashable {
    let title: String
    let user: UserRef?
    let value: Double
    let unit: String

    enum CodingKeys: String, CodingKey { case title, user, value, unit }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        title = c.string(.title) ?? "Premio"
        user = try? c.decodeIfPresent(UserRef.self, forKey: .user)
        value = c.double(.value) ?? 0
        unit = c.string(.unit) ?? ""
    }

    /// The award's value with its unit ("1,25 km²", "12,3 km", "4 actividades").
    var formattedValue: String {
        if unit.hasPrefix("m²") {
            let rest = unit.dropFirst(2).trimmingCharacters(in: .whitespaces)
            return rest.isEmpty ? Format.area(value) : "\(Format.area(value)) \(rest)"
        }
        if unit == "m" {
            let km = value / 1000
            return "\(km.formatted(.number.precision(.fractionLength(1)).locale(Locale(identifier: "es_ES")))) km"
        }
        let number = value == value.rounded() ? String(Int(value)) : value.formatted(.number.precision(.fractionLength(1)).locale(Locale(identifier: "es_ES")))
        return unit.isEmpty ? number : "\(number) \(unit)"
    }
}

struct WeeklyRankEntry: Decodable, Hashable, Identifiable {
    let rank: Int
    let user: UserRef?
    let totalArea: Double
    let activitiesCount: Int
    let areaStolen: Double
    var id: String { user?.id ?? "rank-\(rank)" }

    enum CodingKeys: String, CodingKey { case rank, user, totalArea, activitiesCount, areaStolen }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        rank = c.int(.rank) ?? 0
        user = try? c.decodeIfPresent(UserRef.self, forKey: .user)
        totalArea = c.double(.totalArea) ?? 0
        activitiesCount = c.int(.activitiesCount) ?? 0
        areaStolen = c.double(.areaStolen) ?? 0
    }
}

// MARK: - Store

/// Current competition state (GET /api/competition/active), shared by the map and the rankings.
@MainActor
@Observable
final class CompetitionStore {
    static let shared = CompetitionStore()

    private(set) var info: CompetitionInfo?
    /// Powers the user can still activate (badge on the map's ⚡ button).
    private(set) var availablePowerCount = 0

    private init() {}

    var status: String { info?.status ?? "no_competition" }
    var competition: CompetitionInfo.Competition? { info?.competition }
    var isActive: Bool { status == "active" && competition != nil }
    var isUpcoming: Bool { status == "upcoming" && competition != nil }
    var isFinished: Bool { status == "finished" && competition != nil }

    /// Week number as the server counts it: ceil((now - start) / 7 days), at least 1.
    var currentWeek: Int? {
        guard isActive, let start = competition?.startDate else { return nil }
        let weeks = Date().timeIntervalSince(start) / (7 * 24 * 3600)
        return max(1, Int(weeks.rounded(.up)))
    }

    private static let activePath = "/api/competition/active"

    /// Shows the last known competition state (also after a cold start) before the first refresh answers.
    func loadCachedIfNeeded() {
        guard info == nil else { return }
        info = APIClient.shared.cached(Self.activePath, as: CompetitionInfo.self)
    }

    /// The competition state was fetched recently (switching tabs doesn't refetch it).
    var isFresh: Bool {
        APIClient.shared.isCacheFresh(Self.activePath)
    }

    func refresh() async {
        loadCachedIfNeeded()
        do {
            info = try await APIClient.shared.request("GET", Self.activePath, as: CompetitionInfo.self)
        } catch is CancellationError {
            return
        } catch {
            // Keep the last known state (offline, server error)
        }
    }

    /// Refreshes only when the state isn't fresh (or `force`).
    func refreshIfStale(force: Bool = false) async {
        loadCachedIfNeeded()
        guard force || !isFresh || info == nil else { return }
        await refresh()
    }

    func refreshPowers(userId: String) async {
        guard isActive else {
            availablePowerCount = 0
            return
        }
        let path = "/api/users/\(userId)/powers"
        if let cached = APIClient.shared.cached(path, as: UserPowersResponse.self) {
            availablePowerCount = cached.powers.filter { $0.isAvailable }.count
        }
        if let response = try? await APIClient.shared.request("GET", path, as: UserPowersResponse.self) {
            availablePowerCount = response.powers.filter { $0.isAvailable }.count
        }
    }

    func setAvailablePowerCount(_ count: Int) {
        availablePowerCount = count
    }

    /// The most recent weekly summary of the active competition (this week's, else last week's).
    func latestWeeklySummary() async -> WeeklySummary? {
        guard let week = currentWeek else { return nil }
        for number in [week, week - 1] where number >= 1 {
            if let response = try? await APIClient.shared.request("GET", "/api/competition/weekly-summary/\(number)", as: WeeklySummaryResponse.self),
               let summary = response.summary {
                return summary
            }
        }
        return nil
    }

    func clear() {
        info = nil
        availablePowerCount = 0
    }
}

/// "Already shown" flags for the automatic competition dialogs (one per competition / week).
enum CompetitionSeen {
    static func intro(_ competitionId: String) -> Bool { UserDefaults.standard.bool(forKey: "competition_intro_seen_\(competitionId)") }
    static func markIntro(_ competitionId: String) { UserDefaults.standard.set(true, forKey: "competition_intro_seen_\(competitionId)") }

    static func finalResults(_ competitionId: String) -> Bool { UserDefaults.standard.bool(forKey: "competition_final_seen_\(competitionId)") }
    static func markFinalResults(_ competitionId: String) { UserDefaults.standard.set(true, forKey: "competition_final_seen_\(competitionId)") }

    static func week(_ competitionId: String, _ week: Int) -> Bool { UserDefaults.standard.bool(forKey: "weekly_summary_seen_\(competitionId)_\(week)") }
    static func markWeek(_ competitionId: String, _ week: Int) { UserDefaults.standard.set(true, forKey: "weekly_summary_seen_\(competitionId)_\(week)") }

    /// e2e screenshots open a screen at launch: don't cover it with automatic dialogs.
    static var automaticDialogsDisabled: Bool {
        #if DEBUG
        return ProcessInfo.processInfo.environment["RUNNA_TEST_DEEP_LINK"] != nil
        #else
        return false
        #endif
    }
}

extension Date {
    /// now...end for Text(timerInterval:), never an inverted range.
    static func countdownRange(to end: Date) -> ClosedRange<Date> {
        let now = Date()
        return now...max(now, end)
    }
}
