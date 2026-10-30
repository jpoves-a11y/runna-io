import Foundation
import SwiftUI
import WidgetKit

/// Keeps the widgets up to date. They ask the server by themselves (GET /api/widget/summary every
/// ~30 minutes) with the session the app shares with them; the app also hands them a small snapshot
/// and reloads them when something they show changes (a run, the week's board, the user).
@MainActor
enum WidgetSync {
    private static var lastRefresh: Date?
    private static let refreshInterval: TimeInterval = 15 * 60

    /// The session the widgets use (login, every launch and every time the app comes to the front).
    /// Always written again: a widget that couldn't read it before gets it now.
    static func storeCredentials(token: String, userId: String) {
        let credentials = WidgetCredentials(token: token, userId: userId, baseURL: AppConfig.apiBaseURL.absoluteString)
        let previous = WidgetSnapshotStore.loadCredentials()
        if WidgetSnapshotStore.saveCredentials(credentials), previous != credentials {
            WidgetCenter.shared.reloadAllTimelines()
        }
    }

    /// Writes the session again and redraws every widget ("Reconectar widgets").
    static func reconnect(token: String?, userId: String?) {
        if let token, let userId { storeCredentials(token: token, userId: userId) }
        WidgetCenter.shared.reloadAllTimelines()
    }

    /// Whether the widgets can work: the shared session is readable and the server answers.
    static func diagnose() async -> (ok: Bool, text: String) {
        guard let credentials = WidgetSnapshotStore.loadCredentials() else {
            return (false, "Sin sesión compartida: \(WidgetSnapshotStore.problem ?? "no se ha guardado")")
        }
        do {
            let _: WidgetSummary = try await APIClient.shared.request("GET", "/api/widget/summary")
            return (credentials.userId == RunOwner.currentUserId, credentials.userId == RunOwner.currentUserId ? "Conectados" : "Sesión de otra cuenta")
        } catch {
            return (false, "El servidor no responde: \(error.localizedDescription)")
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

/// Perfil → "Widgets": whether they're connected, and a button to connect them again.
struct WidgetStatusRow: View {
    @Environment(SessionStore.self) private var session
    @State private var status: (ok: Bool, text: String)?
    @State private var isChecking = false

    var body: some View {
        Button {
            Task { await check(reconnect: true) }
        } label: {
            HStack {
                SocialSettingsLabel(title: "Widgets", systemImage: "square.grid.2x2")
                Spacer()
                if isChecking {
                    ProgressView()
                } else if let status {
                    Text(status.ok ? "Conectados" : "Reconectar")
                        .font(.subheadline)
                        .foregroundStyle(status.ok ? Color.secondary : Color.steal)
                }
            }
        }
        .task { await check(reconnect: false) }
        if let status, !status.ok {
            Text(status.text)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func check(reconnect: Bool) async {
        isChecking = true
        defer { isChecking = false }
        if reconnect {
            WidgetSync.reconnect(token: APIClient.shared.sessionToken, userId: session.userId)
        }
        status = await WidgetSync.diagnose()
    }
}
