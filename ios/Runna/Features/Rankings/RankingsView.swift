import SwiftUI

/// Competition leaderboard entry (GET /api/competition/leaderboard).
struct CompetitionEntry: Decodable, Identifiable {
    let user: UserRef
    let totalArea: Double
    let totalDistance: Double
    let treasuresCollected: Int
    var id: String { user.id }

    enum CodingKeys: String, CodingKey { case user, totalArea, totalDistance, treasuresCollected }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        user = try c.decode(UserRef.self, forKey: .user)
        totalArea = c.double(.totalArea) ?? 0
        totalDistance = c.double(.totalDistance) ?? 0
        treasuresCollected = c.int(.treasuresCollected) ?? 0
    }
}

private struct CompetitionLeaderboardResponse: Decodable {
    let leaderboard: [CompetitionEntry]
}

struct RankingsView: View {
    @Environment(SessionStore.self) private var session
    @Environment(AppRouter.self) private var router

    enum Board: Hashable { case friends, competition }

    @State private var board: Board = .friends
    @State private var friends: [AppUser] = []
    @State private var competition: [CompetitionEntry] = []
    @State private var competitionName: String?
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var selectedUserId: String?

    var body: some View {
        NavigationStack {
            List {
                if competitionName != nil {
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
            .refreshable { await load() }
            .task(id: router.reloadSignal) { await load() }
            .sheet(item: Binding(
                get: { selectedUserId.map { RankedUser(id: $0) } },
                set: { selectedUserId = $0?.id }
            )) { user in
                UserProfileSheet(userId: user.id)
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
                    if user.id != session.userId { selectedUserId = user.id }
                } label: {
                    RankRow(
                        rank: user.rank ?? 0,
                        name: user.id == session.userId ? "\(user.displayName) (tú)" : user.displayName,
                        avatar: user.avatar,
                        color: user.color,
                        value: Format.area(user.totalArea),
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
        Section(competitionName ?? "Competición") {
            ForEach(Array(competition.enumerated()), id: \.element.id) { index, entry in
                Button {
                    if entry.user.id != session.userId { selectedUserId = entry.user.id }
                } label: {
                    RankRow(
                        rank: index + 1,
                        name: entry.user.displayName,
                        avatar: entry.user.avatar,
                        color: entry.user.color,
                        value: Format.area(entry.totalArea),
                        detail: entry.treasuresCollected > 0 ? "🎁 \(entry.treasuresCollected)" : nil,
                        highlighted: entry.user.id == session.userId
                    )
                }
                .buttonStyle(.plain)
            }
        }
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
        if let info = try? await APIClient.shared.request("GET", "/api/competition/active", as: CompetitionInfo.self),
           info.status == "active" || info.status == "finished" {
            competitionName = info.competition?.name
            competition = (try? await APIClient.shared.request("GET", "/api/competition/leaderboard", as: CompetitionLeaderboardResponse.self))?.leaderboard ?? []
        } else {
            competitionName = nil
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
                Text(name)
                    .font(.body.weight(highlighted ? .bold : .regular))
                    .lineLimit(1)
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
        .listRowBackground(highlighted ? Color.brand.opacity(0.12) : nil)
    }
}
