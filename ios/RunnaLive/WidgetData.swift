import Foundation
import ImageIO
import MapKit
import SwiftUI
import UIKit

// Data of the home / lock screen widgets: GET /api/widget/summary with the session the app shares
// (WidgetSnapshotStore.loadCredentials), cached on disk so the widgets still draw offline, plus the
// friends' pictures and a map image of your territory.

// MARK: - Loading

enum WidgetDataLoader {
    /// Several widgets refresh together: within this time the cached answer is used.
    private static let freshFor: TimeInterval = 10 * 60
    /// The same while the server is still working out the map (it's asked again sooner).
    private static let pendingFreshFor: TimeInterval = 3 * 60

    private static func cacheURL(userId: String) -> URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("widget-summary-\(userId).json")
    }

    enum Outcome {
        case loaded(WidgetSummary)
        /// No session shared by the app (logged out, or the shared keychain failed: `reason`).
        case noSession(reason: String?)
        /// The server couldn't be reached or answered an error, and there's nothing cached.
        case failed(reason: String)

        var summary: WidgetSummary? {
            if case .loaded(let summary) = self { return summary }
            return nil
        }
    }

    /// The latest summary: from the server when the cache is old, else the cache. The widgets refresh
    /// together: they share one request instead of asking the server four times at once.
    static func load() async -> Outcome {
        await inflight.run { await loadNow() }
    }

    private static let inflight = Inflight()

    private actor Inflight {
        private var task: Task<Outcome, Never>?

        func run(_ work: @escaping @Sendable () async -> Outcome) async -> Outcome {
            if let task { return await task.value }
            let task = Task { await work() }
            self.task = task
            let outcome = await task.value
            self.task = nil
            return outcome
        }
    }

    private static func loadNow() async -> Outcome {
        guard let credentials = WidgetSnapshotStore.loadCredentials() else {
            return .noSession(reason: WidgetSnapshotStore.problem)
        }
        let url = cacheURL(userId: credentials.userId)
        let cached = (try? Data(contentsOf: url)).flatMap { try? JSONDecoder().decode(WidgetSummary.self, from: $0) }
        if let cached, let generated = WidgetDates.parse(cached.generatedAt),
           Date().timeIntervalSince(generated) < (cached.mapPending == true ? pendingFreshFor : freshFor) {
            return .loaded(cached)
        }
        // A busy server (503) or a dropped connection: try again twice before giving up
        var result = await fetch(credentials)
        for delay in [2.0, 6.0] {
            guard case .failure(.failed) = result else { break }
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            result = await fetch(credentials)
        }
        switch result {
        case .success(let data):
            do {
                let fresh = try JSONDecoder().decode(WidgetSummary.self, from: data)
                try? data.write(to: url, options: .atomic)
                return .loaded(fresh)
            } catch {
                return cached.map { Outcome.loaded($0) } ?? .failed(reason: "datos no válidos (\(error.localizedDescription))")
            }
        case .failure(let reason):
            return cached.map { Outcome.loaded($0) } ?? reason
        }
    }

    private enum Fetch { case success(Data), failure(Outcome) }

    private static func fetch(_ credentials: WidgetCredentials) async -> Fetch {
        guard let base = URL(string: credentials.baseURL) else { return .failure(.failed(reason: "dirección del servidor no válida")) }
        var request = URLRequest(url: base.appendingPathComponent("api/widget/summary"))
        request.timeoutInterval = 15
        request.setValue("Bearer \(credentials.token)", forHTTPHeaderField: "Authorization")
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            switch status {
            case 200: return .success(data)
            case 401, 403: return .failure(.noSession(reason: "la sesión ha caducado"))
            default: return .failure(.failed(reason: "el servidor respondió \(status)"))
            }
        } catch {
            return .failure(.failed(reason: "sin conexión"))
        }
    }
}

// MARK: - Pictures

enum WidgetAvatars {
    private static let side: CGFloat = 96

