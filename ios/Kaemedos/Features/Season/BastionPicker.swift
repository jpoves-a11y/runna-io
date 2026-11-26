import MapKit
import SwiftUI

/// Bastión: tap a point of your territory on the map; the app proposes the zone it would reinforce
/// (about 2.5 km² of your territory around that point: never land you don't hold) and you confirm it
/// or tap somewhere else. A point outside your territory moves to its nearest part, and a zone
/// smaller than 2.5 km² (thin strips, a small territory) is reinforced whole: the sheet says so.
struct BastionPickerSheet: View {
    let item: InventoryItem
    /// Activates the power with the chosen point (the zone is computed again on the server)
    let onConfirm: (CLLocationCoordinate2D) async -> Bool

    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var territories: [Territory] = []
    @State private var hasLoaded = false
    @State private var camera: MapCameraPosition = .automatic
    @State private var tapped: CLLocationCoordinate2D?
    @State private var zone: BastionZone?
    @State private var target: Double = 2_500_000
    @State private var isPreviewing = false
    @State private var isConfirming = false
    @State private var errorMessage: String?

    private var mine: [Territory] { territories.filter { $0.userId == session.userId } }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                map
                panel
            }
            .navigationTitle(item.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancelar") { dismiss() }
                }
            }
            .task { await loadTerritory() }
            .errorAlert($errorMessage)
        }
    }

    // MARK: Map

    private var map: some View {
        MapReader { proxy in
            Map(position: $camera) {
                ForEach(mine) { territory in
                    ForEach(Array(territory.polygons.enumerated()), id: \.offset) { _, rings in
                        if let outer = rings.first {
                            MapPolygon(coordinates: outer)
                                .foregroundStyle(Color.brand.opacity(0.18))
                                .stroke(Color.brand.opacity(0.8), lineWidth: 1.5)
                        }
                    }
                }
                if let zone {
                    ForEach(Array(zone.polygons.enumerated()), id: \.offset) { _, rings in
                        if let outer = rings.first {
                            MapPolygon(coordinates: outer)
                                .foregroundStyle(Color.gold.opacity(0.35))
                                .stroke(Color.gold, style: StrokeStyle(lineWidth: 3, lineJoin: .round))
                        }
                    }
                    Annotation("", coordinate: zone.center) {
                        Image(systemName: "building.columns.fill")
                            .font(.system(size: 15, weight: .bold))
                            .foregroundStyle(.white)
                            .frame(width: 32, height: 32)
                            .background(Color.gold, in: Circle())
                            .overlay(Circle().strokeBorder(.white, lineWidth: 2))
                            .shadow(radius: 3)
                    }
                }
                if let tapped, zone?.snapped == true {
                    Annotation("", coordinate: tapped) {
                        Circle()
                            .strokeBorder(Color.secondary, style: StrokeStyle(lineWidth: 2, dash: [3, 3]))
                            .frame(width: 18, height: 18)
                    }
                }
            }
            .mapStyle(.standard(pointsOfInterest: .excludingAll))
            .onTapGesture { location in
                guard let coordinate = proxy.convert(location, from: .local) else { return }
                Task { await preview(at: coordinate) }
            }
            .overlay {
                if !hasLoaded {
                    ProgressView()
                } else if mine.isEmpty {
                    Text("Todavía no tienes territorio en esta competición. Corre primero: el Bastión refuerza zonas que ya son tuyas.")
                        .font(.subheadline)
                        .multilineTextAlignment(.center)
                        .padding(DS.Spacing.l)
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                        .padding(DS.Spacing.xl)
                }
            }
        }
    }

    // MARK: Panel

    private var panel: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.m) {
            if let zone {
                HStack(alignment: .firstTextBaseline) {
                    Text(Format.area(zone.area))
                        .font(.title2.weight(.bold))
                        .monospacedDigit()
                    Text("de tu territorio, 3 capas de fortaleza")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                if zone.snapped {
                    note("Has tocado fuera de tu territorio: te proponemos la parte más cercana (a \(Format.distance(zone.snappedMeters))).", symbol: "arrow.down.right.and.arrow.up.left")
                }
                if !zone.complete {
                    note("Alrededor no tienes \(Format.area(target)): se refuerza todo lo que hay.", symbol: "info.circle")
                }
                note("¿Otra zona? Toca otro punto del mapa.", symbol: "hand.tap")
                Button {
                    Task { await confirm() }
                } label: {
                    if isConfirming {
                        ProgressView().tint(Color.onBrand)
                    } else {
                        Text("Reforzar esta zona")
                    }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(isConfirming || isPreviewing)
            } else {
                Label(isPreviewing ? "Calculando la zona…" : "Toca un punto de tu territorio: reforzamos unos \(Format.area(target)) de tu zona a su alrededor.", systemImage: "hand.tap")
                    .font(.subheadline)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(DS.Spacing.l)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.canvas)
        .overlay(alignment: .top) { HairlineDivider() }
        .animation(.snappy, value: zone?.area)
    }

    private func note(_ text: String, symbol: String) -> some View {
        Label(text, systemImage: symbol)
            .font(.footnote)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }

    // MARK: Actions

    private func loadTerritory() async {
        defer { hasLoaded = true }
        if let map: SeasonMapResponse = try? await APIClient.shared.request("GET", "/api/season/map") {
            territories = map.territories
            let points = mine.flatMap { $0.polygons.flatMap { $0.first ?? [] } }
            if let region = Self.region(around: points) { camera = .region(region) }
        }
    }

    private func preview(at coordinate: CLLocationCoordinate2D) async {
        guard !mine.isEmpty, !isConfirming else { return }
        tapped = coordinate
        isPreviewing = true
        defer { isPreviewing = false }
        do {
            let response: BastionPreviewResponse = try await APIClient.shared.request(
                "POST", "/api/season/bastion/preview", body: ["lat": coordinate.latitude, "lng": coordinate.longitude]
            )
            Haptics.tap()
            withAnimation(.snappy) {
                zone = response.zone
                target = response.target
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func confirm() async {
        // The point the zone came from: the server recomputes the same zone
        guard let point = tapped else { return }
        isConfirming = true
        defer { isConfirming = false }
        if await onConfirm(point) { dismiss() }
    }

    static func region(around points: [CLLocationCoordinate2D]) -> MKCoordinateRegion? {
        guard let first = points.first else { return nil }
        var minLat = first.latitude, maxLat = first.latitude, minLng = first.longitude, maxLng = first.longitude
        for p in points {
            minLat = min(minLat, p.latitude); maxLat = max(maxLat, p.latitude)
            minLng = min(minLng, p.longitude); maxLng = max(maxLng, p.longitude)
        }
        let center = CLLocationCoordinate2D(latitude: (minLat + maxLat) / 2, longitude: (minLng + maxLng) / 2)
        let span = MKCoordinateSpan(latitudeDelta: max(0.01, (maxLat - minLat) * 1.4), longitudeDelta: max(0.01, (maxLng - minLng) * 1.4))
        return MKCoordinateRegion(center: center, span: span)
    }
}
