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
                    .padding(.bottom, DS.Spacing.m)

                switch router.activitySection {
                case .feed:
                    FeedList()
                        .transition(.opacity)
                case .mine:
                    MyRoutesList()
                        .transition(.opacity)
                }
            }
            .animation(.snappy(duration: 0.25), value: router.activitySection)
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
    /// Kept for compatibility: reactions are optimistic now, so cards never wait for a request.
    private(set) var reactingIds: Set<String> = []
    var actionError: String?
    /// Reactions shown before the server confirmed them, by event id: they survive a refresh that
    /// returns the old counters while the request is still in flight.
    private var optimisticReactions: [String: ReactionState] = [:]
    private let reactionSync = ReactionSync()

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
        optimisticReactions = [:]
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
        let shown = page.filter { event in
            guard Self.knownEventTypes.contains(event.eventType) else { return false }
            // Sentinel alerts are private to the defender
            return event.eventType != "sentinel_alert" || event.userId == userId
        }
        guard !optimisticReactions.isEmpty else { return shown }
        return shown.map { event in
            guard let state = optimisticReactions[event.id] else { return event }
            var copy = event
            copy.likeCount = state.likeCount
            copy.dislikeCount = state.dislikeCount
            copy.userReaction = state.userReaction
            return copy
        }
    }

    /// The card of a run you just uploaded, shown at the top before the server's feed is refetched.
    func insertLocal(_ event: FeedEvent, userId: String) {
        guard ownerId == userId || ownerId == nil else { return }
        guard !events.contains(where: { $0.id == event.id || ($0.routeId != nil && $0.routeId == event.routeId) }) else { return }
        events.insert(event, at: 0)
        hasLoaded = true
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

    /// Optimistic: the card changes at once, the request goes in the background, and the counters
    /// are rolled back (with a short message) if it fails.
    func react(to event: FeedEvent, with reaction: String) async {
        guard !OptimisticCache.isLocal(event.id),
              let index = events.firstIndex(where: { $0.id == event.id }) else { return }
        let current = events[index]
        let before = ReactionState(likeCount: current.likeCount, dislikeCount: current.dislikeCount, userReaction: current.userReaction)
        let after = before.toggled(reaction)
        let eventId = event.id
        optimisticReactions[eventId] = after
        showReaction(after, eventId: eventId)
        reactionSync.send(
            targetType: "event",
            targetId: eventId,
            before: before,
            after: after,
            onSettled: { [weak self] state in
                guard let self else { return }
                self.optimisticReactions[eventId] = nil
                self.showReaction(state, eventId: eventId)
            },
            onFailed: { [weak self] state, message in
                guard let self else { return }
                self.optimisticReactions[eventId] = nil
                self.showReaction(state, eventId: eventId)
                self.actionError = message
            }
        )
    }

    private func showReaction(_ state: ReactionState, eventId: String) {
        if let index = events.firstIndex(where: { $0.id == eventId }) {
            events[index].likeCount = state.likeCount
            events[index].dislikeCount = state.dislikeCount
            events[index].userReaction = state.userReaction
        }
        OptimisticCache.setEventReaction(eventId: eventId, state: state)
    }

    func updateCommentCount(eventId: String, count: Int) {
        if let index = events.firstIndex(where: { $0.id == eventId }) {
            events[index].commentCount = count
        }
        OptimisticCache.setCommentCount(eventId: eventId, count: count)
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
        ScrollViewReader { proxy in
            feedScroll
                // A notification asked for a post: once it's loaded, scroll to it (and open its comments)
                .task(id: "\(router.feedFocus?.eventId ?? "")-\(model.events.count)") {
                    guard let focus = router.feedFocus,
                          let event = model.events.first(where: { $0.id == focus.eventId }) else { return }
                    router.feedFocus = nil
                    withAnimation(.snappy) { proxy.scrollTo(event.id, anchor: .top) }
                    if focus.openComments, !OptimisticCache.isLocal(event.id) { commentsFor = event }
                }
        }
    }

    private var feedScroll: some View {
        ScrollView {
            LazyVStack(spacing: DS.Spacing.m) {
                if let message = model.errorMessage, !model.events.isEmpty {
                    ErrorBanner(message: message, retry: { Task { await reload(force: true) } })
                }
                if model.events.isEmpty {
                    emptyContent
                }
                ForEach(model.events) { event in
                    card(for: event)
                        .id(event.id)
                }
                footer
            }
            .padding(.horizontal, DS.Spacing.l)
            .padding(.top, DS.Spacing.xs)
            .padding(.bottom, DS.Spacing.xxl)
        }
        .scrollIndicators(.hidden)
        .refreshable {
            // Cached cards stay on screen; new ones replace them in place when they arrive
            await QuickRefresh.run { await reload(force: true) }
        }
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
        .errorToast(Binding(get: { model.actionError }, set: { model.actionError = $0 }))
    }

    private func card(for event: FeedEvent) -> some View {
        FeedEventCard(
            event: event,
            currentUserId: session.userId,
            previewComments: model.previews[event.id] ?? [],
            people: model.friends,
            isReacting: false,
            onReact: { reaction in Task { await model.react(to: event, with: reaction) } },
            onComments: {
                // A run just uploaded: its card is local until the server's one replaces it
                if !OptimisticCache.isLocal(event.id) { commentsFor = event }
            },
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
                systemImage: "figure.run",
                title: "Sin actividad todavía",
                message: "Las carreras, conquistas y tesoros tuyos y de tus amigos aparecerán aquí.",
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
                Text("No hay más actividad")
                    .font(Font.meta)
                    .foregroundStyle(.tertiary)
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

    private(set) var routes: [RunRoute] = [] {
        didSet { rebuildDerived() }
    }
    /// Month sections and weekly numbers, worked out once per change (not on every redraw).
    fileprivate private(set) var monthGroups: [ActivityMonthGroup] = []
    fileprivate private(set) var weekSummary = ActivityWeekSummary(routes: [])
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

    private func rebuildDerived() {
        monthGroups = ActivityMonthGroup.group(routes)
        weekSummary = ActivityWeekSummary(routes: routes)
    }

    /// A run just uploaded from this iPhone, shown at once (the next refresh confirms it).
    func insertUploaded(_ route: RunRoute) {
        guard ownerId == nil || ownerId == route.userId else { return }
        guard !routes.contains(where: { $0.id == route.id }) else { return }
        routes.insert(route, at: 0)
        hasLoaded = true
    }

    /// Optimistic rename (RouteDetailView); `name` is put back if the server refuses it.
    func applyRename(routeId: String, name: String) {
        if let index = routes.firstIndex(where: { $0.id == routeId }) {
            routes[index].name = name
        }
        OptimisticCache.renameRoute(routeId: routeId, name: name)
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

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: DS.Spacing.s) {
                if routes.isEmpty {
                    emptyContent
                } else {
                    ActivityWeekCard(summary: model.weekSummary)
                        .padding(.bottom, DS.Spacing.m)
                    if let errorMessage {
                        ErrorBanner(message: errorMessage, retry: { Task { await load(force: true) } })
                    }
                    // One lazy element per header and per run, so only the rows on screen are built
                    ForEach(model.monthGroups) { group in
                        monthHeader(group)
                        ForEach(Array(group.routes.enumerated()), id: \.element.id) { index, route in
                            runRow(route, isFirst: index == 0, isLast: index == group.routes.count - 1)
                        }
                    }
                }
            }
            .padding(.horizontal, DS.Spacing.l)
            .padding(.top, DS.Spacing.xs)
            .padding(.bottom, DS.Spacing.xxl)
        }
        .scrollIndicators(.hidden)
        .navigationDestination(for: RunRoute.self) { route in
            RouteDetailView(route: route) {
                Task { await load(force: true) }
            }
        }
        .refreshable { await QuickRefresh.run { await load(force: true) } }
        .task(id: router.reloadSignal) {
            await load(force: model.reloadTracker.consume(router.reloadSignal))
        }
    }

    private func monthHeader(_ group: ActivityMonthGroup) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: DS.Spacing.s) {
            SectionLabel(group.title)
            Spacer(minLength: DS.Spacing.s)
            Text(group.summary)
                .font(Font.meta)
                .monospacedDigit()
                .foregroundStyle(.secondary)
        }
        .padding(.top, DS.Spacing.l)
        .padding(.bottom, DS.Spacing.xs)
        .padding(.horizontal, DS.Spacing.xs)
    }

    /// A run row; consecutive rows of a month join into one card (rounded only at its ends).
    private func runRow(_ route: RunRoute, isFirst: Bool, isLast: Bool) -> some View {
        let top: CGFloat = isFirst ? DS.Radius.card : 0
        let bottom: CGFloat = isLast ? DS.Radius.card : 0
        let shape = UnevenRoundedRectangle(
            topLeadingRadius: top,
            bottomLeadingRadius: bottom,
            bottomTrailingRadius: bottom,
            topTrailingRadius: top,
            style: .continuous
        )
        return VStack(spacing: 0) {
            if !isFirst {
                HairlineDivider()
                    .padding(.leading, ActivityRunRow.textInset)
            }
            NavigationLink(value: route) {
                ActivityRunRow(route: route, color: userColor)
            }
            .buttonStyle(.pressable)
        }
        .background(Color.surface, in: shape)
        // Rows after the first cancel the stack spacing, so a month reads as one card
        .padding(.top, isFirst ? 0 : -DS.Spacing.s)
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
                systemImage: "figure.run",
                title: "Aún no tienes carreras",
                message: "Sal a correr desde el mapa, conecta Strava o Polar, o importa tus entrenamientos de Apple Salud desde el perfil.",
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

/// One of your runs inside the month list: map thumbnail, name, date and condensed stats.
private struct ActivityRunRow: View {
    let route: RunRoute
    let color: Color

    static let thumbnailSize: CGFloat = 56
    /// Leading inset of the separator so it lines up with the text column.
    static let textInset: CGFloat = DS.Spacing.m + thumbnailSize + DS.Spacing.m

    var body: some View {
        HStack(spacing: DS.Spacing.m) {
            thumbnail
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: DS.Spacing.s) {
                    Text(route.name)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    Spacer(minLength: DS.Spacing.xs)
                    Text(Format.dayAndTime(route.startDate))
                        .font(Font.meta)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .layoutPriority(1)
                }
                stats
            }
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .padding(DS.Spacing.m)
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private var thumbnail: some View {
        if route.coordinates.count >= 2 {
            ActivityRouteMap(cacheKey: "route-\(route.id)", coordinates: route.coordinates, color: color, cornerRadius: DS.Radius.small, lineWidth: 2.5)
                .frame(width: Self.thumbnailSize, height: Self.thumbnailSize)
        } else {
            Image(systemName: "figure.run")
                .font(.system(size: 20, weight: .regular))
                .foregroundStyle(.secondary)
                .frame(width: Self.thumbnailSize, height: Self.thumbnailSize)
                .background(Color.surfaceRaised, in: RoundedRectangle(cornerRadius: DS.Radius.small, style: .continuous))
        }
    }

    // Figures never truncate: if all of them don't fit, the time is dropped
    private var stats: some View {
        ViewThatFits(in: .horizontal) {
            statsRow(showDuration: true)
            statsRow(showDuration: false)
        }
    }

    private func statsRow(showDuration: Bool) -> some View {
        let distance = ActivityFormat.distanceParts(route.distance)
        return HStack(alignment: .firstTextBaseline, spacing: DS.Spacing.m) {
            StatValue(value: distance.value, unit: distance.unit, font: Font.stat(19, weight: .semibold))
            if showDuration {
                StatValue(value: Format.duration(route.duration), font: Font.stat(19, weight: .semibold))
            }
            if let area = route.territoryArea, area > 0 {
                let parts = ActivityFormat.areaParts(area)
                StatValue(value: "+\(parts.value)", unit: parts.unit, font: Font.stat(19, weight: .semibold), tint: Color.brand)
            }
        }
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

/// Summary card at the top of "Mis carreras": this week's kilometres, a day-by-day bar chart and a stats row.
private struct ActivityWeekCard: View {
    let summary: ActivityWeekSummary

    private static let dayLetters: [String] = ["L", "M", "X", "J", "V", "S", "D"]
    private static let chartHeight: CGFloat = 56

    private var kmText: String {
        (summary.distance / 1000).formatted(.number.precision(.fractionLength(1)).locale(ActivityCalendar.locale))
    }

    private var lastWeekText: String {
        (summary.lastWeekDistance / 1000).formatted(.number.precision(.fractionLength(1)).locale(ActivityCalendar.locale))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.l) {
            topRow
            HStack(alignment: .bottom, spacing: DS.Spacing.l) {
                bigNumber
                Spacer(minLength: 0)
                chart
            }
            HairlineDivider()
            statsRow
        }
        .card()
        .accessibilityElement(children: .combine)
    }

    private var topRow: some View {
        HStack(alignment: .firstTextBaseline) {
            SectionLabel("Esta semana")
            Spacer()
            if let delta = summary.deltaPercent {
                deltaLabel(delta)
            }
        }
    }

    private func deltaLabel(_ delta: Int) -> some View {
        HStack(spacing: 3) {
            Image(systemName: delta >= 0 ? "arrow.up.right" : "arrow.down.right")
                .font(.caption2.weight(.semibold))
            Text("\(delta >= 0 ? "+" : "")\(delta) % vs. semana anterior")
                .font(Font.meta)
                .monospacedDigit()
        }
        .foregroundStyle(.secondary)
    }

    private var bigNumber: some View {
        VStack(alignment: .leading, spacing: 2) {
            StatValue(value: kmText, unit: "km", font: Font.statHero)
            Text(summary.lastWeekDistance > 0 ? "Semana anterior: \(lastWeekText) km" : "Lunes a domingo")
                .font(Font.meta)
                .foregroundStyle(.secondary)
                .monospacedDigit()
        }
    }

    private var chart: some View {
        let maxKm: Double = max(summary.dailyKm.max() ?? 0, 0.1)
        return HStack(alignment: .bottom, spacing: 7) {
            ForEach(0..<7, id: \.self) { index in
                dayBar(index: index, maxKm: maxKm)
            }
        }
        .accessibilityHidden(true)
    }

    private func dayBar(index: Int, maxKm: Double) -> some View {
        let km: Double = summary.dailyKm[index]
        let height: CGFloat = km > 0 ? max(6, CGFloat(km / maxKm) * Self.chartHeight) : 3
        let isToday: Bool = index == summary.todayIndex
        let fill: Color = km > 0 ? Color.brand.opacity(isToday ? 0.85 : 0.4) : Color.hairline
        return VStack(spacing: 5) {
            VStack(spacing: 0) {
                Spacer(minLength: 0)
                RoundedRectangle(cornerRadius: 2, style: .continuous)
                    .fill(fill)
                    .frame(width: 8, height: height)
            }
            .frame(height: Self.chartHeight)
            Text(Self.dayLetters[index])
                .font(.system(size: 10, weight: isToday ? .semibold : .regular))
                .foregroundStyle(isToday ? Color.primary : Color.secondary)
        }
    }

    private var statsRow: some View {
        let area = ActivityFormat.areaParts(summary.area)
        return HStack(spacing: 0) {
            StatTile(value: "\(summary.runs)", label: summary.runs == 1 ? "Carrera" : "Carreras")
            StatDivider()
            StatTile(value: Format.duration(summary.duration), label: "Tiempo")
            StatDivider()
            StatTile(value: area.value, label: "Conquistado", unit: area.unit)
        }
    }
}
