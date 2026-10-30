import SwiftUI
import MapKit
import UIKit

// What a run share (cards and video) is made of: the run itself, what it conquered and whom it
// stole from (GET /api/conquest-result/:routeId), and your place in the week's league
// (GET /api/widget/summary).

/// A run to share, from the run detail, the run summary or the replay.
struct ShareRun {
    let routeId: String?
    let name: String
    let date: Date?
    let coordinates: [CLLocationCoordinate2D]
    let distance: Double
    let duration: Int
    /// Owner's territory colour ("#RRGGBB").
    let colorHex: String
    /// Territory this run conquered (the zones it passes through); empty when unknown.
    var territories: [TerritoryShape] = []

    var color: Color { Color(hex: colorHex) }
    var uiColor: UIColor { UIColor(widgetHex: colorHex) ?? .systemGreen }

    /// The rings drawn as "conquered": the zones when known, else the route closed back to its start.
    var conqueredRings: [[CLLocationCoordinate2D]] {
        if !territories.isEmpty { return territories.flatMap { $0.rings } }
        guard coordinates.count >= 3, let first = coordinates.first else { return [] }
        return [coordinates + [first]]
    }

    var paceText: String? {
        guard distance >= 50, duration > 0 else { return nil }
        let perKm = Double(duration) / (distance / 1000)
        guard perKm.isFinite, perKm < 3600 else { return nil }
        let total = Int(perKm.rounded())
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}

/// What to show on the cards.
struct ShareOptions: Equatable {
    enum Background: String, CaseIterable, Identifiable {
        case dark, light, transparent
        var id: String { rawValue }
        var title: String {
            switch self {
            case .dark: return "Oscuro"
            case .light: return "Claro"
            case .transparent: return "Transparente"
            }
        }
    }

    var distance = true
    var time = true
    var pace = true
    var territory = true
    var steals = true
    var ranking = true
    var background: Background = .dark
}

enum ShareTemplate: String, CaseIterable, Identifiable {
    case sticker, map, conquest, league
    var id: String { rawValue }

    var title: String {
        switch self {
        case .sticker: return "Pegatina"
        case .map: return "Mapa"
        case .conquest: return "Conquista"
        case .league: return "Liga"
        }
    }

    /// Size in points (rendered at 3x: 1080 px wide).
    var size: CGSize {
        switch self {
        case .sticker: return CGSize(width: 360, height: 420)
        case .map, .league: return CGSize(width: 360, height: 640)
        case .conquest: return CGSize(width: 360, height: 450)
        }
    }

    /// Transparent background allowed (pasted over a photo).
    var allowsTransparency: Bool { self == .sticker || self == .conquest }
}

/// Everything loaded for the share screen.
@MainActor
@Observable
final class ShareContext {
    let run: ShareRun
    private(set) var conquest: ConquestResult?
    private(set) var summary: WidgetSummary?
    private(set) var avatars: [String: UIImage] = [:]
    private(set) var mapImage: UIImage?
    private(set) var isLoading = true

    init(run: ShareRun, conquest: ConquestResult? = nil) {
        self.run = run
        self.conquest = conquest
    }

    var newArea: Double { conquest?.newAreaConquered ?? 0 }
    var victims: [Victim] { conquest?.stolenVictims ?? [] }
    var castlesBuilt: Int { conquest?.castlesBuilt ?? 0 }
    var weekRank: Int? { summary?.week.myRank }
    var weekPlayers: Int { summary?.week.players ?? 0 }

    func load() async {
        isLoading = true
        defer { isLoading = false }
        if conquest == nil, let routeId = run.routeId {
            conquest = try? await APIClient.shared.request("GET", "/api/conquest-result/\(routeId)")
        }
        summary = try? await APIClient.shared.request("GET", "/api/widget/summary")
        mapImage = await ShareMapRenderer.render(run, size: ShareTemplate.map.size, scale: 3)
        await loadAvatars()
    }

