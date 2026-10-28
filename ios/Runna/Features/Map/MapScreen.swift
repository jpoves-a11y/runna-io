import SwiftUI
import MapKit

/// Home screen: full-bleed territory map with a compact header card, player filter chips,
/// a column of small round controls on the right and the solid "Correr" button at the bottom.
struct MapScreen: View {
    @Environment(SessionStore.self) private var session
    @Environment(RunTracker.self) private var tracker
    @Environment(AppRouter.self) private var router
    @State private var model = MapModel.shared
    @State private var camera: MapCameraPosition = .userLocation(fallback: MapScreen.fallbackPosition)
    /// Last camera reported by the map (for the north button).
    @State private var lastCamera: MapCamera?
    @State private var heading: Double = 0
    @State private var selectedUserId: String?
    @State private var selectedTreasure: Treasure?
    @State private var uploadedPendingRuns = 0
    @State private var showIntro = false
    @State private var showFinalResults = false
    @State private var autoWeeklySummary: WeeklySummary?
    @State private var lastWeeklySummaryCheck: Date?
    @State private var confirmDiscardRun = false
    @AppStorage("map_style_satellite") private var satellite = false
    @AppStorage("map_route_mode") private var routeMode: RouteDisplayMode = .lines
    @AppStorage("map_routes_everyone") private var routesOfEveryone = false
    @AppStorage("map_focus") private var focus: MapFocus = .all
    @AppStorage("map_only_fortified") private var onlyFortified = false
    /// Look that depends on the zoom (updated when the camera stops).
    @State private var zoomStyle = MapZoomStyle(cameraDistance: 8_000)
    /// Territory tapped on the map: its card shows and the run that conquered it is drawn.
    @State private var selectedTerritory: TerritoryShape?
    @State private var selectedRoute: RunRoute?
    @State private var isLoadingSelectedRoute = false
    /// 0...1 while the selected run is being drawn.
    @State private var selectedRouteProgress: Double = 1
    @State private var routeDetail: RunRoute?
    @State private var showLegend = false

    private var competition: CompetitionStore { CompetitionStore.shared }

    private static let fallbackPosition: MapCameraPosition = .region(MKCoordinateRegion(
        center: CLLocationCoordinate2D(latitude: AppConfig.defaultLatitude, longitude: AppConfig.defaultLongitude),
        span: MKCoordinateSpan(latitudeDelta: 0.08, longitudeDelta: 0.08)
    ))

    var body: some View {
        @Bindable var router = router
        ZStack {
            mapLayer
            overlayLayout
        }
        .sheet(item: Binding(
            get: { selectedUserId.map { SelectedUser(id: $0) } },
            set: { selectedUserId = $0?.id }
        )) { selected in
            UserProfileSheet(userId: selected.id)
        }
        .sheet(item: $selectedTreasure) { treasure in
            TreasureDetailView(treasure: treasure)
        }
        .sheet(item: $routeDetail) { route in
            NavigationStack {
                RouteDetailView(
                    route: route,
                    color: selectedTerritory?.colorHex,
                    editable: route.userId == session.userId,
                    onChange: { Task { await reload(force: true) } }
                )
            }
        }
        .sheet(isPresented: $showLegend) {
            MapLegendSheet(color: Color(hex: session.user?.color ?? "#16A34A"))
        }
        .sheet(isPresented: $router.showPowers, onDismiss: { refreshPowerBadge() }) {
            PowersSheet()
        }
        .sheet(item: $autoWeeklySummary) { summary in
            WeeklySummaryView(initialSummary: summary)
        }
        .sheet(isPresented: $showFinalResults) {
            CompetitionFinalView(competitionName: competition.competition?.name ?? "La competición")
        }
        .fullScreenCover(isPresented: $showIntro) {
            CompetitionIntroView(store: competition)
        }
        .confirmationDialog("¿Descartar la carrera a medias?", isPresented: $confirmDiscardRun, titleVisibility: .visible) {
            Button("Descartar carrera", role: .destructive) {
                tracker.discardRecoveredRun()
            }
            Button("Cancelar", role: .cancel) {}
        } message: {
            Text("Se perderá el recorrido que quedó grabado.")
        }
        .conquestInbox()
        .task(id: router.reloadSignal) {
            await reload(force: model.reloadTracker.consume(router.reloadSignal))
        }
        .task(id: competition.competition?.id ?? "none") { await refreshOverlaysPeriodically() }
        .task(id: uploadedPendingRuns) { await autoHideUploadedNotice() }
        .onChange(of: tracker.isPresented) { _, presented in
            // Back from a run: the new territory may need a moment to be processed
            if !presented {
                Task {
                    await reload(force: true)
                    try? await Task.sleep(nanoseconds: 8_000_000_000)
                    await reload(force: true)
                }
            }
        }
        .onChange(of: model.treasures) { _, _ in
            tracker.activeTreasures = model.liveTreasures
        }
        .task(id: friendRoutesKey) {
            guard showsFriendRoutes else { return }
            await model.loadFriendRoutes()
        }
        .task(id: selectedRoute?.id) { await drawSelectedRoute() }
    }

