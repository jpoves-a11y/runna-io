import Foundation

/// GET /api/widget/details: what the map and podium widgets draw.
struct WidgetDetails: Codable, Equatable {
    /// A polygon: outer ring first, then holes; points are [lng, lat].
    typealias Polygon = [[[Double]]]

    struct Bounds: Codable, Equatable {
        let minLng: Double
        let minLat: Double
        let maxLng: Double
        let maxLat: Double
    }

    struct Neighbour: Codable, Equatable {
        let color: String?
        let polygons: [Polygon]
    }

    struct MapData: Codable, Equatable {
        let color: String?
        let area: Double
        let polygons: [Polygon]
        let others: [Neighbour]
        let bounds: Bounds
    }

    struct Place: Codable, Equatable {
        let name: String
        let color: String?
        let score: Double
        let rank: Int
        let me: Bool
    }

    struct Ahead: Codable, Equatable {
        let name: String
        let gap: Double
    }

    struct Standing: Codable, Equatable {
        let rank: Int
        let score: Double
        let color: String?
        let ahead: Ahead?
    }

    struct Podium: Codable, Equatable {
        let mode: String
        let modeName: String
        let participants: Int
        let endsAt: String?
        let top: [Place]
        let me: Standing?
    }

    let map: MapData?
    let podium: Podium?
    let phase: String
    let nextChangeAt: String?

    static func fetch() async throws -> WidgetDetails? {
        guard let session = SharedSession.load(),
              let url = URL(string: session.apiBaseURL)?.appendingPathComponent("api/widget/details") else { return nil }
        var request = URLRequest(url: url)
        request.timeoutInterval = 20
        request.setValue("Bearer \(session.token)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { return nil }
        if http.statusCode == 401 { return nil }
        guard (200..<300).contains(http.statusCode) else { throw URLError(.badServerResponse) }
        return try JSONDecoder().decode(WidgetDetails.self, from: data)
    }

    /// For the widget gallery and placeholders: a territory around Zaragoza, a podium in play.
    static let placeholder: WidgetDetails = {
        func blob(_ cx: Double, _ cy: Double, _ r: Double, _ seed: Double) -> Polygon {
            var ring: [[Double]] = []
            for i in 0..<48 {
                let a = 2 * Double.pi * Double(i) / 48
                let wobble = 1 + 0.22 * sin(a * 3 + seed) + 0.12 * sin(a * 7 + seed * 2)
                ring.append([cx + r * wobble * cos(a) * 1.35, cy + r * wobble * sin(a)])
            }
            ring.append(ring[0])
            return [ring]
        }
        let mine = [blob(-0.885, 41.652, 0.012, 0.4), blob(-0.862, 41.66, 0.006, 2.1)]
        let others = [
            Neighbour(color: "#3D7BFF", polygons: [blob(-0.9, 41.642, 0.009, 1.3)]),
            Neighbour(color: "#FF5A36", polygons: [blob(-0.868, 41.643, 0.007, 3.3)])
        ]
        let end = ISO8601DateFormatter().string(from: Date().addingTimeInterval(3 * 86_400 + 5 * 3600))
        return WidgetDetails(
            map: MapData(color: "#00FF1E", area: 1_250_000, polygons: mine, others: others,
                         bounds: Bounds(minLng: -0.91, minLat: 41.635, maxLng: -0.85, maxLat: 41.672)),
            podium: Podium(
                mode: "ffa", modeName: "Todos contra todos", participants: 23, endsAt: end,
                top: [
                    Place(name: "Marta", color: "#FF5A36", score: 2_140_000, rank: 1, me: false),
                    Place(name: "Dani", color: "#3D7BFF", score: 1_870_000, rank: 2, me: false),
                    Place(name: "Lucía", color: "#F5C400", score: 1_420_000, rank: 3, me: false)
                ],
                me: Standing(rank: 5, score: 1_250_000, color: "#00FF1E", ahead: Ahead(name: "Iván", gap: 90_000))
            ),
            phase: "competition",
            nextChangeAt: end
        )
    }()
}

/// What every KM2 widget reads: the summary and the details (last ones kept for when offline).
enum WidgetStore {
    private static let summaryKey = "widget.summary"
    private static let detailsKey = "widget.details"

    struct Snapshot {
        let summary: WidgetSummary?
        let details: WidgetDetails?
        let signedOut: Bool
    }

    static func load() async -> Snapshot {
        guard SharedSession.load() != nil else { return Snapshot(summary: nil, details: nil, signedOut: true) }
        async let summaryResult = fetchSummary()
        async let detailsResult = fetchDetails()
        let summary = await summaryResult
        let details = await detailsResult
        return Snapshot(summary: summary, details: details, signedOut: summary == nil && details == nil)
    }

    static func cached() -> Snapshot {
        Snapshot(summary: decode(summaryKey), details: decode(detailsKey), signedOut: false)
    }

    private static func fetchSummary() async -> WidgetSummary? {
        do {
            let value = try await WidgetSummary.fetch()
            if let value { store(value, summaryKey) }
            return value
        } catch {
            return decode(summaryKey)
        }
    }

    private static func fetchDetails() async -> WidgetDetails? {
        do {
            let value = try await WidgetDetails.fetch()
            if let value { store(value, detailsKey) }
            return value
        } catch {
            return decode(detailsKey)
        }
    }

    private static func decode<T: Decodable>(_ key: String) -> T? {
        guard let data = UserDefaults.standard.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }

    private static func store<T: Encodable>(_ value: T, _ key: String) {
        if let data = try? JSONEncoder().encode(value) { UserDefaults.standard.set(data, forKey: key) }
    }
}
