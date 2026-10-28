import SwiftUI
import MapKit

// MARK: - Map settings

/// Which territory stands out on the map (the rest is shown desaturated).
enum MapFocus: String, CaseIterable, Identifiable {
    case all, mine, rivals

    var id: String { rawValue }

    var title: String {
        switch self {
        case .all: return "Todos igual"
        case .mine: return "Mi territorio"
        case .rivals: return "Rivales"
        }
    }

    var systemImage: String {
        switch self {
        case .all: return "circle.grid.2x2"
        case .mine: return "person"
        case .rivals: return "person.2"
        }
    }
}

/// How runs are drawn: hidden, as thin lines, or overlapped as a heat map of the streets run most.
enum RouteDisplayMode: String, CaseIterable, Identifiable {
    case off, lines, heat

    var id: String { rawValue }

    var title: String {
        switch self {
        case .off: return "Ocultos"
        case .lines: return "Líneas"
        case .heat: return "Mapa de calor"
        }
    }

    var systemImage: String {
        switch self {
        case .off: return "eye.slash"
        case .lines: return "point.topleft.down.to.point.bottomright.curvepath"
        case .heat: return "flame"
        }
    }
}

/// Map look that depends on the zoom: far away the fill is stronger and the outline thin (who owns the city),
/// close up the fill is soft and the outline strong (the streets stay readable).
struct MapZoomStyle: Equatable {
    /// 0 = street level, 1 = whole city (rounded to tenths so small zooms don't redraw the map).
    let farness: Double

    init(cameraDistance: Double) {
        let raw = (cameraDistance - 1_500) / (14_000 - 1_500)
        farness = (min(max(raw, 0), 1) * 10).rounded() / 10
    }

    /// Hatching and other fine details only make sense close up.
    var showsDetail: Bool { farness <= 0.4 }

    func fillOpacity(isMine: Bool, isShared: Bool) -> Double {
        let base = 0.16 + 0.24 * farness
        let mine = isMine ? 0.06 : 0
        let shared = isShared ? 0.04 : 0
        return base + mine + shared
    }

    func strokeWidth(isMine: Bool) -> CGFloat {
        let base = 3.2 - 1.8 * farness
        return CGFloat(base + (isMine ? 0.6 : 0))
    }
}

/// Territories conquered recently are brighter; old ones fade, so neglected areas show.
enum TerritoryAge {
    static let recentInterval: TimeInterval = 48 * 3600

    static func isRecent(_ date: Date?, now: Date = Date()) -> Bool {
        guard let date else { return false }
        return now.timeIntervalSince(date) < recentInterval
    }

    /// 1 for the last two days, down to 0.55 after three weeks.
    static func fade(_ date: Date?, now: Date = Date()) -> Double {
        guard let date else { return 0.8 }
        let days = now.timeIntervalSince(date) / 86_400
        if days <= 2 { return 1 }
        if days >= 21 { return 0.55 }
        return 1 - (days - 2) / 19 * 0.45
    }
}

extension Color {
    /// The colour with most of its saturation removed and slightly lighter (for territory out of focus).
    func muted() -> Color {
        let ui = UIColor(self)
        var hue: CGFloat = 0
        var saturation: CGFloat = 0
        var brightness: CGFloat = 0
        var alpha: CGFloat = 0
        guard ui.getHue(&hue, saturation: &saturation, brightness: &brightness, alpha: &alpha) else { return self }
        return Color(hue: Double(hue), saturation: Double(saturation * 0.2), brightness: Double(min(1, brightness * 0.9 + 0.1)), opacity: Double(alpha))
    }
}

// MARK: - Geometry

/// A line drawn on the map (contested borders).
struct MapLine: Identifiable {
    let id: String
    let userId: String
    let coordinates: [CLLocationCoordinate2D]
}

/// A line with its own colour (fortification hatching).
struct ColoredMapLine: Identifiable {
    let id: String
    let color: Color
    let coordinates: [CLLocationCoordinate2D]
}

