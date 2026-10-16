import SwiftUI
import MapKit

struct MapScreen: View {
    @Environment(SessionStore.self) private var session
    @Environment(RunTracker.self) private var tracker
    @Environment(AppRouter.self) private var router
    @State private var model = MapModel()
    @State private var camera: MapCameraPosition = .userLocation(
        fallback: .region(MKCoordinateRegion(
            center: CLLocationCoordinate2D(latitude: AppConfig.defaultLatitude, longitude: AppConfig.defaultLongitude),
            span: MKCoordinateSpan(latitudeDelta: 0.08, longitudeDelta: 0.08)
        ))
    )
    @State private var selectedUserId: String?
    @State private var selectedTreasure: Treasure?
    @State private var uploadedPendingRuns = 0
    @State private var showIntro = false
    @State private var showFinalResults = false
    @State private var autoWeeklySummary: WeeklySummary?
    @State private var lastWeeklySummaryCheck: Date?
    @AppStorage("map_show_own_routes") private var showOwnRoutes = true

    private var competition: CompetitionStore { CompetitionStore.shared }

    var body: some View {
        @Bindable var router = router
        ZStack(alignment: .bottom) {
            MapReader { proxy in
                Map(position: $camera) {
                    UserAnnotation()
                    ForEach(model.visibleShapes) { shape in
                        MapPolygon(shape.polygon)
                            .foregroundStyle(shape.color.opacity(shape.isShared ? 0.45 : 0.35))
                            .stroke(shape.color, lineWidth: 2)
                    }
                    ForEach(model.visibleFortifications) { fort in
                        MapPolygon(fort.polygon)
                            .foregroundStyle(fort.color.opacity(fort.fillOpacity))
                            .stroke(fort.color, lineWidth: 1)
                    }
                    if showOwnRoutes {
                        ForEach(model.visibleRouteLines) { line in
                            MapPolyline(coordinates: line.coordinates)
                                .stroke(line.color.opacity(0.45), lineWidth: 2)
                        }
                    }
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
                .mapStyle(.standard(pointsOfInterest: .excludingAll))
                .mapControls {
                    MapUserLocationButton()
                    MapCompass()
                    MapScaleView()
                }
                .onTapGesture { location in
                    if let treasure = treasureNear(location, proxy: proxy) {
                        selectedTreasure = treasure
                    } else if let coordinate = proxy.convert(location, from: .local),
                              let shape = model.shape(at: coordinate) {
                        selectedUserId = shape.userId
                    }
                }
            }
            .ignoresSafeArea(edges: .top)

            VStack(spacing: 10) {
                Spacer()
                if tracker.hasRecoverableRun {
                    recoveredRunBanner
                }
                if uploadedPendingRuns > 0 {
                    Label("Se han subido \(uploadedPendingRuns) carrera(s) guardadas sin conexión", systemImage: "checkmark.icloud")
                        .font(.footnote.weight(.semibold))
                        .padding(10)
                        .background(.regularMaterial, in: Capsule())
                }
                runButton
            }
            .padding(.bottom, 16)
        }
        .overlay(alignment: .bottomLeading) {
            if competition.isActive {
                powersButton
                    .padding(.leading, 16)
                    .padding(.bottom, 24)
            }
        }
        .safeAreaInset(edge: .top) {
            VStack(spacing: 8) {
                CompetitionBanner(store: competition) { showFinalResults = true }
                statsCard
                HStack(spacing: 8) {
                    mapOptionsMenu
                    if model.players.count > 1 {
                        PlayerFilterBar(players: model.players, hidden: model.hiddenUserIds) { model.toggle($0) }
                    } else {
                        Spacer(minLength: 0)
                    }
                }
            }
            .padding(.horizontal)
            .padding(.top, 4)
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
        .sheet(isPresented: $router.showPowers, onDismiss: refreshPowerBadge) {
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
        .conquestInbox()
        .task(id: router.reloadSignal) { await reload() }
        .task(id: competition.competition?.id ?? "none") { await refreshOverlaysPeriodically() }
        .onChange(of: tracker.isPresented) { _, presented in
            // Back from a run: the new territory may need a moment to be processed
            if !presented {
                Task {
                    await reload()
                    try? await Task.sleep(nanoseconds: 8_000_000_000)
                    await reload()
                }
            }
        }
        .onChange(of: model.treasures) { _, _ in
            tracker.activeTreasures = model.liveTreasures
        }
    }

    private func reload() async {
        uploadedPendingRuns = await PendingRuns.uploadAll()
        await HealthImporter.shared.autoImportIfEnabled()
        guard let user = session.user else { return }
        await model.load(user: user)
        tracker.territoryShapes = model.shapes
        tracker.activeTreasures = model.liveTreasures
        await session.refreshUser()
        await presentAutomaticDialogs()
        await ConquestInbox.shared.discoverNewRoutes(userId: user.id)
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

    // MARK: - Overlays

    private var statsCard: some View {
        HStack(spacing: 14) {
            if let user = session.user {
                AvatarView(name: user.name, avatar: user.avatar, color: user.color, size: 42)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Tu territorio")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    let area = Format.areaParts(user.totalArea)
                    HStack(alignment: .firstTextBaseline, spacing: 3) {
                        Text(area.value).font(.title2.bold()).monospacedDigit()
                        Text(area.unit).font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                    }
                }
                Spacer()
                if let rank = user.rank {
                    VStack(spacing: 0) {
                        Text("#\(rank)").font(.title2.bold())
                        Text("entre amigos").font(.caption2).foregroundStyle(.secondary)
                    }
                }
            }
            if model.isLoading {
                ProgressView()
            }
        }
        .padding(12)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    /// Show / hide every player and the user's own run traces.
    private var mapOptionsMenu: some View {
        Menu {
            if model.players.count > 1 {
                Button {
                    model.showAll()
                } label: {
                    Label("Mostrar todos", systemImage: "eye")
                }
                Button {
                    model.hideAll()
                } label: {
                    Label("Ocultar todos", systemImage: "eye.slash")
                }
                Divider()
            }
            Toggle(isOn: $showOwnRoutes) {
                Label("Mis recorridos", systemImage: "point.topleft.down.to.point.bottomright.curvepath")
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: model.visiblePlayerCount == 0 && !model.players.isEmpty ? "eye.slash" : "eye")
                if model.players.count > 1 {
                    Text("\(model.visiblePlayerCount)/\(model.players.count)")
                        .monospacedDigit()
                }
            }
            .font(.footnote.weight(.semibold))
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(.regularMaterial, in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Opciones del mapa")
    }

    /// ⚡ Powers won from treasures (only during an active competition).
    private var powersButton: some View {
        Button {
            Haptics.tap()
            router.showPowers = true
        } label: {
            Text("⚡")
                .font(.title2)
                .frame(width: 54, height: 54)
                .background(
                    LinearGradient(colors: [.orange, .pink], startPoint: .topLeading, endPoint: .bottomTrailing),
                    in: Circle()
                )
                .shadow(color: .black.opacity(0.25), radius: 8, y: 3)
                .overlay(alignment: .topTrailing) {
                    if competition.availablePowerCount > 0 {
                        Text("\(competition.availablePowerCount)")
                            .font(.caption2.weight(.heavy))
                            .monospacedDigit()
                            .foregroundStyle(.white)
                            .frame(minWidth: 20, minHeight: 20)
                            .padding(.horizontal, 2)
                            .background(Color.red, in: Capsule())
                            .overlay(Capsule().stroke(.white, lineWidth: 1.5))
                            .offset(x: 4, y: -4)
                    }
                }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(competition.availablePowerCount > 0 ? "Poderes, \(competition.availablePowerCount) disponibles" : "Poderes")
    }

    private var runButton: some View {
        Button {
            Haptics.tap()
            tracker.isPresented = true
        } label: {
            Label("Correr", systemImage: "play.fill")
                .font(.title3.bold())
                .padding(.horizontal, 36)
                .padding(.vertical, 16)
                .background(Color.brand, in: Capsule())
                .foregroundStyle(.white)
                .shadow(color: .black.opacity(0.25), radius: 10, y: 4)
        }
        .accessibilityHint("Abre la pantalla para grabar una carrera")
    }

    private var recoveredRunBanner: some View {
        VStack(spacing: 10) {
            Text("Tienes una carrera sin terminar")
                .font(.subheadline.weight(.semibold))
            HStack {
                Button("Descartar", role: .destructive) {
                    tracker.discardRecoveredRun()
                }
                .buttonStyle(.bordered)
                Button("Continuar") {
                    tracker.resumeRecoveredRun()
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .padding()
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .padding(.horizontal)
    }
}

private struct SelectedUser: Identifiable {
    let id: String
}

/// Chips to show or hide each player's territory.
struct PlayerFilterBar: View {
    let players: [UserRef]
    let hidden: Set<String>
    let toggle: (String) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(players) { player in
                    let isHidden = hidden.contains(player.id)
                    Button {
                        toggle(player.id)
                    } label: {
                        HStack(spacing: 6) {
                            Circle()
                                .fill(Color(hex: player.color))
                                .frame(width: 10, height: 10)
                            Text(player.name)
                                .font(.footnote.weight(.semibold))
                                .lineLimit(1)
                            Image(systemName: isHidden ? "eye.slash" : "eye")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(.regularMaterial, in: Capsule())
                        .opacity(isHidden ? 0.45 : 1)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(player.name), \(isHidden ? "oculto" : "visible")")
                }
            }
        }
    }
}
