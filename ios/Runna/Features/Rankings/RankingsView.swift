import SwiftUI

struct RankingsView: View {
    @Environment(SessionStore.self) private var session
    @Environment(AppRouter.self) private var router

    enum Board: Hashable { case friends, competition }

    @State private var board: Board = .friends
    @State private var model = RankingsModel.shared
    @State private var selectedUserId: String?
    @State private var showFinalResults = false

    private var friends: [AppUser] { model.friends }
    private var competitionEntries: [CompetitionEntry] { model.competitionEntries }
    private var isLoading: Bool { model.isLoading }
    private var errorMessage: String? { model.errorMessage }
    private var hasLoaded: Bool { model.hasLoaded }

    private var competition: CompetitionStore { CompetitionStore.shared }
    private var hasCompetitionBoard: Bool { competition.isActive || competition.isFinished }
    private var showsBanner: Bool { competition.isUpcoming || competition.isActive || competition.isFinished }

    var body: some View {
        @Bindable var router = router
        NavigationStack {
            ScrollView {
                VStack(spacing: DS.Spacing.l) {
                    header
                    boardContent
                }
                .padding(.horizontal, DS.Spacing.l)
                .padding(.top, DS.Spacing.s)
                .padding(.bottom, DS.Spacing.xxl)
                .animation(.snappy, value: board)
            }
            .screenBackground()
            .navigationTitle("Ranking")
            .toolbar { toolbarContent }
            .refreshable { await load(force: true) }
            .task(id: router.reloadSignal) {
                await load(force: model.reloadTracker.consume(router.reloadSignal))
            }
            .sheet(item: Binding(
                get: { selectedUserId.map { RankedUser(id: $0) } },
                set: { selectedUserId = $0?.id }
            )) { user in
                UserProfileSheet(userId: user.id)
            }
            .sheet(isPresented: $router.showWeeklySummary) {
                WeeklySummaryView()
            }
            .sheet(isPresented: $showFinalResults) {
                CompetitionFinalView(competitionName: competition.competition?.name ?? "La competición")
            }
        }
    }

    // MARK: Header

    @ViewBuilder
    private var header: some View {
        if showsBanner {
            CompetitionBanner(store: competition, style: .hero) { showFinalResults = true }
        }
        if hasCompetitionBoard {
            Picker("Clasificación", selection: $board) {
                Text("Amigos").tag(Board.friends)
                Text("Competición").tag(Board.competition)
            }
            .pickerStyle(.segmented)
            .sensoryFeedback(.selection, trigger: board)
        }
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            if competition.isActive {
                Button {
                    router.showWeeklySummary = true
                } label: {
                    Label("Resumen semanal", systemImage: "chart.bar.doc.horizontal")
                }
                .tint(Color.brand)
                .accessibilityLabel("Resumen semanal")
            }
        }
    }

    // MARK: Boards

    @ViewBuilder
    private var boardContent: some View {
        switch board {
        case .friends:
            friendsBoard
                .transition(.opacity)
        case .competition:
            competitionBoard
                .transition(.opacity)
        }
    }

    @ViewBuilder
    private var friendsBoard: some View {
        if let errorMessage, friends.isEmpty {
            ErrorView(message: errorMessage) { Task { await load(force: true) } }
                .padding(.top, 40)
        } else if friends.isEmpty && (isLoading || !hasLoaded) {
            RankingSkeleton()
        } else {
            VStack(spacing: DS.Spacing.l) {
                if friends.count <= 1 {
                    inviteFriends
                }
                if !friends.isEmpty {
                    RankingBoardView(
                        items: friendItems,
                        showsPosition: friends.count > 1,
                        footnote: "Territorio total conquistado por ti y tus amigos.",
                        onSelect: { item in open(item.id) }
                    )
                }
            }
        }
    }

    private var inviteFriends: some View {
        EmptyStateView(
            systemImage: "person.2",
            title: "Compite con tus amigos",
            message: "Añade amigos para comparar el territorio que conquista cada uno.",
            actionTitle: "Buscar amigos",
            action: { router.selectedTab = .friends }
        )
        .card()
    }

    @ViewBuilder
    private var competitionBoard: some View {
        if competitionEntries.isEmpty && (isLoading || !hasLoaded) {
            RankingSkeleton()
        } else if competitionEntries.isEmpty {
            EmptyStateView(
                systemImage: "flag.checkered",
                title: "Sin territorio todavía",
                message: "Nadie ha conquistado zona en la competición. La primera carrera abre la clasificación.",
                actionTitle: "Ir al mapa",
                action: { router.selectedTab = .map }
            )
            .card()
        } else {
            RankingBoardView(
                items: competitionItems,
                footnote: "Territorio conquistado durante \(competition.competition?.name ?? "la competición").",
                onSelect: { item in open(item.id) }
            )
        }
    }

    private var friendItems: [RankingItem] {
        var items: [RankingItem] = []
        for (index, user) in friends.enumerated() {
            items.append(RankingItem(user: user, rank: user.rank ?? index + 1, isMe: user.id == session.userId))
        }
        return items
    }

    private var competitionItems: [RankingItem] {
        var items: [RankingItem] = []
        for (index, entry) in competitionEntries.enumerated() {
            items.append(RankingItem(entry: entry, rank: index + 1, isMe: entry.user.id == session.userId))
        }
        return items
    }

    /// Other players open their profile; the user's own row goes to the Profile tab.
    private func open(_ userId: String) {
        if userId == session.userId {
            router.selectedTab = .profile
        } else {
            selectedUserId = userId
        }
    }

    /// Cached boards first; refetched in the background when they aren't fresh (or `force`).
    private func load(force: Bool = false) async {
        guard let userId = session.userId else { return }
        await model.load(userId: userId, force: force)
        if !hasCompetitionBoard {
            board = .friends
        }
    }
}