/// How one territory polygon is drawn right now (zoom, focus, age and selection applied).
struct TerritoryLook: Identifiable {
    let shape: TerritoryShape
    let fill: Color
    let stroke: Color
    let strokeStyle: StrokeStyle
    /// Width of the halo around recently conquered territory (nil: no halo).
    let haloWidth: CGFloat?

    var id: String { shape.id }
}

/// Plane geometry in metres around a reference latitude (good enough at city scale).
enum MapGeometry {
    private static let metersPerDegreeLat = 110_540.0
    private static let metersPerDegreeLng = 111_320.0

    private struct Projection {
        let cosLat: Double

        init(latitude: Double) {
            cosLat = max(0.2, cos(latitude * .pi / 180))
        }

        func point(_ c: CLLocationCoordinate2D) -> (x: Double, y: Double) {
            (x: c.longitude * MapGeometry.metersPerDegreeLng * cosLat, y: c.latitude * MapGeometry.metersPerDegreeLat)
        }

        func coordinate(x: Double, y: Double) -> CLLocationCoordinate2D {
            CLLocationCoordinate2D(latitude: y / MapGeometry.metersPerDegreeLat, longitude: x / (MapGeometry.metersPerDegreeLng * cosLat))
        }
    }

    // MARK: Thinning and camera

    /// At most `maxPoints` points, evenly picked (first and last kept).
    static func simplified(_ coordinates: [CLLocationCoordinate2D], maxPoints: Int) -> [CLLocationCoordinate2D] {
        guard coordinates.count > maxPoints, maxPoints >= 2 else { return coordinates }
        let step = Double(coordinates.count - 1) / Double(maxPoints - 1)
        return (0..<maxPoints).map { coordinates[min(coordinates.count - 1, Int((Double($0) * step).rounded()))] }
    }

    /// Map rect showing `points` with a margin, leaving `topShare` / `bottomShare` of the screen height free
    /// (for the cards drawn over the map).
    static func fittingRect(_ points: [CLLocationCoordinate2D], bottomShare: Double = 0, topShare: Double = 0) -> MKMapRect? {
        guard !points.isEmpty else { return nil }
        var minX = Double.greatestFiniteMagnitude
        var minY = Double.greatestFiniteMagnitude
        var maxX = -Double.greatestFiniteMagnitude
        var maxY = -Double.greatestFiniteMagnitude
        for point in points {
            let p = MKMapPoint(point)
            minX = min(minX, p.x)
            minY = min(minY, p.y)
            maxX = max(maxX, p.x)
            maxY = max(maxY, p.y)
        }
        // At least ~150 m across, plus 15 % on each side
        let minimum = MKMapPointsPerMeterAtLatitude(points[0].latitude) * 150
        var width = max(maxX - minX, minimum)
        var height = max(maxY - minY, minimum)
        let centerX = (minX + maxX) / 2
        width *= 1.3
        height *= 1.3
        // Map y grows southwards: the free space at the bottom goes below the content
        let free = min(max(topShare + bottomShare, 0), 0.8)
        let totalHeight = height / (1 - free)
        let top = (minY + maxY) / 2 - height / 2 - totalHeight * topShare
        return MKMapRect(x: centerX - width / 2, y: top, width: width, height: totalHeight)
    }

    // MARK: Hatching

