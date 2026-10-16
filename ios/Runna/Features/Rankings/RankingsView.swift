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

    private var competition: CompetitionStore { CompetitionStore.shared }
    private var hasCompetitionBoard: Bool { competition.isActive || competition.isFinished }

    var body: some View {
        @Bindable var router = router
        NavigationStack {
            List {
                if competition.isUpcoming || competition.isActive || competition.isFinished {
                    CompetitionBanner(store: competition) { showFinalResults = true }
                        .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
                        .listRowBackground(Color.clear)
                }
                if hasCompetitionBoard {
                    Picker("Clasificación", selection: $board) {
                        Text("Amigos").tag(Board.friends)
                        Text("Competición").tag(Board.competition)
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear)
                }

                switch board {
                case .friends:
                    friendsSection
                case .competition:
                    competitionSection
                }
            }
            .overlay {
                if let errorMessage, friends.isEmpty {
                    ErrorView(message: errorMessage) { Task { await load() } }
                } else if isLoading && friends.isEmpty {
                    ProgressView()
                }
            }
            .navigationTitle("Ranking")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    if competition.isActive {
                        Button {
                            router.showWeeklySummary = true
                        } label: {
                            Label("Resumen semanal", systemImage: "chart.bar.fill")
                                .labelStyle(.titleAndIcon)
                                .font(.subheadline.weight(.semibold))
                        }
                        .tint(.orange)
                    }
                }
            }
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

    @ViewBuilder
    private var friendsSection: some View {
        if friends.count <= 1 && !isLoading && errorMessage == nil {
            Section {
                EmptyStateView(
                    systemImage: "person.2",
                    title: "Compite con tus amigos",
                    message: "Añade amigos en la pestaña Amigos para ver quién conquista más territorio."
                )
            }
        }
        Section {
            ForEach(friends) { user in
                Button {
                    open(user.id)
                } label: {
                    RankRow(
                        rank: user.rank ?? 0,
                        name: user.id == session.userId ? "\(user.name) (tú)" : user.name,
                        avatar: user.avatar,
                        color: user.color,
                        value: Format.area(user.totalArea),
                        subtitle: Self.subtitle(username: user.username, name: user.name, nickname: user.nickname),
                        nickname: user.nickname,
                        highlighted: user.id == session.userId
                    )
                }
                .buttonStyle(.plain)
            }
        } footer: {
            if !friends.isEmpty {
                Text("Metros cuadrados conquistados por ti y tus amigos.")
            }
        }
    }

    @ViewBuilder
    private var competitionSection: some View {
        Section {
            if competitionEntries.isEmpty && !isLoading {
                Text("Aún no hay participantes con territorio. ¡Sal a correr!")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            ForEach(Array(competitionEntries.enumerated()), id: \.element.id) { index, entry in
                Button {
                    open(entry.user.id)
                } label: {
                    RankRow(
                        rank: index + 1,
                        name: entry.user.id == session.userId ? "\(entry.user.name) (tú)" : entry.user.name,
                        avatar: entry.user.avatar,
                        color: entry.user.color,
                        value: Format.area(entry.totalArea),
                        detail: Self.competitionDetail(entry),
                        subtitle: Self.subtitle(username: entry.user.username, name: entry.user.name, nickname: entry.user.nickname),
                        nickname: entry.user.nickname,
                        highlighted: entry.user.id == session.userId
                    )
                }
                .buttonStyle(.plain)
            }
        } header: {
            Text(competition.competition?.name ?? "Competición")
        }
    }

    /// Other players open their profile; the user's own row goes to the Profile tab.
    private func open(_ userId: String) {
        if userId == session.userId {
            router.selectedTab = .profile
        } else {
            selectedUserId = userId
        }
    }

    private static func subtitle(username: String, name: String, nickname: String?) -> String? {
        let handle = username.isEmpty ? nil : "@\(username)"
        if let nickname, !nickname.isEmpty {
            return [handle, "antes: \(name)"].compactMap { $0 }.joined(separator: " · ")
        }
        return handle
    }

    private static func competitionDetail(_ entry: CompetitionEntry) -> String? {
        var parts: [String] = []
        if entry.areaStolen > 0 { parts.append("🗡️ \(Format.area(entry.areaStolen))") }
        if entry.treasuresCollected > 0 { parts.append("🎁 \(entry.treasuresCollected)") }
        return parts.isEmpty ? nil : parts.joined(separator: "  ")
    }

    private func load() async {
        guard let userId = session.userId else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            friends = try await APIClient.shared.request("GET", "/api/leaderboard/friends/\(userId)", as: [AppUser].self)
            errorMessage = nil
        } catch is CancellationError {
            return
        } catch {
            errorMessage = error.localizedDescription
        }
        await competition.refresh()
        if hasCompetitionBoard {
            if let response = try? await APIClient.shared.request("GET", "/api/competition/leaderboard", as: CompetitionLeaderboardResponse.self) {
                competitionEntries = response.leaderboard.sorted { $0.totalArea > $1.totalArea }
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

struct RankRow: View {
    let rank: Int
    let name: String
    let avatar: String?
    let color: String
    let value: String
    var detail: String? = nil
    var subtitle: String? = nil
    /// Active nickname (Pluma del Troll): shown as "🎭 nickname" instead of the name.
    var nickname: String? = nil
    var highlighted = false

    var body: some View {
        HStack(spacing: 12) {
            Group {
                switch rank {
                case 1: Text("🥇")
                case 2: Text("🥈")
                case 3: Text("🥉")
                default: Text("\(rank)").foregroundStyle(.secondary)
                }
            }
            .font(.title3.weight(.bold))
            .frame(width: 34)

            AvatarView(name: name, avatar: avatar, color: color, size: 40)
            VStack(alignment: .leading, spacing: 2) {
                if let nickname, !nickname.isEmpty {
                    Text("🎭 \(nickname)")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(.pink)
                        .lineLimit(1)
                } else {
                    Text(name)
                        .font(.body.weight(highlighted ? .bold : .regular))
                        .lineLimit(1)
                }
                if let subtitle {
                    Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                if let detail {
                    Text(detail).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
            Text(value)
                .font(.subheadline.weight(.semibold))
                .monospacedDigit()
        }
        .contentShape(Rectangle())
        .padding(.vertical, 4)
        .listRowBackground(rowBackground)
    }

    private var rowBackground: Color? {
        if highlighted { return Color.brand.opacity(0.12) }
        switch rank {
        case 1: return Color.yellow.opacity(0.12)
        case 2: return Color.gray.opacity(0.12)
        case 3: return Color.orange.opacity(0.10)
        default: return nil
        }
    }
}
