import SwiftUI

struct ActivityView: View {
    @Environment(AppRouter.self) private var router

    var body: some View {
        @Bindable var router = router
        NavigationStack {
            VStack(spacing: 0) {
                ActivitySectionPicker(selection: $router.activitySection)
                    .padding(.horizontal, DS.Spacing.l)
                    .padding(.top, DS.Spacing.xs)
                    .padding(.bottom, DS.Spacing.s)

                switch router.activitySection {
                case .feed:
                    FeedList()
                        .transition(.move(edge: .leading).combined(with: .opacity))
                case .mine:
                    MyRoutesList()
                        .transition(.move(edge: .trailing).combined(with: .opacity))
                }
            }
            .animation(.snappy(duration: 0.3), value: router.activitySection)
            .navigationTitle("Actividad")
            .screenBackground()
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
    /// The first page is being refetched in the background.
    private var isRefreshing = false

    // MARK: Cache (stale-while-revalidate)

    /// Shared by the Activity tab across tab switches; reset on logout.
    static let shared = FeedModel()

    /// Query of the first page (also warmed by TabPrefetcher).
    static let firstPageQuery: [String: String] = ["limit": "20", "offset": "0"]
    static let previewQuery: [String: String] = ["limit": "2"]
    nonisolated static func previewPath(_ eventId: String) -> String {
        "/api/feed/events/\(eventId)/preview-comments"
    }

    private var ownerId: String?
    private var firstPage: CachedResource<[FeedEvent]>?
    private var friendsResource: CachedResource<[AppUser]>?
    /// The first page was drawn (from the cache or the server).
    private(set) var hasLoaded = false
    var reloadTracker = ReloadSignalTracker()

    func reset() {
        ownerId = nil
        firstPage = nil
        friendsResource = nil
        hasLoaded = false
        reloadTracker = ReloadSignalTracker()
        events = []
        isLoading = false
        reachedEnd = false
        errorMessage = nil
        previews = [:]
        friends = []
        reactingIds = []
        actionError = nil
        serverOffset = 0
        loadingPreviews = []
        isRefreshing = false
    }

    private func prepare(userId: String) {
        guard ownerId != userId else { return }
        reset()
        ownerId = userId
        firstPage = CachedResource("/api/feed/\(userId)", query: Self.firstPageQuery)
        friendsResource = CachedResource("/api/friends/\(userId)")
    }

    /// Draws the last known first page right away.
    func showCached(userId: String) async {
        prepare(userId: userId)
        if let page = await firstPage?.loadCached() {
            applyFirstPage(page, userId: userId)
            hasLoaded = true
        }
        if let loaded = await friendsResource?.loadCached() {
            friends = loaded.map { MentionCandidate($0) }
        }
    }

    /// Cached first page first; then the first page and your friends refetched in parallel
    /// (skipped while fresh, unless `force`).
    func reload(userId: String, force: Bool = true) async {
        await showCached(userId: userId)
        guard let firstPage, let friendsResource else { return }
        if !force && firstPage.isFresh && hasLoaded { return }
        // Background refresh: the skeleton shows only when there is nothing to draw yet
        isRefreshing = true
        isLoading = events.isEmpty
        defer {
            isRefreshing = false
            isLoading = false
        }
        async let pageResult: [FeedEvent]? = firstPage.fetch()
        async let friendsResult: [AppUser]? = Self.fetchQuietly(friendsResource)
        do {
            // nil: same first page as shown, so the cards (and pages loaded below it) stay as they are
            if let page = try await pageResult {
                applyFirstPage(page, userId: userId)
            }
            errorMessage = nil
            hasLoaded = true
        } catch is CancellationError {
            return
        } catch {
            // With cached cards on screen the refresh fails silently (it's retried on the next visit)
            errorMessage = events.isEmpty ? error.localizedDescription : nil
            hasLoaded = true
        }
        if let loaded = await friendsResult {
            friends = loaded.map { MentionCandidate($0) }
        }
    }

    /// New body of a resource, nil when unchanged or on failure.
    private static func fetchQuietly<T: Decodable>(_ resource: CachedResource<T>) async -> T? {
        try? await resource.fetch()
    }

    func loadMore(userId: String) async {
        guard !isLoading, !isRefreshing, !reachedEnd else { return }
        await loadPage(userId: userId, offset: serverOffset)
    }

    private func visible(_ page: [FeedEvent], userId: String) -> [FeedEvent] {
        page.filter { event in
            guard Self.knownEventTypes.contains(event.eventType) else { return false }
            // Sentinel alerts are private to the defender
            return event.eventType != "sentinel_alert" || event.userId == userId
        }
    }

    /// Replaces the list with the first page. Comment previews of cards whose comment count didn't change are kept.
    private func applyFirstPage(_ page: [FeedEvent], userId: String) {
        let newEvents = visible(page, userId: userId)
        var counts: [String: Int] = [:]
        for event in events {
            counts[event.id] = event.commentCount
        }
        var keptPreviews: [String: [FeedComment]] = [:]
        for event in newEvents {
            if let preview = previews[event.id], counts[event.id] == event.commentCount {
                keptPreviews[event.id] = preview
            }
        }
        events = newEvents
        previews = keptPreviews
        loadingPreviews = []
        serverOffset = page.count
        reachedEnd = page.count < pageSize
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
                applyFirstPage(page, userId: userId)
            } else {
                let known = Set(events.map(\.id))
                events += visible(page, userId: userId).filter { !known.contains($0.id) }
                serverOffset = offset + page.count
                reachedEnd = page.count < pageSize
            }
            errorMessage = nil
        } catch is CancellationError {
            return
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func loadPreviewIfNeeded(for event: FeedEvent) async {
        guard event.commentCount > 0, previews[event.id] == nil, !loadingPreviews.contains(event.id) else { return }
        let path = Self.previewPath(event.id)
        // Last known preview right away; refetched only when it isn't fresh
        if let cached = APIClient.shared.cached(path, query: Self.previewQuery, as: [FeedComment].self) {
            previews[event.id] = cached
            if APIClient.shared.isCacheFresh(path, query: Self.previewQuery) { return }
        }
        loadingPreviews.insert(event.id)
        defer { loadingPreviews.remove(event.id) }
        if let comments = try? await APIClient.shared.request(
            "GET", path,
            query: Self.previewQuery,
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
    @State private var model = FeedModel.shared
    @State private var commentsFor: FeedEvent?
    @State private var profileUserId: String?
    @State private var reportTarget: ReportTarget?

    var body: some View {
        ScrollView {
            LazyVStack(spacing: DS.Spacing.l) {
                if let message = model.errorMessage, !model.events.isEmpty {
                    ErrorBanner(message: message, retry: { Task { await reload(force: true) } })
                }
                if model.events.isEmpty {
                    emptyContent
                }
                ForEach(model.events) { event in
                    card(for: event)
                }
                footer
            }
            .padding(.horizontal, DS.Spacing.l)
            .padding(.top, DS.Spacing.s)
            .padding(.bottom, DS.Spacing.xxl)
        }
        .scrollIndicators(.hidden)
        .refreshable { await reload(force: true) }
        .task(id: router.reloadSignal) {
            await reload(force: model.reloadTracker.consume(router.reloadSignal))
        }
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

    private func card(for event: FeedEvent) -> some View {
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
        .task(id: "\(event.id)-\(event.commentCount)") { await model.loadPreviewIfNeeded(for: event) }
        .onAppear {
            if event.id == model.events.last?.id, let userId = session.userId {
                Task { await model.loadMore(userId: userId) }
            }
        }
    }

    @ViewBuilder
    private var emptyContent: some View {
        if let message = model.errorMessage {
            ErrorView(message: message) { Task { await reload(force: true) } }
                .padding(.top, 40)
        } else if model.isLoading || !model.hasLoaded {
            ActivitySkeletonCard()
            ActivitySkeletonCard()
        } else {
            EmptyStateView(
                systemImage: "figure.run.circle",
                title: "Aquí aún no corre nadie",
                message: "Cuando tú o tus amigos salgáis a correr, vuestras carreras, robos y tesoros aparecerán aquí.",
                actionTitle: "Buscar amigos",
                action: { router.selectedTab = .friends }
            )
            .padding(.top, 40)
        }
    }

    @ViewBuilder
    private var footer: some View {
        if !model.events.isEmpty {
            if model.isLoading {
                ProgressView()
                    .padding(.vertical, DS.Spacing.l)
            } else if model.reachedEnd {
                Label("Estás al día", systemImage: "flag.checkered")
                    .font(.system(.footnote, design: .rounded, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .padding(.vertical, DS.Spacing.l)
            }
        }
    }

    /// Cached cards first; the server is asked again only when they aren't fresh (or `force`).
    private func reload(force: Bool = false) async {
        guard let userId = session.userId else { return }
        await model.reload(userId: userId, force: force)
    }
}

private struct ProfileTarget: Identifiable {
    let id: String
}

// MARK: - My routes

/// Your runs (GET /api/routes/:userId, shared with the map's cache), kept across tab switches.
@MainActor
@Observable
final class MyRoutesModel {
    static let shared = MyRoutesModel()

    private(set) var routes: [RunRoute] = []
    private(set) var isLoading = false
    private(set) var errorMessage: String?
    private(set) var hasLoaded = false
    var reloadTracker = ReloadSignalTracker()

    private var ownerId: String?
    private var resource: CachedResource<[RunRoute]>?

    func reset() {
        ownerId = nil
        resource = nil
        routes = []
        isLoading = false
        errorMessage = nil
        hasLoaded = false
        reloadTracker = ReloadSignalTracker()
    }

    /// Cached runs first; refetched when they aren't fresh (or `force`).
    func load(userId: String, force: Bool) async {
        if ownerId != userId {
            reset()
            ownerId = userId
            resource = CachedResource("/api/routes/\(userId)")
        }
        guard let resource else { return }
        if let cached = await resource.loadCached() {
            routes = cached
            hasLoaded = true
        }
        if !force && hasLoaded && resource.isFresh { return }
        isLoading = routes.isEmpty
        defer {
            isLoading = false
            hasLoaded = true
        }
        do {
            if let loaded = try await resource.fetch() {
                routes = loaded
            }
            errorMessage = nil
        } catch is CancellationError {
            return
        } catch {
            // With cached runs on screen the refresh fails silently (it's retried on the next visit)
            errorMessage = routes.isEmpty ? error.localizedDescription : nil
        }
    }
}

private struct MyRoutesList: View {
    @Environment(SessionStore.self) private var session
    @Environment(AppRouter.self) private var router
    @State private var model = MyRoutesModel.shared

    private var routes: [RunRoute] { model.routes }
    private var isLoading: Bool { model.isLoading }
    private var errorMessage: String? { model.errorMessage }
    private var didLoad: Bool { model.hasLoaded }

    private var userColor: Color { Color(hex: session.user?.color ?? "#16A34A") }
    private var groups: [ActivityMonthGroup] { ActivityMonthGroup.group(routes) }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: DS.Spacing.m) {
                if routes.isEmpty {
                    emptyContent
                } else {
                    ActivityWeekCard(summary: ActivityWeekSummary(routes: routes))
                        .padding(.bottom, DS.Spacing.s)
                    if let errorMessage {
                        ErrorBanner(message: errorMessage, retry: { Task { await load(force: true) } })
                    }
                    ForEach(groups) { group in
                        monthSection(group)
                    }
                }
            }
            .padding(.horizontal, DS.Spacing.l)
            .padding(.top, DS.Spacing.s)
            .padding(.bottom, DS.Spacing.xxl)
        }
        .scrollIndicators(.hidden)
        .navigationDestination(for: RunRoute.self) { route in
            RouteDetailView(route: route) {
                Task { await load(force: true) }
            }
        }
        .refreshable { await load(force: true) }
        .task(id: router.reloadSignal) {
            await load(force: model.reloadTracker.consume(router.reloadSignal))
        }
    }

    @ViewBuilder
    private func monthSection(_ group: ActivityMonthGroup) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(group.title)
                .font(Font.sectionTitle)
            Spacer()
            Text(group.summary)
                .font(.system(.caption, design: .rounded, weight: .semibold))
                .foregroundStyle(.secondary)
        }
        .padding(.top, DS.Spacing.m)
        .padding(.horizontal, DS.Spacing.xs)
        ForEach(group.routes) { route in
            NavigationLink(value: route) {
                ActivityRunRow(route: route, color: userColor)
            }
            .buttonStyle(.pressable)
        }
    }

    @ViewBuilder
    private var emptyContent: some View {
        if let errorMessage {
            ErrorView(message: errorMessage) { Task { await load(force: true) } }
                .padding(.top, 40)
        } else if isLoading || !didLoad {
            ProgressView()
                .frame(maxWidth: .infinity)
                .padding(.top, 80)
        } else {
            EmptyStateView(
                systemImage: "shoeprints.fill",
                title: "Tus zapatillas te echan de menos",
                message: "Sal a correr desde el mapa, conecta Strava/Polar o importa tus entrenos de Apple Salud desde el Perfil.",
                actionTitle: "Ir al mapa",
                action: { router.selectedTab = .map }
            )
            .padding(.top, 40)
        }
    }

    private func load(force: Bool = false) async {
        guard let userId = session.userId else { return }
        await model.load(userId: userId, force: force)
    }
}

// MARK: - Run row

/// One of your runs: map thumbnail, name, date and stat pills.
private struct ActivityRunRow: View {
    let route: RunRoute
    let color: Color

    var body: some View {
        HStack(spacing: 14) {
            thumbnail
            VStack(alignment: .leading, spacing: 6) {
                Text(route.name)
                    .font(Font.cardTitle)
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                Text(Format.dayAndTime(route.startDate))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                pills
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right")
                .font(.caption.weight(.bold))
                .foregroundStyle(.tertiary)
        }
        .activityCard(padding: DS.Spacing.m)
        .contentShape(RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous))
    }

    @ViewBuilder
    private var thumbnail: some View {
        if route.coordinates.count >= 2 {
            ActivityRouteMap(cacheKey: "route-\(route.id)", coordinates: route.coordinates, color: color, cornerRadius: 14, lineWidth: 3)
                .frame(width: 64, height: 64)
        } else {
            Image(systemName: "figure.run")
                .font(.title2.weight(.semibold))
                .foregroundStyle(color)
                .frame(width: 64, height: 64)
                .background(color.opacity(0.12), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
    }

    // Pills never truncate: if all three don't fit, the time pill is dropped
    private var pills: some View {
        ViewThatFits(in: .horizontal) {
            pillRow(showDuration: true)
            pillRow(showDuration: false)
        }
    }

    private func pillRow(showDuration: Bool) -> some View {
        HStack(spacing: 6) {
            ActivityMiniPill(systemImage: "figure.run", text: Format.distance(route.distance), tint: Color.sky)
            if showDuration {
                ActivityMiniPill(systemImage: "stopwatch.fill", text: Format.duration(route.duration), tint: Color.grape)
            }
            if let area = route.territoryArea, area > 0 {
                ActivityMiniPill(systemImage: "flag.fill", text: "+\(Format.area(area))", tint: Color.brand)
            }
        }
    }
}

private struct ActivityMiniPill: View {
    let systemImage: String
    let text: String
    let tint: Color

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: systemImage)
                .font(.system(size: 9, weight: .bold))
                .foregroundStyle(tint)
            Text(text)
                .font(.system(.caption2, design: .rounded, weight: .bold))
                .monospacedDigit()
                .foregroundStyle(.primary)
                .lineLimit(1)
        }
        .padding(.horizontal, 7)
        .padding(.vertical, 4)
        .background(tint.opacity(0.13), in: Capsule())
        .fixedSize()
    }
}

// MARK: - Grouping and weekly summary

private enum ActivityCalendar {
    static let locale = Locale(identifier: "es_ES")