    /// Diagonal (45°) lines clipped to a polygon (outer ring first, then holes), `spacing` metres apart.
    /// At most `maxLines` lines: a big polygon gets a wider spacing.
    static func hatch(rings: [[CLLocationCoordinate2D]], spacing: Double = 28, maxLines: Int = 120) -> [[CLLocationCoordinate2D]] {
        guard let outer = rings.first, outer.count >= 3 else { return [] }
        let projection = Projection(latitude: outer[0].latitude)
        let root2 = 2.0.squareRoot()
        // Rotated frame: u runs across the hatch lines, v along them
        let projected: [[(u: Double, v: Double)]] = rings.map { ring in
            ring.map { coordinate in
                let p = projection.point(coordinate)
                return (u: (p.x + p.y) / root2, v: (p.y - p.x) / root2)
            }
        }
        let us = projected[0].map(\.u)
        guard let minU = us.min(), let maxU = us.max(), maxU > minU else { return [] }
        let step = max(spacing, (maxU - minU) / Double(maxLines))

        var lines: [[CLLocationCoordinate2D]] = []
        var u = (minU / step).rounded(.up) * step
        while u < maxU {
            var crossings: [Double] = []
            for ring in projected where ring.count >= 3 {
                var j = ring.count - 1
                for i in 0..<ring.count {
                    let a = ring[j]
                    let b = ring[i]
                    if (a.u <= u) != (b.u <= u) {
                        crossings.append(a.v + (u - a.u) / (b.u - a.u) * (b.v - a.v))
                    }
                    j = i
                }
            }
            crossings.sort()
            var index = 0
            while index + 1 < crossings.count {
                let v1 = crossings[index]
                let v2 = crossings[index + 1]
                if v2 - v1 > 2 {
                    let start = projection.coordinate(x: (u - v1) / root2, y: (u + v1) / root2)
                    let end = projection.coordinate(x: (u - v2) / root2, y: (u + v2) / root2)
                    lines.append([start, end])
                }
                index += 2
            }
            u += step
        }
        return lines
    }

    // MARK: Contested borders

    /// Stretches of the outlines in `mine` that run within `tolerance` metres of an outline in `rivals`:
    /// where your territory touches someone else's. Each result is a polyline.
    static func contestedBorders(
        mine: [[[CLLocationCoordinate2D]]],
        rivals: [[[CLLocationCoordinate2D]]],
        tolerance: Double = 15
    ) -> [[CLLocationCoordinate2D]] {
        guard let reference = mine.first?.first?.first, !rivals.isEmpty else { return [] }
        let projection = Projection(latitude: reference.latitude)
        let cell = max(tolerance * 3, 50)

        // Rival segments in a grid of `cell` metres
        struct Segment { let ax, ay, bx, by: Double }
        var grid: [Int64: [Segment]] = [:]
        func key(_ cx: Int, _ cy: Int) -> Int64 { Int64(cx) &* 1_000_003 &+ Int64(cy) }
        for polygon in rivals {
            for ring in polygon where ring.count >= 2 {
                let points = ring.map(projection.point)
                for i in 0..<points.count {
                    let a = points[i]
                    let b = points[(i + 1) % points.count]
                    let segment = Segment(ax: a.x, ay: a.y, bx: b.x, by: b.y)
                    let minX = Int(((min(a.x, b.x) - tolerance) / cell).rounded(.down))
                    let maxX = Int(((max(a.x, b.x) + tolerance) / cell).rounded(.down))
                    let minY = Int(((min(a.y, b.y) - tolerance) / cell).rounded(.down))
                    let maxY = Int(((max(a.y, b.y) + tolerance) / cell).rounded(.down))
                    // A very long edge would fill too many cells: it's split by sampling instead
                    guard (maxX - minX + 1) * (maxY - minY + 1) <= 400 else { continue }
                    for cx in minX...maxX {
                        for cy in minY...maxY {
                            grid[key(cx, cy), default: []].append(segment)
                        }
                    }
                }
            }
        }
        guard !grid.isEmpty else { return [] }

        func distance(_ px: Double, _ py: Double, _ s: Segment) -> Double {
            let dx = s.bx - s.ax
            let dy = s.by - s.ay
            let lengthSquared = dx * dx + dy * dy
            var t = lengthSquared > 0 ? ((px - s.ax) * dx + (py - s.ay) * dy) / lengthSquared : 0
            t = min(max(t, 0), 1)
            let qx = s.ax + t * dx - px
            let qy = s.ay + t * dy - py
            return (qx * qx + qy * qy).squareRoot()
        }

        func isContested(_ p: (x: Double, y: Double)) -> Bool {
            let cx = Int((p.x / cell).rounded(.down))
            let cy = Int((p.y / cell).rounded(.down))
            guard let segments = grid[key(cx, cy)] else { return false }
            return segments.contains { distance(p.x, p.y, $0) <= tolerance }
        }

        var result: [[CLLocationCoordinate2D]] = []
        for polygon in mine {
            for ring in polygon where ring.count >= 3 {
                // Densify long edges so a border along a single long edge is still found
                var samples: [(coordinate: CLLocationCoordinate2D, contested: Bool)] = []
                for i in 0..<ring.count {
                    let a = ring[i]
                    let b = ring[(i + 1) % ring.count]
                    let pa = projection.point(a)
                    let pb = projection.point(b)
                    let length = ((pb.x - pa.x) * (pb.x - pa.x) + (pb.y - pa.y) * (pb.y - pa.y)).squareRoot()
                    let pieces = min(50, max(1, Int(length / 10)))
                    for k in 0..<pieces {
                        let t = Double(k) / Double(pieces)
                        let p = (x: pa.x + (pb.x - pa.x) * t, y: pa.y + (pb.y - pa.y) * t)
                        samples.append((coordinate: projection.coordinate(x: p.x, y: p.y), contested: isContested(p)))
                    }
                }
                guard samples.contains(where: \.contested) else { continue }
                // Start right after a free sample so a stretch crossing the ring's start isn't cut in two
                let start = (samples.firstIndex { !$0.contested } ?? 0) + 1
                var current: [CLLocationCoordinate2D] = []
                for offset in 0...samples.count {
                    let sample = samples[(start + offset) % samples.count]
                    if sample.contested && offset < samples.count {
                        current.append(sample.coordinate)
                    } else {
                        if current.count >= 2 { result.append(current) }
                        current = []
                    }
                }
            }
        }
        return result
    }
}

