import CoreLocation
import MapKit
import SwiftUI
@testable import Runna

/// Synthetic tracks around a point in Zaragoza (metres east / north of the origin).
enum TestTracks {
    static let origin = CLLocationCoordinate2D(latitude: 41.65, longitude: -0.89)
    private static let metersPerDegreeLat = 111_000.0
    private static var metersPerDegreeLng: Double { 111_000 * cos(origin.latitude * .pi / 180) }

    static func point(east: Double, north: Double) -> CLLocationCoordinate2D {
        CLLocationCoordinate2D(
            latitude: origin.latitude + north / metersPerDegreeLat,
            longitude: origin.longitude + east / metersPerDegreeLng
        )
    }

    /// Square path of `side` metres (south-west corner at east/north), a point every `step` metres.
    static func square(east: Double = 0, north: Double = 0, side: Double, step: Double = 10) -> [CLLocationCoordinate2D] {
        let corners: [(Double, Double)] = [(0, 0), (side, 0), (side, side), (0, side), (0, 0)]
        var points: [CLLocationCoordinate2D] = []
        for c in 0..<4 {
            let (x1, y1) = corners[c]
            let (x2, y2) = corners[c + 1]
            let n = Int((side / step).rounded())
            for i in 0..<n {
                let t = Double(i) / Double(n)
                points.append(point(east: east + x1 + (x2 - x1) * t, north: north + y1 + (y2 - y1) * t))
            }
        }
        return points
    }

    /// A territory (closed rectangle) owned by `userId`.
    static func territory(userId: String, name: String, east: Double, north: Double, width: Double, height: Double) -> TerritoryShape {
        var ring = [
            point(east: east, north: north),
            point(east: east + width, north: north),
            point(east: east + width, north: north + height),
            point(east: east, north: north + height),
        ]
        ring.append(ring[0])
        return TerritoryShape(
            id: "\(userId)-\(east)-\(north)",
            territoryId: "\(userId)-\(east)-\(north)",
            userId: userId,
            ownerName: name,
            color: .red,
            colorHex: "#FF0000",
            mutedColor: .gray,
            isShared: false,
            polygon: MKPolygon(coordinates: ring, count: ring.count),
            rings: [ring],
            routeId: nil,
            conqueredAt: nil
        )
    }
}
