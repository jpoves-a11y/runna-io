import Foundation
import MapKit
import Observation
import SwiftUI

/// A territory polygon ready to draw.
struct TerritoryShape: Identifiable {
    let id: String
    let userId: String
    let ownerName: String
    let color: Color
    let isShared: Bool
    let polygon: MKPolygon
    /// Outer ring and holes, for hit-testing taps.
    let rings: [[CLLocationCoordinate2D]]
}

/// One of the user's own runs drawn as a thin line on the map.
struct RouteLine: Identifiable {
    let id: String
    let userId: String
    let color: Color
    let coordinates: [CLLocationCoordinate2D]
}

@MainActor
@Observable
final class MapModel {
    private(set) var shapes: [TerritoryShape] = []
    private(set) var players: [UserRef] = []
    private(set) var treasures: [Treasure] = []
    private(set) var fortifications: [FortificationShape] = []
    private(set) var castles: [CastleZone] = []
    private(set) var routeLines: [RouteLine] = []
    private(set) var isLoading = false
    private(set) var errorMessage: String?
    var hiddenUserIds: Set<String> = []

    /// Most recent own runs drawn on the map.
    private let maxRouteLines = 40

    var visibleShapes: [TerritoryShape] {
        hiddenUserIds.isEmpty ? shapes : shapes.filter { !hiddenUserIds.contains($0.userId) }
    }

    var visibleFortifications: [FortificationShape] {
        hiddenUserIds.isEmpty ? fortifications : fortifications.filter { !hiddenUserIds.contains($0.userId) }
    }

    var visibleCastles: [CastleZone] {
        hiddenUserIds.isEmpty ? castles : castles.filter { !hiddenUserIds.contains($0.userId) }
    }

    var visibleRouteLines: [RouteLine] {
        hiddenUserIds.isEmpty ? routeLines : routeLines.filter { !hiddenUserIds.contains($0.userId) }
    }

    /// Treasures that haven't expired yet.
    var liveTreasures: [Treasure] {
        let now = Date()
        return treasures.filter { treasure in
            guard let expires = treasure.expiresDate else { return true }
            return expires > now
        }
    }

    var visiblePlayerCount: Int {
        players.filter { !hiddenUserIds.contains($0.id) }.count
    }

    func load(user: AppUser) async {
        isLoading = true
        defer { isLoading = false }
        do {
            async let territoriesRequest: [Territory] = APIClient.shared.request("GET", "/api/territories/friends/\(user.id)")
            async let friendsRequest: [AppUser] = APIClient.shared.request("GET", "/api/friends/\(user.id)")
            let (territories, friends) = try await (territoriesRequest, friendsRequest)
            shapes = Self.makeShapes(territories)
            let me = UserRef(id: user.id, username: user.username, name: "Tú", color: user.color, avatar: user.avatar)
            players = [me] + friends.map { UserRef(id: $0.id, username: $0.username, name: $0.name, color: $0.color, avatar: $0.avatar) }
            errorMessage = nil
        } catch is CancellationError {
            return
        } catch {
            errorMessage = error.localizedDescription
        }
        await loadRoutes(user: user)
        await loadCompetition(userId: user.id)
    }

    private func loadRoutes(user: AppUser) async {
        guard let routes = try? await APIClient.shared.request("GET", "/api/routes/\(user.id)", as: [RunRoute].self) else { return }
        let color = Color(hex: user.color)
        let recent = routes
            .sorted { ($0.startDate ?? .distantPast) > ($1.startDate ?? .distantPast) }
            .prefix(maxRouteLines)
        routeLines = recent.compactMap { route -> RouteLine? in
            let coordinates = route.locations
            guard coordinates.count >= 2 else { return nil }
            return RouteLine(id: route.id, userId: user.id, color: color, coordinates: coordinates)
        }
    }

    /// Competition state, then treasures, fortifications and the powers badge while it is active.
    private func loadCompetition(userId: String) async {
        let store = CompetitionStore.shared
        await store.refresh()
        guard store.isActive else {
            treasures = []
            fortifications = []
            castles = []
            store.setAvailablePowerCount(0)
            return
        }
        await refreshCompetitionOverlays()
        await store.refreshPowers(userId: userId)
    }

    /// Treasures and fortifications (refreshed every minute while the map is visible).
    func refreshCompetitionOverlays() async {
        guard CompetitionStore.shared.isActive else { return }
        if let response = try? await APIClient.shared.request("GET", "/api/treasures/active", as: TreasuresResponse.self) {
            treasures = response.treasures
        }
        if let response = try? await APIClient.shared.request("GET", "/api/territories/fortifications", as: FortificationsResponse.self) {
            makeFortifications(response.fortifications)
        }
    }

    func toggle(_ userId: String) {
        if hiddenUserIds.contains(userId) {
            hiddenUserIds.remove(userId)
        } else {
            hiddenUserIds.insert(userId)
        }
    }

    func showAll() {
        hiddenUserIds = []
    }

    func hideAll() {
        hiddenUserIds = Set(players.map(\.id))
    }

    /// The territory under a tapped coordinate, if any (topmost first).
    func shape(at coordinate: CLLocationCoordinate2D) -> TerritoryShape? {
        visibleShapes.reversed().first { shape in
            guard let outer = shape.rings.first, Self.contains(outer, coordinate) else { return false }
            return !shape.rings.dropFirst().contains { Self.contains($0, coordinate) }
        }
    }

