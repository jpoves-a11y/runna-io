import Foundation
import CoreLocation
import UIKit

// GET /api/widget/summary: what the widgets show (and the run share cards use: your place in the
// week's league). Compiled into the app and the RunnaLive extension.

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

