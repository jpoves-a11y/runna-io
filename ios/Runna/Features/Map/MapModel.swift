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
    /// Someone else's global map shown for information (lighter, not tappable as a rival).
    var isOverlay: Bool = false
}

/// One of the user's own runs drawn as a thin line on the map.
struct RouteLine: Identifiable {
    let id: String
    let userId: String
    let color: Color
    let coordinates: [CLLocationCoordinate2D]
}

/// The two maps of the app: the user's world map (Global) and the running club competition.
enum MapMode: String, CaseIterable, Identifiable {
    case global, competition
    var id: String { rawValue }

    var title: String {
        switch self {
        case .global: return "Global"
        case .competition: return "Competición"
        }
    }
}

/// Whose global maps are drawn over mine, for information only.
enum GlobalOverlay: String, CaseIterable, Identifiable {
    case onlyMe, friends, club, all
    var id: String { rawValue }

    var title: String {
        switch self {
        case .onlyMe: return "Solo yo"
        case .friends: return "Amigos"
        case .club: return "Mi club"
        case .all: return "Amigos y club"
        }
    }

    /// `include` query of GET /api/global/territories
    var include: String {
        switch self {
        case .onlyMe: return "none"
        case .friends: return "friends"
        case .club: return "club"
        case .all: return "friends,club"
        }
    }
}

@MainActor
@Observable
final class MapModel {
    private(set) var globalShapes: [TerritoryShape] = []
    private(set) var competitionShapes: [TerritoryShape] = []
    private(set) var chests: [Chest] = []
    private(set) var fortifications: [FortificationShape] = []
    private(set) var castles: [CastleZone] = []
    private(set) var routeLines: [RouteLine] = []
    private(set) var isLoading = false
    private(set) var errorMessage: String?
    /// The competition map has data to show (I take part in a running competition).
    private(set) var hasCompetitionMap = false

    /// Saved by the map screen (UserDefaults "map_mode" / "map_global_overlay").
    var mode: MapMode = MapMode(rawValue: UserDefaults.standard.string(forKey: "map_mode") ?? "") ?? .global
    var overlay: GlobalOverlay = GlobalOverlay(rawValue: UserDefaults.standard.string(forKey: "map_global_overlay") ?? "") ?? .onlyMe

    /// Most recent own runs drawn on the map.
    private let maxRouteLines = 40

    /// What the map draws in the current mode.
    var visibleShapes: [TerritoryShape] {
        mode == .global ? globalShapes : competitionShapes
    }

    var visibleFortifications: [FortificationShape] { mode == .competition ? fortifications : [] }
    var visibleCastles: [CastleZone] { mode == .competition ? castles : [] }
    var visibleRouteLines: [RouteLine] { routeLines }

    /// Chests that haven't expired yet (competition map only).
    var liveChests: [Chest] {
        guard mode == .competition else { return [] }
        let now = Date()
        return chests.filter { chest in
            guard let expires = chest.expiresDate else { return true }
            return expires > now
        }
    }

    // MARK: - Loading (stale-while-revalidate)

    /// Shared by the map tab across tab switches; reset on logout.
    static let shared = MapModel()

    /// Account the data belongs to.
    private var ownerId: String?
    /// Overlay whose global map is drawn in `globalShapes`
    @ObservationIgnored private var drawnOverlay: GlobalOverlay?
    /// One resource per overlay choice (each is a different request)
    @ObservationIgnored private var globalResources: [GlobalOverlay: CachedResource<GlobalTerritoriesResponse>] = [:]
    private var globalResource: CachedResource<GlobalTerritoriesResponse> {
        if let existing = globalResources[overlay] { return existing }
        let created = CachedResource<GlobalTerritoriesResponse>("/api/global/territories", query: ["include": overlay.include])
        globalResources[overlay] = created
        return created
    }
    private let seasonMapResource = CachedResource<SeasonMapResponse>("/api/season/map")
    private var routesResource: CachedResource<[RunRoute]>?
    private var latestRoutes: [RunRoute] = []
    private var routeColor: String?
    private var ownColor: String = "#16A34A"
    /// Something was drawn (from the cache or the server).
    private(set) var hasContent = false
    var reloadTracker = ReloadSignalTracker()

    /// Forgets everything (logout).
    func reset() {
        ownerId = nil
        for resource in globalResources.values { resource.forget() }
        globalResources = [:]
        drawnOverlay = nil
        seasonMapResource.forget()
        routesResource = nil
        latestRoutes = []
        routeColor = nil
        hasContent = false
        hasCompetitionMap = false
        reloadTracker = ReloadSignalTracker()
        globalShapes = []
        competitionShapes = []
        chests = []
        fortifications = []
        castles = []
        routeLines = []
        isLoading = false
        errorMessage = nil
    }