    /// Region that fits all visible territories.
    func boundingRegion() -> MKCoordinateRegion? {
        let points = visibleShapes.flatMap { $0.rings.first ?? [] }
        guard let minLat = points.map(\.latitude).min(), let maxLat = points.map(\.latitude).max(),
              let minLng = points.map(\.longitude).min(), let maxLng = points.map(\.longitude).max() else { return nil }
        return MKCoordinateRegion(
            center: CLLocationCoordinate2D(latitude: (minLat + maxLat) / 2, longitude: (minLng + maxLng) / 2),
            span: MKCoordinateSpan(latitudeDelta: max(0.01, (maxLat - minLat) * 1.3), longitudeDelta: max(0.01, (maxLng - minLng) * 1.3))
        )
    }

    // MARK: - Fortifications

    /// Fortified zones in the owner's colour (darker), and a castle on each zone fortified several times.
    private func makeFortifications(_ groups: [FortificationsResponse.Group]) {
        var colors: [String: Color] = [:]
        for shape in shapes where colors[shape.userId] == nil {
            colors[shape.userId] = shape.color
        }
        for player in players {
            colors[player.id] = Color(hex: player.color)
        }

        var newShapes: [FortificationShape] = []
        var newCastles: [CastleZone] = []
        for group in groups where group.layers >= 1 {
            let baseColor = colors[group.userId] ?? Color.gray
            let color = baseColor.darkened(0.35)
            let level = 1 + Double(group.layers) * 0.5

            // Zones: record centroids closer than 0.0005° are the same zone
            var zones: [(lat: Double, lng: Double, sumLat: Double, sumLng: Double, count: Int)] = []

            for (recordIndex, record) in group.records.enumerated() {
                for (polygonIndex, rings) in record.polygons.enumerated() {
                    guard let outer = rings.first else { continue }
                    let holes = rings.dropFirst().map { MKPolygon(coordinates: $0, count: $0.count) }
                    let polygon = MKPolygon(coordinates: outer, count: outer.count, interiorPolygons: holes)
                    newShapes.append(FortificationShape(
                        id: "\(group.userId)-\(recordIndex)-\(polygonIndex)",
                        userId: group.userId,
                        color: color,
                        polygon: polygon,
                        level: level
                    ))
                }

                guard group.layers >= 2, let centroid = Self.centroid(of: record.polygons) else { continue }
                if let index = zones.firstIndex(where: { abs($0.lat - centroid.latitude) < 0.0005 && abs($0.lng - centroid.longitude) < 0.0005 }) {
                    zones[index].sumLat += centroid.latitude
                    zones[index].sumLng += centroid.longitude
                    zones[index].count += 1
                } else {
                    zones.append((lat: centroid.latitude, lng: centroid.longitude, sumLat: centroid.latitude, sumLng: centroid.longitude, count: 1))
                }
            }

            for (zoneIndex, zone) in zones.enumerated() {
                let count = Double(zone.count)
                newCastles.append(CastleZone(
                    id: "\(group.userId)-castle-\(zoneIndex)",
                    userId: group.userId,
                    coordinate: CLLocationCoordinate2D(latitude: zone.sumLat / count, longitude: zone.sumLng / count),
                    level: 1 + count * 0.5,
                    color: color
                ))
            }
        }
        fortifications = newShapes
        castles = newCastles
    }

    /// Average of the outer-ring points of every polygon of a record.
    private static func centroid(of polygons: [[[CLLocationCoordinate2D]]]) -> CLLocationCoordinate2D? {
        var sumLat = 0.0
        var sumLng = 0.0
        var count = 0
        for rings in polygons {
            guard let outer = rings.first else { continue }
            for point in outer {
                sumLat += point.latitude
                sumLng += point.longitude
                count += 1
            }
        }
        guard count > 0 else { return nil }
        return CLLocationCoordinate2D(latitude: sumLat / Double(count), longitude: sumLng / Double(count))
    }

    private static func makeShapes(_ territories: [Territory]) -> [TerritoryShape] {
        var result: [TerritoryShape] = []
        for territory in territories {
            for (index, rings) in territory.polygons.enumerated() {
                guard let outer = rings.first else { continue }
                let holes = rings.dropFirst().map { MKPolygon(coordinates: $0, count: $0.count) }
                let polygon = MKPolygon(coordinates: outer, count: outer.count, interiorPolygons: holes)
                result.append(TerritoryShape(
                    id: "\(territory.id)-\(index)",
                    userId: territory.userId,
                    ownerName: territory.owner?.name ?? "",
                    color: Color(hex: territory.color),
                    isShared: !territory.coRunnerColors.isEmpty,
                    polygon: polygon,
                    rings: rings
                ))
            }
        }
        return result
    }

    /// Ray-casting point-in-polygon test.
    private static func contains(_ ring: [CLLocationCoordinate2D], _ point: CLLocationCoordinate2D) -> Bool {
        var inside = false
        var j = ring.count - 1
        for i in 0..<ring.count {
            let a = ring[i]
            let b = ring[j]
            if (a.latitude > point.latitude) != (b.latitude > point.latitude) {
                let crossing = (b.longitude - a.longitude) * (point.latitude - a.latitude) / (b.latitude - a.latitude) + a.longitude
                if point.longitude < crossing { inside.toggle() }
            }
            j = i
        }
        return inside
    }
}
