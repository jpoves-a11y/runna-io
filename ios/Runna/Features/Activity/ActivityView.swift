import SwiftUI

struct ActivityView: View {
    @Environment(AppRouter.self) private var router

    var body: some View {
        @Bindable var router = router
        NavigationStack {
            VStack(spacing: 0) {
                Picker("Sección", selection: $router.activitySection) {
                    Text("Amigos").tag(AppRouter.ActivitySection.feed)
                    Text("Mis carreras").tag(AppRouter.ActivitySection.mine)
                }
                .pickerStyle(.segmented)
                .padding(.horizontal)
                .padding(.vertical, 8)

                switch router.activitySection {
                case .feed:
                    FeedList()
                case .mine:
                    MyRoutesList()
                }
            }
            .navigationTitle("Actividad")
            .background(Color(.systemGroupedBackground))
        }
    }
}

// MARK: - Feed

@MainActor
@Observable
final class FeedModel {
    private(set) var events: [FeedEvent] = []
    private(set) var isLoading = false
    private(set) var reachedEnd = false
    private(set) var errorMessage: String?
    private let pageSize = 20

    func reload(userId: String) async {
        reachedEnd = false
        await loadPage(userId: userId, offset: 0)
    }

    func loadMore(userId: String) async {
        guard !isLoading, !reachedEnd else { return }
        await loadPage(userId: userId, offset: events.count)
    }

