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
    @State private var uploadedPendingRuns = 0

    var body: some View {
        ZStack(alignment: .bottom) {
            MapReader { proxy in
                Map(position: $camera) {
                    UserAnnotation()
                    ForEach(model.visibleShapes) { shape in
                        MapPolygon(shape.polygon)
                            .foregroundStyle(shape.color.opacity(shape.isShared ? 0.45 : 0.35))
                            .stroke(shape.color, lineWidth: 2)
                    }
                    ForEach(model.treasures) { treasure in
                        Annotation(treasure.name, coordinate: treasure.coordinate) {
                            Text(treasure.emoji ?? "🎁")
                                .font(.title2)
                                .padding(6)
                                .background(.thinMaterial, in: Circle())
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
                    if let coordinate = proxy.convert(location, from: .local),
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
        .safeAreaInset(edge: .top) {
            VStack(spacing: 8) {
                statsCard
                if model.players.count > 1 {
                    PlayerFilterBar(players: model.players, hidden: model.hiddenUserIds) { model.toggle($0) }
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
        .task(id: router.reloadSignal) { await reload() }
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
        .onChange(of: model.treasures) { _, treasures in
            tracker.activeTreasures = treasures
        }
    }

    private func reload() async {
        uploadedPendingRuns = await PendingRuns.uploadAll()
        await HealthImporter.shared.autoImportIfEnabled()
        guard let user = session.user else { return }
        await model.load(user: user)
        await session.refreshUser()
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
        .overlay(alignment: .bottomLeading) {
            if let name = model.competitionName {
                Label(name, systemImage: "trophy.fill")
                    .font(.caption2.weight(.bold))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(Color.orange, in: Capsule())
                    .foregroundStyle(.white)
                    .offset(x: 12, y: 10)
            }
        }
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
