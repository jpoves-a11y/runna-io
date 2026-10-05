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

@MainActor
@Observable
final class MapModel {
    private(set) var shapes: [TerritoryShape] = []
    private(set) var players: [UserRef] = []
    private(set) var treasures: [Treasure] = []
    private(set) var competitionName: String?
    private(set) var isLoading = false
    private(set) var errorMessage: String?
    var hiddenUserIds: Set<String> = []

    var visibleShapes: [TerritoryShape] {
        hiddenUserIds.isEmpty ? shapes : shapes.filter { !hiddenUserIds.contains($0.userId) }
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
        await loadCompetition()
    }

    private func loadCompetition() async {
        guard let info: CompetitionInfo = try? await APIClient.shared.request("GET", "/api/competition/active"),
              info.status == "active" else {
            competitionName = nil
            treasures = []
            return
        }
        competitionName = info.competition?.name
        if let response: TreasuresResponse = try? await APIClient.shared.request("GET", "/api/treasures/active") {
            treasures = response.treasures
        }
    }

    func toggle(_ userId: String) {
        if hiddenUserIds.contains(userId) {
            hiddenUserIds.remove(userId)
        } else {
            hiddenUserIds.insert(userId)
        }
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
