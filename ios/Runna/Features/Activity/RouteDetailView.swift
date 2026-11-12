import SwiftUI
import MapKit

/// An activity: map, stats, charts (altitude, pace, splits, climbs) and, for your own activities, rename and delete.
struct RouteDetailView: View {
    let route: RunRoute
    /// Route colour (the owner's territory colour); defaults to yours.
    let color: String?
    /// Rename/delete are only offered on your own activities.
    let editable: Bool
    /// The runner, for the flag of the replay and the video (nil: you).
    let owner: ReplayRunner?
    let onChange: () -> Void

    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var isRenaming = false
    @State private var confirmDelete = false
    @State private var isWorking = false
    @State private var errorMessage: String?
    @State private var showsReplay = false
    @State private var showsShareEditor = false

    init(route: RunRoute, color: String? = nil, editable: Bool = true, owner: ReplayRunner? = nil, onChange: @escaping () -> Void = {}) {
        self.route = route
        self.color = color
        self.editable = editable
        self.owner = owner
        self.onChange = onChange
        _name = State(initialValue: route.name)
    }

    private var lineColor: Color {
        Color(hex: color ?? session.user?.color ?? "#16A34A")
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: DS.Spacing.l) {
                mapHeader
                VStack(alignment: .leading, spacing: DS.Spacing.xxl) {
                    titleBlock
                    validationSection
                    statsSection
                    if route.locations.count >= 2 {
                        // Altitude profile, pace, km splits, climbs and highlights
                        ActivityProfileSection(routeId: route.id, accent: lineColor)
                    }
                    conquestSection
                    companions
                    if editable {
                        actions
                    }
                }
                .padding(.horizontal, DS.Spacing.l)
            }
            .padding(.bottom, DS.Spacing.xxxl)
        }
        .screenBackground()
        .navigationTitle(name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if route.locations.count >= 2 {
                    Menu {
                        Button {
                            showsShareEditor = true
                        } label: {
                            Label("Vídeo del recorrido", systemImage: "film")
                        }
                        ShareLink(item: shareText) {
                            Label("Solo texto", systemImage: "text.alignleft")
                        }
                    } label: {
                        Image(systemName: "square.and.arrow.up")
                    }
                    .accessibilityLabel("Compartir actividad")
                } else {
                    ShareLink(item: shareText) {
                        Image(systemName: "square.and.arrow.up")
                    }
                    .accessibilityLabel("Compartir actividad")
                }
            }
        }
        .fullScreenCover(isPresented: $showsShareEditor) {
            RouteShareEditor(
                coordinates: route.locations,
                distance: route.distance,
                duration: route.duration,
                title: name,
                date: route.startDate,
                area: route.isRejected ? nil : route.globalAreaGained,
                color: lineColor,
                runner: owner,
                activity: ReplayActivity(route: route)
            )
        }
        .disabled(isWorking)
        .overlay {
            if isWorking {
                ProgressView()
                    .controlSize(.large)
                    .padding(24)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: DS.Radius.tile, style: .continuous))
            }
        }
        .alert("Nombre de la actividad", isPresented: $isRenaming) {
            TextField("Nombre", text: $name)
            Button("Guardar") { rename() }
            Button("Cancelar", role: .cancel) { name = route.name }
        }
        .confirmationDialog("¿Borrar esta actividad?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Borrar", role: .destructive) { delete() }
        } message: {
            Text("No se puede deshacer.")
        }
        .errorAlert($errorMessage)
    }

    // MARK: Map

    @ViewBuilder
    private var mapHeader: some View {
        if route.locations.count >= 2 {
            RouteDetailMap(locations: route.locations, color: lineColor)
                .frame(height: 320)
                .overlay(alignment: .bottom) { HairlineDivider() }
                .overlay(alignment: .bottomTrailing) {
                    Button {
                        showsReplay = true
                    } label: {
                        Label("Ver animación", systemImage: "play.fill")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.primary)
                            .padding(.horizontal, 14)
                            .frame(height: 36)
                            .glassSurface(Capsule(), interactive: true)
                    }
                    .buttonStyle(.pressable)
                    .padding(DS.Spacing.m)
                }
                .fullScreenCover(isPresented: $showsReplay) {
                    RouteReplayFullScreen(coordinates: route.locations, color: lineColor, distance: route.distance, duration: route.duration, runner: owner, activity: ReplayActivity(route: route))
                }
        } else {
            EmptyStateView(
                systemImage: "location.slash",
                title: "Sin recorrido GPS",
                message: "Esta actividad no tiene ruta registrada. Sus datos cuentan igualmente."
            )
        }
    }

    // MARK: Title

    private var titleBlock: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: DS.Spacing.s) {
                Text(name)
                    .font(.title2.weight(.bold))
                    .tracking(DS.Tracking.title)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                if editable {
                    Button {
                        isRenaming = true
                    } label: {
                        Image(systemName: "pencil")
                            .font(.body.weight(.regular))
                            .foregroundStyle(.secondary)
                            .frame(width: 44, height: 32)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.pressable)
                    .accessibilityLabel("Cambiar nombre")
                }
            }
            Text(Format.dayAndTime(route.startDate))
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .padding(.top, route.locations.count >= 2 ? 0 : DS.Spacing.s)
    }

    // MARK: Stats

    private var paceText: String {
        Format.pace(distanceMeters: route.distance, seconds: route.duration).replacingOccurrences(of: " /km", with: "")
    }

    private var speedText: String {
        guard route.duration > 0, route.distance > 0 else { return "--" }
        let kmh: Double = route.distance / Double(route.duration) * 3.6
        return kmh.formatted(.number.precision(.fractionLength(1)).locale(Locale(identifier: "es_ES")))
    }

    private var statsSection: some View {
        let distance = ActivityFormat.distanceParts(route.distance)
        return VStack(alignment: .leading, spacing: DS.Spacing.s) {
            SectionHeader(title: "Resumen")
            VStack(spacing: 0) {
                HStack(spacing: 0) {
                    RouteDetailStatTile(value: distance.value, unit: distance.unit, label: "Distancia")
                    StatDivider(height: 44)
                    RouteDetailStatTile(value: Format.duration(route.duration), unit: nil, label: "Tiempo")
                }
                HairlineDivider()
                    .padding(.vertical, DS.Spacing.m)
                HStack(spacing: 0) {
                    RouteDetailStatTile(value: paceText, unit: "/km", label: "Ritmo medio")
                    StatDivider(height: 44)
                    RouteDetailStatTile(value: speedText, unit: "km/h", label: "Velocidad media")
                }
            }
            .card()
        }
    }

    // MARK: Anti-cheat

    /// Why the run doesn't count or is under review.
    @ViewBuilder
    private var validationSection: some View {
        if route.isRejected || route.isUnderReview {
            HStack(alignment: .top, spacing: DS.Spacing.m) {
                Image(systemName: route.isRejected ? "xmark.circle" : "hourglass")
                    .font(.system(size: 20, weight: .regular))
                    .foregroundStyle(route.isRejected ? Color.steal : Color.secondary)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text(route.isRejected ? "Esta carrera no cuenta" : "Carrera en revisión")
                        .font(.subheadline.weight(.semibold))
                    Text(validationText)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            .card()
        }
    }

    private var validationText: String {
        if let message = route.validationMessage, !message.isEmpty {
            return route.isRejected ? message : "\(message) Cuenta mientras tanto; si no es válida, se quitará su área."
        }
        return route.isRejected
            ? "El sistema anti-trampas no la ha aceptado, así que no suma área en ningún mapa."
            : "Cuenta mientras tanto; si no es válida, se quitará su área."
    }

    // MARK: Conquest

    /// New area on the global map (the one that stays) and competition territory of this run.
    @ViewBuilder
    private var conquestSection: some View {
        let global = route.isRejected ? 0 : (route.globalAreaGained ?? 0)
        let competition = route.isRejected ? 0 : (route.territoryArea ?? 0)
        if global > 0 || competition > 0 {
            VStack(alignment: .leading, spacing: DS.Spacing.s) {
                SectionHeader(title: "Territorio")
                VStack(alignment: .leading, spacing: DS.Spacing.m) {
                    HStack(spacing: 0) {
                        areaTile(global, label: "Mapa global")
                        if competition > 0 {
                            StatDivider(height: 44)
                            areaTile(competition, label: "Competición")
                        }
                    }
                    Text(editable ? "Si borras esta carrera, tu mapa global y tu competición se recalculan." : "Área nueva que sumó esta carrera.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .card()
            }
        }
    }

    private func areaTile(_ area: Double, label: String) -> some View {
        let parts = ActivityFormat.areaParts(area)
        return VStack(alignment: .leading, spacing: 4) {
            StatValue(value: "+\(parts.value)", unit: parts.unit, font: Font.stat(28, weight: .semibold), tint: Color.brand)
            Text(label)
                .statLabelStyle()
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.leading, DS.Spacing.xs)
        .accessibilityElement(children: .combine)
    }

    // MARK: Companions

    @ViewBuilder
    private var companions: some View {
        if !route.ranTogetherWith.isEmpty {
            VStack(alignment: .leading, spacing: DS.Spacing.s) {
                SectionHeader(title: "Corriste con")
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(route.ranTogetherWith.enumerated()), id: \.offset) { index, person in
                        if index > 0 {
                            HairlineDivider()
                        }
                        HStack(spacing: DS.Spacing.m) {
                            Image(systemName: "person")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                            Text(person)
                                .font(.body)
                                .lineLimit(1)
                            Spacer(minLength: 0)
                        }
                        .padding(.vertical, DS.Spacing.m)
                    }
                }
                .padding(.horizontal, DS.Spacing.l)
                .frame(maxWidth: .infinity, alignment: .leading)
                .card(padding: 0)
            }
        }
    }

    // MARK: Actions

    private var actions: some View {
        VStack(spacing: DS.Spacing.s) {
            HStack(spacing: DS.Spacing.m) {
                Button {
                    isRenaming = true
                } label: {
                    Label("Renombrar", systemImage: "pencil")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(SecondaryButtonStyle(tint: .primary))

                Button {
                    confirmDelete = true
                } label: {
                    Label("Borrar", systemImage: "trash")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(SecondaryButtonStyle(tint: .steal))
            }
            Text("Al borrarla, tus mapas se recalculan sin esta carrera.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity)
                .multilineTextAlignment(.center)
        }
    }

    private var shareText: String {
        var text = "\(name): \(Format.distance(route.distance)) en \(Format.duration(route.duration))"
        if !route.isRejected, let area = route.globalAreaGained, area > 0 {
            text += " y +\(Format.area(area)) de mapa nuevo"
        }
        return text + " con Runna.io"
    }

    // MARK: Requests

    private func rename() {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else {
            name = route.name
            return
        }
        // Optimistic: the new name shows everywhere at once and is put back if the server refuses
        let previous = route.name
        name = trimmed
        MyRoutesModel.shared.applyRename(routeId: route.id, name: trimmed)
        Haptics.success()
        Task {
            do {
                try await APIClient.shared.send("PATCH", "/api/routes/\(route.id)/name", body: ["name": trimmed])
                onChange()
            } catch {
                name = previous
                MyRoutesModel.shared.applyRename(routeId: route.id, name: previous)
                errorMessage = "No se ha podido cambiar el nombre. \(error.localizedDescription)"
            }
        }
    }

    private func delete() {
        guard let userId = session.userId else { return }
        isWorking = true
        Task {
            do {
                try await APIClient.shared.send("DELETE", "/api/routes/\(userId)/\(route.id)")
                onChange()
                dismiss()
            } catch {
                errorMessage = error.localizedDescription
            }
            isWorking = false
        }
    }
}

// MARK: - Pieces

/// Interactive map of the route with start and finish markers.
private struct RouteDetailMap: View {
    let locations: [CLLocationCoordinate2D]
    let color: Color

    var body: some View {
        Map(initialPosition: .automatic) {
            MapPolyline(coordinates: locations)
                .stroke(Color.white.opacity(0.7), style: StrokeStyle(lineWidth: 7, lineCap: .round, lineJoin: .round))
            MapPolyline(coordinates: locations)
                .stroke(color, style: StrokeStyle(lineWidth: 4.5, lineCap: .round, lineJoin: .round))
            if let start = locations.first {
                Annotation("Salida", coordinate: start) {
                    RouteDetailPin(isFinish: false, tint: color)
                }
            }
            if let end = locations.last {
                Annotation("Llegada", coordinate: end) {
                    RouteDetailPin(isFinish: true, tint: color)
                }
            }
        }
        .mapStyle(.standard(emphasis: .muted, pointsOfInterest: .excludingAll))
    }
}

/// Small start (hollow) / finish (solid) dot.
private struct RouteDetailPin: View {
    let isFinish: Bool
    let tint: Color

    var body: some View {
        Circle()
            .fill(isFinish ? tint : Color.white)
            .frame(width: 14, height: 14)
            .overlay(Circle().strokeBorder(isFinish ? Color.white : tint, lineWidth: 3))
    }
}

/// One figure of the summary grid: condensed value (+ unit) over an uppercase label.
private struct RouteDetailStatTile: View {
    let value: String
    let unit: String?
    let label: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            StatValue(value: value, unit: unit, font: Font.stat(28, weight: .semibold))
            Text(label)
                .statLabelStyle()
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.leading, DS.Spacing.xs)
        .accessibilityElement(children: .combine)
    }
}