    private func loadAvatars() async {
        var urls: [String: URL] = [:]
        for victim in victims {
            urls[victim.userId] = AppConfig.apiBaseURL.appendingPathComponent("api/users/\(victim.userId)/avatar")
        }
        for entry in summary?.week.entries ?? [] {
            if let text = entry.avatarUrl, let url = URL(string: text) { urls[entry.id] = url }
        }
        for (id, url) in urls {
            if let image = await RemoteImageCache.shared.image(for: url) { avatars[id] = image }
        }
    }
}

// MARK: - Geometry

enum ShareGeometry {
    /// The route projected into `rect` keeping its shape (north up), centred, with `padding`.
    static func fit(_ coordinates: [CLLocationCoordinate2D], in rect: CGRect, padding: CGFloat = 0) -> [CGPoint] {
        guard let first = coordinates.first else { return [] }
        let cosLat = max(0.2, cos(first.latitude * .pi / 180))
        let raw = coordinates.map { CGPoint(x: $0.longitude * cosLat, y: -$0.latitude) }
        let xs = raw.map(\.x), ys = raw.map(\.y)
        guard let minX = xs.min(), let maxX = xs.max(), let minY = ys.min(), let maxY = ys.max() else { return [] }
        let width = max(maxX - minX, 1e-9)
        let height = max(maxY - minY, 1e-9)
        let box = rect.insetBy(dx: padding, dy: padding)
        let scale = min(box.width / width, box.height / height)
        let offsetX = box.midX - (minX + width / 2) * scale
        let offsetY = box.midY - (minY + height / 2) * scale
        return raw.map { CGPoint(x: $0.x * scale + offsetX, y: $0.y * scale + offsetY) }
    }

    /// A smooth path through the points (at most `maxPoints`, evenly picked).
    static func path(_ points: [CGPoint], maxPoints: Int = 400) -> Path {
        var path = Path()
        let shown = thinned(points, maxPoints: maxPoints)
        guard let first = shown.first else { return path }
        path.move(to: first)
        for point in shown.dropFirst() { path.addLine(to: point) }
        return path
    }

    static func thinned<T>(_ items: [T], maxPoints: Int) -> [T] {
        guard items.count > maxPoints, maxPoints >= 2 else { return items }
        let step = Double(items.count - 1) / Double(maxPoints - 1)
        return (0..<maxPoints).map { items[min(items.count - 1, Int((Double($0) * step).rounded()))] }
    }
}

// MARK: - Map picture

enum ShareMapRenderer {
    /// Dark map of the run with the conquered territory in the owner's colour and the route on top.
    /// `size` in points; the route sits in the upper part, leaving room for the stats at the bottom.
    static func render(_ run: ShareRun, size: CGSize, scale: CGFloat, bottomInset: CGFloat = 0.32) async -> UIImage? {
        guard let snapshot = await snapshot(run, size: size, scale: scale, bottomInset: bottomInset) else { return nil }
        let format = UIGraphicsImageRendererFormat()
        format.scale = scale
        return UIGraphicsImageRenderer(size: size, format: format).image { context in
            snapshot.image.draw(at: .zero)
            draw(run, on: context.cgContext, project: { snapshot.point(for: $0) }, progress: 1, territoryAlpha: 1, lineScale: 1)
        }
    }

    /// The map alone (no route drawn), framed like `render`.
    static func snapshot(_ run: ShareRun, size: CGSize, scale: CGFloat, bottomInset: CGFloat) async -> MKMapSnapshotter.Snapshot? {
        guard run.coordinates.count >= 2 else { return nil }
        let options = MKMapSnapshotter.Options()
        options.region = region(for: run.coordinates, size: size, bottomInset: bottomInset)
        options.size = size
        options.scale = scale
        options.traitCollection = UITraitCollection(userInterfaceStyle: .dark)
        options.pointOfInterestFilter = .excludingAll
        return await withCheckedContinuation { continuation in
            MKMapSnapshotter(options: options).start { snapshot, _ in
                continuation.resume(returning: snapshot)
            }
        }
    }