// MARK: - Legend

/// What every mark on the map means.
struct MapLegendSheet: View {
    let color: Color
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section("Territorio") {
                    row("Tu territorio", "Relleno y borde con tu color.") {
                        swatch(fill: color.opacity(0.35), stroke: color, width: 3)
                    }
                    row("Territorio de un rival", "Con el color de cada jugador. Tócalo para ver quién lo conquistó y con qué carrera.") {
                        swatch(fill: Color.steal.opacity(0.28), stroke: Color.steal, width: 2.5)
                    }
                    row("Compartido", "Conquistado corriendo con otra persona: borde discontinuo.") {
                        swatch(fill: color.opacity(0.38), stroke: color, width: 2.5, dash: [5, 3])
                    }
                    row("Reciente", "Conquistado en las últimas 48 horas: con halo. Lo más antiguo se va apagando.") {
                        ZStack {
                            RoundedRectangle(cornerRadius: 5).stroke(color.opacity(0.35), lineWidth: 7)
                            swatch(fill: color.opacity(0.4), stroke: color, width: 3)
                        }
                    }
                    row("Frontera en disputa", "Donde tu territorio toca el de otro jugador.") {
                        Capsule().fill(Color.steal).frame(width: 34, height: 5)
                            .background(Capsule().fill(Color.steal.opacity(0.3)).frame(width: 38, height: 11))
                    }
                }
                Section("Fortificaciones") {
                    row("Zona fortificada", "Rayada y con muralla: cuantas más capas, más gruesa.") {
                        ZStack {
                            swatch(fill: color.darkened(0.35).opacity(0.45), stroke: color.darkened(0.35), width: 4.5)
                            Hatch().stroke(color.darkened(0.35).opacity(0.6), lineWidth: 1)
                                .clipShape(RoundedRectangle(cornerRadius: 5))
                            RoundedRectangle(cornerRadius: 5).stroke(Color.white.opacity(0.6), lineWidth: 1.2)
                        }
                    }
                    row("Fortaleza", "Número de capas de la zona.") {
                        CastleMarker(zone: CastleZone(id: "legend", userId: "", coordinate: CLLocationCoordinate2D(), layers: 3, color: color.darkened(0.35)))
                    }
                }
                Section("Recorridos") {
                    row("Recorrido", "Tus carreras (o las de todos) como líneas.") {
                        Capsule().fill(color.opacity(0.7)).frame(width: 36, height: 3)
                    }
                    row("Mapa de calor", "Las calles por las que más corres se ven más intensas.") {
                        ZStack {
                            Capsule().fill(color.opacity(0.2)).frame(width: 36, height: 7)
                            Capsule().fill(color.opacity(0.35)).frame(width: 24, height: 7)
                            Capsule().fill(color.opacity(0.6)).frame(width: 12, height: 7)
                        }
                    }
                }
            }
            .navigationTitle("Leyenda del mapa")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Hecho") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func row<Icon: View>(_ title: String, _ detail: String, @ViewBuilder icon: () -> Icon) -> some View {
        HStack(spacing: DS.Spacing.m) {
            icon()
                .frame(width: 44, height: 30)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func swatch(fill: Color, stroke: Color, width: CGFloat, dash: [CGFloat] = []) -> some View {
        RoundedRectangle(cornerRadius: 5)
            .fill(fill)
            .overlay(RoundedRectangle(cornerRadius: 5).stroke(stroke, style: StrokeStyle(lineWidth: width, dash: dash)))
            .frame(width: 38, height: 26)
    }
}