    static var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.locale = locale
        calendar.firstWeekday = 2
        return calendar
    }
}

/// Runs of one month (in the server's order, newest first).
private struct ActivityMonthGroup: Identifiable {
    let id: String
    let title: String
    var routes: [RunRoute]

    var summary: String {
        let distance = routes.reduce(0.0) { $0 + $1.distance }
        let count = routes.count
        return "\(count) \(count == 1 ? "carrera" : "carreras") · \(Format.distance(distance))"
    }

    static func group(_ routes: [RunRoute]) -> [ActivityMonthGroup] {
        let calendar = ActivityCalendar.calendar
        var groups: [ActivityMonthGroup] = []
        for route in routes {
            var key = "unknown"
            var title = "Sin fecha"
            if let date = route.startDate {
                let parts = calendar.dateComponents([.year, .month], from: date)
                key = "\(parts.year ?? 0)-\(parts.month ?? 0)"
                let formatted: String = date.formatted(.dateTime.month(.wide).year().locale(ActivityCalendar.locale))
                title = formatted.prefix(1).uppercased() + String(formatted.dropFirst())
            }
            if let index = groups.firstIndex(where: { $0.id == key }) {
                groups[index].routes.append(route)
            } else {
                groups.append(ActivityMonthGroup(id: key, title: title, routes: [route]))
            }
        }
        return groups
    }
}

