import SwiftUI

struct RankingsView: View {
    @Environment(SessionStore.self) private var session
    @Environment(AppRouter.self) private var router

    enum Board: Hashable { case friends, competition }

    @State private var board: Board = .friends
    @State private var friends: [AppUser] = []
    @State private var competitionEntries: [CompetitionEntry] = []
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var selectedUserId: String?
    @State private var showFinalResults = false
    @State private var hasLoaded = false

    private var competition: CompetitionStore { CompetitionStore.shared }
    private var hasCompetitionBoard: Bool { competition.isActive || competition.isFinished }
    private var showsBanner: Bool { competition.isUpcoming || competition.isActive || competition.isFinished }

    var body: some View {
        @Bindable var router = router
        NavigationStack {
            ScrollView {
                VStack(spacing: DS.Spacing.xl) {
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
            .refreshable { await load() }
            .task(id: router.reloadSignal) { await load() }
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
            RankingCapsulePicker(options: boardOptions, selection: $board)
        }
    }

    private var boardOptions: [RankingCapsulePicker<Board>.Option] {
        [
            RankingCapsulePicker<Board>.Option(value: .friends, title: "Amigos", systemImage: "person.2.fill", gradient: LinearGradient.brandGradient),
            RankingCapsulePicker<Board>.Option(value: .competition, title: "Competición", systemImage: "trophy.fill", gradient: LinearGradient.goldGradient)
        ]
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            if competition.isActive {
                Button {
                    router.showWeeklySummary = true
                } label: {
                    Label("Resumen", systemImage: "party.popper.fill")
                        .labelStyle(.titleAndIcon)
                        .font(.system(.subheadline, design: .rounded, weight: .bold))
                }
                .tint(Color.gold)
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
                .transition(.asymmetric(insertion: .move(edge: .leading).combined(with: .opacity), removal: .opacity))
        case .competition:
            competitionBoard
                .transition(.asymmetric(insertion: .move(edge: .trailing).combined(with: .opacity), removal: .opacity))
        }
    }

    @ViewBuilder
    private var friendsBoard: some View {
        if let errorMessage, friends.isEmpty {
            ErrorView(message: errorMessage) { Task { await load() } }
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
            systemImage: "person.2.wave.2.fill",
            title: "Esto se gana en grupo",
            message: "Añade a tu gente y descubre quién pinta más mapa. Que empiece el pique.",
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
                title: "El mapa está en blanco",
                message: "Nadie ha conquistado nada todavía. Sal a correr y estrena el podio.",
                actionTitle: "Ir al mapa",
                action: { router.selectedTab = .map },
                tint: Color.gold
            )
            .card()
        } else {
            RankingBoardView(
                items: competitionItems,
                footnote: "Territorio conquistado durante \(competition.competition?.name ?? "la competición"). 🔥 robado · 🎁 tesoros",
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

    private func load() async {
        guard let userId = session.userId else { return }
        isLoading = true
        defer {
            isLoading = false
            hasLoaded = true
        }
        do {
            let loaded = try await APIClient.shared.request("GET", "/api/leaderboard/friends/\(userId)", as: [AppUser].self)
            withAnimation(.snappy) { friends = loaded }
            errorMessage = nil
        } catch is CancellationError {
            return
        } catch {
            errorMessage = error.localizedDescription
        }
        await competition.refresh()
        if hasCompetitionBoard {
            if let response = try? await APIClient.shared.request("GET", "/api/competition/leaderboard", as: CompetitionLeaderboardResponse.self) {
                let sorted = response.leaderboard.sorted { $0.totalArea > $1.totalArea }
                withAnimation(.snappy) { competitionEntries = sorted }
            }
        } else {
            competitionEntries = []
            board = .friends
        }
    }
}

private struct RankedUser: Identifiable {
    let id: String
}