    // MARK: - Map

    private var mapLayer: some View {
        MapReader { proxy in
            Map(position: $camera) {
                mapContent
            }
            .mapStyle(satellite
                ? MapStyle.hybrid(elevation: .realistic, pointsOfInterest: .excludingAll)
                : MapStyle.standard(emphasis: .muted, pointsOfInterest: .excludingAll))
            .mapControls {
                // Our own floating controls replace the system ones (they used to hide behind the header)
                MapCompass().mapControlVisibility(.hidden)
                MapUserLocationButton().mapControlVisibility(.hidden)
            }
            .onMapCameraChange(frequency: .onEnd) { context in
                lastCamera = context.camera
                withAnimation(.snappy) { heading = context.camera.heading }
                let zoom = MapZoomStyle(cameraDistance: context.camera.distance)
                if zoom != zoomStyle { zoomStyle = zoom }
            }
            .onTapGesture { location in
                if let treasure = treasureNear(location, proxy: proxy) {
                    selectedTreasure = treasure
                } else if let coordinate = proxy.convert(location, from: .local),
                          let shape = model.shape(at: coordinate) {
                    select(shape)
                } else {
                    clearSelection()
                }
            }
        }
        .ignoresSafeArea()
    }

    @MapContentBuilder
    private var mapContent: some MapContent {
        UserAnnotation()
        territoryContent
        fortificationContent
        routeContent
        selectionContent
        markerContent
    }

