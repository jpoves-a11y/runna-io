import Foundation
import CoreLocation

// MARK: - Users

/// A user as returned by the API. Own-account responses also include email and verification state;
/// login/registration responses include the session token.
struct AppUser: Codable, Identifiable, Hashable {
    let id: String
    var username: String
    var name: String
    var color: String
    var avatar: String?
    var totalArea: Double
    var email: String?
    var emailVerified: Bool?
    var rank: Int?
    var friendCount: Int?
    var nickname: String?
    var createdAt: String?
    var token: String?

    enum CodingKeys: String, CodingKey {
        case id, username, name, color, avatar, totalArea, email, emailVerified, rank, friendCount
        case nickname, createdAt, token
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        username = c.string(.username) ?? ""
        name = c.string(.name) ?? ""
        color = c.string(.color) ?? "#16A34A"
        avatar = c.string(.avatar)
        totalArea = c.double(.totalArea) ?? 0
        email = c.string(.email)
        emailVerified = c.bool(.emailVerified)
        rank = c.int(.rank)
        friendCount = c.int(.friendCount)
        nickname = c.string(.nickname)
        createdAt = c.string(.createdAt)
        token = c.string(.token)
    }

    var displayName: String { nickname.map { "\($0) (\(name))" } ?? name }
}

/// Short user reference embedded in other objects (feed, requests, territories).
struct UserRef: Decodable, Identifiable, Hashable {
    let id: String
    var username: String
    var name: String
    var color: String
    var avatar: String?
    var nickname: String?

    enum CodingKeys: String, CodingKey { case id, username, name, color, avatar, nickname }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        username = c.string(.username) ?? ""
        name = c.string(.name) ?? ""
        color = c.string(.color) ?? "#888888"
        avatar = c.string(.avatar)
        nickname = c.string(.nickname)
    }

    init(id: String, username: String, name: String, color: String, avatar: String?) {
        self.id = id
        self.username = username
        self.name = name
        self.color = color
        self.avatar = avatar
        self.nickname = nil
    }

    var displayName: String { nickname.map { "\($0) (\(name))" } ?? name }
}

/// GET /api/users/:id/stats
struct UserStats: Decodable {
    let user: UserRef
    let totalArea: Double
    let activitiesCount: Int
    let lastActivity: String?
    let totalStolen: Double
    let totalLost: Double
    let stolenFromViewer: Double
    let stolenByViewer: Double

    enum CodingKeys: String, CodingKey {
        case user, totalArea, activitiesCount, lastActivity, totalStolen, totalLost, stolenFromViewer, stolenByViewer
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        user = try c.decode(UserRef.self, forKey: .user)
        totalArea = c.double(.totalArea) ?? 0
        activitiesCount = c.int(.activitiesCount) ?? 0
        lastActivity = c.string(.lastActivity)
        totalStolen = c.double(.totalStolen) ?? 0
        totalLost = c.double(.totalLost) ?? 0
        stolenFromViewer = c.double(.stolenFromViewer) ?? 0
        stolenByViewer = c.double(.stolenByViewer) ?? 0
    }
}

/// GET /api/conquest-stats/:userId
struct ConquestStats: Decodable {
    struct Entry: Decodable, Identifiable, Hashable {
        let userId: String
        let userName: String
        let userColor: String
        let amount: Double
        var id: String { userId }

        enum CodingKeys: String, CodingKey { case userId, userName, userColor, amount }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            userId = c.string(.userId) ?? UUID().uuidString
            userName = c.string(.userName) ?? ""
            userColor = c.string(.userColor) ?? "#888888"
            amount = c.double(.amount) ?? 0
        }
    }

    let totalStolen: Double
    let totalLost: Double
    let stolenByUser: [Entry]
    let lostToUser: [Entry]

    enum CodingKeys: String, CodingKey { case totalStolen, totalLost, stolenByUser, lostToUser }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        totalStolen = c.double(.totalStolen) ?? 0
        totalLost = c.double(.totalLost) ?? 0
        stolenByUser = (try? c.decodeIfPresent([Entry].self, forKey: .stolenByUser)) ?? []
        lostToUser = (try? c.decodeIfPresent([Entry].self, forKey: .lostToUser)) ?? []
    }
}