    private static func fileURL(for url: String) -> URL {
        let name = url.data(using: .utf8)!.base64EncodedString()
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "+", with: "-")
            .suffix(80)
        return FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("avatar-\(name).jpg")
    }

    /// Pictures of these entries by user id (from the disk cache, else downloaded and shrunk).
    static func load(_ entries: [(id: String, url: String?)]) async -> [String: UIImage] {
        var result: [String: UIImage] = [:]
        await withTaskGroup(of: (String, UIImage?).self) { group in
            for entry in entries {
                guard let url = entry.url else { continue }
                group.addTask { (entry.id, await Self.image(url)) }
            }
            for await (id, image) in group {
                if let image { result[id] = image }
            }
        }
        return result
    }

    /// Pictures bigger than this aren't used (the server doesn't offer them either).
    private static let maxBytes = 4_000_000

    private static func image(_ url: String) async -> UIImage? {
        let file = fileURL(for: url)
        if let data = try? Data(contentsOf: file), let image = UIImage(data: data) { return image }
        guard let remote = URL(string: url) else { return nil }
        var request = URLRequest(url: remote)
        request.timeoutInterval = 6
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              data.count <= maxBytes,
              let picture = thumbnail(data) else { return nil }
        let small = squared(picture)
        if let jpeg = small.jpegData(compressionQuality: 0.8) { try? jpeg.write(to: file, options: .atomic) }
        return small
    }

    /// Decoded straight at widget size: decoding a big photo at full size (then shrinking it) went over
    /// the memory a widget is allowed, and iOS stopped the widget.
    private static func thumbnail(_ data: Data) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
        let width = (properties?[kCGImagePropertyPixelWidth] as? NSNumber)?.doubleValue ?? 0
        let height = (properties?[kCGImagePropertyPixelHeight] as? NSNumber)?.doubleValue ?? 0
        // The shorter side at least `side` once shrunk: the square crop fills it
        let ratio = min(width, height) > 0 ? max(width, height) / min(width, height) : 1
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: Int((side * min(ratio, 4)).rounded(.up)),
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return UIImage(cgImage: image)
    }

    private static func squared(_ image: UIImage) -> UIImage {
        let crop = min(image.size.width, image.size.height)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: format).image { _ in
            let scale = side / max(crop, 1)
            let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
            image.draw(in: CGRect(x: (side - size.width) / 2, y: (side - size.height) / 2, width: size.width, height: size.height))
        }
    }
}

// MARK: - Map image