/// Friends and competition leaderboards, kept across tab switches (stale-while-revalidate).
@MainActor
@Observable
final class RankingsModel {
    static let shared = RankingsModel()

    private(set) var friends: [AppUser] = []
    private(set) var competitionEntries: [CompetitionEntry] = []
    private(set) var isLoading = false
    private(set) var errorMessage: String?
    private(set) var hasLoaded = false
    var reloadTracker = ReloadSignalTracker()

    private var ownerId: String?
    private var friendsResource: CachedResource<[AppUser]>?
    private let competitionResource = CachedResource<CompetitionLeaderboardResponse>("/api/competition/leaderboard")

    private var competition: CompetitionStore { CompetitionStore.shared }
    private var hasCompetitionBoard: Bool { competition.isActive || competition.isFinished }

    func reset() {
        ownerId = nil
        friendsResource = nil
        competitionResource.forget()
        friends = []
        competitionEntries = []
        isLoading = false
        errorMessage = nil
        hasLoaded = false
        reloadTracker = ReloadSignalTracker()
    }

    func load(userId: String, force: Bool) async {
        if ownerId != userId {
            reset()
            ownerId = userId
            friendsResource = CachedResource("/api/leaderboard/friends/\(userId)")
        }
        guard let friendsResource else { return }

        // 1. Last known boards, instantly
        competition.loadCachedIfNeeded()
        if let cached = await friendsResource.loadCached() {
            friends = cached
            hasLoaded = true
        }
        if hasCompetitionBoard, let cached = await competitionResource.loadCached() {
            competitionEntries = Self.sorted(cached)
        }
        let fresh = friendsResource.isFresh && competition.isFresh && (!hasCompetitionBoard || competitionResource.isFresh)
        if !force && hasLoaded && fresh { return }

        // 2. Refetch: friends board, competition state and (if known to exist) the competition board in parallel
        isLoading = friends.isEmpty
        defer {
            isLoading = false
            hasLoaded = true
        }
        let competitionKnown = hasCompetitionBoard
        let store: CompetitionStore = competition
        let boardResource: CachedResource<CompetitionLeaderboardResponse> = competitionResource
        async let friendsResult: [AppUser]? = friendsResource.fetch()
        async let competitionRefresh: Void = store.refresh()
        async let competitionBoard: CompetitionLeaderboardResponse? = Self.fetchCompetitionBoard(boardResource, enabled: competitionKnown)

        do {
            if let loaded = try await friendsResult {
                withAnimation(.snappy) { friends = loaded }
            }
            errorMessage = nil
        } catch is CancellationError {
            return
        } catch {
            // With a cached board on screen the refresh fails silently (it's retried on the next visit)
            errorMessage = friends.isEmpty ? error.localizedDescription : nil
        }
        await competitionRefresh
        var board: CompetitionLeaderboardResponse? = await competitionBoard
        if hasCompetitionBoard {
            if !competitionKnown {
                // The competition just started: its board wasn't requested yet
                board = try? await competitionResource.fetch()
            }
            if let board {
                let sorted = Self.sorted(board)
                withAnimation(.snappy) { competitionEntries = sorted }
            }
        } else {
            competitionEntries = []
            // Drawn again in full if the competition comes back
            competitionResource.forget()
        }
    }

    /// The competition board, when it is known to exist (nil when unchanged, failed or not requested).
    private static func fetchCompetitionBoard(_ resource: CachedResource<CompetitionLeaderboardResponse>, enabled: Bool) async -> CompetitionLeaderboardResponse? {
        guard enabled else { return nil }
        return try? await resource.fetch()
    }

    private static func sorted(_ response: CompetitionLeaderboardResponse) -> [CompetitionEntry] {
        response.leaderboard.sorted { $0.totalArea > $1.totalArea }
    }
}

private struct RankedUser: Identifiable {
    let id: String
}
