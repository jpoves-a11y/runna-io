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
    /// Event types the app knows how to show; anything else the server adds later is skipped.
    static let knownEventTypes: Set<String> = [
        "activity", "treasure_found", "treasure_spawned", "nickname_changed", "sentinel_alert",
        "personal_record", "territory_stolen", "ran_together",
    ]

    private(set) var events: [FeedEvent] = []
    private(set) var isLoading = false
    private(set) var reachedEnd = false
    private(set) var errorMessage: String?
    /// First comments of each event (GET /api/feed/events/:id/preview-comments), by event id.
    private(set) var previews: [String: [FeedComment]] = [:]
    /// Your friends, to resolve @mentions in comment previews.
    private(set) var friends: [MentionCandidate] = []
    /// Events with a reaction request in flight.
    private(set) var reactingIds: Set<String> = []
    var actionError: String?

    private let pageSize = 20
    /// Rows received from the server (before filtering), used as the next page offset.
    private var serverOffset = 0
    private var loadingPreviews: Set<String> = []

    func reload(userId: String) async {
        reachedEnd = false
        await loadPage(userId: userId, offset: 0)
        if friends.isEmpty {
            let loaded = (try? await APIClient.shared.request("GET", "/api/friends/\(userId)", as: [AppUser].self)) ?? []
            friends = loaded.map { MentionCandidate($0) }
        }
    }

    func loadMore(userId: String) async {
        guard !isLoading, !reachedEnd else { return }
        await loadPage(userId: userId, offset: serverOffset)
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
            let visible = page.filter { event in
                guard Self.knownEventTypes.contains(event.eventType) else { return false }
                // Sentinel alerts are private to the defender
                return event.eventType != "sentinel_alert" || event.userId == userId
            }
            if offset == 0 {
                events = visible
                previews = [:]
                loadingPreviews = []
            } else {
                let known = Set(events.map(\.id))
                events += visible.filter { !known.contains($0.id) }
            }
            serverOffset = offset + page.count
            reachedEnd = page.count < pageSize
            errorMessage = nil
        } catch is CancellationError {
            return
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func loadPreviewIfNeeded(for event: FeedEvent) async {
        guard event.commentCount > 0, previews[event.id] == nil, !loadingPreviews.contains(event.id) else { return }
        loadingPreviews.insert(event.id)
        defer { loadingPreviews.remove(event.id) }
        if let comments = try? await APIClient.shared.request(
            "GET", "/api/feed/events/\(event.id)/preview-comments",
            query: ["limit": "2"],
            as: [FeedComment].self
        ) {
            previews[event.id] = comments
        }
    }

    func react(to event: FeedEvent, with reaction: String) async {
        guard !reactingIds.contains(event.id) else { return }
        reactingIds.insert(event.id)
        defer { reactingIds.remove(event.id) }
        do {
            let result = try await APIClient.shared.request(
                "POST", "/api/feed/reactions",
                body: ["targetType": "event", "targetId": event.id, "reactionType": reaction],
                as: ReactionResult.self
            )
            if let index = events.firstIndex(where: { $0.id == event.id }) {
                events[index].likeCount = result.likeCount
                events[index].dislikeCount = result.dislikeCount
                events[index].userReaction = result.userReaction
            }
        } catch {
            actionError = error.localizedDescription
        }
    }

    func updateCommentCount(eventId: String, count: Int) {
        if let index = events.firstIndex(where: { $0.id == eventId }) {
            events[index].commentCount = count
        }
        // Reload the preview with the new comments next time the card shows
        previews[eventId] = nil
    }
}

