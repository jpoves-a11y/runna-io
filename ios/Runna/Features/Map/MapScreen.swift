import SwiftUI
import MapKit

/// Home screen: full-bleed map with a Global / Competición switch at the top, a compact header card,
/// a column of small round controls on the right and the solid "Correr" button at the bottom.
///   - Global: my world map (nobody can take it), optionally with friends' / club mates' maps drawn
///     lighter for information.
///   - Competición: the map of my running club competition, with chests in the rest days.
struct MapScreen: View {
    @Environment(SessionStore.self) private var session
    @Environment(RunTracker.self) private var tracker
    @Environment(AppRouter.self) private var router
    @State private var model = MapModel.shared
    @State private var season = SeasonStore.shared
    @State private var camera: MapCameraPosition = .userLocation(fallback: MapScreen.fallbackPosition)
    /// Last camera reported by the map (for the north button).
    @State private var lastCamera: MapCamera?
    @State private var heading: Double = 0
    @State private var selectedUserId: String?
    @State private var selectedChest: Chest?
    /// Runner whose quick card is open (tapped territory or avatar).
    @State private var selectedRunnerId: String?
    /// Visible region, for grouping the avatars at the current zoom.
    @State private var visibleRegion: MKCoordinateRegion?
    @State private var uploadedPendingRuns = 0
    @State private var confirmDiscardRun = false
    @AppStorage("map_show_own_routes") private var showOwnRoutes = true
    @AppStorage("map_style_satellite") private var satellite = false

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
        .sheet(item: $selectedChest) { chest in
            ChestDetailView(chest: chest)
        }
        .sheet(isPresented: $router.showPowers, onDismiss: { Task { await season.load(force: true) } }) {
            InventorySheet()
        }
        .confirmationDialog("¿Descartar la carrera a medias?", isPresented: $confirmDiscardRun, titleVisibility: .visible) {
            Button("Descartar carrera", role: .destructive) {
                tracker.discardRecoveredRun()
            }
            Button("Cancelar", role: .cancel) {}
        } message: {
            Text("Se perderá el recorrido que quedó grabado.")
        }
        .task(id: router.reloadSignal) {
            await reload(force: model.reloadTracker.consume(router.reloadSignal))
        }
        .task(id: model.mode) { await refreshOverlaysPeriodically() }
        .task(id: model.overlay) {
            // A different overlay is another request: load it (cached first)
            if let user = session.user { await model.load(user: user, force: false) }
            syncTracker()
        }
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
        .onChange(of: model.mode) { _, mode in
            UserDefaults.standard.set(mode.rawValue, forKey: "map_mode")
            clearSelection()
            syncTracker()
        }
        .onChange(of: model.overlay) { _, overlay in
            UserDefaults.standard.set(overlay.rawValue, forKey: "map_global_overlay")
            clearSelection()
        }
        .onChange(of: model.globalView) { _, view in
            UserDefaults.standard.set(view.rawValue, forKey: "map_global_view")
            clearSelection()
            syncTracker()
        }
        .onChange(of: paletteContext, initial: true) { _, context in
            model.paletteContext = context
            syncTracker()
        }
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
                visibleRegion = context.region
                withAnimation(.snappy) { heading = context.camera.heading }
            }
            .onTapGesture { location in
                if let chest = chestNear(location, proxy: proxy) {
                    selectedChest = chest
                } else if !isFogView,
                          let coordinate = proxy.convert(location, from: .local),
                          let shape = model.shape(at: coordinate),
                          shape.relation != .mine, shape.userId != session.userId, shape.userId != "me" {
                    withAnimation(.snappy) { selectedRunnerId = shape.userId }
                } else if selectedRunnerId != nil {
                    withAnimation(.snappy) { selectedRunnerId = nil }
                }
            }
        }
        .ignoresSafeArea()
    }

    @MapContentBuilder
    private var mapContent: some MapContent {
        UserAnnotation()
        ForEach(model.visibleShapes) { shape in
            MapPolygon(shape.polygon)
                .foregroundStyle(shape.style.fill.opacity(shape.style.fillOpacity))
                .stroke(shape.style.stroke.opacity(shape.style.strokeOpacity), style: shape.style.strokeStyle)
        }
        ForEach(pinClusters) { cluster in
            Annotation("", coordinate: cluster.coordinate) {
                Button {
                    tap(cluster)
                } label: {
                    RunnerPin(cluster: cluster)
                }
                .buttonStyle(.plain)
            }
            .annotationTitles(.hidden)
        }
        ForEach(model.visibleFortifications) { fort in
            MapPolygon(fort.polygon)
                .foregroundStyle(fort.color.opacity(fort.fillOpacity))
                .stroke(fort.color, lineWidth: 1)
        }
        if showOwnRoutes {
            ForEach(model.visibleRouteLines) { line in
                MapPolyline(coordinates: line.coordinates)
                    .stroke(line.color.opacity(0.55), style: StrokeStyle(lineWidth: 2.5, lineCap: .round, lineJoin: .round))
            }
        }
        ForEach(model.visibleCastles) { zone in
            Annotation("", coordinate: zone.coordinate) {
                CastleMarker(zone: zone)
            }
        }
        ForEach(model.visibleCompassSpots) { spot in
            Annotation("Sin explorar", coordinate: spot.coordinate) {
                Image(systemName: "location.north.circle.fill")
                    .font(.system(size: 26))
                    .symbolRenderingMode(.palette)
                    .foregroundStyle(.white, Color.brand)
                    .shadow(color: Color.black.opacity(0.25), radius: 2, x: 0, y: 1)
                    .accessibilityLabel("Zona sin explorar a \(Int(spot.distanceMeters)) m")
            }
        }
        ForEach(model.visibleFlags) { flag in
            Annotation(flag.name, coordinate: flag.coordinate) {
                FlagMarker(flag: flag, isMine: flag.holderId == session.userId)
            }
        }
        ForEach(model.liveChests) { chest in
            Annotation(chest.name, coordinate: chest.coordinate) {
                Button {
                    selectedChest = chest
                } label: {
                    ChestMarker(chest: chest)
                }
                .buttonStyle(.plain)
            }
        }
    }

    // MARK: - Colours, avatars and focus

    /// What the colours depend on right now: the competition on the map, where I am in its
    /// ranking and my own colour (see MapPalette).
    private var paletteContext: PaletteContext {
        let competition = season.competition
        let myId = session.userId
        var directRivals: Set<String> = []
        var danger: Set<String> = []
        if let competition, let myId {
            // The runners just above (two) and below (one) me, still in the game
            let standings = competition.standings
                .filter { $0.eliminatedCut == nil }
                .sorted { $0.rank < $1.rank }
            if let index = standings.firstIndex(where: { $0.userId == myId }) {
                for offset in [-2, -1, 1] where standings.indices.contains(index + offset) {
                    directRivals.insert(standings[index + offset].userId)
                }
            }
            if let window = competition.elimination?.window {
                danger = Set(window.filter(\.danger).map(\.userId))
            }
        }
        return PaletteContext(
            mode: model.mode,
            myId: myId,
            myColor: session.user?.color ?? "#16A34A",
            competitionMode: model.competitionMode ?? competition?.mode,
            myTeam: competition?.myTeam,
            directRivals: directRivals,
            danger: danger
        )
    }

    /// Global "Sin pisar por nadie": territories are fog, nothing to tap.
    private var isFogView: Bool {
        model.mode == .global && model.globalView == .unexplored
    }

    /// Faces on the territories: in the competition, and over friends' / club mates' maps in Global.
    private var pinClusters: [RunnerCluster] {
        let showsPins = model.mode == .global
            ? model.overlay != .onlyMe && model.globalView == .normal
            : model.hasCompetitionMap
        guard showsPins else { return [] }
        var runners = model.visibleRunners
        if let focus = model.focusUserId {
            runners = runners.filter { $0.id == focus }
        }
        // The biggest maps first if there are very many
        if runners.count > 80 {
            runners = Array(runners.sorted { $0.area > $1.area }.prefix(80))
        }
        return RunnerCluster.clusters(runners, region: visibleRegion)
    }

    private var selectedRunner: MapRunner? {
        guard let selectedRunnerId else { return nil }
        return model.visibleRunners.first { $0.id == selectedRunnerId }
    }

    private var focusedRunner: MapRunner? {
        guard let focus = model.focusUserId else { return nil }
        return model.visibleRunners.first { $0.id == focus }
    }

    /// One face opens its card; a group zooms in until its faces separate.
    private func tap(_ cluster: RunnerCluster) {
        if cluster.runners.count == 1, let runner = cluster.runners.first {
            withAnimation(.snappy) { selectedRunnerId = runner.id }
        } else {
            withAnimation(.smooth(duration: 0.8)) { camera = .region(cluster.region) }
        }
    }

    private func toggleFocus(_ userId: String) {
        withAnimation(.snappy) {
            model.focusUserId = model.focusUserId == userId ? nil : userId
            selectedRunnerId = nil
        }
        syncTracker()
    }

    private func clearSelection() {
        selectedRunnerId = nil
        model.focusUserId = nil
    }

    /// What this runner's zones mean for me, in a few words.
    private func relationText(_ runner: MapRunner) -> String {
        switch runner.relation {
        case .mine: return "Tú"
        case .ally:
            return (model.competitionMode ?? season.competition?.mode) == "teams" ? "Tu equipo" : "Tu club"
        case .rival:
            return (model.competitionMode ?? season.competition?.mode) == "derby" ? "Club rival · se puede robar" : "Equipo rival · se puede robar"
        case .directRival: return "Justo a tu lado en la clasificación · se puede robar"
        case .other: return "Se puede robar"
        case .danger: return "En peligro de eliminación · se puede robar"
        case .overlay: return "Su mapa global"
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
            await season.loadCached()
            syncTracker()
            return
        }
        let mutationsBefore = ResponseCache.shared.mutationCount
        await model.showCached(user: user)
        syncTracker()
        // New auto-imported routes are looked up at the same time (its GET /api/routes is shared with the map's)
        let conquestInbox: ConquestInbox = ConquestInbox.shared
        let userId: String = user.id
        let seasonStore: SeasonStore = season
        async let inbox: Void = conquestInbox.discoverNewRoutes(userId: userId)
        async let seasonLoad: Void = seasonStore.load(force: force)
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
        await seasonLoad
        await inbox
        // The other tabs' data, once per session, at low priority
        TabPrefetcher.prefetchOnce(userId: user.id)
    }

    /// The run screen draws the territory of the current map and the competition chests (collected by
    /// the server when the run passes within their radius; the voice announces them).
    private func syncTracker() {
        tracker.territoryShapes = model.visibleShapes
        tracker.activeTreasures = []
        tracker.chests = model.liveChests
    }

    /// Chests and the competition map change during the day: refresh them every minute while visible.
    private func refreshOverlaysPeriodically() async {
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 60_000_000_000)
            if Task.isCancelled { return }
            guard model.mode == .competition, !tracker.isPresented else { continue }
            await model.refreshCompetitionOverlays()
            syncTracker()
        }
    }

    /// A chest drawn within 30 points of a tap.
    private func chestNear(_ location: CGPoint, proxy: MapProxy) -> Chest? {
        var best: (chest: Chest, distance: CGFloat)?
        for chest in model.liveChests {
            guard let point = proxy.convert(chest.coordinate, to: .local) else { continue }
            let dx = point.x - location.x
            let dy = point.y - location.y
            let distance = (dx * dx + dy * dy).squareRoot()
            if distance <= 30, distance < (best?.distance ?? .greatestFiniteMagnitude) {
                best = (chest: chest, distance: distance)
            }
        }
        return best?.chest
    }

    // MARK: - Overlay layout

    /// One vertical stack inside the safe area (status bar and tab bar), so nothing can overlap:
    /// mode switch + header at the top, controls on the right, banners and "Correr" at the bottom.
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
        @Bindable var model = model
        return VStack(spacing: DS.Spacing.s) {
            MapTopBar(
                user: session.user,
                mode: $model.mode,
                isLoading: model.isLoading,
                season: season,
                onTapStats: {
                    if model.mode == .global {
                        router.selectedTab = .rankings
                    } else {
                        router.clubSection = .club
                        router.selectedTab = .club
                    }
                }
            )
            // In Competición the bar already shows the mode and the countdown
            if season.cycle != nil && !(model.mode == .competition && season.competition?.isActive == true) {
                HStack {
                    SeasonPhaseChip(store: season) {
                        router.clubSection = .club
                        router.selectedTab = .club
                    }
                    Spacer(minLength: 0)
                }
            }
            if model.mode == .competition && !model.hasCompetitionMap {
                noCompetitionCard
            }
            if let runner = focusedRunner {
                HStack {
                    FocusPill(
                        runner: runner,
                        title: model.mode == .global ? "Comparando con \(runner.name)" : "Viendo a \(runner.name)"
                    ) {
                        toggleFocus(runner.id)
                    }
                    Spacer(minLength: 0)
                }
                .transition(.move(edge: .top).combined(with: .opacity))
            }
            if isFogView {
                HStack(spacing: 6) {
                    Image(systemName: "sparkles")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color.brand)
                    Text(model.overlay == .onlyMe
                         ? "Lo despejado es donde aún no has corrido"
                         : "Lo despejado es terreno que nadie ha pisado")
                        .font(.footnote.weight(.medium))
                        .lineLimit(2)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .glassSurface(Capsule())
                .transition(.move(edge: .top).combined(with: .opacity))
            }
            if let error = model.errorMessage, !model.isLoading {
                ErrorBanner(message: "No hemos podido cargar el mapa. \(error)", retry: { Task { await reload(force: true) } })
            }
        }
        .animation(.snappy, value: model.focusUserId)
        .animation(.snappy, value: model.globalView)
    }

    /// Competition mode without a running competition: why, and what to do.
    private var noCompetitionCard: some View {
        HStack(spacing: DS.Spacing.m) {
            Image(systemName: season.club == nil ? "shield.lefthalf.filled" : "clock")
                .font(.system(size: DS.Size.icon, weight: .medium))
                .foregroundStyle(.secondary)
                .frame(width: 24)
            Text(noCompetitionText)
                .font(.footnote)
                .lineLimit(3)
                .frame(maxWidth: .infinity, alignment: .leading)
            if season.club == nil {
                Button("Ver clubes") {
                    router.clubSection = .club
                    router.selectedTab = .club
                }
                .buttonStyle(SecondaryButtonStyle(tint: .brand))
            }
        }
        .padding(.horizontal, DS.Spacing.m)
        .padding(.vertical, 10)
        .glassSurface(RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous))
    }

    private var noCompetitionText: String {
        if season.club == nil {
            return "La competición es por clubes. Únete a uno para competir y abrir los cofres del descanso."
        }
        if season.cycle?.isCompetition == true {
            return "Tu club no compite en esta ronda. Mientras tanto, cada carrera suma a tu mapa global."
        }
        return "Días de descanso: busca los cofres cerca de tu ciudad y completa tus retos."
    }

    // MARK: - Floating controls

    private var controlsColumn: some View {
        GlassGroup(spacing: DS.Spacing.s) {
            VStack(spacing: DS.Spacing.s) {
                inventoryButton
                layersMenu
                if abs(heading) > 2 && abs(heading) < 358 {
                    GlassCircleButton(systemImage: "location.north.line", accessibilityLabel: "Orientar al norte", tint: .steal) {
                        resetNorth()
                    }
                    .rotationEffect(.degrees(-heading))
                    .transition(.scale.combined(with: .opacity))
                }
                if !model.visibleShapes.isEmpty {
                    GlassCircleButton(systemImage: "arrow.up.left.and.arrow.down.right", accessibilityLabel: "Ver todo el territorio") {
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
    }

    /// Powers, global boosts and cosmetics won in chests, challenges and competitions.
    private var inventoryButton: some View {
        let available = season.availableItemCount
        return Button {
            router.showPowers = true
        } label: {
            PowersIcon(size: 28, glow: available > 0, lineWidth: 2)
                .foregroundStyle(Color.primary)
                .shadow(color: Color(uiColor: .systemBackground).opacity(0.9), radius: 2)
                .shadow(color: .black.opacity(0.25), radius: 3, y: 1)
                .frame(width: DS.Size.mapControl, height: DS.Size.mapControl)
                .contentShape(Rectangle())
                .overlay(alignment: .topTrailing) {
                    if available > 0 {
                        CountBadge(count: available)
                            .offset(x: -2, y: 2)
                    }
                }
        }
        .buttonStyle(.pressable)
        .sensoryFeedback(.impact(weight: .light), trigger: router.showPowers)
        .accessibilityLabel(available > 0 ? "Poderes, \(available) disponibles" : "Poderes")
    }

    /// Map style, own routes and (Global) whose maps are drawn over mine.
    private var layersMenu: some View {
        @Bindable var model = model
        return Menu {
            Picker("Estilo del mapa", selection: $satellite) {
                Label("Mapa", systemImage: "map").tag(false)
                Label("Satélite", systemImage: "globe.europe.africa.fill").tag(true)
            }
            Toggle(isOn: $showOwnRoutes) {
                Label("Mis recorridos", systemImage: "point.topleft.down.to.point.bottomright.curvepath")
            }
            if model.mode == .global {
                Divider()
                Picker("Superponer en el mapa global", selection: $model.overlay) {
                    ForEach(GlobalOverlay.allCases) { overlay in
                        Text(overlay.title).tag(overlay)
                    }
                }
                Divider()
                Picker("Vista", selection: $model.globalView) {
                    Label(GlobalView.normal.title, systemImage: "map").tag(GlobalView.normal)
                    Label(GlobalView.unexplored.title, systemImage: "cloud.fog").tag(GlobalView.unexplored)
                }
                let runners = model.visibleRunners.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
                if model.overlay != .onlyMe && model.globalView == .normal && !runners.isEmpty {
                    Menu {
                        ForEach(runners) { runner in
                            Button {
                                toggleFocus(runner.id)
                            } label: {
                                if model.focusUserId == runner.id {
                                    Label(runner.name, systemImage: "checkmark")
                                } else {
                                    Text(runner.name)
                                }
                            }
                        }
                    } label: {
                        Label("Comparar con…", systemImage: "person.2")
                    }
                }
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
            if let runner = selectedRunner {
                TerritoryCallout(
                    runner: runner,
                    relationText: relationText(runner),
                    isFocused: model.focusUserId == runner.id,
                    focusTitle: model.mode == .global ? "Comparar" : "Enfocar",
                    onFocus: { toggleFocus(runner.id) },
                    onProfile: { selectedUserId = runner.id },
                    onClose: { withAnimation(.snappy) { selectedRunnerId = nil } }
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
            // First two weeks: welcome missions; later, with no friends nor club, a nudge to find some
            if selectedRunnerId == nil && !tracker.hasRecoverableRun {
                WelcomeMissionsCard()
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
            PrimaryActionButton(title: "Correr", systemImage: "figure.run", pulse: true) {
                tracker.isPresented = true
            }
            .accessibilityHint("Abre la pantalla para grabar una carrera")
        }
        .animation(.snappy, value: tracker.hasRecoverableRun)
        .animation(.snappy, value: uploadedPendingRuns)
        .animation(.snappy, value: selectedRunnerId)
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

