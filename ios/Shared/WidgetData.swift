import CoreLocation
import Foundation
import ImageIO
import MapKit
import SwiftUI
import UIKit

// Data of the home / lock screen widgets: GET /api/widget/summary with the session the app shares
// (WidgetSnapshotStore.loadCredentials), cached on disk so the widgets still draw offline, plus the
// friends' pictures, a map image of your territory and the name of its city. In Shared: the app draws
// the widgets too (DEBUG widget gallery).

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
    /// Parts of the widget covered by text, as fractions of its size: the territory is framed in the rest.
    struct Insets {
        var top: Double = 0.12
        var left: Double = 0.06
        var bottom: Double = 0.12
        var right: Double = 0.06
    }

    /// Your territory on a dark, muted map: zones in your colour, zones wearing away dashed, zones at risk
    /// dotted and a badge on every castle zone. The server sends the place where you run the most (not
    /// every city you ran in); `focus` zooms on a point instead (the zone to defend).
    static func render(_ summary: WidgetSummary, size: CGSize, focus: CLLocationCoordinate2D? = nil, focusMeters: Double = 900, insets: Insets = Insets()) async -> UIImage? {
        guard size.width > 10, size.height > 10 else { return nil }
        let region: MKCoordinateRegion
        if let focus {
            region = MKCoordinateRegion(center: focus, latitudinalMeters: focusMeters, longitudinalMeters: focusMeters * Double(size.width / size.height))
        } else if let box = summary.map.bbox, box.count == 4 {
            region = Self.region(for: box, size: size, insets: insets)
        } else {
            return nil
        }

        let options = MKMapSnapshotter.Options()
        options.region = region
        options.size = size
        options.scale = 2
        options.traitCollection = UITraitCollection(userInterfaceStyle: .dark)
        // Muted colours and no places or traffic: the territory is what stands out
        let configuration = MKStandardMapConfiguration(elevationStyle: .flat, emphasisStyle: .muted)
        configuration.pointOfInterestFilter = .excludingAll
        configuration.showsTraffic = false
        options.preferredConfiguration = configuration

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
            // A darker map: its street and city names step back and the territory stands out
            UIColor.black.withAlphaComponent(0.2).setFill()
            cg.fill(CGRect(origin: .zero, size: size))

            func path(_ shape: WidgetSummary.Shape?) -> UIBezierPath? {
                guard let shape else { return nil }
                let bezier = UIBezierPath()
                for ring in shape.rings where ring.count >= 3 {
                    bezier.move(to: snapshot.point(for: ring[0]))
                    for point in ring.dropFirst() { bezier.addLine(to: snapshot.point(for: point)) }
                    bezier.close()
                }
                bezier.usesEvenOddFillRule = true
                bezier.lineJoinStyle = .round
                bezier.lineCapStyle = .round
                return bezier
            }

            if let territory = path(summary.map.territory) {
                // Soft glow in your colour around the fill
                cg.saveGState()
                cg.setShadow(offset: .zero, blur: 12, color: color.withAlphaComponent(0.75).cgColor)
                color.withAlphaComponent(0.36).setFill()
                territory.fill()
                cg.restoreGState()
                // Dark halo under the border so it reads on any street
                UIColor.black.withAlphaComponent(0.45).setStroke()
                territory.lineWidth = 4.5
                territory.stroke()
                color.setStroke()
                territory.lineWidth = 2.2
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
                atRisk.setLineDash([0.1, 5], count: 2, phase: 0)
                atRisk.stroke()
            }

            // Castles: the emoji on a dark round badge with a ring in your colour
            let attributes: [NSAttributedString.Key: Any] = [.font: UIFont.systemFont(ofSize: 11)]
            let badge: CGFloat = 20
            for castle in summary.map.castles {
                let point = snapshot.point(for: CLLocationCoordinate2D(latitude: castle.lat, longitude: castle.lng))
                guard CGRect(origin: .zero, size: size).insetBy(dx: -10, dy: -10).contains(point) else { continue }
                let circle = UIBezierPath(ovalIn: CGRect(x: point.x - badge / 2, y: point.y - badge / 2, width: badge, height: badge))
                cg.saveGState()
                cg.setShadow(offset: CGSize(width: 0, height: 1), blur: 3, color: UIColor.black.withAlphaComponent(0.6).cgColor)
                UIColor(white: 0.08, alpha: 0.85).setFill()
                circle.fill()
                cg.restoreGState()
                color.setStroke()
                circle.lineWidth = 1.5
                circle.stroke()
                let text = "🏰" as NSString
                let textSize = text.size(withAttributes: attributes)
                text.draw(at: CGPoint(x: point.x - textSize.width / 2, y: point.y - textSize.height / 2), withAttributes: attributes)
            }
        }
    }

    /// The region that shows `box` ([minLng, minLat, maxLng, maxLat]) in the part of a `size` map that the
    /// widget's text leaves free (`insets`), filling at most 85 % of it and never closer than ~700 m.
    static func region(for box: [Double], size: CGSize, insets: Insets) -> MKCoordinateRegion {
        let centerLat = (box[1] + box[3]) / 2
        let centerLng = (box[0] + box[2]) / 2
        let metersPerDegreeLat = 111_320.0
        let metersPerDegreeLng = max(1, 111_320.0 * cos(centerLat * .pi / 180))
        let boxWidth = max(0, box[2] - box[0]) * metersPerDegreeLng
        let boxHeight = max(0, box[3] - box[1]) * metersPerDegreeLat
        let freeWidth = max(0.2, 1 - insets.left - insets.right)
        let freeHeight = max(0.2, 1 - insets.top - insets.bottom)
        let aspect = Double(size.width / size.height)
        let height = min(4_000_000, max(boxHeight / (freeHeight * 0.85), boxWidth / (freeWidth * 0.85) / aspect, 700))
        let width = height * aspect
        // The centre moves so the box sits in the middle of the free part
        let shiftRight = insets.left + freeWidth / 2 - 0.5
        let shiftUp = 0.5 - (insets.top + freeHeight / 2)
        let center = CLLocationCoordinate2D(
            latitude: min(85, max(-85, centerLat - shiftUp * height / metersPerDegreeLat)),
            longitude: centerLng - shiftRight * width / metersPerDegreeLng
        )
        return MKCoordinateRegion(center: center, latitudinalMeters: height, longitudinalMeters: width)
    }
}