    private func prepare(for userId: String) {
        guard ownerId != userId else { return }
        reset()
        ownerId = userId
        routesResource = CachedResource("/api/routes/\(userId)")
    }

    /// Main data answered recently: switching back to the map doesn't refetch it.
    func isFresh(userId: String) -> Bool {
        guard ownerId == userId, hasContent else { return false }
        return globalResource.isFresh && seasonMapResource.isFresh
    }

    /// Draws the last known data right away (memory, or disk after a cold start).
    func showCached(user: AppUser) async {
        prepare(for: user.id)
        ownColor = user.color
        if let global = await globalResource.loadCached() {
            globalShapes = Self.makeGlobalShapes(global, ownColor: user.color)
            drawnOverlay = overlay
            hasContent = true
        } else if drawnOverlay != overlay, let global = globalResource.value {
            // Back to an overlay drawn before: its value was already handed out
            globalShapes = Self.makeGlobalShapes(global, ownColor: user.color)
            drawnOverlay = overlay
            hasContent = true
        }
        if let season = await seasonMapResource.loadCached() {
            applySeasonMap(season, ownColor: user.color)
        }
        if let routes = await routesResource?.loadCached() {
            latestRoutes = routes
        }
        updateRouteLines(user: user)
    }

    /// Cached data first, then the global map, the competition map and my routes refetched in parallel.
    /// With `force == false` fresh data isn't refetched.
    func load(user: AppUser, force: Bool = true) async {
        await showCached(user: user)
        guard force || !isFresh(userId: user.id) else {
            updateRouteLines(user: user)
            return
        }
        guard let routesResource else { return }

        // The spinner only shows while there is nothing to draw yet
        isLoading = !hasContent
        defer { isLoading = false }

        let requestedOverlay: GlobalOverlay = overlay
        let globalSource: CachedResource<GlobalTerritoriesResponse> = globalResource
        let seasonSource: CachedResource<SeasonMapResponse> = seasonMapResource
        async let globalResult = Self.fetch(globalSource)
        async let seasonResult = Self.fetch(seasonSource)
        async let routesResult = Self.fetch(routesResource)

        let global: Result<GlobalTerritoriesResponse?, Error> = await globalResult
        let season: Result<SeasonMapResponse?, Error> = await seasonResult
        let routes: Result<[RunRoute]?, Error> = await routesResult

        var failure: Error?
        switch global {
        case .success(let value):
            // Ignored if the user switched overlays meanwhile (that overlay loads on its own)
            if let value, requestedOverlay == overlay {
                globalShapes = Self.makeGlobalShapes(value, ownColor: user.color)
                drawnOverlay = requestedOverlay
            }
        case .failure(let error):
            failure = error
        }
        switch season {
        case .success(let value):
            if let value { applySeasonMap(value, ownColor: user.color) }
        case .failure(let error):
            failure = failure ?? error
        }
        if case .success(let value) = routes, let value {
            latestRoutes = value
        }
        updateRouteLines(user: user)

        if let failure {
            if failure is CancellationError { return }
            // With cached data on screen the refresh fails silently (it's retried on the next visit)
            errorMessage = globalSource.hasValue ? nil : failure.localizedDescription
        } else {
            errorMessage = nil
            hasContent = true
        }
    }

    /// Chests and the competition map (refreshed every minute while the map is visible).
    func refreshCompetitionOverlays() async {
        let seasonSource: CachedResource<SeasonMapResponse> = seasonMapResource
        if case .success(let value) = await Self.fetch(seasonSource), let value {
            applySeasonMap(value, ownColor: ownColor)
        }
    }

    private static func fetch<T: Decodable>(_ resource: CachedResource<T>) async -> Result<T?, Error> {
        do {
            return .success(try await resource.fetch())
        } catch {
            return .failure(error)
        }
    }

    private func applySeasonMap(_ response: SeasonMapResponse, ownColor: String) {
        competitionShapes = Self.makeShapes(response.territories)
        chests = response.chests
        hasCompetitionMap = response.competitionId != nil
        makeFortifications(response.fortifications, ownColor: ownColor)
    }

