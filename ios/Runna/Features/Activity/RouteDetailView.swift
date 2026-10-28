import SwiftUI
import MapKit

/// An activity: map, stats and, for your own activities, rename and delete.
struct RouteDetailView: View {
    let route: RunRoute
    /// Route colour (the owner's territory colour); defaults to yours.
    let color: String?
    /// Rename/delete are only offered on your own activities.
    let editable: Bool
    let onChange: () -> Void

    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var isRenaming = false
    @State private var confirmDelete = false
    @State private var isWorking = false
    @State private var errorMessage: String?

    init(route: RunRoute, color: String? = nil, editable: Bool = true, onChange: @escaping () -> Void = {}) {
        self.route = route
        self.color = color
        self.editable = editable
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
                    statsSection
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
                ShareLink(item: shareText) {
                    Image(systemName: "square.and.arrow.up")
                }
                .accessibilityLabel("Compartir actividad")
            }
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
            RouteDetailMap(
                locations: route.locations,
                color: lineColor,
                // The territory this run conquered (as drawn on the map), for the replay
                territories: MapModel.shared.shapes.filter { $0.routeId == route.id }
            )
                .frame(height: 320)
                .overlay(alignment: .bottom) { HairlineDivider() }
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

    // MARK: Conquest

    @ViewBuilder
    private var conquestSection: some View {
        if let area = route.territoryArea, area > 0 {
            let parts = ActivityFormat.areaParts(area)
            VStack(alignment: .leading, spacing: DS.Spacing.s) {
                SectionHeader(title: "Territorio")
                HStack(alignment: .center, spacing: DS.Spacing.m) {
                    VStack(alignment: .leading, spacing: 4) {
                        StatValue(value: "+\(parts.value)", unit: parts.unit, font: Font.stat(32, weight: .bold), tint: Color.brand)
                        Text(editable ? "Si borras esta carrera, tu territorio se recalcula." : "Pintado en el mapa con su color.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "flag")
                        .font(.system(size: 20, weight: .regular))
                        .foregroundStyle(.secondary)
                        .accessibilityHidden(true)
                }
                .card()
            }
        }
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
            Text("Al borrarla, tu territorio se recalcula sin esta carrera.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity)
                .multilineTextAlignment(.center)
        }
    }

    private var shareText: String {
        var text = "\(name): \(Format.distance(route.distance)) en \(Format.duration(route.duration))"
        if let area = route.territoryArea, area > 0 {
            text += " y +\(Format.area(area)) conquistados"
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

/// Interactive map of the route with start and finish markers, the territory it conquered and a button
/// that replays the conquest: the line is drawn from start to finish and then the territory fills in.
private struct RouteDetailMap: View {
    let locations: [CLLocationCoordinate2D]
    let color: Color
    let territories: [TerritoryShape]

    /// 0...1 of the line drawn.
    @State private var progress: Double = 1
    @State private var territoryOpacity: Double = 1
    /// Bumped by the button; 0 = no replay yet.
    @State private var replayToken = 0

    private var drawnLocations: [CLLocationCoordinate2D] {
        guard progress < 1 else { return locations }
        let count = max(2, Int((Double(locations.count) * progress).rounded()))
        return Array(locations.prefix(count))
    }

    private var isReplaying: Bool { progress < 1 || territoryOpacity < 1 }

    var body: some View {
        Map(initialPosition: .automatic) {
            ForEach(territories) { shape in
                MapPolygon(shape.polygon)
                    .foregroundStyle(color.opacity(0.3 * territoryOpacity))
                    .stroke(color.opacity(territoryOpacity), lineWidth: 2)
            }
            MapPolyline(coordinates: drawnLocations)
                .stroke(Color.white.opacity(0.7), style: StrokeStyle(lineWidth: 7, lineCap: .round, lineJoin: .round))
            MapPolyline(coordinates: drawnLocations)
                .stroke(color, style: StrokeStyle(lineWidth: 4.5, lineCap: .round, lineJoin: .round))
            if let start = locations.first {
                Annotation("Salida", coordinate: start) {
                    RouteDetailPin(isFinish: false, tint: color)
                }
            }
            if progress >= 1, let end = locations.last {
                Annotation("Llegada", coordinate: end) {
                    RouteDetailPin(isFinish: true, tint: color)
                }
            }
            if progress < 1, let head = drawnLocations.last {
                Annotation("", coordinate: head) {
                    Circle()
                        .fill(color)
                        .frame(width: 16, height: 16)
                        .overlay(Circle().strokeBorder(Color.white, lineWidth: 3))
                        .shadow(color: Color.black.opacity(0.2), radius: 2, x: 0, y: 1)
                }
            }
        }
        .mapStyle(.standard(emphasis: .muted, pointsOfInterest: .excludingAll))
        .overlay(alignment: .bottomTrailing) {
            Button {
                replayToken += 1
            } label: {
                Label(territories.isEmpty ? "Reproducir recorrido" : "Reproducir conquista", systemImage: "play.fill")
                    .font(.footnote.weight(.semibold))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .glassSurface(Capsule(), interactive: true)
            }
            .buttonStyle(.plain)
            .disabled(isReplaying)
            .opacity(isReplaying ? 0.5 : 1)
            .padding(DS.Spacing.m)
        }
        .task(id: replayToken) { await replay() }
    }

    private func replay() async {
        guard replayToken > 0 else { return }
        Haptics.tap()
        territoryOpacity = 0
        progress = 0
        let steps = 60
        for step in 1...steps {
            try? await Task.sleep(nanoseconds: 2_400_000_000 / UInt64(steps))
            if Task.isCancelled {
                progress = 1
                territoryOpacity = 1
                return
            }
            progress = Double(step) / Double(steps)
        }
        // The territory fills in (stepped: map overlays don't animate)
        for step in 1...12 {
            try? await Task.sleep(nanoseconds: 50_000_000)
            if Task.isCancelled { break }
            territoryOpacity = Double(step) / 12
        }
        territoryOpacity = 1
        if !territories.isEmpty { Haptics.success() }
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