    private func loadPage(userId: String, offset: Int) async {
        isLoading = true
        defer { isLoading = false }
        do {
            let page = try await APIClient.shared.request(
                "GET", "/api/feed/\(userId)",
                query: ["limit": "\(pageSize)", "offset": "\(offset)"],
                as: [FeedEvent].self
            )
            if offset == 0 {
                events = page
            } else {
                let known = Set(events.map(\.id))
                events += page.filter { !known.contains($0.id) }
            }
            reachedEnd = page.count < pageSize
            errorMessage = nil
        } catch is CancellationError {
            return
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func react(to event: FeedEvent, with reaction: String) async {
        guard let index = events.firstIndex(where: { $0.id == event.id }) else { return }
        do {
            let result = try await APIClient.shared.request(
                "POST", "/api/feed/reactions",
                body: ["targetType": "event", "targetId": event.id, "reactionType": reaction],
                as: ReactionResult.self
            )
            events[index].likeCount = result.likeCount
            events[index].dislikeCount = result.dislikeCount
            events[index].userReaction = result.userReaction
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func updateCommentCount(eventId: String, count: Int) {
        if let index = events.firstIndex(where: { $0.id == eventId }) {
            events[index].commentCount = count
        }
    }
}

private struct FeedList: View {
    @Environment(SessionStore.self) private var session
    @Environment(AppRouter.self) private var router
    @State private var model = FeedModel()
    @State private var commentsFor: FeedEvent?
    @State private var profileUserId: String?

    var body: some View {
        List {
            if model.events.isEmpty && !model.isLoading && model.errorMessage == nil {
                EmptyStateView(
                    systemImage: "figure.run.square.stack",
                    title: "Todavía no hay actividad",
                    message: "Aquí verás las carreras y conquistas tuyas y de tus amigos."
                )
                .listRowBackground(Color.clear)
            }
            ForEach(model.events) { event in
                FeedEventCard(
                    event: event,
                    onReact: { reaction in Task { await model.react(to: event, with: reaction) } },
                    onComments: { commentsFor = event },
                    onOpenUser: { profileUserId = $0 }
                )
                .listRowInsets(EdgeInsets(top: 6, leading: 12, bottom: 6, trailing: 12))
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
                .onAppear {
                    if event.id == model.events.last?.id, let userId = session.userId {
                        Task { await model.loadMore(userId: userId) }
                    }
                }
            }
            if model.isLoading && !model.events.isEmpty {
                ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
            }
        }
        .listStyle(.plain)
        .overlay {
            if model.events.isEmpty {
                if let message = model.errorMessage {
                    ErrorView(message: message) { Task { await reload() } }
                } else if model.isLoading {
                    ProgressView()
                }
            }
        }
        .refreshable { await reload() }
        .task(id: router.reloadSignal) { await reload() }
        .sheet(item: $commentsFor) { event in
            CommentsSheet(event: event) { count in
                model.updateCommentCount(eventId: event.id, count: count)
            }
        }
        .sheet(item: Binding(
            get: { profileUserId.map { ProfileTarget(id: $0) } },
            set: { profileUserId = $0?.id }
        )) { target in
            UserProfileSheet(userId: target.id)
        }
    }

    private func reload() async {
        guard let userId = session.userId else { return }
        await model.reload(userId: userId)
    }
}

private struct ProfileTarget: Identifiable {
    let id: String
}

struct FeedEventCard: View {
    let event: FeedEvent
    let onReact: (String) -> Void
    let onComments: () -> Void
    let onOpenUser: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Button { onOpenUser(event.user.id) } label: {
                    AvatarView(name: event.user.name, avatar: event.user.avatar, color: event.user.color, size: 40)
                }
                .buttonStyle(.plain)
                VStack(alignment: .leading, spacing: 2) {
                    Text(event.user.displayName).font(.subheadline.weight(.semibold))
                    Text(Format.relative(event.date)).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
            }

            Text(headline)
                .font(.subheadline)

            if event.routeCoordinates.count >= 2 {
                RouteShape(coordinates: event.routeCoordinates)
                    .stroke(Color(hex: event.user.color), style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
                    .frame(height: 140)
                    .padding(12)
                    .frame(maxWidth: .infinity)
                    .background(Color(hex: event.user.color).opacity(0.08), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            }

            if event.distance != nil || event.newArea != nil {
                HStack {
                    if let distance = event.distance, distance > 0 {
                        StatTile(value: Format.distance(distance), label: "Distancia")
                    }
                    if let duration = event.duration, duration > 0 {
                        StatTile(value: Format.duration(duration), label: "Tiempo")
                    }
                    if let area = event.newArea, area > 0 {
                        StatTile(value: Format.area(area), label: "Conquistado", tint: .brand)
                    }
                }
            }

            ForEach(details, id: \.self) { detail in
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            HStack(spacing: 18) {
                reactionButton("like", systemImage: "hand.thumbsup", count: event.likeCount)
                reactionButton("dislike", systemImage: "hand.thumbsdown", count: event.dislikeCount)
                Button(action: onComments) {
                    Label("\(event.commentCount)", systemImage: "bubble.right")
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(event.commentCount) comentarios")
                Spacer()
            }
            .font(.subheadline)
            .foregroundStyle(.secondary)
        }
        .cardStyle()
    }

    private func reactionButton(_ reaction: String, systemImage: String, count: Int) -> some View {
        let active = event.userReaction == reaction
        return Button {
            Haptics.tap()
            onReact(reaction)
        } label: {
            Label("\(count)", systemImage: active ? "\(systemImage).fill" : systemImage)
                .foregroundStyle(active ? Color.brand : Color.secondary)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(reaction == "like" ? "Me gusta, \(count)" : "No me gusta, \(count)")
    }

    private var headline: String {
        switch event.eventType {
        case "treasure_found":
            let name = event.metadata?.treasureName ?? "un tesoro"
            return "\(event.metadata?.emoji ?? "🎁") Ha encontrado \(name)"
        case "territory_stolen":
            return "Ha robado \(Format.area(event.areaStolen ?? 0)) a \(event.victim?.name ?? "alguien")"
        case "personal_record":
            return "🏅 Nuevo récord personal"
        case "ran_together":
            return "Ha corrido acompañado"
        default:
            if let routeName = event.routeName, !routeName.isEmpty {
                return routeName
            }
            return "Ha salido a correr"
        }
    }

    private var details: [String] {
        var lines: [String] = []
        if let victims = event.metadata?.victims, !victims.isEmpty {
            let names = victims.map { "\($0.userName) (\(Format.area($0.stolenArea)))" }.joined(separator: ", ")
            lines.append("⚔️ Ha robado territorio a \(names)")
        }
        if let companions = event.metadata?.ranTogetherWith, !companions.isEmpty {
            lines.append("👟 Ha corrido con \(companions.map(\.name).joined(separator: ", "))")
        }
        for record in event.metadata?.records ?? [] {
            switch record.type {
            case "longest_run": lines.append("🏅 Su carrera más larga")
            case "fastest_pace": lines.append("⚡ Su ritmo más rápido")
            case "biggest_conquest": lines.append("👑 Su mayor conquista")
            default: break
            }
        }
        if let treasures = event.metadata?.treasures, !treasures.isEmpty, event.eventType != "treasure_found" {
            lines.append("🎁 Tesoros: \(treasures.compactMap(\.treasureName).joined(separator: ", "))")
        }
        if let destroyed = event.metadata?.fortressesDestroyed, destroyed > 0 {
            lines.append("🏰 Ha derribado \(destroyed) fortaleza(s)")
        }
        return lines
    }
}

// MARK: - My routes

private struct MyRoutesList: View {
    @Environment(SessionStore.self) private var session
    @Environment(AppRouter.self) private var router
    @State private var routes: [RunRoute] = []
    @State private var isLoading = false
    @State private var errorMessage: String?

    var body: some View {
        List {
            if routes.isEmpty && !isLoading && errorMessage == nil {
                EmptyStateView(
                    systemImage: "figure.run",
                    title: "Aún no has corrido",
                    message: "Pulsa Correr en el mapa, conecta Strava/Polar o importa tus entrenamientos de Apple Salud desde el Perfil."
                )
                .listRowBackground(Color.clear)
            }
            ForEach(routes) { route in
                NavigationLink(value: route) {
                    RouteRow(route: route, color: Color(hex: session.user?.color ?? "#16A34A"))
                }
            }
        }
        .overlay {
            if routes.isEmpty {
                if let errorMessage {
                    ErrorView(message: errorMessage) { Task { await load() } }
                } else if isLoading {
                    ProgressView()
                }
            }
        }
        .navigationDestination(for: RunRoute.self) { route in
            RouteDetailView(route: route) {
                Task { await load() }
            }
        }
        .refreshable { await load() }
        .task(id: router.reloadSignal) { await load() }
    }

    private func load() async {
        guard let userId = session.userId else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            routes = try await APIClient.shared.request("GET", "/api/routes/\(userId)", as: [RunRoute].self)
            errorMessage = nil
        } catch is CancellationError {
            return
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