// MARK: - Territories

struct Territory: Decodable, Identifiable {
    let id: String
    let userId: String
    let routeId: String?
    let area: Double
    let conqueredAt: String?
    let owner: UserRef?
    let coRunnerColors: [String]
    /// Polygons (outer ring first, then holes) in map coordinates.
    let polygons: [[[CLLocationCoordinate2D]]]

    enum CodingKeys: String, CodingKey {
        case id, userId, routeId, area, conqueredAt, user, ranTogetherWithColors, geometry
    }

    private struct ColorRef: Decodable { let color: String }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        userId = c.string(.userId) ?? ""
        routeId = c.string(.routeId)
        area = c.double(.area) ?? 0
        conqueredAt = c.string(.conqueredAt)
        owner = try? c.decodeIfPresent(UserRef.self, forKey: .user)
        coRunnerColors = (try? c.decodeIfPresent([ColorRef].self, forKey: .ranTogetherWithColors))?.map(\.color) ?? []
        polygons = GeoJSON.polygons(from: c.jsonObject(.geometry))
    }

    var color: String { owner?.color ?? "#888888" }
}

enum GeoJSON {
    /// Reads a GeoJSON Polygon or MultiPolygon ([lng, lat] positions).
    static func polygons(from object: Any?) -> [[[CLLocationCoordinate2D]]] {
        guard let geometry = object as? [String: Any],
              let type = geometry["type"] as? String,
              let coordinates = geometry["coordinates"] as? [Any] else { return [] }

        func ring(_ value: Any) -> [CLLocationCoordinate2D] {
            guard let points = value as? [Any] else { return [] }
            return points.compactMap { point in
                guard let pair = point as? [Any], pair.count >= 2,
                      let lng = (pair[0] as? NSNumber)?.doubleValue,
                      let lat = (pair[1] as? NSNumber)?.doubleValue else { return nil }
                return CLLocationCoordinate2D(latitude: lat, longitude: lng)
            }
        }
        func polygon(_ value: Any) -> [[CLLocationCoordinate2D]] {
            guard let rings = value as? [Any] else { return [] }
            return rings.map(ring).filter { $0.count >= 3 }
        }

        switch type {
        case "Polygon":
            let rings = polygon(coordinates)
            return rings.isEmpty ? [] : [rings]
        case "MultiPolygon":
            return coordinates.map(polygon).filter { !$0.isEmpty }
        default:
            return []
        }
    }
}

// MARK: - Routes

struct RunRoute: Decodable, Identifiable, Hashable {
    let id: String
    let userId: String
    var name: String
    let coordinates: [[Double]]
    let distance: Double
    let duration: Int
    let startedAt: String
    let completedAt: String
    let territoryArea: Double?
    let ranTogetherWith: [String]
    /// Seconds since the start of each point (runs recorded or imported since times are kept).
    let pointTimes: [Double]?
    /// Altitude of each point in metres (nil where unknown).
    let altitudes: [Double?]?

    enum CodingKeys: String, CodingKey {
        case id, userId, name, coordinates, distance, duration, startedAt, completedAt, territory, ranTogetherWithUsers
        case pointTimes, altitudes
    }

    private struct TerritorySummary: Decodable {
        let area: Double?
    }

    private struct NameRef: Decodable { let name: String }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        userId = c.string(.userId) ?? ""
        name = c.string(.name) ?? "Ruta"
        coordinates = CoordinateList.parse(c.jsonObject(.coordinates))
        distance = c.double(.distance) ?? 0
        duration = c.int(.duration) ?? 0
        startedAt = c.string(.startedAt) ?? ""
        completedAt = c.string(.completedAt) ?? ""
        territoryArea = (try? c.decodeIfPresent(TerritorySummary.self, forKey: .territory))?.area
        ranTogetherWith = (try? c.decodeIfPresent([NameRef].self, forKey: .ranTogetherWithUsers))?.map(\.name) ?? []
        // One value per point, or nothing
        let pointCount = coordinates.count
        let times = (c.jsonObject(.pointTimes) as? [Any])?.map { ($0 as? NSNumber)?.doubleValue }
        if let times, times.count == pointCount, times.allSatisfy({ $0 != nil }) {
            pointTimes = times.compactMap { $0 }
        } else {
            pointTimes = nil
        }
        let heights = (c.jsonObject(.altitudes) as? [Any])?.map { ($0 as? NSNumber)?.doubleValue }
        altitudes = heights?.count == pointCount ? heights : nil
    }

    var startDate: Date? { APIDate.parse(startedAt) }
    var locations: [CLLocationCoordinate2D] {
        coordinates.map { CLLocationCoordinate2D(latitude: $0[0], longitude: $0[1]) }
    }

    static func == (lhs: RunRoute, rhs: RunRoute) -> Bool { lhs.id == rhs.id && lhs.name == rhs.name }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