    private func updateRouteLines(user: AppUser) {
        let color = Color(hex: user.color)
        let recent = latestRoutes
            .sorted { ($0.startDate ?? .distantPast) > ($1.startDate ?? .distantPast) }
            .prefix(maxRouteLines)
        let ids = recent.map(\.id)
        // Same routes in the same colour: nothing to redraw
        if routeColor == user.color && ids == routeLines.map(\.id) { return }
        routeColor = user.color
        routeLines = recent.compactMap { route -> RouteLine? in
            let coordinates = route.locations
            guard coordinates.count >= 2 else { return nil }
            return RouteLine(id: route.id, userId: user.id, color: color, coordinates: coordinates)
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

    // MARK: - Fortifications

    /// My fortified zones on the competition map (darker own colour), and a castle on each zone
    /// fortified several times.
    private func makeFortifications(_ records: [SeasonMapResponse.Fortification], ownColor: String) {
        guard let ownerId else {
            fortifications = []
            castles = []
            return
        }
        let color = Color(hex: ownColor).darkened(0.35)
        var newShapes: [FortificationShape] = []
        // Zones: record centroids closer than 0.0005° are the same zone
        var zones: [(sumLat: Double, sumLng: Double, lat: Double, lng: Double, count: Int)] = []
        for (recordIndex, record) in records.enumerated() {
            for (polygonIndex, rings) in record.polygons.enumerated() {
                guard let outer = rings.first else { continue }
                let holes = rings.dropFirst().map { MKPolygon(coordinates: $0, count: $0.count) }
                let polygon = MKPolygon(coordinates: outer, count: outer.count, interiorPolygons: holes)
                newShapes.append(FortificationShape(
                    id: "\(record.id)-\(recordIndex)-\(polygonIndex)",
                    userId: ownerId,
                    color: color,
                    polygon: polygon,
                    level: 1.5
                ))
            }
            guard let centroid = Self.centroid(of: record.polygons) else { continue }
            if let index = zones.firstIndex(where: { abs($0.lat - centroid.latitude) < 0.0005 && abs($0.lng - centroid.longitude) < 0.0005 }) {
                zones[index].sumLat += centroid.latitude
                zones[index].sumLng += centroid.longitude
                zones[index].count += 1
            } else {
                zones.append((sumLat: centroid.latitude, sumLng: centroid.longitude, lat: centroid.latitude, lng: centroid.longitude, count: 1))
            }
        }
        var newCastles: [CastleZone] = []
        for (zoneIndex, zone) in zones.enumerated() where zone.count >= 2 {
            let count = Double(zone.count)
            newCastles.append(CastleZone(
                id: "\(ownerId)-castle-\(zoneIndex)",
                userId: ownerId,
                coordinate: CLLocationCoordinate2D(latitude: zone.sumLat / count, longitude: zone.sumLng / count),
                level: 1 + count * 0.5,
                color: color
            ))
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

    /// My global map first, then the overlays of friends / club mates (drawn lighter).
    private static func makeGlobalShapes(_ response: GlobalTerritoriesResponse, ownColor: String) -> [TerritoryShape] {
        var result: [TerritoryShape] = []
        for overlay in response.overlays {
            guard let user = overlay.user else { continue }
            result += polygonsToShapes(
                idPrefix: "overlay-\(user.id)", userId: user.id, ownerName: user.name, color: user.color,
                polygons: overlay.polygons, isShared: false, isOverlay: true
            )
        }
        if let me = response.me {
            result += polygonsToShapes(
                idPrefix: "me", userId: me.user?.id ?? "me", ownerName: "Tú", color: me.user?.color ?? ownColor,
                polygons: me.polygons, isShared: false, isOverlay: false
            )
        }
        return result
    }

    private static func makeShapes(_ territories: [Territory]) -> [TerritoryShape] {
        var result: [TerritoryShape] = []
        for territory in territories {
            result += polygonsToShapes(
                idPrefix: territory.id, userId: territory.userId, ownerName: territory.owner?.name ?? "",
                color: territory.color, polygons: territory.polygons, isShared: !territory.coRunnerColors.isEmpty, isOverlay: false
            )
        }
        return result
    }

    private static func polygonsToShapes(idPrefix: String, userId: String, ownerName: String, color: String, polygons: [[[CLLocationCoordinate2D]]], isShared: Bool, isOverlay: Bool) -> [TerritoryShape] {
        var result: [TerritoryShape] = []
        for (index, rings) in polygons.enumerated() {
            guard let outer = rings.first else { continue }
            let holes = rings.dropFirst().map { MKPolygon(coordinates: $0, count: $0.count) }
            let polygon = MKPolygon(coordinates: outer, count: outer.count, interiorPolygons: holes)
            result.append(TerritoryShape(
                id: "\(idPrefix)-\(index)",
                userId: userId,
                ownerName: ownerName,
                color: Color(hex: color),
                isShared: isShared,
                polygon: polygon,
                rings: rings,
                isOverlay: isOverlay
            ))
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