/// Your numbers for the current week (Monday to Sunday) and last week's distance.
private struct ActivityWeekSummary {
    var distance: Double = 0
    var duration: Int = 0
    var runs: Int = 0
    var area: Double = 0
    var lastWeekDistance: Double = 0
    /// Kilometres per day, Monday first.
    var dailyKm: [Double] = Array(repeating: 0, count: 7)
    /// Index of today (0 = Monday).
    var todayIndex: Int = 0

    init(routes: [RunRoute], now: Date = Date()) {
        let calendar = ActivityCalendar.calendar
        guard let week = calendar.dateInterval(of: .weekOfYear, for: now) else { return }
        let lastWeekStart = week.start.addingTimeInterval(-7 * 24 * 3600)
        let todayOffset = calendar.dateComponents([.day], from: week.start, to: calendar.startOfDay(for: now)).day ?? 0
        todayIndex = min(max(todayOffset, 0), 6)

        for route in routes {
            guard let date = route.startDate else { continue }
            if week.contains(date) {
                distance += route.distance
                duration += route.duration
                runs += 1
                area += route.territoryArea ?? 0
                let day = calendar.dateComponents([.day], from: week.start, to: calendar.startOfDay(for: date)).day ?? 0
                let index = min(max(day, 0), 6)
                dailyKm[index] += route.distance / 1000
            } else if date >= lastWeekStart && date < week.start {
                lastWeekDistance += route.distance
            }
        }
    }