    @MapContentBuilder
    private var territoryContent: some MapContent {
        ForEach(territoryLooks) { look in
            if let haloWidth = look.haloWidth {
                MapPolygon(look.shape.polygon)
                    .foregroundStyle(Color.clear)
                    .stroke(look.stroke.opacity(0.3), lineWidth: haloWidth)
            }
            MapPolygon(look.shape.polygon)
                .foregroundStyle(look.fill)
                .stroke(look.stroke, style: look.strokeStyle)
        }
        if !onlyFortified {
            // Where your territory touches a rival's
            ForEach(model.visibleContestedBorders) { line in
                MapPolyline(coordinates: line.coordinates)
                    .stroke(Color.steal.opacity(0.3), style: StrokeStyle(lineWidth: 9, lineCap: .round, lineJoin: .round))
                MapPolyline(coordinates: line.coordinates)
                    .stroke(Color.steal, style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
            }
        }
    }

    /// Walls (thicker with every layer, with a light inner line) and, close up, the hatching.
    @MapContentBuilder
    private var fortificationContent: some MapContent {
        ForEach(model.visibleFortifications) { fort in
            MapPolygon(fort.polygon)
                .foregroundStyle(fort.color.opacity(fort.fillOpacity))
                .stroke(fort.color, lineWidth: fort.wallWidth)
            MapPolygon(fort.polygon)
                .foregroundStyle(Color.clear)
                .stroke(Color.white.opacity(0.55), lineWidth: max(1, fort.wallWidth / 3))
        }
        if zoomStyle.showsDetail {
            ForEach(hatchLines) { line in
                MapPolyline(coordinates: line.coordinates)
                    .stroke(line.color.opacity(0.55), lineWidth: 1)
            }
        }
    }

    @MapContentBuilder
    private var routeContent: some MapContent {
        if routeMode == .lines {
            ForEach(plainRouteLines) { line in
                MapPolyline(coordinates: line.coordinates)
                    .stroke(line.color.opacity(0.55), style: StrokeStyle(lineWidth: 2.5, lineCap: .round, lineJoin: .round))
            }
        }
        if routeMode == .heat {
            // Faint wide lines on top of each other: the streets run most get the strongest colour
            ForEach(heatRouteLines) { line in
                MapPolyline(coordinates: line.coordinates)
                    .stroke(line.color.opacity(0.16), style: StrokeStyle(lineWidth: zoomStyle.showsDetail ? 7 : 4.5, lineCap: .round, lineJoin: .round))
            }
        }
    }

    /// The run that conquered the selected territory, drawn from start to finish.
    @MapContentBuilder
    private var selectionContent: some MapContent {
        if let route = selectedRoute, let territory = selectedTerritory {
            let coordinates = Self.prefix(route.locations, progress: selectedRouteProgress)
            if coordinates.count >= 2 {
                MapPolyline(coordinates: coordinates)
                    .stroke(Color.white.opacity(0.85), style: StrokeStyle(lineWidth: 8, lineCap: .round, lineJoin: .round))
                MapPolyline(coordinates: coordinates)
                    .stroke(territory.color, style: StrokeStyle(lineWidth: 4.5, lineCap: .round, lineJoin: .round))
            }
            if let head = coordinates.last, selectedRouteProgress < 1 {
                Annotation("", coordinate: head) {
                    Circle()
                        .fill(territory.color)
                        .frame(width: 14, height: 14)
                        .overlay(Circle().strokeBorder(Color.white, lineWidth: 3))
                }
            }
        }
    }

    @MapContentBuilder
    private var markerContent: some MapContent {
        ForEach(model.visibleCastles) { zone in
            Annotation("", coordinate: zone.coordinate) {
                CastleMarker(zone: zone)
            }
        }
        ForEach(model.liveTreasures) { treasure in
            Annotation(treasure.name, coordinate: treasure.coordinate) {
                Button {
                    selectedTreasure = treasure
                } label: {
                    TreasureMarker(treasure: treasure)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func isMine(_ shape: TerritoryShape) -> Bool {
        shape.userId == session.userId
    }

    /// Every visible territory with zoom, focus, age and selection applied.
    private var territoryLooks: [TerritoryLook] {
        guard !onlyFortified else { return [] }
        let now = Date()
        let selectedId = selectedTerritory?.territoryId
        return model.visibleShapes.map { shape in
            let mine = isMine(shape)
            let inFocus: Bool
            switch focus {
            case .all: inFocus = true
            case .mine: inFocus = mine
            case .rivals: inFocus = !mine
            }
            let isSelected = selectedId == shape.territoryId
            var opacity = zoomStyle.fillOpacity(isMine: mine, isShared: shape.isShared) * TerritoryAge.fade(shape.conqueredAt, now: now)
            if !inFocus { opacity *= 0.6 }
            if selectedId != nil && !isSelected { opacity *= 0.5 }
            var width = zoomStyle.strokeWidth(isMine: mine)
            let isRecent = inFocus && TerritoryAge.isRecent(shape.conqueredAt, now: now)
            if isRecent { width += 0.8 }
            if isSelected { width += 2 }
            let color = inFocus ? shape.color : shape.mutedColor
            return TerritoryLook(
                shape: shape,
                fill: color.opacity(opacity),
                stroke: inFocus ? color : color.opacity(0.8),
                // Shared (ran together) territories get a dashed outline
                strokeStyle: StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round, dash: shape.isShared ? [8, 5] : []),
                haloWidth: isRecent || isSelected ? width + 7 : nil
            )
        }
    }

    private var hatchLines: [ColoredMapLine] {
        model.visibleFortifications.flatMap { fort in
            fort.hatch.enumerated().map { index, coordinates in
                ColoredMapLine(id: "\(fort.id)-\(index)", color: fort.color, coordinates: coordinates)
            }
        }
    }

    private var showsFriendRoutes: Bool {
        routeMode != .off && routesOfEveryone && model.players.count > 1
    }

    /// Changes when friends' runs need to be (re)loaded.
    private var friendRoutesKey: String {
        "\(showsFriendRoutes)-\(model.players.map(\.id).joined(separator: ","))"
    }

    private var plainRouteLines: [RouteLine] {
        let own = Array(model.visibleRouteLines.prefix(MapModel.maxPlainRouteLines))
        return showsFriendRoutes ? own + model.visibleFriendRouteLines : own
    }

    private var heatRouteLines: [RouteLine] {
        showsFriendRoutes ? model.visibleRouteLines + model.visibleFriendRouteLines : model.visibleRouteLines
    }

    private static func prefix(_ coordinates: [CLLocationCoordinate2D], progress: Double) -> [CLLocationCoordinate2D] {
        guard progress < 1 else { return coordinates }
        let count = max(2, Int((Double(coordinates.count) * progress).rounded()))
        return Array(coordinates.prefix(count))
    }

    // MARK: - Selection

    private func select(_ shape: TerritoryShape) {
        Haptics.tap()
        withAnimation(.snappy) {
            selectedTerritory = shape
            selectedRoute = nil
        }
        guard let routeId = shape.routeId else {
            isLoadingSelectedRoute = false
            return
        }
        isLoadingSelectedRoute = true
        Task {
            let route = await model.route(id: routeId, userId: shape.userId)
            // Another territory may have been tapped meanwhile
            guard selectedTerritory?.id == shape.id else { return }
            isLoadingSelectedRoute = false
            withAnimation(.snappy) { selectedRoute = route }
        }
    }

    private func clearSelection() {
        guard selectedTerritory != nil else { return }
        withAnimation(.snappy) {
            selectedTerritory = nil
            selectedRoute = nil
        }
        isLoadingSelectedRoute = false
    }

    /// Draws the selected run from start to finish in about a second.
    private func drawSelectedRoute() async {
        guard selectedRoute != nil else {
            selectedRouteProgress = 1
            return
        }
        let steps = 24
        selectedRouteProgress = 0
        for step in 1...steps {
            try? await Task.sleep(nanoseconds: 1_100_000_000 / UInt64(steps))
            if Task.isCancelled { return }
            selectedRouteProgress = Double(step) / Double(steps)
        }
    }

    // MARK: - Camera

    private var isFollowingUser: Bool {
        camera.followsUserLocation
    }

    private func centerOnUser() {
        withAnimation(.smooth(duration: 0.8)) {
            camera = .userLocation(fallback: Self.fallbackPosition)
        }
    }

    private func resetNorth() {
        withAnimation(.smooth(duration: 0.6)) {
            if isFollowingUser {
                camera = .userLocation(followsHeading: false, fallback: Self.fallbackPosition)
            } else if let current = lastCamera {
                camera = .camera(MapCamera(centerCoordinate: current.centerCoordinate, distance: current.distance, heading: 0, pitch: 0))
            }
            heading = 0
        }
    }

    private func fitTerritories() {
        guard let region = model.boundingRegion() else { return }
        withAnimation(.smooth(duration: 0.8)) {
            camera = .region(region)
        }
    }

    private func autoHideUploadedNotice() async {
        guard uploadedPendingRuns > 0 else { return }
        try? await Task.sleep(nanoseconds: 6_000_000_000)
        if Task.isCancelled { return }
        withAnimation(.snappy) { uploadedPendingRuns = 0 }
    }

    /// Draws the cached map instantly, then refreshes in the background. Coming back to the tab within
    /// a few seconds doesn't refetch anything unless `force` (a notification, a finished run, retry).
    private func reload(force: Bool = false) async {
        guard let user = session.user else { return }
        guard force || !model.isFresh(userId: user.id) else {
            // Fresh: just make sure the cached data is drawn
            await model.showCached(user: user)
            syncTracker()
            await presentAutomaticDialogs()
            return
        }
        let mutationsBefore = ResponseCache.shared.mutationCount
        await model.showCached(user: user)
        syncTracker()
        // New auto-imported routes are looked up at the same time (its GET /api/routes is shared with the map's)
        let conquestInbox: ConquestInbox = ConquestInbox.shared
        let userId: String = user.id
        async let inbox: Void = conquestInbox.discoverNewRoutes(userId: userId)
        await model.load(user: user, force: true)
        syncTracker()

        // Runs recorded offline and Apple Health imports, after the map is drawn
        uploadedPendingRuns = await PendingRuns.uploadAll()
        await HealthImporter.shared.autoImportIfEnabled()
        if ResponseCache.shared.mutationCount != mutationsBefore, let current = session.user {
            // Something was uploaded meanwhile: redraw with it
            await model.load(user: current, force: true)
            syncTracker()
        }
        await session.refreshUser(force: force)
        await inbox
        await presentAutomaticDialogs()
        // The other tabs' data, once per session, at low priority
        TabPrefetcher.prefetchOnce(userId: user.id)
    }

    private func syncTracker() {
        tracker.territoryShapes = model.shapes
        tracker.activeTreasures = model.liveTreasures
    }

    /// Treasures and fortifications change during the day: refresh them every minute while the map is visible.
    private func refreshOverlaysPeriodically() async {
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 60_000_000_000)
            if Task.isCancelled { return }
            guard competition.isActive, !tracker.isPresented else { continue }
            await model.refreshCompetitionOverlays()
        }
    }

    private func refreshPowerBadge() {
        guard let userId = session.userId else { return }
        Task { await competition.refreshPowers(userId: userId) }
    }

    /// Competition intro (once per competition), final podium (once), then the weekly summary (once per week).
    private func presentAutomaticDialogs() async {
        guard !CompetitionSeen.automaticDialogsDisabled,
              router.selectedTab == .map,
              !tracker.isPresented,
              !router.showPowers,
              !showIntro, !showFinalResults, autoWeeklySummary == nil,
              selectedUserId == nil, selectedTreasure == nil,
              let current = competition.competition else { return }

        if competition.isActive, !CompetitionSeen.intro(current.id) {
            CompetitionSeen.markIntro(current.id)
            showIntro = true
            return
        }
        if competition.isFinished, !CompetitionSeen.finalResults(current.id) {
            CompetitionSeen.markFinalResults(current.id)
            showFinalResults = true
            return
        }
        guard competition.isActive else { return }
        // At most one check every 30 minutes (two requests)
        if let last = lastWeeklySummaryCheck, Date().timeIntervalSince(last) < 30 * 60 { return }
        lastWeeklySummaryCheck = Date()
        guard let summary = await competition.latestWeeklySummary(),
              !CompetitionSeen.week(current.id, summary.weekNumber) else { return }
        // The user may have opened something else while it loaded
        guard router.selectedTab == .map, !tracker.isPresented, !router.showPowers, !showIntro,
              selectedUserId == nil, selectedTreasure == nil else { return }
        CompetitionSeen.markWeek(current.id, summary.weekNumber)
        autoWeeklySummary = summary
    }

    /// A treasure drawn within 30 points of a tap.
    private func treasureNear(_ location: CGPoint, proxy: MapProxy) -> Treasure? {
        var best: (treasure: Treasure, distance: CGFloat)?
        for treasure in model.liveTreasures {
            guard let point = proxy.convert(treasure.coordinate, to: .local) else { continue }
            let dx = point.x - location.x
            let dy = point.y - location.y
            let distance = (dx * dx + dy * dy).squareRoot()
            if distance <= 30, distance < (best?.distance ?? .greatestFiniteMagnitude) {
                best = (treasure: treasure, distance: distance)
            }
        }
        return best?.treasure
    }

    // MARK: - Overlay layout

    /// One vertical stack inside the safe area (status bar and tab bar), so nothing can overlap:
    /// header + chips at the top, controls on the right, banners and "Correr" at the bottom.
    private var overlayLayout: some View {
        VStack(spacing: DS.Spacing.m) {
            topArea
            Spacer(minLength: 0)
            HStack(alignment: .bottom) {
                Spacer(minLength: 0)
                controlsColumn
            }
            bottomArea
        }
        .padding(.horizontal, DS.Spacing.l)
        .padding(.top, 6)
        .padding(.bottom, DS.Spacing.l)
    }

    private var topArea: some View {
        VStack(spacing: DS.Spacing.s) {
            if !competition.isActive {
                CompetitionBanner(store: competition) { showFinalResults = true }
            }
            MapHeaderCard(
                user: session.user,
                isLoading: model.isLoading,
                competitionDay: competitionDayText,
                onRankTap: { router.selectedTab = .rankings },
                onCompetitionTap: { router.selectedTab = .rankings }
            )
            if model.players.count > 1 {
                PlayerFilterBar(
                    players: model.players,
                    hidden: model.hiddenUserIds,
                    toggle: { id in withAnimation(.snappy) { model.toggle(id) } },
                    onToggleAll: { withAnimation(.snappy) { toggleAllPlayers() } }
                )
                .padding(.horizontal, -DS.Spacing.l)
            }
            if let error = model.errorMessage, !model.isLoading {
                ErrorBanner(message: "No hemos podido cargar el mapa. \(error)", retry: { Task { await reload(force: true) } })
            }
        }
    }

    /// "Día 3/14" while a competition is running.
    private var competitionDayText: String? {
        guard competition.isActive else { return nil }
        if let day = competition.info?.dayOfCompetition, let total = competition.info?.totalDays {
            return "Día \(day)/\(total)"
        }
        return "En juego"
    }

    private func toggleAllPlayers() {
        if model.hiddenUserIds.isEmpty {
            model.hideAll()
        } else {
            model.showAll()
        }
    }

    // MARK: - Floating controls

    private var controlsColumn: some View {
        GlassGroup(spacing: DS.Spacing.s) {
            VStack(spacing: DS.Spacing.s) {
                if competition.isActive {
                    powersButton
                }
                layersMenu
                if abs(heading) > 2 && abs(heading) < 358 {
                    GlassCircleButton(systemImage: "location.north.line", accessibilityLabel: "Orientar al norte", tint: .steal) {
                        resetNorth()
                    }
                    .rotationEffect(.degrees(-heading))
                    .transition(.scale.combined(with: .opacity))
                }
                if !model.visibleShapes.isEmpty {
                    GlassCircleButton(systemImage: "arrow.up.left.and.arrow.down.right", accessibilityLabel: "Ver todos los territorios") {
                        fitTerritories()
                    }
                }
                GlassCircleButton(
                    systemImage: isFollowingUser ? "location.fill" : "location",
                    accessibilityLabel: "Centrar en mi ubicación",
                    isActive: isFollowingUser
                ) {
                    centerOnUser()
                }
            }
        }
        .animation(.snappy, value: competition.isActive)
    }

    /// Powers won from treasures (only during an active competition).
    private var powersButton: some View {
        GlassCircleButton(
            systemImage: "bolt",
            accessibilityLabel: competition.availablePowerCount > 0 ? "Poderes, \(competition.availablePowerCount) disponibles" : "Poderes",
            badge: competition.availablePowerCount
        ) {
            router.showPowers = true
        }
    }

    /// Map style, territory focus and filters, runs (lines / heat map, yours / everyone's), players and the legend.
    private var layersMenu: some View {
        Menu {
            Picker("Estilo del mapa", selection: $satellite) {
                Label("Mapa", systemImage: "map").tag(false)
                Label("Satélite", systemImage: "globe.europe.africa.fill").tag(true)
            }
            Section("Territorio") {
                Picker(selection: $focus) {
                    ForEach(MapFocus.allCases) { option in
                        Label(option.title, systemImage: option.systemImage).tag(option)
                    }
                } label: {
                    Label("Resaltar", systemImage: "scope")
                }
                .pickerStyle(.menu)
                if !model.fortifications.isEmpty {
                    Toggle(isOn: $onlyFortified) {
                        Label("Solo fortificaciones", systemImage: "shield.lefthalf.filled")
                    }
                }
                if model.players.count > 1 {
                    Button {
                        withAnimation(.snappy) { model.showOnlyMe() }
                    } label: {
                        Label("Solo mi territorio", systemImage: "person.crop.circle")
                    }
                }
            }
            Section("Recorridos") {
                Picker(selection: $routeMode) {
                    ForEach(RouteDisplayMode.allCases) { option in
                        Label(option.title, systemImage: option.systemImage).tag(option)
                    }
                } label: {
                    Label("Recorridos", systemImage: "point.topleft.down.to.point.bottomright.curvepath")
                }
                .pickerStyle(.menu)
                if model.players.count > 1 && routeMode != .off {
                    Toggle(isOn: $routesOfEveryone) {
                        Label("Recorridos de todos", systemImage: "person.3")
                    }
                }
            }
            if model.players.count > 1 {
                Section {
                    Button {
                        withAnimation(.snappy) { model.showAll() }
                    } label: {
                        Label("Mostrar a todos", systemImage: "eye")
                    }
                    Button {
                        withAnimation(.snappy) { model.hideAll() }
                    } label: {
                        Label("Ocultar a todos", systemImage: "eye.slash")
                    }
                }
            }
            Button {
                showLegend = true
            } label: {
                Label("Leyenda", systemImage: "info.circle")
            }
        } label: {
            GlassCircleLabel(systemImage: "square.3.layers.3d")
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Capas del mapa")
    }

    // MARK: - Bottom

    private var bottomArea: some View {
        VStack(spacing: DS.Spacing.s) {
            if let territory = selectedTerritory {
                SelectedTerritoryCard(
                    owner: model.players.first(where: { $0.id == territory.userId }),
                    ownerName: territory.ownerName,
                    color: territory.color,
                    conqueredAt: territory.conqueredAt,
                    route: selectedRoute,
                    isLoadingRoute: isLoadingSelectedRoute,
                    onProfile: { selectedUserId = territory.userId },
                    onRoute: { routeDetail = selectedRoute },
                    onClose: { clearSelection() }
                )
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
            if tracker.hasRecoverableRun {
                recoveredRunCard
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
            if uploadedPendingRuns > 0 {
                uploadedCard
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
            PrimaryActionButton(title: "Correr", systemImage: "figure.run") {
                tracker.isPresented = true
            }
            .accessibilityHint("Abre la pantalla para grabar una carrera")
        }
        .animation(.snappy, value: tracker.hasRecoverableRun)
        .animation(.snappy, value: selectedTerritory?.id)
        .animation(.snappy, value: uploadedPendingRuns)
    }

    private var recoveredRunCard: some View {
        HStack(spacing: DS.Spacing.m) {
            Image(systemName: "figure.run")
                .font(.system(size: DS.Size.icon, weight: .medium))
                .foregroundStyle(.secondary)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text("Carrera sin terminar")
                    .font(.subheadline.weight(.semibold))
                Text("Puedes retomarla donde la dejaste.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 4)
            Button(role: .destructive) {
                confirmDiscardRun = true
            } label: {
                Image(systemName: "trash")
            }
            .buttonStyle(SecondaryButtonStyle(tint: .steal))
            .accessibilityLabel("Descartar")
            Button("Continuar") {
                tracker.resumeRecoveredRun()
            }
            .buttonStyle(SecondaryButtonStyle(tint: .brand))
        }
        .padding(.horizontal, DS.Spacing.m)
        .padding(.vertical, 10)
        .glassSurface(RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous))
    }

    private var uploadedCard: some View {
        HStack(spacing: DS.Spacing.s) {
            Image(systemName: "checkmark.icloud")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Color.brand)
            Text(uploadedPendingRuns == 1
                 ? "Se ha subido 1 carrera guardada sin conexión"
                 : "Se han subido \(uploadedPendingRuns) carreras guardadas sin conexión")
                .font(.footnote.weight(.medium))
                .lineLimit(2)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .glassSurface(RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous))
    }
}

private struct SelectedUser: Identifiable {
    let id: String
}

/// Compact card at the top of the map: avatar, your territory, then rank and competition day
/// as small stat columns separated by hairlines.
struct MapHeaderCard: View {
    let user: AppUser?
    let isLoading: Bool
    let competitionDay: String?
    let onRankTap: () -> Void
    let onCompetitionTap: () -> Void

    var body: some View {
        HStack(spacing: DS.Spacing.m) {
            if let user {
                AvatarView(name: user.name, avatar: user.avatar, color: user.color, size: 38)
                territory(user)
                Spacer(minLength: DS.Spacing.s)
                trailingStats(user)
            } else {
                Spacer()
                ProgressView()
                Spacer()
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(minHeight: 60)
        .glassSurface(RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous))
    }

    private func territory(_ user: AppUser) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: 6) {
                Text("Tu territorio")
                    .statLabelStyle()
                if isLoading {
                    ProgressView()
                        .controlSize(.mini)
                }
            }
            if user.totalArea > 0 {
                let area = Format.areaParts(user.totalArea)
                StatValue(value: area.value, unit: area.unit, font: Font.stat(26, weight: .semibold))
                    .animation(.snappy, value: user.totalArea)
            } else {
                Text("Aún sin territorio")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func trailingStats(_ user: AppUser) -> some View {
        HStack(spacing: DS.Spacing.m) {
            if let rank = user.rank {
                Button(action: onRankTap) {
                    miniStat(value: "#\(rank)", label: "Ranking", tint: rank == 1 ? Color.gold : Color.primary)
                }
                .buttonStyle(.pressable)
                .accessibilityLabel("Puesto \(rank) entre amigos")
            }
            if user.rank != nil && competitionDay != nil {
                StatDivider(height: 30)
            }
            if let competitionDay {
                Button(action: onCompetitionTap) {
                    miniStat(value: competitionDayValue(competitionDay), label: competitionDayLabel(competitionDay), tint: Color.primary)
                }
                .buttonStyle(.pressable)
                .accessibilityLabel("Competición, \(competitionDay)")
            }
        }
    }

    private func miniStat(value: String, label: String, tint: Color) -> some View {
        VStack(alignment: .trailing, spacing: 1) {
            Text(value)
                .font(Font.stat(20, weight: .semibold))
                .monospacedDigit()
                .foregroundStyle(tint)
                .contentTransition(.numericText())
                .lineLimit(1)
            Text(label)
                .statLabelStyle()
                .lineLimit(1)
        }
    }

    /// "Día 11/29" → "11/29" (label "Día"); "En juego" stays as is (label "Liga").
    private func competitionDayValue(_ text: String) -> String {
        let prefix: String = "Día "
        if text.hasPrefix(prefix) {
            return String(text.dropFirst(prefix.count))
        }
        return text
    }

    private func competitionDayLabel(_ text: String) -> String {
        text.hasPrefix("Día ") ? "Día" : "Liga"
    }
}

/// Horizontally scrolling chips (material, hairline) to show or hide each player's territory.
struct PlayerFilterBar: View {
    let players: [UserRef]
    let hidden: Set<String>
    let toggle: (String) -> Void
    /// Optional leading "Todos" chip.
    var onToggleAll: (() -> Void)? = nil

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                if let onToggleAll {
                    ChipToggle(
                        title: "Todos",
                        isOn: hidden.isEmpty,
                        systemImage: hidden.isEmpty ? "eye" : "eye.slash",
                        onGlass: true,
                        action: onToggleAll
                    )
                }
                ForEach(players) { player in
                    let isHidden = hidden.contains(player.id)
                    ChipToggle(
                        title: player.name,
                        isOn: !isHidden,
                        color: Color(hex: player.color),
                        onGlass: true
                    ) {
                        toggle(player.id)
                    }
                    .accessibilityLabel("\(player.name), \(isHidden ? "oculto" : "visible")")
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 4)
        }
        .scrollClipDisabled()
    }
}