// MARK: - Place name

/// City of the map widget's place ("Zaragoza"), from Apple's reverse geocoding, kept on the phone: it's
/// asked once per place, and the widget shows "Mi territorio" when it can't be found out.
enum WidgetPlaceNames {
    static func name(for place: WidgetSummary.Place) async -> String? {
        let key = String(format: "widget-place-%.2f,%.2f", place.lat, place.lng)
        let defaults = UserDefaults.standard
        if let cached = defaults.string(forKey: key) { return cached.isEmpty ? nil : cached }
        guard let placemark = await reverseGeocode(CLLocation(latitude: place.lat, longitude: place.lng), timeout: 4) else {
            return nil // not cached: asked again on the next refresh
        }
        let name = placemark.locality ?? placemark.subAdministrativeArea ?? placemark.administrativeArea ?? ""
        defaults.set(name, forKey: key)
        return name.isEmpty ? nil : name
    }

    private static func reverseGeocode(_ location: CLLocation, timeout: TimeInterval) async -> CLPlacemark? {
        await withCheckedContinuation { (continuation: CheckedContinuation<CLPlacemark?, Never>) in
            let once = ResumeOnce(continuation)
            let geocoder = CLGeocoder()
            geocoder.reverseGeocodeLocation(location, preferredLocale: Locale(identifier: "es_ES")) { placemarks, _ in
                once.resume(placemarks?.first)
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + timeout) {
                geocoder.cancelGeocode()
                once.resume(nil)
            }
        }
    }

    /// Resumes the continuation the first time only (the geocoder's answer or the timeout).
    private final class ResumeOnce: @unchecked Sendable {
        private let lock = NSLock()
        private var continuation: CheckedContinuation<CLPlacemark?, Never>?

        init(_ continuation: CheckedContinuation<CLPlacemark?, Never>) {
            self.continuation = continuation
        }

        func resume(_ value: CLPlacemark?) {
            lock.lock()
            let pending = continuation
            continuation = nil
            lock.unlock()
            pending?.resume(returning: value)
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
