import Foundation
import SwiftUI
import MapKit
import CoreLocation
import Observation

/// Conquest results the user hasn't seen yet: activities imported from Strava, Polar, Suunto, Garmin, COROS or Apple Health,
/// runs uploaded later from the offline queue, and pushes about auto-imports.
/// Live runs show their own summary and are marked as shown.
@MainActor
@Observable
final class ConquestInbox {
    static let shared = ConquestInbox()

    struct Item: Identifiable, Hashable {
        let routeId: String
        var id: String { routeId }
    }

    /// Routes waiting to be shown, oldest first.
    private(set) var queue: [String] = []

    /// Route details already loaded by discovery (used for the replay).
    @ObservationIgnored private var knownRoutes: [String: RunRoute] = [:]
    /// Account the in-memory state belongs to.
    @ObservationIgnored private var ownerId: String?
    @ObservationIgnored private var seen: [String] = []
    @ObservationIgnored private var seenSet: Set<String> = []
    @ObservationIgnored private var isDiscovering = false

    private let maxSeen = 600

    private init() {}

    /// The result to present now.
    var current: Item? { queue.first.map { Item(routeId: $0) } }

    /// Route already loaded for an item, if any.
    func route(for routeId: String) -> RunRoute? { knownRoutes[routeId] }

    // MARK: - Public API

    /// Queues a route whose conquest the user should see (e.g. after an auto-import push).
    func enqueue(routeId: String) {
        guard !routeId.isEmpty else { return }
        guard prepare(for: RunOwner.currentUserId) else { return }
        guard !seenSet.contains(routeId), !queue.contains(routeId) else { return }
        queue.append(routeId)
    }

    /// Looks for routes of the user that haven't been shown yet.
    /// The first call for an account only records the existing routes (no backlog is shown).
    func discoverNewRoutes(userId: String) async {
        guard !userId.isEmpty, !isDiscovering else { return }
        guard prepare(for: userId) else { return }
        isDiscovering = true
        defer { isDiscovering = false }

        let routes: [RunRoute]
        do {
            routes = try await APIClient.shared.request("GET", "/api/routes/\(userId)")
        } catch {
            return
        }
        // The account may have changed while waiting
        guard ownerId == userId else { return }

        for route in routes {
            knownRoutes[route.id] = route
        }

        if !hasBaseline(userId: userId) {
            // First time for this account on this device: everything that exists now counts as seen
            for route in routes where !queue.contains(route.id) {
                insertSeen(route.id)
            }
            setBaseline(userId: userId)
            saveSeen()
            return
        }

        // Newest first from the server: queue the new ones oldest first
        let fresh = routes
            .filter { !seenSet.contains($0.id) && !queue.contains($0.id) }
            .sorted { ($0.startDate ?? .distantPast) < ($1.startDate ?? .distantPast) }
        for route in fresh {
            queue.append(route.id)
        }
    }

    /// Marks a route as shown (its result was seen, or it's a live run with its own summary).
    func markShown(routeId: String) {
        guard !routeId.isEmpty else { return }
        guard prepare(for: RunOwner.currentUserId) else { return }
        insertSeen(routeId)
        saveSeen()
        queue.removeAll { $0 == routeId }
    }

    /// Forgets the in-memory state (logout). What each account has seen stays on the device.
    func reset() {
        queue = []
        knownRoutes = [:]
        ownerId = nil
        seen = []
        seenSet = []
    }

    // MARK: - Storage

    /// Loads the state of `userId`; returns false when no one is logged in.
    private func prepare(for userId: String?) -> Bool {
        guard let userId, !userId.isEmpty else { return false }
        if ownerId != userId {
            queue = []
            knownRoutes = [:]
            ownerId = userId
            seen = UserDefaults.standard.stringArray(forKey: Self.seenKey(userId)) ?? []
            seenSet = Set(seen)
        }
        return true
    }

    private func insertSeen(_ routeId: String) {
        guard !seenSet.contains(routeId) else { return }
        seen.append(routeId)
        seenSet.insert(routeId)
        if seen.count > maxSeen {
            let overflow = seen.count - maxSeen
            let dropped = seen.prefix(overflow)
            seen.removeFirst(overflow)
            for id in dropped where !seen.contains(id) {
                seenSet.remove(id)
            }
        }
    }

    private func saveSeen() {
        guard let ownerId else { return }
        UserDefaults.standard.set(seen, forKey: Self.seenKey(ownerId))
    }

    private func hasBaseline(userId: String) -> Bool {
        UserDefaults.standard.bool(forKey: Self.baselineKey(userId))
    }

    private func setBaseline(userId: String) {
        UserDefaults.standard.set(true, forKey: Self.baselineKey(userId))
    }

    private static func seenKey(_ userId: String) -> String { "conquestInbox.seen.\(userId)" }
    private static func baselineKey(_ userId: String) -> String { "conquestInbox.baseline.\(userId)" }
}