    /// Change against last week, in percent (nil without data last week).
    var deltaPercent: Int? {
        guard lastWeekDistance > 0 else { return nil }
        let percent: Double = (distance - lastWeekDistance) / lastWeekDistance * 100
        return Int(percent.rounded())
    }
}

/// Hero card at the top of "Mis carreras": this week's kilometres and a mini day-by-day chart.
private struct ActivityWeekCard: View {
    let summary: ActivityWeekSummary

    private static let dayLetters: [String] = ["L", "M", "X", "J", "V", "S", "D"]

    private var kmText: String {
        (summary.distance / 1000).formatted(.number.precision(.fractionLength(1)).locale(ActivityCalendar.locale))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.l) {
            topRow
            HStack(alignment: .bottom, spacing: DS.Spacing.l) {
                bigNumber
                Spacer(minLength: 0)
                chart
            }
            statsRow
        }
        .foregroundStyle(.white)
        .padding(DS.Spacing.xl)
        .background { background }
        .shadow(color: Color.brand.opacity(0.35), radius: 16, x: 0, y: 8)
        .accessibilityElement(children: .combine)
    }

    private var background: some View {
        let shape = RoundedRectangle(cornerRadius: DS.Radius.card + 2, style: .continuous)
        return ZStack(alignment: .topTrailing) {
            shape.fill(.brandGradient)
            Image(systemName: "figure.run")
                .font(.system(size: 120, weight: .black))
                .foregroundStyle(Color.white.opacity(0.08))
                .offset(x: 20, y: -10)
                .accessibilityHidden(true)
        }
        .clipShape(shape)
    }

    private var topRow: some View {
        HStack {
            Text("Esta semana")
                .font(.system(.subheadline, design: .rounded, weight: .bold))
                .textCase(.uppercase)
                .tracking(0.8)
                .opacity(0.9)
            Spacer()
            if let delta = summary.deltaPercent {
                deltaBadge(delta)
            }
        }
    }

    private func deltaBadge(_ delta: Int) -> some View {
        HStack(spacing: 3) {
            Image(systemName: delta >= 0 ? "arrow.up.right" : "arrow.down.right")
                .font(.caption2.weight(.heavy))
            Text("\(delta >= 0 ? "+" : "")\(delta)% vs. anterior")
                .font(.system(.caption, design: .rounded, weight: .bold))
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 5)
        .background(Color.white.opacity(0.2), in: Capsule())
    }

    private var bigNumber: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(kmText)
                    .font(Font.stat(52, weight: .heavy))
                    .monospacedDigit()
                    .contentTransition(.numericText())
                Text("km")
                    .font(.system(.title3, design: .rounded, weight: .bold))
                    .opacity(0.85)
            }
            Text(summary.runs == 0 ? "¿Salimos hoy?" : "¡Sigue así!")
                .font(.system(.footnote, design: .rounded, weight: .semibold))
                .opacity(0.85)
        }
    }

    private var chart: some View {
        let maxKm: Double = max(summary.dailyKm.max() ?? 0, 0.1)
        return HStack(alignment: .bottom, spacing: 6) {
            ForEach(0..<7, id: \.self) { index in
                dayBar(index: index, maxKm: maxKm)
            }
        }
        .frame(height: 74, alignment: .bottom)
        .accessibilityHidden(true)
    }

    private func dayBar(index: Int, maxKm: Double) -> some View {
        let km: Double = summary.dailyKm[index]
        let height: CGFloat = km > 0 ? max(8, CGFloat(km / maxKm) * 54) : 6
        let isToday: Bool = index == summary.todayIndex
        return VStack(spacing: 4) {
            Capsule()
                .fill(Color.white.opacity(km > 0 ? 0.95 : 0.3))
                .frame(width: 10, height: height)
            Text(Self.dayLetters[index])
                .font(.system(size: 10, weight: isToday ? .heavy : .semibold, design: .rounded))
                .opacity(isToday ? 1 : 0.75)
        }
    }

    private var statsRow: some View {
        HStack(spacing: 0) {
            weekStat(value: "\(summary.runs)", label: summary.runs == 1 ? "Carrera" : "Carreras")
            divider
            weekStat(value: Format.duration(summary.duration), label: "Tiempo")
            divider
            weekStat(value: Format.area(summary.area), label: "Conquistado")
        }
        .padding(.vertical, 10)
        .background(Color.white.opacity(0.16), in: RoundedRectangle(cornerRadius: DS.Radius.tile, style: .continuous))
    }

    private var divider: some View {
        Rectangle()
            .fill(Color.white.opacity(0.25))
            .frame(width: 1, height: 28)
    }

    private func weekStat(value: String, label: String) -> some View {
        VStack(spacing: 2) {
            Text(value)
                .font(.system(.headline, design: .rounded, weight: .heavy))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            Text(label)
                .font(Font.statLabel)
                .textCase(.uppercase)
                .tracking(0.5)
                .opacity(0.85)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity)
    }
}
