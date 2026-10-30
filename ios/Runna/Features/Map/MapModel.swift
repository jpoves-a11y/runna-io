import Foundation
import MapKit
import Observation
import SwiftUI

/// A territory polygon ready to draw.
struct TerritoryShape: Identifiable {
    let id: String
    let territoryId: String
    let userId: String
    let ownerName: String
    let color: Color
    /// The owner's colour as sent by the server ("#RRGGBB").
    let colorHex: String
    /// The colour desaturated, for territory out of focus.
    let mutedColor: Color
    let isShared: Bool
    let polygon: MKPolygon
    /// Outer ring and holes, for hit-testing taps.
    let rings: [[CLLocationCoordinate2D]]
    /// The run that conquered it.
    let routeId: String?
    let conqueredAt: Date?
}

/// A run drawn as a line on the map (yours, or a friend's with "Recorridos de todos").
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
    /// Castle zones as polygons (for the run preview).
    private(set) var castleAreas: [CastleArea] = []
    /// Zones wearing away (not run over for 14 days) and, yours, the ones that start soon.
    private(set) var weakZones: [WeakZoneShape] = []
    /// You're in rest mode (your territory doesn't wear away).
    private(set) var isResting = false
    /// Your runs, most recent first.
    private(set) var routeLines: [RouteLine] = []
    /// Friends' runs (only loaded while "Recorridos de todos" is on).
    private(set) var friendRouteLines: [RouteLine] = []
    /// Stretches of your outline that touch someone else's territory.
    private(set) var contestedBorders: [MapLine] = []
    private(set) var isLoading = false
    private(set) var errorMessage: String?
    var hiddenUserIds: Set<String> = []

    /// Most recent own runs kept for the map (the heat map uses all of them, the lines only the latest).
    private let maxRouteLines = 250
    /// Runs drawn as plain lines.
    static let maxPlainRouteLines = 40
    /// Most recent runs per friend with "Recorridos de todos".
    private let maxFriendRouteLines = 60

    var visibleShapes: [TerritoryShape] {
        hiddenUserIds.isEmpty ? shapes : shapes.filter { !hiddenUserIds.contains($0.userId) }
    }

    var visibleFortifications: [FortificationShape] {
        hiddenUserIds.isEmpty ? fortifications : fortifications.filter { !hiddenUserIds.contains($0.userId) }
    }

    var visibleCastles: [CastleZone] {
        hiddenUserIds.isEmpty ? castles : castles.filter { !hiddenUserIds.contains($0.userId) }
    }

    var visibleWeakZones: [WeakZoneShape] {
        hiddenUserIds.isEmpty ? weakZones : weakZones.filter { !hiddenUserIds.contains($0.userId) }
    }

    var visibleRouteLines: [RouteLine] {
        hiddenUserIds.isEmpty ? routeLines : routeLines.filter { !hiddenUserIds.contains($0.userId) }
    }

    var visibleFriendRouteLines: [RouteLine] {
        hiddenUserIds.isEmpty ? friendRouteLines : friendRouteLines.filter { !hiddenUserIds.contains($0.userId) }
    }

    var visibleContestedBorders: [MapLine] {
        hiddenUserIds.isEmpty ? contestedBorders : contestedBorders.filter { !hiddenUserIds.contains($0.userId) }
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

    // MARK: - Loading (stale-while-revalidate)

    /// Shared by the map tab across tab switches; reset on logout.
    static let shared = MapModel()

    /// Account the data belongs to.
    private var ownerId: String?
    private var territoriesResource: CachedResource<[Territory]>?
    private var friendsResource: CachedResource<[AppUser]>?
    private var routesResource: CachedResource<[RunRoute]>?
    private let treasuresResource = CachedResource<TreasuresResponse>("/api/treasures/active")
    private let fortificationsResource = CachedResource<FortificationsResponse>("/api/territories/fortifications")
    private let weakResource = CachedResource<WeakZonesResponse>("/api/territories/weak")
    /// Friends as last received (players are rebuilt when the user's own name/colour changes).
    private var friendList: [AppUser] = []
    private var latestRoutes: [RunRoute] = []
    private var routeColor: String?
    /// Friends' runs by user id, fetched on demand (the selected territory's run, "Recorridos de todos").
    private var routesByUser: [String: [RunRoute]] = [:]
    /// Bumped on every territory change, so an older contested-border computation is dropped.
    private var contestedGeneration = 0
    /// Something was drawn (from the cache or the server).
    private(set) var hasContent = false
    var reloadTracker = ReloadSignalTracker()

    /// Forgets everything (logout).
    func reset() {
        ownerId = nil
        territoriesResource = nil
        friendsResource = nil
        routesResource = nil
        treasuresResource.forget()
        fortificationsResource.forget()
        weakResource.forget()
        friendList = []
        latestRoutes = []
        routeColor = nil
        routesByUser = [:]
        contestedGeneration += 1
        hasContent = false
        reloadTracker = ReloadSignalTracker()
        shapes = []
        players = []
        treasures = []
        fortifications = []
        castles = []
        castleAreas = []
        weakZones = []
        isResting = false
        routeLines = []
        friendRouteLines = []
        contestedBorders = []
        isLoading = false
        errorMessage = nil
        hiddenUserIds = []
    }

    private func prepare(for userId: String) {
        guard ownerId != userId else { return }
        reset()
        ownerId = userId
        territoriesResource = CachedResource("/api/territories/friends/\(userId)")
        friendsResource = CachedResource("/api/friends/\(userId)")
        routesResource = CachedResource("/api/routes/\(userId)")
    }

    /// Main data answered recently: switching back to the map doesn't refetch it.
    func isFresh(userId: String) -> Bool {
        guard ownerId == userId, hasContent,
              let territories = territoriesResource, let friends = friendsResource else { return false }
        return territories.isFresh && friends.isFresh && CompetitionStore.shared.isFresh
    }

    /// Draws the last known data right away (memory, or disk after a cold start).
    func showCached(user: AppUser) async {
        prepare(for: user.id)
        CompetitionStore.shared.loadCachedIfNeeded()
        if let territories = await territoriesResource?.loadCached() {
            setShapes(Self.makeShapes(territories))
            hasContent = true
        }
        if let friends = await friendsResource?.loadCached() {
            friendList = friends
            hasContent = true
        }
        updatePlayers(user: user)
        if let routes = await routesResource?.loadCached() {
            latestRoutes = routes
        }
        updateRouteLines(user: user)
        // Castles and wear are part of the normal game (not only competitions)
        if let response = await fortificationsResource.loadCached() {
            makeFortifications(response)
        }
        if let response = await weakResource.loadCached() {
            makeWeakZones(response)
        }
        if CompetitionStore.shared.isActive {
            if let response = await treasuresResource.loadCached() {
                treasures = response.treasures
            }
        }
    }

    /// Cached data first, then everything refetched in parallel (territories, friends, routes and the
    /// competition), then the competition overlays. With `force == false` fresh data isn't refetched.
    func load(user: AppUser, force: Bool = true) async {
        await showCached(user: user)
        guard force || !isFresh(userId: user.id) else {
            updatePlayers(user: user)
            updateRouteLines(user: user)
            return
        }
        guard let territoriesResource, let friendsResource, let routesResource else { return }

        // The spinner only shows while there is nothing to draw yet
        isLoading = !hasContent
        defer { isLoading = false }

        let competitionStore: CompetitionStore = CompetitionStore.shared
        async let territoriesResult = Self.fetch(territoriesResource)
        async let friendsResult = Self.fetch(friendsResource)
        async let routesResult = Self.fetch(routesResource)
        async let competitionRefresh: Void = competitionStore.refresh()

        let territories: Result<[Territory]?, Error> = await territoriesResult
        let friends: Result<[AppUser]?, Error> = await friendsResult
        let routes: Result<[RunRoute]?, Error> = await routesResult
        await competitionRefresh

        var failure: Error?
        switch territories {
        case .success(let value):
            if let value { setShapes(Self.makeShapes(value)) }
        case .failure(let error):
            failure = error
        }
        switch friends {
        case .success(let value):
            if let value { friendList = value }
        case .failure(let error):
            failure = failure ?? error
        }
        if case .success(let value) = routes, let value {
            latestRoutes = value
        }
        updatePlayers(user: user)
        updateRouteLines(user: user)

        if let failure {
            if failure is CancellationError { return }
            // With cached data on screen the refresh fails silently (it's retried on the next visit)
            errorMessage = (territoriesResource.hasValue && friendsResource.hasValue) ? nil : failure.localizedDescription
        } else {
            errorMessage = nil
            hasContent = true
        }
        async let defense: Void = refreshDefenseOverlays()
        async let competitionOverlays: Void = loadCompetition(userId: user.id)
        await defense
        await competitionOverlays
    }

    private static func fetch<T: Decodable>(_ resource: CachedResource<T>) async -> Result<T?, Error> {
        do {
            return .success(try await resource.fetch())
        } catch {
            return .failure(error)
        }
    }

    private func updatePlayers(user: AppUser) {
        let me = UserRef(id: user.id, username: user.username, name: "Tú", color: user.color, avatar: user.avatar)
        let updated = [me] + friendList.map { UserRef(id: $0.id, username: $0.username, name: $0.name, color: $0.color, avatar: $0.avatar) }
        if updated != players { players = updated }
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

    /// Competition state, then treasures, fortifications and the powers badge while it is active.
    private func loadCompetition(userId: String) async {
        let store = CompetitionStore.shared
        guard store.isActive else {
            treasures = []
            store.setAvailablePowerCount(0)
            return
        }
        async let overlays: Void = refreshCompetitionOverlays()
        async let powers: Void = store.refreshPowers(userId: userId)
        await overlays
        await powers
    }

    /// Castles and zones wearing away (yours and your friends'), in parallel.
    func refreshDefenseOverlays() async {
        let fortificationsSource: CachedResource<FortificationsResponse> = fortificationsResource
        let weakSource: CachedResource<WeakZonesResponse> = weakResource
        async let fortificationsResult = Self.fetch(fortificationsSource)
        async let weakResult = Self.fetch(weakSource)
        if case .success(let response) = await fortificationsResult, let response {
            makeFortifications(response)
        }
        if case .success(let response) = await weakResult, let response {
            makeWeakZones(response)
        }
    }

    /// Treasures and fortifications (refreshed every minute while the map is visible), in parallel.
    func refreshCompetitionOverlays() async {
        guard CompetitionStore.shared.isActive else { return }
        let treasuresSource: CachedResource<TreasuresResponse> = treasuresResource
        let fortificationsSource: CachedResource<FortificationsResponse> = fortificationsResource
        async let treasuresResult = Self.fetch(treasuresSource)
        async let fortificationsResult = Self.fetch(fortificationsSource)
        let treasuresOutcome: Result<TreasuresResponse?, Error> = await treasuresResult
        let fortificationsOutcome: Result<FortificationsResponse?, Error> = await fortificationsResult
        if case .success(let response) = treasuresOutcome, let response {
            treasures = response.treasures
        }
        if case .success(let response) = fortificationsOutcome, let response {
            makeFortifications(response)
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

    /// Only your own territory and runs.
    func showOnlyMe() {
        guard let ownerId else { return }
        hiddenUserIds = Set(players.map(\.id).filter { $0 != ownerId })
    }

    // MARK: - Shapes and contested borders

    private func setShapes(_ newShapes: [TerritoryShape]) {
        shapes = newShapes
        updateContestedBorders()
    }

    /// Where your territory touches a rival's, computed off the main thread.
    private func updateContestedBorders() {
        contestedGeneration += 1
        let generation = contestedGeneration
        guard let me = ownerId else {
            contestedBorders = []
            return
        }
        let mine = shapes.filter { $0.userId == me }.map(\.rings)
        let rivals = shapes.filter { $0.userId != me }.map(\.rings)
        guard !mine.isEmpty, !rivals.isEmpty else {
            contestedBorders = []
            return
        }
        Task { [weak self] in
            let lines = await Task.detached(priority: .utility) { () -> [[CLLocationCoordinate2D]] in
                MapGeometry.contestedBorders(mine: mine, rivals: rivals)
            }.value
            guard let self, self.contestedGeneration == generation else { return }
            self.contestedBorders = lines.enumerated().map { index, coordinates in
                MapLine(id: "contested-\(generation)-\(index)", userId: me, coordinates: coordinates)
            }
        }
    }

    // MARK: - Runs of other players

    /// Zones of the run's owner that the run passes through (what it conquered or reinforced).
    func zones(crossedBy route: RunRoute) -> [TerritoryShape] {
        let points = MapGeometry.simplified(route.locations, maxPoints: 300)
        guard !points.isEmpty else { return [] }
        let routeBox = MKPolyline(coordinates: points, count: points.count).boundingMapRect
        return shapes.filter { shape in
            guard shape.userId == route.userId, let outer = shape.rings.first else { return false }
            // Bounding boxes first: the point-in-polygon tests are the slow part
            let box = shape.polygon.boundingMapRect
            guard box.intersects(routeBox) else { return false }
            let holes = shape.rings.dropFirst()
            return points.contains { point in
                box.contains(MKMapPoint(point))
                    && Self.contains(outer, point) && !holes.contains { Self.contains($0, point) }
            }
        }
    }

    /// The owner's most recent run that goes through this zone (the run that last conquered it).
    /// A user's territory is one multipolygon, so the territory's own routeId is just their latest run.
    func latestRoute(through shape: TerritoryShape) async -> RunRoute? {
        var candidates: [RunRoute] = []
        if shape.userId == ownerId {
            candidates = latestRoutes
        }
        if candidates.isEmpty {
            candidates = await routes(of: shape.userId) ?? []
        }
        guard let outer = shape.rings.first, !outer.isEmpty else { return nil }
        let holes = Array(shape.rings.dropFirst())
        let minLat = outer.map(\.latitude).min() ?? 0
        let maxLat = outer.map(\.latitude).max() ?? 0
        let minLng = outer.map(\.longitude).min() ?? 0
        let maxLng = outer.map(\.longitude).max() ?? 0
        let sorted = candidates.sorted { ($0.startDate ?? .distantPast) > ($1.startDate ?? .distantPast) }
        for route in sorted {
            let points = MapGeometry.simplified(route.locations, maxPoints: 300)
            let passes = points.contains { point in
                guard point.latitude >= minLat, point.latitude <= maxLat,
                      point.longitude >= minLng, point.longitude <= maxLng else { return false }
                return Self.contains(outer, point) && !holes.contains { Self.contains($0, point) }
            }
            if passes { return route }
        }
        return nil
    }

    private func routes(of userId: String) async -> [RunRoute]? {
        if let known = routesByUser[userId] { return known }
        guard let routes: [RunRoute] = try? await APIClient.shared.request("GET", "/api/routes/\(userId)") else { return nil }
        routesByUser[userId] = routes
        return routes
    }

    /// Friends' latest runs for "Recorridos de todos" (fetched in parallel, once per session).
    func loadFriendRoutes() async {
        let owner = ownerId
        let friends = players.filter { $0.id != owner }
        guard !friends.isEmpty else {
            friendRouteLines = []
            return
        }
        let missing = friends.map(\.id).filter { routesByUser[$0] == nil }
        if !missing.isEmpty {
            let fetched: [(String, [RunRoute])] = await withTaskGroup(of: (String, [RunRoute])?.self) { group in
                for userId in missing {
                    group.addTask {
                        guard let routes: [RunRoute] = try? await APIClient.shared.request("GET", "/api/routes/\(userId)") else { return nil }
                        return (userId, routes)
                    }
                }
                var results: [(String, [RunRoute])] = []
                for await result in group {
                    if let result { results.append(result) }
                }
                return results
            }
            // The account may have changed meanwhile
            guard ownerId == owner else { return }
            for (userId, routes) in fetched {
                routesByUser[userId] = routes
            }
        }
        var lines: [RouteLine] = []
        for friend in friends {
            let color = Color(hex: friend.color)
            let recent = (routesByUser[friend.id] ?? [])
                .sorted { ($0.startDate ?? .distantPast) > ($1.startDate ?? .distantPast) }
                .prefix(maxFriendRouteLines)
            for route in recent {
                let coordinates = route.locations
                guard coordinates.count >= 2 else { continue }
                lines.append(RouteLine(id: route.id, userId: friend.id, color: color, coordinates: coordinates))
            }
        }
        friendRouteLines = lines
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

    /// Colour of each player (territory colour, or the friend list's).
    private func playerColors() -> [String: Color] {
        var colors: [String: Color] = [:]
        for shape in shapes where colors[shape.userId] == nil {
            colors[shape.userId] = shape.color
        }
        for player in players {
            colors[player.id] = Color(hex: player.color)
        }
        return colors
    }

    /// Castle zones from the server: the wall and hatching of each zone and a castle marker with its castles.
    private func makeFortifications(_ response: FortificationsResponse) {
        guard !response.castles.isEmpty || response.fortifications.isEmpty else {
            // Older server: raw records only
            makeFortifications(response.fortifications)
            return
        }
        let colors = playerColors()
        let names = Dictionary(players.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
        var newShapes: [FortificationShape] = []
        var newCastles: [CastleZone] = []
        for castle in response.castles {
            let color = (colors[castle.userId] ?? Color.gray).darkened(0.35)
            for (index, rings) in castle.polygons.enumerated() {
                guard let outer = rings.first else { continue }
                let holes = rings.dropFirst().map { MKPolygon(coordinates: $0, count: $0.count) }
                newShapes.append(FortificationShape(
                    id: "\(castle.id)-\(index)",
                    userId: castle.userId,
                    color: color,
                    polygon: MKPolygon(coordinates: outer, count: outer.count, interiorPolygons: holes),
                    layers: castle.layers,
                    hatch: MapGeometry.hatch(rings: rings)
                ))
            }
            guard let coordinate = castle.coordinate ?? Self.centroid(of: castle.polygons) else { continue }
            newCastles.append(CastleZone(
                id: castle.id,
                userId: castle.userId,
                coordinate: coordinate,
                layers: castle.layers,
                color: color,
                area: castle.area,
                nextExpiryAt: castle.nextExpiryAt,
                expiresAt: castle.expiresAt,
                ownerName: names[castle.userId] ?? ""
            ))
        }
        fortifications = newShapes
        castles = newCastles
        castleAreas = response.castles.map { CastleArea(userId: $0.userId, layers: $0.layers, polygons: $0.polygons) }
    }

    private func makeWeakZones(_ response: WeakZonesResponse) {
        let colors = playerColors()
        var zones: [WeakZoneShape] = []
        for zone in response.zones {
            let color = colors[zone.userId] ?? Color.gray
            for (kind, polygons) in [(false, zone.weak), (true, zone.atRisk)] {
                for (index, rings) in polygons.enumerated() {
                    guard let outer = rings.first else { continue }
                    let holes = rings.dropFirst().map { MKPolygon(coordinates: $0, count: $0.count) }
                    zones.append(WeakZoneShape(
                        id: "\(zone.userId)-\(kind ? "risk" : "weak")-\(index)",
                        userId: zone.userId,
                        color: color,
                        polygon: MKPolygon(coordinates: outer, count: outer.count, interiorPolygons: holes),
                        isAtRisk: kind
                    ))
                }
            }
        }
        weakZones = zones
        isResting = response.resting
    }

    /// Fortified zones in the owner's colour (darker): the wall gets thicker with every layer stacked on the
    /// same zone, the zone is hatched, and a castle shows the number of layers where there are several.
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
            let color = (colors[group.userId] ?? Color.gray).darkened(0.35)

            // Zones: record centroids closer than 0.0005° are the same zone (each record is one layer)
            var zones: [(sumLat: Double, sumLng: Double, count: Int)] = []
            var zoneOfRecord: [Int] = []
            for record in group.records {
                guard let centroid = Self.centroid(of: record.polygons) else {
                    zoneOfRecord.append(-1)
                    continue
                }
                if let index = zones.firstIndex(where: {
                    abs($0.sumLat / Double($0.count) - centroid.latitude) < 0.0005
                        && abs($0.sumLng / Double($0.count) - centroid.longitude) < 0.0005
                }) {
                    zones[index].sumLat += centroid.latitude
                    zones[index].sumLng += centroid.longitude
                    zones[index].count += 1
                    zoneOfRecord.append(index)
                } else {
                    zones.append((sumLat: centroid.latitude, sumLng: centroid.longitude, count: 1))
                    zoneOfRecord.append(zones.count - 1)
                }
            }

            for (recordIndex, record) in group.records.enumerated() {
                let zone = zoneOfRecord[recordIndex]
                let layers = zone >= 0 ? zones[zone].count : 1
                for (polygonIndex, rings) in record.polygons.enumerated() {
                    guard let outer = rings.first else { continue }
                    let holes = rings.dropFirst().map { MKPolygon(coordinates: $0, count: $0.count) }
                    let polygon = MKPolygon(coordinates: outer, count: outer.count, interiorPolygons: holes)
                    newShapes.append(FortificationShape(
                        id: "\(group.userId)-\(recordIndex)-\(polygonIndex)",
                        userId: group.userId,
                        color: color,
                        polygon: polygon,
                        layers: layers,
                        // Stacked layers share the hatch of the first one
                        hatch: Self.isFirstRecord(recordIndex, ofZone: zone, in: zoneOfRecord) ? MapGeometry.hatch(rings: rings) : []
                    ))
                }
            }

            for (zoneIndex, zone) in zones.enumerated() where zone.count >= 2 {
                let count = Double(zone.count)
                newCastles.append(CastleZone(
                    id: "\(group.userId)-castle-\(zoneIndex)",
                    userId: group.userId,
                    coordinate: CLLocationCoordinate2D(latitude: zone.sumLat / count, longitude: zone.sumLng / count),
                    layers: zone.count,
                    color: color
                ))
            }
        }
        fortifications = newShapes
        castles = newCastles
    }

    private static func isFirstRecord(_ recordIndex: Int, ofZone zone: Int, in zoneOfRecord: [Int]) -> Bool {
        zone < 0 || zoneOfRecord.firstIndex(of: zone) == recordIndex
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
            let color = Color(hex: territory.color)
            let mutedColor = color.muted()
            let conqueredAt = APIDate.parse(territory.conqueredAt)
            for (index, rings) in territory.polygons.enumerated() {
                guard let outer = rings.first else { continue }
                let holes = rings.dropFirst().map { MKPolygon(coordinates: $0, count: $0.count) }
                let polygon = MKPolygon(coordinates: outer, count: outer.count, interiorPolygons: holes)
                result.append(TerritoryShape(
                    id: "\(territory.id)-\(index)",
                    territoryId: territory.id,
                    userId: territory.userId,
                    ownerName: territory.owner?.name ?? "",
                    color: color,
                    colorHex: territory.color,
                    mutedColor: mutedColor,
                    isShared: !territory.coRunnerColors.isEmpty,
                    polygon: polygon,
                    rings: rings,
                    routeId: territory.routeId,
                    conqueredAt: conqueredAt
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
