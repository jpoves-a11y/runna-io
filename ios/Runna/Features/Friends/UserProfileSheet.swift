import SwiftUI

/// Another runner's profile: stats, rivalry with you, recent activities and friend button.
struct UserProfileSheet: View {
    let userId: String

    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var stats: UserStats?
    @State private var routes: [RunRoute] = []
    @State private var isFriend = false
    @State private var requestSent = false
    @State private var errorMessage: String?
    @State private var loadFailed = false

    private var isMe: Bool { userId == session.userId }

    var body: some View {
        NavigationStack {
            Group {
                if let stats {
                    content(stats)
                } else if loadFailed {
                    ErrorView(message: "Comprueba tu conexión") { Task { await load() } }
                } else {
                    ProgressView()
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Cerrar") { dismiss() }
                }
            }
            .errorAlert($errorMessage)
        }
        .presentationDetents([.medium, .large])
        .task { await load() }
    }

    private func content(_ stats: UserStats) -> some View {
        List {
            Section {
                VStack(spacing: 10) {
                    AvatarView(name: stats.user.name, avatar: stats.user.avatar, color: stats.user.color, size: 84)
                    Text(stats.user.displayName).font(.title2.bold())
                    Text("@\(stats.user.username)").foregroundStyle(.secondary)
                    if !isMe && !isFriend {
                        Button {
                            sendFriendRequest()
                        } label: {
                            Label(requestSent ? "Solicitud enviada" : "Añadir amigo", systemImage: requestSent ? "checkmark" : "person.badge.plus")
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(requestSent)
                    }
                }
                .frame(maxWidth: .infinity)
                .listRowBackground(Color.clear)
            }

            Section("Estadísticas") {
                LabeledContent("Territorio", value: Format.area(stats.totalArea))
                LabeledContent("Actividades", value: "\(stats.activitiesCount)")
                if let last = APIDate.parse(stats.lastActivity) {
                    LabeledContent("Última actividad", value: Format.relative(last))
                }
                LabeledContent("Ha robado en total", value: Format.area(stats.totalStolen))
                LabeledContent("Le han robado", value: Format.area(stats.totalLost))
            }

            if !isMe && (stats.stolenFromViewer > 0 || stats.stolenByViewer > 0) {
                Section("Vuestra rivalidad") {
                    LabeledContent("Te ha robado", value: Format.area(stats.stolenFromViewer))
                    LabeledContent("Le has robado", value: Format.area(stats.stolenByViewer))
                }
            }

            if !routes.isEmpty {
                Section("Actividades recientes") {
                    ForEach(routes.prefix(10)) { route in
                        RouteRow(route: route, color: Color(hex: stats.user.color))
                    }
                }
            }
        }
    }

    private func load() async {
        loadFailed = false
        do {
            stats = try await APIClient.shared.request("GET", "/api/users/\(userId)/stats", as: UserStats.self)
        } catch {
            loadFailed = true
            return
        }
        if let myId = session.userId, !isMe,
           let friends: [AppUser] = try? await APIClient.shared.request("GET", "/api/friends/\(myId)") {
            isFriend = friends.contains { $0.id == userId }
        }
        routes = (try? await APIClient.shared.request("GET", "/api/routes/\(userId)", as: [RunRoute].self)) ?? []
    }

    private func sendFriendRequest() {
        Task {
            do {
                try await APIClient.shared.send("POST", "/api/friends", body: ["friendId": userId])
                requestSent = true
                Haptics.success()
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
}

/// One activity in a list: route shape, name, date, distance and time.
struct RouteRow: View {
    let route: RunRoute
    let color: Color

    var body: some View {
        HStack(spacing: 14) {
            RouteShape(coordinates: route.coordinates)
                .stroke(color, style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                .frame(width: 52, height: 52)
                .padding(4)
                .background(color.opacity(0.1), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            VStack(alignment: .leading, spacing: 4) {
                Text(route.name)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Text(Format.dayAndTime(route.startDate))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                HStack(spacing: 10) {
                    Label(Format.distance(route.distance), systemImage: "figure.run")
                    Label(Format.duration(route.duration), systemImage: "stopwatch")
                    if let area = route.territoryArea, area > 0 {
                        Label(Format.area(area), systemImage: "flag")
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .labelStyle(.titleAndIcon)
            }
        }
        .padding(.vertical, 2)
    }
}