/// Diagonal lines for the legend's fortified swatch.
private struct Hatch: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        var x = -rect.height
        while x < rect.width {
            path.move(to: CGPoint(x: rect.minX + x, y: rect.maxY))
            path.addLine(to: CGPoint(x: rect.minX + x + rect.height, y: rect.minY))
            x += 6
        }
        return path
    }
}

// MARK: - Selected territory

/// Card shown after tapping a territory: whose it is, when it was conquered and the run that did it.
struct SelectedTerritoryCard: View {
    let owner: UserRef?
    let ownerName: String
    let color: Color
    let conqueredAt: Date?
    let route: RunRoute?
    let isLoadingRoute: Bool
    let onProfile: () -> Void
    let onRoute: () -> Void
    let onClose: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Spacing.s) {
            HStack(spacing: DS.Spacing.m) {
                if let owner {
                    AvatarView(name: owner.name, avatar: owner.avatar, color: owner.color, size: 34)
                } else {
                    Circle().fill(color).frame(width: 34, height: 34)
                }
                VStack(alignment: .leading, spacing: 1) {
                    Text(owner?.name ?? (ownerName.isEmpty ? "Territorio" : ownerName))
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 4)
                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 32, height: 32)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Cerrar")
            }
            HStack(spacing: DS.Spacing.s) {
                Button(action: onProfile) {
                    Label("Ver perfil", systemImage: "person")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(SecondaryButtonStyle(tint: .primary))
                if route != nil {
                    Button(action: onRoute) {
                        Label("Ver carrera", systemImage: "figure.run")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(SecondaryButtonStyle(tint: color))
                }
            }
        }
        .padding(.horizontal, DS.Spacing.m)
        .padding(.vertical, 10)
        .glassSurface(RoundedRectangle(cornerRadius: DS.Radius.card, style: .continuous))
    }

    private var subtitle: String {
        var parts: [String] = []
        if let conqueredAt {
            parts.append("Conquistado el \(Format.dayAndTime(conqueredAt))")
        }
        if let route {
            parts.append("\(route.name) · \(Format.distance(route.distance))")
        } else if isLoadingRoute {
            parts.append("Buscando la carrera…")
        }
        return parts.isEmpty ? "Territorio conquistado" : parts.joined(separator: "\n")
    }
}