/// POST /api/routes
struct CreateRouteResponse: Decodable {
    let route: RunRoute
}

/// GET /api/conquest-result/:routeId (polled until the territory has been processed)
struct ConquestResult: Decodable {
    let ready: Bool
    let newAreaConquered: Double
    let areaStolen: Double
    let victims: [Victim]
    /// Treasures the server collected along the route (and the ones collected live, once processed).
    let treasuresCollected: [CollectedTreasure]
    /// Castles this run built on your territory, and castles of rivals it knocked down.
    let castlesBuilt: Int
    let castlesDestroyed: Int

    enum CodingKeys: String, CodingKey { case ready, newAreaConquered, areaStolen, victims, treasuresCollected, castlesBuilt, castlesDestroyed }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ready = c.bool(.ready) ?? false
        newAreaConquered = c.double(.newAreaConquered) ?? 0
        areaStolen = c.double(.areaStolen) ?? 0
        victims = (try? c.decodeIfPresent([Victim].self, forKey: .victims)) ?? []
        treasuresCollected = (try? c.decodeIfPresent([CollectedTreasure].self, forKey: .treasuresCollected)) ?? []
        castlesBuilt = c.int(.castlesBuilt) ?? 0
        castlesDestroyed = c.int(.castlesDestroyed) ?? 0
    }

    /// Victims that actually lost territory.
    var stolenVictims: [Victim] { victims.filter { $0.stolenArea > 0 } }

    /// Total area taken from other runners (sum of the victims; falls back to the server total).
    var totalStolen: Double {
        let sum = stolenVictims.reduce(0) { $0 + $1.stolenArea }
        return sum > 0 ? sum : areaStolen
    }
}

/// A treasure listed in a conquest result.
struct CollectedTreasure: Decodable, Identifiable, Hashable {
    let treasureId: String
    let treasureName: String
    let powerType: String?
    let rarity: String

    var id: String { treasureId }

    enum CodingKeys: String, CodingKey { case treasureId, treasureName, powerType, rarity }

    init(treasureId: String, treasureName: String, powerType: String?, rarity: String) {
        self.treasureId = treasureId
        self.treasureName = treasureName
        self.powerType = powerType
        self.rarity = rarity
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        treasureId = c.string(.treasureId) ?? UUID().uuidString
        treasureName = c.string(.treasureName) ?? "Tesoro"
        powerType = c.string(.powerType)
        rarity = c.string(.rarity) ?? "common"
    }
}

struct Victim: Decodable, Identifiable, Hashable {
    let userId: String
    let userName: String
    let userColor: String
    let stolenArea: Double
    var id: String { userId }

    enum CodingKeys: String, CodingKey { case userId, userName, userColor, stolenArea }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        userId = c.string(.userId) ?? UUID().uuidString
        userName = c.string(.userName) ?? ""
        userColor = c.string(.userColor) ?? "#888888"
        stolenArea = c.double(.stolenArea) ?? 0
    }
}

// MARK: - Feed

struct FeedMetadata: Decodable, Hashable {
    struct NameRef: Decodable, Hashable { let id: String?; let name: String }
    struct TreasureRef: Decodable, Hashable { let treasureName: String?; let rarity: String? }
    struct Record: Decodable, Hashable {
        let type: String
        let value: Double?
    }

    let victims: [Victim]?
    let ranTogetherWith: [NameRef]?
    let treasures: [TreasureRef]?
    let records: [Record]?
    let fortressesDestroyed: Int?
    let fortificationLayers: Int?
    let fortificationArea: Double?
    let treasureName: String?
    let emoji: String?
    let rarity: String?
    let zone: String?
    let powerType: String?
    /// nickname_changed
    let nickname: String?
    let targetName: String?
    let attackerName: String?
    /// sentinel_alert
    let alertMessage: String?
    let attackerId: String?
    let stolenArea: Double?

