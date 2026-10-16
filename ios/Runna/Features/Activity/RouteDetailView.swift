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
            VStack(alignment: .leading, spacing: DS.Spacing.xl) {
                mapHeader
                VStack(alignment: .leading, spacing: DS.Spacing.l) {
                    titleBlock
                    statsGrid
                    conquestCard
                    companions
                    if editable {
                        actions
                    }
                }
                .padding(.horizontal, DS.Spacing.l)
            }
            .padding(.bottom, 32)
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
            RouteDetailMap(locations: route.locations, color: lineColor)
                .frame(height: 340)
                .clipShape(UnevenRoundedRectangle(bottomLeadingRadius: 28, bottomTrailingRadius: 28, style: .continuous))
                .shadow(color: Color.black.opacity(0.08), radius: 12, x: 0, y: 6)
        } else {
            EmptyStateView(
                systemImage: "location.slash",
                title: "Sin recorrido GPS",
                message: "Esta actividad no tiene ruta registrada, pero sus números cuentan igual.",
                tint: .sky
            )
        }
    }

    // MARK: Title

    private var titleBlock: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(name)
                    .font(.system(.title, design: .rounded, weight: .heavy))
                    .fixedSize(horizontal: false, vertical: true)
                if editable {
                    Button {
                        isRenaming = true
                    } label: {
                        Image(systemName: "pencil")
                            .font(.subheadline.weight(.bold))
                            .foregroundStyle(Color.brand)
                            .frame(width: 30, height: 30)
                            .background(Color.brand.opacity(0.14), in: Circle())
                    }
                    .buttonStyle(.pressable)
                    .accessibilityLabel("Cambiar nombre")
                }
            }
            Label(Format.dayAndTime(route.startDate), systemImage: "calendar")
                .font(.system(.subheadline, design: .rounded, weight: .medium))
                .foregroundStyle(.secondary)
        }
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

    private var statsGrid: some View {
        let columns: [GridItem] = [GridItem(.flexible(), spacing: DS.Spacing.m), GridItem(.flexible(), spacing: DS.Spacing.m)]
        return LazyVGrid(columns: columns, spacing: DS.Spacing.m) {
            RouteDetailStatTile(systemImage: "figure.run", value: Format.distance(route.distance), unit: nil, label: "Distancia", tint: Color.sky)
            RouteDetailStatTile(systemImage: "stopwatch.fill", value: Format.duration(route.duration), unit: nil, label: "Tiempo", tint: Color.grape)
            RouteDetailStatTile(systemImage: "speedometer", value: paceText, unit: "/km", label: "Ritmo medio", tint: Color.gold)
            RouteDetailStatTile(systemImage: "bolt.fill", value: speedText, unit: "km/h", label: "Velocidad", tint: Color.steal)
        }
    }

    // MARK: Conquest

    @ViewBuilder
    private var conquestCard: some View {
        if let area = route.territoryArea, area > 0 {
            HStack(spacing: 14) {
                Image(systemName: "flag.fill")
                    .font(.title3.weight(.bold))
                    .foregroundStyle(Color.brand)
                    .frame(width: 48, height: 48)
                    .background(Color.white, in: Circle())
                VStack(alignment: .leading, spacing: 2) {
                    Text("Territorio conquistado")
                        .font(Font.statLabel)
                        .textCase(.uppercase)
                        .tracking(0.6)
                        .opacity(0.9)
                    Text("+\(Format.area(area))")
                        .font(Font.stat(30, weight: .heavy))
                        .monospacedDigit()
                    Text(editable ? "Si borras esta carrera, tu territorio se recalcula." : "Pintado en el mapa con su color.")
                        .font(.caption)
                        .opacity(0.85)
                }
                Spacer(minLength: 0)
            }
            .foregroundStyle(.white)
            .padding(DS.Spacing.l)
            .background(.brandGradient, in: RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous))
            .shadow(color: Color.brand.opacity(0.3), radius: 12, x: 0, y: 6)
        }
    }

    // MARK: Companions

    @ViewBuilder
    private var companions: some View {
        if !route.ranTogetherWith.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Label("Corriste con", systemImage: "person.2.fill")
                    .font(Font.cardTitle)
                    .foregroundStyle(Color.sky)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(Array(route.ranTogetherWith.enumerated()), id: \.offset) { _, person in
                            Text(person)
                                .font(.system(.subheadline, design: .rounded, weight: .semibold))
                                .padding(.horizontal, 12)
                                .padding(.vertical, 7)
                                .background(Color.sky.opacity(0.14), in: Capsule())
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .card()
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
                .buttonStyle(SecondaryButtonStyle(tint: .brand))

                Button {
                    confirmDelete = true
                } label: {
                    Label("Borrar", systemImage: "trash")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(SecondaryButtonStyle(tint: .steal))
            }
            Text("Al borrarla se recalcula tu territorio sin esta carrera.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity)
                .multilineTextAlignment(.center)
        }
        .padding(.top, DS.Spacing.s)
    }

    private var shareText: String {
        var text = "\(name): \(Format.distance(route.distance)) en \(Format.duration(route.duration))"
        if let area = route.territoryArea, area > 0 {
            text += " y +\(Format.area(area)) conquistados"
        }
        return text + " con Runna.io 🏃"
    }

    // MARK: Requests

    private func rename() {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else {
            name = route.name
            return
        }
        isWorking = true
        Task {
            do {
                try await APIClient.shared.send("PATCH", "/api/routes/\(route.id)/name", body: ["name": trimmed])
                Haptics.success()
                onChange()
            } catch {
                name = route.name
                errorMessage = error.localizedDescription
            }
            isWorking = false
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

/// Interactive map of the route with start and finish pins.
private struct RouteDetailMap: View {
    let locations: [CLLocationCoordinate2D]
    let color: Color

    var body: some View {
        Map(initialPosition: .automatic) {
            MapPolyline(coordinates: locations)
                .stroke(Color.white.opacity(0.9), style: StrokeStyle(lineWidth: 9, lineCap: .round, lineJoin: .round))
            MapPolyline(coordinates: locations)
                .stroke(color, style: StrokeStyle(lineWidth: 5, lineCap: .round, lineJoin: .round))
            if let start = locations.first {
                Annotation("Salida", coordinate: start) {
                    RouteDetailPin(systemImage: "figure.run", tint: Color.brand)
                }
            }
            if let end = locations.last {
                Annotation("Llegada", coordinate: end) {
                    RouteDetailPin(systemImage: "flag.checkered", tint: Color.steal)
                }
            }
        }
        .mapStyle(.standard(pointsOfInterest: .excludingAll))
    }
}

private struct RouteDetailPin: View {
    let systemImage: String
    let tint: Color

    var body: some View {
        Image(systemName: systemImage)
            .font(.system(size: 12, weight: .bold))
            .foregroundStyle(.white)
            .frame(width: 28, height: 28)
            .background(tint, in: Circle())
            .overlay(Circle().stroke(Color.white, lineWidth: 2.5))
            .shadow(color: Color.black.opacity(0.25), radius: 4, x: 0, y: 2)
    }
}

/// Stat card of the detail grid: icon on a gradient circle, big rounded value, small label.
private struct RouteDetailStatTile: View {
    let systemImage: String
    let value: String
    let unit: String?
    let label: String
    let tint: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Image(systemName: systemImage)
                .font(.subheadline.weight(.bold))
                .foregroundStyle(.white)
                .frame(width: 34, height: 34)
                .background(tint.gradient, in: Circle())
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 3) {
                    Text(value)
                        .font(Font.statNumber)
                        .monospacedDigit()
                        .lineLimit(1)
                        .minimumScaleFactor(0.6)
                    if let unit {
                        Text(unit)
                            .font(.system(.caption, design: .rounded, weight: .semibold))
                            .foregroundStyle(.secondary)
                    }
                }
                Text(label)
                    .statLabelStyle()
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card(padding: 14, radius: DS.Radius.tile + 4)
        .accessibilityElement(children: .combine)
    }
}