enum WidgetMapRenderer {
    /// Your territory on a dark map: zones in your colour, zones wearing away dashed, zones at risk
    /// dotted and a 🏰 on every castle zone. `focus` zooms on a point (the zone to defend).
    static func render(_ summary: WidgetSummary, size: CGSize, focus: CLLocationCoordinate2D? = nil, focusMeters: Double = 900) async -> UIImage? {
        guard size.width > 10, size.height > 10 else { return nil }
        let region: MKCoordinateRegion
        if let focus {
            region = MKCoordinateRegion(center: focus, latitudinalMeters: focusMeters, longitudinalMeters: focusMeters * Double(size.width / size.height))
        } else if let box = summary.map.bbox, box.count == 4 {
            let center = CLLocationCoordinate2D(latitude: (box[1] + box[3]) / 2, longitude: (box[0] + box[2]) / 2)
            region = MKCoordinateRegion(
                center: center,
                span: MKCoordinateSpan(latitudeDelta: max(0.004, (box[3] - box[1]) * 1.35), longitudeDelta: max(0.004, (box[2] - box[0]) * 1.35))
            )
        } else {
            return nil
        }

        let options = MKMapSnapshotter.Options()
        options.region = region
        options.size = size
        options.scale = 2
        options.traitCollection = UITraitCollection(userInterfaceStyle: .dark)
        options.pointOfInterestFilter = .excludingAll
        options.showsBuildings = false

        let snapshot: MKMapSnapshotter.Snapshot? = await withCheckedContinuation { continuation in
            MKMapSnapshotter(options: options).start { snapshot, _ in
                continuation.resume(returning: snapshot)
            }
        }
        guard let snapshot else { return nil }

        let color = UIColor(widgetHex: summary.me.color) ?? .systemGreen
        let format = UIGraphicsImageRendererFormat()
        format.scale = 2
        return UIGraphicsImageRenderer(size: size, format: format).image { context in
            snapshot.image.draw(at: .zero)
            let cg = context.cgContext
            cg.setLineJoin(.round)
            cg.setLineCap(.round)

            func path(_ shape: WidgetSummary.Shape?) -> UIBezierPath? {
                guard let shape else { return nil }
                let bezier = UIBezierPath()
                for ring in shape.rings where ring.count >= 3 {
                    bezier.move(to: snapshot.point(for: ring[0]))
                    for point in ring.dropFirst() { bezier.addLine(to: snapshot.point(for: point)) }
                    bezier.close()
                }
                bezier.usesEvenOddFillRule = true
                return bezier
            }

            if let territory = path(summary.map.territory) {
                color.withAlphaComponent(0.38).setFill()
                territory.fill()
                color.setStroke()
                territory.lineWidth = 2
                territory.lineJoinStyle = .round
                territory.stroke()
            }
            if let weak = path(summary.map.weak) {
                UIColor.black.withAlphaComponent(0.35).setFill()
                weak.fill()
                UIColor.systemOrange.setStroke()
                weak.lineWidth = 2
                weak.setLineDash([6, 4], count: 2, phase: 0)
                weak.stroke()
            }
            if let atRisk = path(summary.map.atRisk) {
                UIColor.systemOrange.setStroke()
                atRisk.lineWidth = 2.2
                atRisk.lineCapStyle = .round
                atRisk.setLineDash([0.1, 5], count: 2, phase: 0)
                atRisk.stroke()
            }
            let attributes: [NSAttributedString.Key: Any] = [.font: UIFont.systemFont(ofSize: 13)]
            for castle in summary.map.castles {
                let point = snapshot.point(for: CLLocationCoordinate2D(latitude: castle.lat, longitude: castle.lng))
                guard CGRect(origin: .zero, size: size).insetBy(dx: -10, dy: -10).contains(point) else { continue }
                let text = "🏰" as NSString
                let textSize = text.size(withAttributes: attributes)
                text.draw(at: CGPoint(x: point.x - textSize.width / 2, y: point.y - textSize.height / 2), withAttributes: attributes)
            }
        }
    }
}

// MARK: - Sample (widget gallery and placeholders)

extension WidgetSummary {
    static let sample: WidgetSummary = {
        func entry(_ id: String, _ name: String, _ color: String, _ area: Double, _ rank: Int, _ yesterday: Int?, me: Bool = false) -> Entry {
            Entry(id: id, name: name, color: color, avatarUrl: nil, area: area, distance: area / 20, runs: 3, rank: rank, rankYesterday: yesterday, isMe: me)
        }
        let now = Date()
        let iso = ISO8601DateFormatter()
        return WidgetSummary(
            generatedAt: iso.string(from: now),
            me: Me(id: "me", name: "Tú", color: "#16A34A", avatarUrl: nil, totalArea: 1_240_000, lastRunAt: iso.string(from: now.addingTimeInterval(-86_400))),
            week: Week(
                start: iso.string(from: now.addingTimeInterval(-3 * 86_400)),
                end: iso.string(from: now.addingTimeInterval(4 * 86_400)),
                players: 6, myRank: 2, myArea: 310_000, myDistance: 21_400, myRuns: 3, leaderArea: 420_000,
                entries: [
                    entry("a", "Ana", "#E11D48", 420_000, 1, 2),
                    entry("me", "Tú", "#16A34A", 310_000, 2, 1, me: true),
                    entry("m", "Miguel", "#2563EB", 180_000, 3, 3),
                    entry("p", "Pablo", "#F59E0B", 90_000, 4, 5),
                    entry("l", "Laura", "#9333EA", 40_000, 5, 4),
                    entry("j", "Juan", "#0EA5E9", 8_000, 6, nil),
                ],
                days: [0, 120_000, 0, 190_000, 0, 0, 0],
                dayDistance: [0, 8_000, 0, 13_400, 0, 0, 0]
            ),
            streakWeeks: 4,
            defense: Defense(castles: 2, castleLayers: 3, atRiskArea: 120_000, atRisk: nil, weakArea: 0, lostToday: 0, resting: false),
            map: MapData(territory: nil, weak: nil, atRisk: nil, castles: [], bbox: nil)
        )
    }()
}