    enum CodingKeys: String, CodingKey {
        case victims, ranTogetherWith, treasures, records, fortressesDestroyed, fortificationLayers, fortificationArea
        case treasureName, emoji, rarity, zone, powerType, nickname, targetName, attackerName
        case alertMessage, attackerId, stolenArea
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        victims = try? c.decodeIfPresent([Victim].self, forKey: .victims)
        ranTogetherWith = try? c.decodeIfPresent([NameRef].self, forKey: .ranTogetherWith)
        treasures = try? c.decodeIfPresent([TreasureRef].self, forKey: .treasures)
        records = try? c.decodeIfPresent([Record].self, forKey: .records)
        fortressesDestroyed = c.int(.fortressesDestroyed)
        fortificationLayers = c.int(.fortificationLayers)
        fortificationArea = c.double(.fortificationArea)
        treasureName = c.string(.treasureName)
        emoji = c.string(.emoji)
        rarity = c.string(.rarity)
        zone = c.string(.zone)
        powerType = c.string(.powerType)
        nickname = c.string(.nickname)
        targetName = c.string(.targetName)
        attackerName = c.string(.attackerName)
        alertMessage = c.string(.alertMessage)
        attackerId = c.string(.attackerId)
        stolenArea = c.double(.stolenArea)
    }
}

struct FeedEvent: Decodable, Identifiable, Hashable {
    let id: String
    let userId: String
    let eventType: String
    let routeId: String?
    let areaStolen: Double?
    let distance: Double?
    let duration: Int?
    let newArea: Double?
    let recordType: String?
    let recordValue: Double?
    let metadata: FeedMetadata?
    let createdAt: String
    let user: UserRef
    let victim: UserRef?
    let routeName: String?
    let activityDate: String?
    let routeCoordinates: [[Double]]
    var commentCount: Int
    var likeCount: Int
    var dislikeCount: Int
    var userReaction: String?

    enum CodingKeys: String, CodingKey {
        case id, userId, eventType, routeId, areaStolen, distance, duration, newArea, recordType, recordValue
        case metadata, createdAt, user, victim, routeName, activityDate, routeCoordinates
        case commentCount, likeCount, dislikeCount, userReaction
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        userId = c.string(.userId) ?? ""
        eventType = c.string(.eventType) ?? "activity"
        routeId = c.string(.routeId)
        areaStolen = c.double(.areaStolen)
        distance = c.double(.distance)
        duration = c.int(.duration)
        newArea = c.double(.newArea)
        recordType = c.string(.recordType)
        recordValue = c.double(.recordValue)
        metadata = c.embedded(FeedMetadata.self, .metadata)
        createdAt = c.string(.createdAt) ?? ""
        user = try c.decode(UserRef.self, forKey: .user)
        victim = try? c.decodeIfPresent(UserRef.self, forKey: .victim)
        routeName = c.string(.routeName)
        activityDate = c.string(.activityDate)
        routeCoordinates = CoordinateList.parse(c.jsonObject(.routeCoordinates))
        commentCount = c.int(.commentCount) ?? 0
        likeCount = c.int(.likeCount) ?? 0
        dislikeCount = c.int(.dislikeCount) ?? 0
        userReaction = c.string(.userReaction)
    }

    static func == (lhs: FeedEvent, rhs: FeedEvent) -> Bool {
        lhs.id == rhs.id && lhs.likeCount == rhs.likeCount && lhs.dislikeCount == rhs.dislikeCount
            && lhs.userReaction == rhs.userReaction && lhs.commentCount == rhs.commentCount
    }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }

    var date: Date? { APIDate.parse(activityDate) ?? APIDate.parse(createdAt) }
}

struct FeedComment: Decodable, Identifiable {
    let id: String
    let userId: String
    let parentId: String?
    let content: String
    let createdAt: String
    let user: UserRef
    var replies: [FeedComment]
    var likeCount: Int
    var dislikeCount: Int
    var userReaction: String?