private struct FeedList: View {
    @Environment(SessionStore.self) private var session
    @Environment(AppRouter.self) private var router
    @State private var model = FeedModel()
    @State private var commentsFor: FeedEvent?
    @State private var profileUserId: String?
    @State private var reportTarget: ReportTarget?

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
                    currentUserId: session.userId,
                    previewComments: model.previews[event.id] ?? [],
                    people: model.friends,
                    isReacting: model.reactingIds.contains(event.id),
                    onReact: { reaction in Task { await model.react(to: event, with: reaction) } },
                    onComments: { commentsFor = event },
                    onOpenUser: { profileUserId = $0 },
                    onReport: { reportTarget = .feedEvent(event) }
                )
                .listRowInsets(EdgeInsets(top: 6, leading: 12, bottom: 6, trailing: 12))
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
                .task(id: "\(event.id)-\(event.commentCount)") { await model.loadPreviewIfNeeded(for: event) }
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
        .reportSheet($reportTarget)
        .errorAlert(Binding(get: { model.actionError }, set: { model.actionError = $0 }))
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
    let currentUserId: String?
    let previewComments: [FeedComment]
    let people: [MentionCandidate]
    let isReacting: Bool
    let onReact: (String) -> Void
    let onComments: () -> Void
    let onOpenUser: (String) -> Void
    let onReport: () -> Void

    private static let systemUsername = "_runna_system"

    /// Treasure spawns are posted by the server's system user, which has no real profile.
    private var isSystemEvent: Bool {
        event.eventType == "treasure_spawned" || event.user.username == Self.systemUsername
    }

    private var isMine: Bool { event.userId == currentUserId }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header

            Text(headline)
                .font(.subheadline.weight(isSpecialType ? .semibold : .regular))
                .fixedSize(horizontal: false, vertical: true)

            typeSpecificContent

            if event.routeCoordinates.count >= 2 {
                RouteShape(coordinates: event.routeCoordinates)
                    .stroke(Color(hex: event.user.color), style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
                    .frame(height: 140)
                    .padding(12)
                    .frame(maxWidth: .infinity)
                    .background(Color(hex: event.user.color).opacity(0.08), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            }

            if hasStats {
                HStack {
                    if let distance = event.distance, distance > 0 {
                        StatTile(value: Format.distance(distance), label: "Distancia")
                    }
                    if let duration = event.duration, duration > 0 {
                        StatTile(value: Format.duration(duration), label: "Tiempo")
                    }
                    if let pace = paceText {
                        StatTile(value: pace, label: "Ritmo")
                    }
                    if let area = event.newArea, area > 0 {
                        StatTile(value: "+\(Format.area(area))", label: "Conquistado", tint: .brand)
                    }
                }
            }

            emblems

            actionBar

            if !previewComments.isEmpty {
                commentPreviews
            }
        }
        .cardStyle()
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: 10) {
            if isSystemEvent {
                ZStack {
                    Circle().fill(Color.brand.opacity(0.15))
                    Text("🏴‍☠️").font(.system(size: 20))
                }
                .frame(width: 40, height: 40)
                .accessibilityHidden(true)
            } else {
                Button { onOpenUser(event.user.id) } label: {
                    AvatarView(name: event.user.name, avatar: event.user.avatar, color: event.user.color, size: 40)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Ver perfil de \(event.user.name)")
            }
            VStack(alignment: .leading, spacing: 2) {
                if isSystemEvent {
                    Text("Runna").font(.subheadline.weight(.semibold))
                } else {
                    Button { onOpenUser(event.user.id) } label: {
                        Text(event.user.displayName)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                    }
                    .buttonStyle(.borderless)
                }
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer()
            Image(systemName: typeIcon)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            if !isMine && !isSystemEvent {
                Menu {
                    Button(action: onReport) {
                        Label("Denunciar publicación", systemImage: "exclamationmark.bubble")
                    }
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .frame(width: 32, height: 32)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel("Más opciones")
            }
        }
    }

    private var subtitle: String {
        let time = Format.relative(event.date)
        if event.eventType == "activity", let routeName = event.routeName, !routeName.isEmpty {
            return "\(time) · \(routeName)"
        }
        return time
    }

    private var typeIcon: String {
        switch event.eventType {
        case "treasure_found", "treasure_spawned": return "gift"
        case "nickname_changed": return "theatermasks"
        case "sentinel_alert": return "shield.lefthalf.filled"
        case "personal_record": return "medal"
        default: return "flame"
        }
    }

    // MARK: Headline

    private var isSpecialType: Bool {
        ["treasure_found", "treasure_spawned", "nickname_changed", "sentinel_alert", "personal_record"].contains(event.eventType)
    }

    private var headline: String {
        let meta = event.metadata
        switch event.eventType {
        case "treasure_found":
            return "¡Tesoro encontrado! \(meta?.emoji ?? "🎁") \(meta?.treasureName ?? "Un tesoro")"
        case "treasure_spawned":
            return "¡Nuevo tesoro en el mapa! \(meta?.emoji ?? "📦") \(meta?.treasureName ?? "")"
        case "nickname_changed":
            let nickname = meta?.nickname ?? "???"
            let target = meta?.targetName ?? event.victim?.name ?? "un jugador"
            if isMine {
                return "🎭 Has puesto el apodo \"\(nickname)\" a \(target)"
            }
            if let victimId = event.victim?.id, victimId == currentUserId {
                return "🎭 Te ha puesto el apodo \"\(nickname)\""
            }
            return "🎭 Ha puesto el apodo \"\(nickname)\" a \(target)"
        case "sentinel_alert":
            if let message = meta?.alertMessage, !message.isEmpty {
                return "🛡️ \(message)"
            }
            let attacker = meta?.attackerName ?? "Alguien"
            if let area = meta?.stolenArea, area > 0 {
                return "🛡️ \(attacker) te ha robado \(Format.area(area))"
            }
            return "🛡️ \(attacker) ha entrado en tu territorio"
        case "personal_record":
            return "🏅 Nuevo récord personal: \(Self.recordLabel(event.recordType ?? ""))"
        case "territory_stolen":
            return "Ha robado \(Format.area(event.areaStolen ?? 0)) a \(event.victim?.name ?? "alguien")"
        case "ran_together":
            return "Ha corrido acompañado"
        default:
            return "Ha salido a correr"
        }
    }

    // MARK: Type-specific blocks

    @ViewBuilder
    private var typeSpecificContent: some View {
        switch event.eventType {
        case "treasure_found", "treasure_spawned":
            let rarity = event.metadata?.rarity ?? "common"
            HStack(spacing: 12) {
                Image(Rarity.chestImage(rarity))
                    .resizable()
                    .scaledToFit()
                    .frame(width: 56, height: 56)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 6) {
                    RarityPill(rarity: rarity)
                    if let zone = event.metadata?.zone, !zone.isEmpty {
                        Label(zone, systemImage: "mappin.and.ellipse")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer()
            }
            .padding(10)
            .background(Rarity.color(rarity).opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        case "nickname_changed":
            Text("Durará 48 horas")
                .font(.footnote)
                .foregroundStyle(.secondary)
        case "personal_record":
            if let value = event.recordValue {
                Text(Self.recordValue(type: event.recordType ?? "", value: value))
                    .font(.title3.weight(.bold))
                    .monospacedDigit()
                    .foregroundStyle(Color.brand)
            }
        default:
            EmptyView()
        }
    }

    private var hasStats: Bool {
        (event.distance ?? 0) > 0 || (event.duration ?? 0) > 0 || (event.newArea ?? 0) > 0
    }

    /// Pace only for runs of at least 100 m with a plausible pace (2–20 min/km), like the web app.
    private var paceText: String? {
        guard let distance = event.distance, let duration = event.duration, distance >= 100, duration > 0 else { return nil }
        let secondsPerKm = Double(duration) / (distance / 1000)
        guard secondsPerKm >= 120, secondsPerKm <= 1200 else { return nil }
        return Format.pace(distanceMeters: distance, seconds: duration)
    }

    // MARK: Emblems

    @ViewBuilder
    private var emblems: some View {
        let meta = event.metadata
        let victims = (meta?.victims ?? []).filter { $0.stolenArea > 0 }
        let companions = meta?.ranTogetherWith ?? []
        let records = event.eventType == "personal_record" ? [] : (meta?.records ?? [])
        let treasures = event.eventType == "treasure_found" ? [] : (meta?.treasures ?? [])
        let destroyed = meta?.fortressesDestroyed ?? 0
        let layers = meta?.fortificationLayers ?? 0

        if !victims.isEmpty || !companions.isEmpty || !records.isEmpty || !treasures.isEmpty || destroyed > 0 || layers > 0 {
            VStack(alignment: .leading, spacing: 8) {
                if !victims.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("⚔️ Ha robado territorio a")
                            .font(.footnote.weight(.semibold))
                        ForEach(victims) { victim in
                            Button { onOpenUser(victim.userId) } label: {
                                HStack(spacing: 8) {
                                    Circle().fill(Color(hex: victim.userColor)).frame(width: 8, height: 8)
                                    Text(victim.userId == currentUserId ? "Ti" : victim.userName)
                                        .foregroundStyle(.primary)
                                    Spacer()
                                    Text("-\(Format.area(victim.stolenArea))")
                                        .monospacedDigit()
                                        .foregroundStyle(.red)
                                }
                                .font(.footnote)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.borderless)
                        }
                    }
                }

                if !companions.isEmpty {
                    HStack(alignment: .firstTextBaseline, spacing: 4) {
                        Text("👟 Corrieron juntos:")
                            .font(.footnote.weight(.semibold))
                        ForEach(Array(companions.enumerated()), id: \.offset) { index, companion in
                            let isYou: Bool = companion.id != nil && companion.id == currentUserId
                            let separator: String = index < companions.count - 1 ? "," : ""
                            let label: String = (isYou ? "Ti" : companion.name) + separator
                            if let id = companion.id {
                                Button(label) { onOpenUser(id) }
                                    .buttonStyle(.borderless)
                                    .font(.footnote)
                            } else {
                                Text(label).font(.footnote)
                            }
                        }
                    }
                    .lineLimit(1)
                }

                ForEach(Array(records.enumerated()), id: \.offset) { _, record in
                    if let value = record.value {
                        Text("🏅 \(Self.recordLabel(record.type)): \(Self.recordValue(type: record.type, value: value))")
                            .font(.footnote)
                    } else {
                        Text("🏅 \(Self.recordLabel(record.type))")
                            .font(.footnote)
                    }
                }

                if !treasures.isEmpty {
                    HStack(spacing: 6) {
                        Text("🎁").font(.footnote)
                        ForEach(Array(treasures.enumerated()), id: \.offset) { _, treasure in
                            Text(treasure.treasureName ?? "Tesoro").font(.footnote)
                            if let rarity = treasure.rarity {
                                RarityPill(rarity: rarity)
                            }
                        }
                    }
                }

                if destroyed > 0 {
                    Text(destroyed == 1 ? "🏰 Rompió 1 fortaleza" : "🏰 Rompió \(destroyed) fortalezas")
                        .font(.footnote)
                }

                if layers > 0 {
                    Text("🧱 Reforzó \(Format.area(meta?.fortificationArea ?? 0)) de territorio (+\(layers) \(layers == 1 ? "capa" : "capas"))")
                        .font(.footnote)
                }
            }
            .foregroundStyle(.secondary)
        }
    }

    static func recordLabel(_ type: String) -> String {
        switch type {
        case "longest_run": return "Carrera más larga"
        case "fastest_pace": return "Ritmo más rápido"
        case "biggest_conquest": return "Mayor conquista"
        default: return "Récord"
        }
    }

    /// longest_run in metres, fastest_pace in decimal min/km, biggest_conquest in m².
    static func recordValue(type: String, value: Double) -> String {
        switch type {
        case "longest_run":
            return Format.distance(value)
        case "fastest_pace":
            guard value.isFinite, value > 0 else { return "--" }
            let totalSeconds = Int((value * 60).rounded())
            return String(format: "%d:%02d /km", totalSeconds / 60, totalSeconds % 60)
        case "biggest_conquest":
            return Format.area(value)
        default:
            return value.formatted()
        }
    }

    // MARK: Actions and comments

    private var actionBar: some View {
        HStack(spacing: 18) {
            reactionButton("like", systemImage: "hand.thumbsup", count: event.likeCount)
            reactionButton("dislike", systemImage: "hand.thumbsdown", count: event.dislikeCount)
            Button(action: onComments) {
                Label("\(event.commentCount)", systemImage: "bubble.right")
            }
            .buttonStyle(.borderless)
            .foregroundStyle(.secondary)
            .accessibilityLabel("\(event.commentCount) comentarios")
            Spacer()
        }
        .font(.subheadline)
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
        .buttonStyle(.borderless)
        .disabled(isReacting)
        .accessibilityLabel(reaction == "like" ? "Me gusta, \(count)" : "No me gusta, \(count)")
    }

    private var commentPreviews: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(previewComments.prefix(2)) { comment in
                previewLine(comment)
            }
            if event.commentCount > min(previewComments.count, 2) {
                Button("Ver los \(event.commentCount) comentarios", action: onComments)
                    .buttonStyle(.borderless)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func previewLine(_ comment: FeedComment) -> some View {
        (Text(comment.user.name).bold().foregroundColor(Color(hex: comment.user.color))
            + Text(" ")
            + Text(Mentions.attributed(comment.content, people: people)))
            .font(.footnote)
            .lineLimit(2)
            .environment(\.openURL, OpenURLAction { url in
                if let userId = Mentions.userId(from: url) {
                    onOpenUser(userId)
                    return .handled
                }
                return .systemAction
            })
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
