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
            syncTracker()
        }
        .onChange(of: model.overlay) { _, overlay in
            UserDefaults.standard.set(overlay.rawValue, forKey: "map_global_overlay")
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
                withAnimation(.snappy) { heading = context.camera.heading }
            }
            .onTapGesture { location in
                if let chest = chestNear(location, proxy: proxy) {
                    selectedChest = chest
                } else if let coordinate = proxy.convert(location, from: .local),
                          let shape = model.shape(at: coordinate),
                          shape.userId != session.userId, shape.userId != "me" {
                    selectedUserId = shape.userId
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
                .foregroundStyle(shape.color.opacity(fillOpacity(for: shape)))
                .stroke(shape.isRival ? Color.steal : shape.color.opacity(shape.isOverlay ? 0.6 : 1), style: strokeStyle(for: shape))
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

    private func isMine(_ shape: TerritoryShape) -> Bool {
        shape.userId == session.userId || shape.userId == "me"
    }

    /// Own territory slightly stronger; overlays (other people's global maps) light.
    private func fillOpacity(for shape: TerritoryShape) -> Double {
        if shape.isOverlay { return 0.12 }
        if shape.isShared { return 0.38 }
        return isMine(shape) ? 0.34 : 0.26
    }

    /// 2.5pt outline, 3pt for your own; shared territories, overlays and the rival club's zones in
    /// the Derbi get a dashed outline.
    private func strokeStyle(for shape: TerritoryShape) -> StrokeStyle {
        let width: CGFloat = shape.isOverlay ? 1.5 : (isMine(shape) ? 3 : 2.5)
        if shape.isShared || shape.isOverlay || shape.isRival {
            return StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round, dash: [8, 5])
        }
        return StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round)
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

    /// The run screen draws the territory of the current map; chests are collected by the server.
    private func syncTracker() {
        tracker.territoryShapes = model.visibleShapes
        tracker.activeTreasures = []
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
            Picker("Mapa", selection: $model.mode) {
                ForEach(MapMode.allCases) { mode in
                    Text(mode.title).tag(mode)
                }
            }
            .pickerStyle(.segmented)
            .padding(4)
            .glassSurface(RoundedRectangle(cornerRadius: DS.Radius.tile, style: .continuous))
            .sensoryFeedback(.selection, trigger: model.mode)
            MapHeaderCard(
                user: session.user,
                mode: model.mode,
                isLoading: model.isLoading,
                season: season,
                onTap: {
                    if model.mode == .global {
                        router.selectedTab = .rankings
                    } else {
                        router.clubSection = .club
                        router.selectedTab = .club
                    }
                }
            )
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
            if let error = model.errorMessage, !model.isLoading {
                ErrorBanner(message: "No hemos podido cargar el mapa. \(error)", retry: { Task { await reload(force: true) } })
            }
        }
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
        GlassCircleButton(
            systemImage: "bag",
            assetImage: PowersIcon.asset,
            accessibilityLabel: season.availableItemCount > 0 ? "Poderes, \(season.availableItemCount) disponibles" : "Poderes",
            badge: season.availableItemCount
        ) {
            router.showPowers = true
        }
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

/// Compact card at the top of the map, the same layout in both modes: my avatar (opens my profile),
/// what's counted, my number and my place. Competición adds the mode's colour as a thin edge and
/// the countdown.
struct MapHeaderCard: View {
    @Environment(AppRouter.self) private var router
    let user: AppUser?
    let mode: MapMode
    let isLoading: Bool
    let season: SeasonStore
    let onTap: () -> Void

    private var competition: ClubCompetition? {
        guard mode == .competition, let competition = season.competition, competition.isActive else { return nil }
        return competition
    }

    var body: some View {
        HStack(spacing: DS.Spacing.m) {
            if let user {
                Button {
                    router.showProfile = true
                } label: {
                    AvatarView(name: user.name, avatar: user.avatar, color: user.color, size: 36)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Perfil y ajustes")
                Button(action: onTap) {
                    HStack(spacing: DS.Spacing.s) {
                        leading
                        Spacer(minLength: DS.Spacing.s)
                        trailing
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            } else {
                Spacer()
                ProgressView()
                Spacer()
            }
        }
        .padding(.leading, competition == nil ? 12 : 16)
        .padding(.trailing, 14)
        .padding(.vertical, 9)
        .frame(minHeight: 58)
        .glassSurface(RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous))
        .overlay(alignment: .leading) {
            if let competition {
                UnevenRoundedRectangle(topLeadingRadius: DS.Radius.card, bottomLeadingRadius: DS.Radius.card, style: .continuous)
                    .fill(ModeTheme(mode: competition.mode).gradient)
                    .frame(width: 5)
            }
        }
        .animation(.snappy, value: mode)
    }

    private var title: (symbol: String, text: String, tint: Color) {
        if let competition {
            let theme = ModeTheme(mode: competition.mode)
            return (theme.symbol, competition.modeName, theme.accent)
        }
        return mode == .global ? ("globe.europe.africa.fill", "Mapa global", Color.brand) : ("flag.checkered", "Competición", Color.secondary)
    }

    private var value: Double {
        if let competition { return competition.myScore }
        if mode == .global { return season.globalMe?.area ?? 0 }
        return 0
    }

    private var leading: some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: 5) {
                Image(systemName: title.symbol)
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(title.tint)
                Text(title.text)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                if isLoading {
                    ProgressView()
                        .controlSize(.mini)
                }
            }
            if value > 0 {
                if let competition, competition.mode == "flags" {
                    Text(competition.scoreText(value))
                        .font(Font.stat(24, weight: .semibold))
                        .monospacedDigit()
                } else {
                    let area = Format.areaParts(value)
                    StatValue(value: area.value, unit: area.unit, font: Font.stat(24, weight: .semibold))
                        .animation(.snappy, value: value)
                }
            } else {
                Text(mode == .global ? "Aún sin territorio" : (competition == nil ? "Sin competición ahora" : "Sin territorio"))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(competition == nil && mode == .competition ? .secondary : .primary)
            }
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var trailing: some View {
        if let competition {
            VStack(alignment: .trailing, spacing: 1) {
                if let rank = competition.myRank {
                    HStack(alignment: .firstTextBaseline, spacing: 1) {
                        Text("\(rank)º")
                            .font(Font.stat(22, weight: .bold))
                            .foregroundStyle(rank == 1 ? Color.gold : Color.primary)
                            .contentTransition(.numericText())
                        Text("/\(competition.participants)")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.secondary)
                    }
                }
                if let countdown = season.shortCountdown {
                    Label(countdown, systemImage: "timer")
                        .font(.caption2.weight(.medium))
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                        .labelStyle(.titleAndIcon)
                        .lineLimit(1)
                }
            }
        } else if mode == .global, let rank = season.globalMe?.worldRank {
            VStack(alignment: .trailing, spacing: 1) {
                Text("#\(rank)")
                    .font(Font.stat(22, weight: .bold))
                    .foregroundStyle(rank == 1 ? Color.gold : Color.primary)
                    .contentTransition(.numericText())
                Text("Mundo")
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.secondary)
            }
        }
    }
}