    enum CodingKeys: String, CodingKey {
        case id, userId, parentId, content, createdAt, user, replies, likeCount, dislikeCount, userReaction
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        userId = c.string(.userId) ?? ""
        parentId = c.string(.parentId)
        content = c.string(.content) ?? ""
        createdAt = c.string(.createdAt) ?? ""
        user = try c.decode(UserRef.self, forKey: .user)
        replies = (try? c.decodeIfPresent([FeedComment].self, forKey: .replies)) ?? []
        likeCount = c.int(.likeCount) ?? 0
        dislikeCount = c.int(.dislikeCount) ?? 0
        userReaction = c.string(.userReaction)
    }
}

struct ReactionResult: Decodable {
    let likeCount: Int
    let dislikeCount: Int
    let userReaction: String?

    enum CodingKeys: String, CodingKey { case likeCount, dislikeCount, userReaction }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        likeCount = c.int(.likeCount) ?? 0
        dislikeCount = c.int(.dislikeCount) ?? 0
        userReaction = c.string(.userReaction)
    }
}

// MARK: - Friends

struct FriendRequest: Decodable, Identifiable {
    let id: String
    let senderId: String
    let recipientId: String
    let status: String
    let createdAt: String?
    let sender: UserRef?
    let recipient: UserRef?

    enum CodingKeys: String, CodingKey { case id, senderId, recipientId, status, createdAt, sender, recipient }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        senderId = c.string(.senderId) ?? ""
        recipientId = c.string(.recipientId) ?? ""
        status = c.string(.status) ?? "pending"
        createdAt = c.string(.createdAt)
        sender = try? c.decodeIfPresent(UserRef.self, forKey: .sender)
        recipient = try? c.decodeIfPresent(UserRef.self, forKey: .recipient)
    }
}

struct InviteResponse: Decodable {
    let token: String
    let url: String
}

struct AcceptInviteResponse: Decodable {
    let success: Bool?
    let colorChanged: Bool?
    /// Colour assigned to whichever of the two users had to change (null when nobody changed).
    let newColor: String?
    /// Inviter id (only POST /api/friends/accept/:token).
    let friendId: String?
}

/// GET /api/friends/invite/:token: who sent the invite, before accepting it.
struct InvitePreview: Decodable {
    let inviter: UserRef
    let alreadyFriends: Bool
    let isSelf: Bool

    enum CodingKeys: String, CodingKey { case inviter, alreadyFriends, isSelf }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        inviter = try c.decode(UserRef.self, forKey: .inviter)
        alreadyFriends = c.bool(.alreadyFriends) ?? false
        isSelf = c.bool(.isSelf) ?? false
    }
}

/// GET /api/blocks
struct BlockedUsersResponse: Decodable {
    let blocks: [UserRef]

    enum CodingKeys: String, CodingKey { case blocks }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        blocks = (try? c.decodeIfPresent([UserRef].self, forKey: .blocks)) ?? []
    }
}

// MARK: - Integrations

struct StravaStatus: Decodable {
    struct Athlete: Decodable {
        let id: Int?
        let firstname: String?
        let lastname: String?
    }

    let connected: Bool
    let athlete: Athlete?
    let lastSyncAt: String?

    enum CodingKeys: String, CodingKey { case connected, athleteData, lastSyncAt }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        connected = c.bool(.connected) ?? false
        athlete = c.embedded(Athlete.self, .athleteData)
        lastSyncAt = c.string(.lastSyncAt)
    }
}

struct PolarStatus: Decodable {
    let connected: Bool
    let lastSyncAt: String?
    let totalActivities: Int?
    let pendingActivities: Int?

    enum CodingKeys: String, CodingKey { case connected, lastSyncAt, totalActivities, pendingActivities }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        connected = c.bool(.connected) ?? false
        lastSyncAt = c.string(.lastSyncAt)
        totalActivities = c.int(.totalActivities)
        pendingActivities = c.int(.pendingActivities)
    }
}

struct AuthURLResponse: Decodable {
    let authUrl: String
}

struct SyncResponse: Decodable {
    let imported: Int?
    let processed: Int?
    let remaining: Int?
    let message: String?

