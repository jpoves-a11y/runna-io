import Foundation
import WidgetKit

/// Keeps the widgets up to date. They ask the server by themselves (GET /api/widget/summary every
/// ~30 minutes) with the session the app shares with them; the app also hands them a small snapshot
/// and reloads them when something they show changes (a run, the week's board, the user).
@MainActor
enum WidgetSync {
    private static var lastRefresh: Date?
    private static let refreshInterval: TimeInterval = 15 * 60

    /// The session the widgets use (login and every launch).
    static func storeCredentials(token: String, userId: String) {
        let credentials = WidgetCredentials(token: token, userId: userId, baseURL: AppConfig.apiBaseURL.absoluteString)
        guard WidgetSnapshotStore.loadCredentials() != credentials else { return }
        if WidgetSnapshotStore.saveCredentials(credentials) {
            WidgetCenter.shared.reloadAllTimelines()
        }
    }

    /// Fresh user data (name, colour, total territory).
    static func update(user: AppUser) {
        modify(defaultName: user.name, colorHex: user.color) { snapshot in
            snapshot.name = user.name
            snapshot.colorHex = user.color
            snapshot.totalArea = user.totalArea
        }
    }

    /// This week's board among friends.
    static func update(weekly: WeeklyRankingResponse, myId: String) {
        guard let me = weekly.entries.first(where: { $0.user.id == myId }) else { return }
        modify(defaultName: me.user.name, colorHex: me.user.color) { snapshot in
            snapshot.weekStart = APIDate.parse(weekly.weekStart) ?? RunnaWidgetSnapshot.weekStart(of: Date())
            snapshot.weekArea = me.weekArea
            snapshot.weekDistance = me.weekDistance
            snapshot.weekRuns = me.weekRuns
            snapshot.weekRank = me.rank
            snapshot.weekPlayers = weekly.entries.count
            let leader = weekly.entries.first
            snapshot.weekLeaderName = leader.flatMap { $0.user.id == myId || $0.weekArea <= 0 ? nil : ($0.user.nickname ?? $0.user.name) }
        }
    }

    /// A run was uploaded (recorded or imported).
    static func didRun(at date: Date?) {
        guard let date, WidgetSnapshotStore.load() != nil else { return }
        modify(defaultName: "", colorHex: "#16A34A") { snapshot in
            if snapshot.lastRunAt.map({ $0 < date }) ?? true {
                snapshot.lastRunAt = date
            }
        }
        // The week's figures change with the run: refetch them on the next refresh
        lastRefresh = nil
        // The widgets fetch the new league and map (the run's territory is processed in a few seconds)
        Task {
            try? await Task.sleep(nanoseconds: 20_000_000_000)
            WidgetCenter.shared.reloadAllTimelines()
        }
    }

    /// Refetches this week's board (at most every 15 minutes).
    static func refresh(userId: String) async {
        if let lastRefresh, Date().timeIntervalSince(lastRefresh) < refreshInterval { return }
        lastRefresh = Date()
        guard let weekly: WeeklyRankingResponse = try? await APIClient.shared.request("GET", "/api/leaderboard/friends/\(userId)/weekly"),
              RunOwner.currentUserId == userId else { return }
        update(weekly: weekly, myId: userId)
    }

    /// Logout: the widget goes back to "Abre Runna.io".
    static func clear() {
        lastRefresh = nil
        WidgetSnapshotStore.clear()
        WidgetCenter.shared.reloadAllTimelines()
    }

    private static func modify(defaultName: String, colorHex: String, _ change: (inout RunnaWidgetSnapshot) -> Void) {
        let old = WidgetSnapshotStore.load()
        var snapshot = old ?? RunnaWidgetSnapshot(name: defaultName, colorHex: colorHex, totalArea: 0)
        change(&snapshot)
        snapshot.updatedAt = old?.updatedAt ?? Date()
        guard snapshot != old else { return }
        snapshot.updatedAt = Date()
        if WidgetSnapshotStore.save(snapshot) {
            WidgetCenter.shared.reloadAllTimelines()
        }
    }
}