    /// Region with the route in the upper part of a `size` frame.
    static func region(for coordinates: [CLLocationCoordinate2D], size: CGSize, bottomInset: CGFloat) -> MKCoordinateRegion {
        let lats = coordinates.map(\.latitude), lngs = coordinates.map(\.longitude)
        let minLat = lats.min() ?? 0, maxLat = lats.max() ?? 0
        let minLng = lngs.min() ?? 0, maxLng = lngs.max() ?? 0
        let cosLat = max(0.2, cos((minLat + maxLat) / 2 * .pi / 180))
        // Route box in "screen" units (degrees of latitude), with a margin
        var spanLat = max(maxLat - minLat, 0.002) * 1.35
        var spanLngEq = max((maxLng - minLng) * cosLat, 0.002) * 1.35
        let usableHeight = 1 - bottomInset
        let aspect = size.width / (size.height * usableHeight)
        if spanLngEq / spanLat > aspect { spanLat = spanLngEq / aspect } else { spanLngEq = spanLat * aspect }
        let fullSpanLat = spanLat / usableHeight
        // Shift the centre down so the route sits in the upper part
        let centerLat = (minLat + maxLat) / 2 - (fullSpanLat - spanLat) / 2
        return MKCoordinateRegion(
            center: CLLocationCoordinate2D(latitude: centerLat, longitude: (minLng + maxLng) / 2),
            span: MKCoordinateSpan(latitudeDelta: fullSpanLat, longitudeDelta: spanLngEq / cosLat)
        )
    }

    /// Territory (faded in with `territoryAlpha`) and the route up to `progress` with a soft glow.
    static func draw(_ run: ShareRun, on cg: CGContext, project: (CLLocationCoordinate2D) -> CGPoint,
                     progress: Double, territoryAlpha: CGFloat, lineScale: CGFloat) {
        let color = run.uiColor
        cg.saveGState()
        cg.setLineJoin(.round)
        cg.setLineCap(.round)
        if territoryAlpha > 0 {
            let territory = CGMutablePath()
            for ring in run.conqueredRings where ring.count >= 3 {
                territory.move(to: project(ring[0]))
                for point in ring.dropFirst() { territory.addLine(to: project(point)) }
                territory.closeSubpath()
            }
            cg.addPath(territory)
            cg.setFillColor(color.withAlphaComponent(0.32 * territoryAlpha).cgColor)
            cg.fillPath(using: .evenOdd)
            cg.addPath(territory)
            cg.setStrokeColor(color.withAlphaComponent(territoryAlpha).cgColor)
            cg.setLineWidth(2 * lineScale)
            cg.strokePath()
        }
        let points = ShareGeometry.thinned(run.coordinates, maxPoints: 800).map(project)
        let shown = prefix(points, progress: progress)
        if shown.count >= 2 {
            let line = CGMutablePath()
            line.addLines(between: shown)
            // Glow, white casing, colour
            for (width, stroke) in [(16.0, color.withAlphaComponent(0.25)), (8.0, UIColor.white.withAlphaComponent(0.95)), (5.0, color)] {
                cg.addPath(line)
                cg.setStrokeColor(stroke.cgColor)
                cg.setLineWidth(CGFloat(width) * lineScale)
                cg.strokePath()
            }
        }
        cg.restoreGState()
    }

    /// The first `progress` of a polyline, ending at an interpolated point.
    static func prefix(_ points: [CGPoint], progress: Double) -> [CGPoint] {
        guard points.count >= 2 else { return points }
        let clamped = min(max(progress, 0), 1)
        let position = clamped * Double(points.count - 1)
        let index = Int(position)
        var result = Array(points.prefix(index + 1))
        if index < points.count - 1 {
            let t = CGFloat(position - Double(index))
            let a = points[index], b = points[index + 1]
            result.append(CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t))
        }
        return result
    }
}