    enum CodingKeys: String, CodingKey { case imported, processed, remaining, message }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        imported = c.int(.imported)
        processed = c.int(.processed)
        remaining = c.int(.remaining)
        message = c.string(.message)
    }
}

// MARK: - Ephemeral photos

struct PendingPhoto: Decodable, Identifiable, Hashable {
    let id: String
    let senderId: String
    let senderName: String
    let senderAvatar: String?
    let message: String?
    let areaStolen: Double?

    enum CodingKeys: String, CodingKey { case id, senderId, senderName, senderAvatar, message, areaStolen }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        senderId = c.string(.senderId) ?? ""
        senderName = c.string(.senderName) ?? ""
        senderAvatar = c.string(.senderAvatar)
        message = c.string(.message)
        areaStolen = c.double(.areaStolen)
    }
}

struct PhotoContent: Decodable {
    let photoData: String
    let message: String?
}

// MARK: - Competition

/// GET /api/competition/active
struct CompetitionInfo: Decodable {
    struct Competition: Decodable, Hashable {
        let id: String
        let name: String
        let startsAt: String?
        let endsAt: String?

        enum CodingKeys: String, CodingKey { case id, name, startsAt, endsAt }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            name = c.string(.name) ?? "Competición"
            startsAt = c.string(.startsAt)
            endsAt = c.string(.endsAt)
        }

        var startDate: Date? { APIDate.parse(startsAt) }
        var endDate: Date? { APIDate.parse(endsAt) }
    }

    let competition: Competition?
    /// "no_competition", "upcoming", "active" or "finished".
    let status: String
    /// Milliseconds until the start (upcoming only).
    let timeUntilStart: Double?
    /// 1-based day number (active only).
    let dayOfCompetition: Int?
    let totalDays: Int?
    /// Power definitions by power type (shield, double_area, nickname...).
    let treasurePowers: [String: PowerDefinition]

    enum CodingKeys: String, CodingKey { case competition, status, timeUntilStart, dayOfCompetition, totalDays, treasurePowers }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        competition = try? c.decodeIfPresent(Competition.self, forKey: .competition)
        status = c.string(.status) ?? "no_competition"
        timeUntilStart = c.double(.timeUntilStart)
        dayOfCompetition = c.int(.dayOfCompetition)
        totalDays = c.int(.totalDays)
        treasurePowers = (try? c.decodeIfPresent([String: PowerDefinition].self, forKey: .treasurePowers)) ?? [:]
    }
}

/// How a power looks and what it does (from the server's TREASURE_POWERS).
struct PowerDefinition: Decodable, Hashable {
    let name: String
    let rarity: String
    let description: String
    let color: String?
    let emoji: String

    enum CodingKeys: String, CodingKey { case name, rarity, description, color, emoji }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = c.string(.name) ?? "Poder"
        rarity = c.string(.rarity) ?? "common"
        description = c.string(.description) ?? ""
        color = c.string(.color)
        emoji = c.string(.emoji) ?? "✨"
    }
}

struct Treasure: Decodable, Identifiable, Hashable {
    let id: String
    let name: String
    let rarity: String
    let lat: Double
    let lng: Double
    let emoji: String?
    let powerName: String?
    let powerDescription: String?
    let powerType: String?
    let spawnedAt: String?
    let expiresAt: String?

    enum CodingKeys: String, CodingKey { case id, name, rarity, lat, lng, power, powerType, spawnedAt, expiresAt }

    private struct Power: Decodable {
        let name: String?
        let emoji: String?
        let description: String?
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = c.string(.name) ?? "Tesoro"
        rarity = c.string(.rarity) ?? "common"
        lat = c.double(.lat) ?? 0
        lng = c.double(.lng) ?? 0
        let power = try? c.decodeIfPresent(Power.self, forKey: .power)
        emoji = power?.emoji
        powerName = power?.name
        powerDescription = power?.description
        powerType = c.string(.powerType)
        spawnedAt = c.string(.spawnedAt)
        expiresAt = c.string(.expiresAt)
    }

    var coordinate: CLLocationCoordinate2D { CLLocationCoordinate2D(latitude: lat, longitude: lng) }
    var expiresDate: Date? { APIDate.parse(expiresAt) }
}

struct TreasuresResponse: Decodable {
    let treasures: [Treasure]
}
