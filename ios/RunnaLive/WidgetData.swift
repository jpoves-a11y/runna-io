import Foundation
import MapKit
import SwiftUI
import UIKit

// Data of the home / lock screen widgets: GET /api/widget/summary with the session the app shares
// (WidgetSnapshotStore.loadCredentials), cached on disk so the widgets still draw offline, plus the
// friends' pictures and a map image of your territory.

// MARK: - Model

struct WidgetSummary: Codable {
    struct Me: Codable {
        let id: String
        let name: String
        let color: String
        let avatarUrl: String?
        let totalArea: Double
        let lastRunAt: String?
    }

    struct Entry: Codable, Identifiable {
        let id: String
        let name: String
        let color: String
        let avatarUrl: String?
        let area: Double
        let distance: Double
        let runs: Int
        let rank: Int
        let rankYesterday: Int?
        let isMe: Bool

        /// Positions gained since yesterday (negative: lost), nil when unknown.
        var movement: Int? { rankYesterday.map { $0 - rank } }
    }

    struct Week: Codable {
        let start: String
        let end: String
        let players: Int
        let myRank: Int?
        let myArea: Double
        let myDistance: Double
        let myRuns: Int
        let leaderArea: Double
        let entries: [Entry]
        /// Area conquered each day, Monday first.
        let days: [Double]
        let dayDistance: [Double]
    }

    struct Point: Codable {
        let lat: Double
        let lng: Double
        var coordinate: CLLocationCoordinate2D { CLLocationCoordinate2D(latitude: lat, longitude: lng) }
    }

    struct Defense: Codable {
        let castles: Int
        let castleLayers: Int
        let atRiskArea: Double
        let atRisk: Point?
        let weakArea: Double
        let lostToday: Double
        let resting: Bool
    }

    struct Castle: Codable {
        let lat: Double
        let lng: Double
        let layers: Int
    }

    struct MapData: Codable {
        let territory: Shape?
        let weak: Shape?
        let atRisk: Shape?
        let castles: [Castle]
        /// [minLng, minLat, maxLng, maxLat]
        let bbox: [Double]?
    }

    /// GeoJSON Polygon / MultiPolygon as a list of polygons (rings of [lng, lat]).
    struct Shape: Codable {
        let polygons: [[[[Double]]]]

        enum CodingKeys: String, CodingKey { case type, coordinates }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            let type = try c.decode(String.self, forKey: .type)
            if type == "Polygon" {
                polygons = [try c.decode([[[Double]]].self, forKey: .coordinates)]
            } else {
                polygons = try c.decode([[[[Double]]]].self, forKey: .coordinates)
            }
        }

        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode("MultiPolygon", forKey: .type)
            try c.encode(polygons, forKey: .coordinates)
        }

        /// Rings as map coordinates.
        var rings: [[CLLocationCoordinate2D]] {
            polygons.flatMap { $0 }.map { ring in
                ring.compactMap { $0.count >= 2 ? CLLocationCoordinate2D(latitude: $0[1], longitude: $0[0]) : nil }
            }
        }
    }

    let generatedAt: String
    let me: Me
    let week: Week
    let streakWeeks: Int
    let defense: Defense
    let map: MapData
}

extension WidgetSummary {
    var lastRunDate: Date? { me.lastRunAt.flatMap(WidgetDates.parse) }
    var weekEndDate: Date? { WidgetDates.parse(week.end) }
    var myEntry: Entry? { week.entries.first { $0.isMe } }
    var leader: Entry? { week.entries.first }

    /// Days left until the week ends (Monday 00:00).
    func daysLeft(at date: Date) -> Int {
        guard let end = weekEndDate else { return 0 }
        return max(0, Int(ceil(end.timeIntervalSince(date) / 86_400)))
    }

    /// Whole days since your last run (nil when you never ran).
    func daysSinceRun(at date: Date) -> Int? {
        guard let last = lastRunDate else { return nil }
        let calendar = Calendar.current
        return calendar.dateComponents([.day], from: calendar.startOfDay(for: last), to: calendar.startOfDay(for: date)).day
    }
}

enum WidgetDates {
    private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let plain = ISO8601DateFormatter()

    static func parse(_ text: String) -> Date? {
        fractional.date(from: text) ?? plain.date(from: text)
    }
}

// MARK: - Loading

enum WidgetDataLoader {
    /// Several widgets refresh together: within this time the cached answer is used.
    private static let freshFor: TimeInterval = 10 * 60

    private static func cacheURL(userId: String) -> URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("widget-summary-\(userId).json")
    }

    /// The latest summary: from the server when the cache is old, else the cache. Nil when logged out.
    static func load() async -> WidgetSummary? {
        guard let credentials = WidgetSnapshotStore.loadCredentials() else { return nil }
        let url = cacheURL(userId: credentials.userId)
        let cached = (try? Data(contentsOf: url)).flatMap { try? JSONDecoder().decode(WidgetSummary.self, from: $0) }
        if let cached, let generated = WidgetDates.parse(cached.generatedAt), Date().timeIntervalSince(generated) < freshFor {
            return cached
        }
        guard let data = await fetch(credentials) else { return cached }
        guard let fresh = try? JSONDecoder().decode(WidgetSummary.self, from: data) else { return cached }
        try? data.write(to: url, options: .atomic)
        return fresh
    }

    private static func fetch(_ credentials: WidgetCredentials) async -> Data? {
        guard let base = URL(string: credentials.baseURL) else { return nil }
        var request = URLRequest(url: base.appendingPathComponent("api/widget/summary"))
        request.timeoutInterval = 15
        request.setValue("Bearer \(credentials.token)", forHTTPHeaderField: "Authorization")
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse, http.statusCode == 200 else { return nil }
        return data
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

    private static func image(_ url: String) async -> UIImage? {
        let file = fileURL(for: url)
        if let data = try? Data(contentsOf: file), let image = UIImage(data: data) { return image }
        guard let remote = URL(string: url) else { return nil }
        var request = URLRequest(url: remote)
        request.timeoutInterval = 8
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let picture = UIImage(data: data) else { return nil }
        let small = squared(picture)
        if let jpeg = small.jpegData(compressionQuality: 0.8) { try? jpeg.write(to: file, options: .atomic) }
        return small
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

extension UIColor {
    /// "#RRGGBB" → colour, nil when unreadable.
    convenience init?(widgetHex hex: String) {
        let digits = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        guard digits.count == 6, let value = UInt32(digits, radix: 16) else { return nil }
        self.init(
            red: CGFloat((value >> 16) & 0xFF) / 255,
            green: CGFloat((value >> 8) & 0xFF) / 255,
            blue: CGFloat(value & 0xFF) / 255,
            alpha: 1
        )
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