// MARK: - Presentation

extension View {
    /// Presents, one after another, the conquest results the user hasn't seen yet.
    /// Needs RunTracker, AppRouter and SessionStore in the environment (as on the map screen).
    @MainActor
    func conquestInbox() -> some View {
        modifier(ConquestInboxModifier())
    }
}

@MainActor
private struct ConquestInboxModifier: ViewModifier {
    @Environment(RunTracker.self) private var tracker
    @Environment(AppRouter.self) private var router
    @Environment(SessionStore.self) private var session

    private var inbox: ConquestInbox { ConquestInbox.shared }

    private var presentedItem: ConquestInbox.Item? {
        // Never on top of a run being recorded, and only from the map tab
        guard session.state == .loggedIn, !tracker.isPresented, router.selectedTab == .map else { return nil }
        return inbox.current
    }

    func body(content: Content) -> some View {
        content
            .fullScreenCover(item: Binding<ConquestInbox.Item?>(
                get: { presentedItem },
                // Closing goes through "Hecho", which marks the item shown and moves to the next one
                set: { _ in }
            )) { item in
                ConquestInboxView(routeId: item.routeId, initialRoute: inbox.route(for: item.routeId)) {
                    inbox.markShown(routeId: item.routeId)
                }
            }
    }
}

/// Full-screen result of an activity the user didn't record live in the app.
@MainActor
private struct ConquestInboxView: View {
    let routeId: String
    let initialRoute: RunRoute?
    let onDone: () -> Void

    @Environment(SessionStore.self) private var session
    @State private var route: RunRoute?
    @State private var result: ConquestResult?
    @State private var isLoading = true
    @State private var tauntVictim: Victim?
    @State private var sentVictimIds: Set<String> = []

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: DS.Spacing.xxl) {
                    RunCelebrationHeader(
                        title: headerTitle,
                        subtitle: route?.name ?? "Actividad importada",
                        isWorking: isLoading
                    )
                    .padding(.top, DS.Spacing.s)
                    if let route {
                        VStack(spacing: DS.Spacing.m) {
                            if route.locations.count >= 2 {
                                RouteReplayView(
                                    coordinates: route.locations,
                                    color: Color.brand,
                                    height: 220
                                )
                            }
                            RunStatsCard(distance: route.distance, duration: route.duration)
                        }
                    }
                    resultSection
                }
                .padding(.horizontal, DS.Spacing.screen)
                .padding(.bottom, DS.Spacing.xxl)
                .animation(.snappy, value: isLoading)
            }
            .screenBackground()
            .safeAreaInset(edge: .bottom) {
                doneButton
            }
            .navigationTitle("Nueva actividad")
            .navigationBarTitleDisplayMode(.inline)
            .sheet(item: $tauntVictim) { victim in
                TauntComposerView(victim: victim) {
                    sentVictimIds.insert(victim.userId)
                }
            }
        }
        .interactiveDismissDisabled()
        .task(id: routeId) { await load() }
    }

    private var headerTitle: String {
        if isLoading { return "Nueva actividad" }
        if let result, result.newAreaConquered > 0 { return "Territorio conquistado" }
        return "Actividad guardada"
    }

    private var doneButton: some View {
        Button("Hecho", action: onDone)
            .buttonStyle(PrimaryButtonStyle())
            .padding(.horizontal, DS.Spacing.screen)
            .padding(.top, DS.Spacing.m)
            .padding(.bottom, DS.Spacing.s)
            .background(Color.canvas.ignoresSafeArea(edges: .bottom))
            .overlay(alignment: .top) {
                HairlineDivider()
            }
    }

    @ViewBuilder
    private var resultSection: some View {
        if let result {
            ConquestCard(result: result, sentVictimIds: sentVictimIds) { victim in
                tauntVictim = victim
            }
            let treasures: [TreasureLine] = TreasureLine.merge(live: [], server: result.treasuresCollected)
            if !treasures.isEmpty {
                TreasuresCard(treasures: treasures)
            }
        } else if isLoading {
            RunStatusCard(
                systemImage: "map",
                title: "Calculando el territorio",
                message: "Medimos el área que has conquistado con esta actividad.",
                isLoading: true
            )
        } else {
            RunStatusCard(
                systemImage: "clock",
                title: "Casi listo",
                message: "El territorio de esta actividad todavía se está calculando. Aparecerá en el mapa en unos minutos."
            )
        }
    }

    private func load() async {
        route = initialRoute
        isLoading = true
        if route == nil, let userId = session.userId,
           let routes: [RunRoute] = try? await APIClient.shared.request("GET", "/api/routes/\(userId)") {
            route = routes.first { $0.id == routeId }
        }
        result = await RunSubmission.waitForConquest(routeId: routeId)
        isLoading = false
    }
}
