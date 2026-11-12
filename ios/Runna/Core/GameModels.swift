import Foundation
import CoreLocation

// Models of the new game: Global mode, clubs, the season (competition + rest), inventory and
// challenges. Rules are explained in shared/game.ts (server).

// MARK: - Users

/// Public user reference used by the game endpoints (rankings, clubs, competitions).
struct GameUser: Decodable, Identifiable, Hashable {
    let id: String
    var username: String
    var name: String
    var color: String
    var avatar: String?
    /// Equipped cosmetic title (item id, e.g. "title_pionero")
    var title: String?

    enum CodingKeys: String, CodingKey { case id, username, name, color, avatar, title }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        username = c.string(.username) ?? ""
        name = c.string(.name) ?? ""
        color = c.string(.color) ?? "#888888"
        avatar = c.string(.avatar)
        title = c.string(.title)
    }

    var ref: UserRef { UserRef(id: id, username: username, name: name, color: color, avatar: avatar) }

    /// "Pionero" for "title_pionero" (shown next to the name).
    var titleName: String? { GameTitle.name(title) }
}

enum GameTitle {
    static func name(_ itemId: String?) -> String? {
        switch itemId ?? "" {
        case "title_pionero": return "Pionero"
        case "title_incansable": return "Incansable"
        case "title_cartografo": return "Cartógrafo"
        case "title_leyenda": return "Leyenda"
        default: return nil
        }
    }
}

// MARK: - Clubs

struct Crest: Decodable, Hashable {
    var shape: String
    var pattern: String
    var primary: String
    var secondary: String
    var icon: String
    var initials: String

    enum CodingKeys: String, CodingKey { case shape, pattern, primary, secondary, icon, initials }

    init(shape: String = "classic", pattern: String = "plain", primary: String = "#16A34A", secondary: String = "#FFFFFF", icon: String = "figure.run", initials: String = "") {
        self.shape = shape
        self.pattern = pattern
        self.primary = primary
        self.secondary = secondary
        self.icon = icon
        self.initials = initials
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        shape = c.string(.shape) ?? "classic"
        pattern = c.string(.pattern) ?? "plain"
        primary = c.string(.primary) ?? "#16A34A"
        secondary = c.string(.secondary) ?? "#FFFFFF"
        icon = c.string(.icon) ?? "figure.run"
        initials = c.string(.initials) ?? ""
    }

    var json: [String: Any] {
        ["shape": shape, "pattern": pattern, "primary": primary, "secondary": secondary, "icon": icon, "initials": initials]
    }
}

/// Crest pieces (mirrors CREST_SHAPES / CREST_PATTERNS / CREST_ICONS in shared/game.ts).
enum CrestCatalog {
    struct Piece: Identifiable, Hashable {
        let id: String
        let label: String
        /// Cosmetic item that unlocks it (nil = free)
        let unlock: String?
    }

    static let shapes: [Piece] = [
        Piece(id: "classic", label: "Clásico", unlock: nil),
        Piece(id: "round", label: "Redondo", unlock: nil),
        Piece(id: "hex", label: "Hexágono", unlock: nil),
        Piece(id: "diamond", label: "Diamante", unlock: "crest_shape_diamond"),
        Piece(id: "banner", label: "Estandarte", unlock: "crest_shape_banner"),
    ]

    static let patterns: [Piece] = [
        Piece(id: "plain", label: "Liso", unlock: nil),
        Piece(id: "stripes", label: "Franjas", unlock: nil),
        Piece(id: "chevron", label: "Chevrón", unlock: nil),
        Piece(id: "diagonal", label: "Diagonal", unlock: nil),
        Piece(id: "quartered", label: "Cuartelado", unlock: "crest_pattern_quartered"),
        Piece(id: "cross", label: "Cruz", unlock: "crest_pattern_cross"),
        Piece(id: "stars", label: "Estrellas", unlock: "crest_pattern_stars"),
    ]

    static let icons: [Piece] = [
        Piece(id: "figure.run", label: "Corredor", unlock: nil),
        Piece(id: "flame.fill", label: "Llama", unlock: nil),
        Piece(id: "bolt.fill", label: "Rayo", unlock: nil),
        Piece(id: "star.fill", label: "Estrella", unlock: nil),
        Piece(id: "leaf.fill", label: "Hoja", unlock: nil),
        Piece(id: "mountain.2.fill", label: "Montaña", unlock: nil),
        Piece(id: "hare.fill", label: "Liebre", unlock: nil),
        Piece(id: "heart.fill", label: "Corazón", unlock: nil),
        Piece(id: "sun.max.fill", label: "Sol", unlock: nil),
        Piece(id: "moon.fill", label: "Luna", unlock: nil),
        Piece(id: "pawprint.fill", label: "Huella", unlock: "crest_icon_pawprint"),
        Piece(id: "bird.fill", label: "Ave", unlock: "crest_icon_bird"),
        Piece(id: "sparkles", label: "Destellos", unlock: "crest_icon_sparkles"),
        Piece(id: "trophy.fill", label: "Trofeo", unlock: "crest_icon_trophy"),
        Piece(id: "crown.fill", label: "Corona", unlock: "crest_icon_crown"),
    ]

    static let colors: [String] = [
        "#16A34A", "#0E8A5F", "#1D4ED8", "#0EA5E9", "#7C3AED", "#DB2777",
        "#DC2626", "#EA580C", "#CA8A04", "#111827", "#6B7280", "#FFFFFF", "#FDE68A",
    ]
}

struct ClubSummary: Decodable, Identifiable, Hashable {
    let id: String
    var name: String
    var slogan: String?
    var description: String?
    var crest: Crest
    var color: String
    var visibility: String
    /// "open" (anyone joins), "approval" (leader/officers approve) or "invite_only" (not listed)
    var entryMode: String
    /// "all" (any member invites) or "officers" (only the leader and officers)
    var invitePermission: String
    var city: String?
    var countryCode: String?
    var countryName: String?
    var rating: Int
    var leaguePoints: Int
    var memberCount: Int
    var maxMembers: Int
    var joinCode: String?
    var distanceKm: Double?
    var requestPending: Bool
    var full: Bool

    enum CodingKeys: String, CodingKey {
        case id, name, slogan, description, crest, color, visibility, entryMode, invitePermission, city, countryCode, countryName, rating, leaguePoints
        case memberCount, maxMembers, joinCode, distanceKm, requestPending, full
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = c.string(.name) ?? "Club"
        slogan = c.string(.slogan)
        description = c.string(.description)
        crest = (try? c.decodeIfPresent(Crest.self, forKey: .crest)) ?? Crest()
        color = c.string(.color) ?? "#16A34A"
        visibility = c.string(.visibility) ?? "public"
        entryMode = c.string(.entryMode) ?? (visibility == "private" ? "invite_only" : "open")
        invitePermission = c.string(.invitePermission) ?? "all"
        city = c.string(.city)
        countryCode = c.string(.countryCode)
        countryName = c.string(.countryName)
        rating = c.int(.rating) ?? 1000
        leaguePoints = c.int(.leaguePoints) ?? 0
        memberCount = c.int(.memberCount) ?? 0
        maxMembers = c.int(.maxMembers) ?? 50
        joinCode = c.string(.joinCode)
        distanceKm = c.double(.distanceKm)
        requestPending = c.bool(.requestPending) ?? false
        full = c.bool(.full) ?? false
    }

    var isPrivate: Bool { entryMode == "invite_only" }
    /// Joining from its card sends a request the leader or an officer approves.
    var requiresApproval: Bool { entryMode == "approval" }

    var entryLabel: String { ClubEntry.label(entryMode) }
    var entrySymbol: String { ClubEntry.symbol(entryMode) }
}

/// The three ways into a club.
enum ClubEntry {
    static let modes = ["open", "approval", "invite_only"]

    static func label(_ mode: String) -> String {
        switch mode {
        case "approval": return "Con aprobación"
        case "invite_only": return "Solo invitación"
        default: return "Abierto"
        }
    }

    static func symbol(_ mode: String) -> String {
        switch mode {
        case "approval": return "person.badge.clock"
        case "invite_only": return "lock"
        default: return "globe"
        }
    }

    static func explanation(_ mode: String) -> String {
        switch mode {
        case "approval": return "Aparece en el buscador. Quien quiera entrar envía una solicitud y la aprueba el líder o un oficial."
        case "invite_only": return "No aparece en el buscador. Solo se entra con el código, un enlace o una invitación."
        default: return "Aparece en el buscador y cualquiera puede unirse al momento."
        }
    }
}

struct ClubMember: Decodable, Identifiable, Hashable {
    let user: GameUser
    let role: String
    let joinedAt: String?
    let globalArea: Double
    var id: String { user.id }

    enum CodingKeys: String, CodingKey { case user, role, joinedAt, globalArea }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        user = try c.decode(GameUser.self, forKey: .user)
        role = c.string(.role) ?? "member"
        joinedAt = c.string(.joinedAt)
        globalArea = c.double(.globalArea) ?? 0
    }

    var roleLabel: String? {
        switch role {
        case "owner": return "Líder"
        case "admin": return "Oficial"
        default: return nil
        }
    }
}

struct ClubJoinRequest: Decodable, Identifiable, Hashable {
    let id: String
    let user: GameUser
    let globalArea: Double
    let createdAt: String?

    enum CodingKeys: String, CodingKey { case id, user, globalArea, createdAt }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        user = try c.decode(GameUser.self, forKey: .user)
        globalArea = c.double(.globalArea) ?? 0
        createdAt = c.string(.createdAt)
    }
}

struct ClubInvite: Decodable, Identifiable, Hashable {
    let id: String
    let club: ClubSummary
    let invitedBy: GameUser?
    let createdAt: String?

    enum CodingKeys: String, CodingKey { case id, club, invitedBy, createdAt }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        club = try c.decode(ClubSummary.self, forKey: .club)
        invitedBy = try? c.decodeIfPresent(GameUser.self, forKey: .invitedBy)
        createdAt = c.string(.createdAt)
    }
}

struct ClubOwnRequest: Decodable, Identifiable, Hashable {
    let id: String
    let club: ClubSummary

    enum CodingKeys: String, CodingKey { case id, club }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        club = try c.decode(ClubSummary.self, forKey: .club)
    }
}

struct ClubHistoryEntry: Decodable, Identifiable, Hashable {
    struct Opponent: Decodable, Hashable {
        let name: String
        let score: Double

        enum CodingKeys: String, CodingKey { case name, score }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            name = c.string(.name) ?? "Rival"
            score = c.double(.score) ?? 0
        }
    }

    struct PodiumEntry: Decodable, Hashable, Identifiable {
        let userId: String
        let name: String
        let score: Double
        let rank: Int
        var id: String { userId }

        enum CodingKeys: String, CodingKey { case userId, name, score, rank }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            userId = c.string(.userId) ?? UUID().uuidString
            name = c.string(.name) ?? ""
            score = c.double(.score) ?? 0
            rank = c.int(.rank) ?? 0
        }
    }

    let competitionId: String
    let cycleNumber: Int
    let mode: String
    let modeName: String
    let finishedAt: String?
    let score: Double
    let outcome: String?
    let achieved: Bool?
    let target: Double?
    let opponent: Opponent?
    let leaguePoints: Int
    let mvp: GameUser?
    let podium: [PodiumEntry]
    var id: String { competitionId }

    private struct ModeInfoRef: Decodable { let name: String? }

    enum CodingKeys: String, CodingKey {
        case competitionId, cycleNumber, mode, modeInfo, finishedAt, score, outcome, achieved, target, opponent, leaguePoints, mvp, podium
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        competitionId = c.string(.competitionId) ?? UUID().uuidString
        cycleNumber = c.int(.cycleNumber) ?? 0
        mode = c.string(.mode) ?? "ffa"
        modeName = (try? c.decodeIfPresent(ModeInfoRef.self, forKey: .modeInfo))?.name ?? mode
        finishedAt = c.string(.finishedAt)
        score = c.double(.score) ?? 0
        outcome = c.string(.outcome)
        achieved = c.bool(.achieved)
        target = c.double(.target)
        opponent = try? c.decodeIfPresent(Opponent.self, forKey: .opponent)
        leaguePoints = c.int(.leaguePoints) ?? 0
        mvp = try? c.decodeIfPresent(GameUser.self, forKey: .mvp)
        podium = (try? c.decodeIfPresent([PodiumEntry].self, forKey: .podium)) ?? []
    }

    /// One line describing how it went.
    var summary: String {
        switch mode {
        case "duel", "derby":
            let rival = opponent.map { " contra \($0.name)" } ?? ""
            let name = mode == "derby" ? "Derbi" : "Duelo"
            switch outcome {
            case "won": return "\(name) ganado\(rival)"
            case "draw": return "\(name) empatado\(rival)"
            default: return "\(name) perdido\(rival)"
            }
        case "target":
            return achieved == true ? "Objetivo conseguido" : "Objetivo no alcanzado"
        default:
            if let winner = podium.first { return "Ganó \(winner.name)" }
            return modeName
        }
    }
}

struct ClubTrophies: Decodable, Hashable {
    let competitions: Int
    let duelsWon: Int
    let duelsDrawn: Int
    let duelsLost: Int
    let targetsAchieved: Int

    enum CodingKeys: String, CodingKey { case competitions, duelsWon, duelsDrawn, duelsLost, targetsAchieved }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        competitions = c.int(.competitions) ?? 0
        duelsWon = c.int(.duelsWon) ?? 0
        duelsDrawn = c.int(.duelsDrawn) ?? 0
        duelsLost = c.int(.duelsLost) ?? 0
        targetsAchieved = c.int(.targetsAchieved) ?? 0
    }
}

/// GET /api/clubs/mine and GET /api/clubs/:id
struct ClubDetailResponse: Decodable {
    struct RunningCompetition: Decodable, Hashable {
        let id: String
        let mode: String
        let modeName: String

        private struct ModeInfoRef: Decodable { let name: String? }

        enum CodingKeys: String, CodingKey { case id, mode, modeInfo }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = c.string(.id) ?? ""
            mode = c.string(.mode) ?? "ffa"
            modeName = (try? c.decodeIfPresent(ModeInfoRef.self, forKey: .modeInfo))?.name ?? mode
        }
    }

    let club: ClubSummary?
    let role: String?
    let isMember: Bool
    let members: [ClubMember]
    let competition: RunningCompetition?
    let pendingRequests: [ClubJoinRequest]
    let history: [ClubHistoryEntry]
    let trophies: ClubTrophies?
    let unlockedCrestPieces: [String]
    let requestPending: Bool
    /// Only in /api/clubs/mine
    let invites: [ClubInvite]
    let myRequests: [ClubOwnRequest]
    /// I can invite (personal invites, links) and see the code.
    let canInvite: Bool
    /// Only in /api/clubs/mine: club chat messages I haven't read (99 at most)
    let unreadCount: Int

    enum CodingKeys: String, CodingKey {
        case club, role, isMember, canInvite, members, competition, pendingRequests, history, trophies, unlockedCrestPieces
        case requestPending, invites, myRequests, unreadCount
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let decodedClub = try? c.decodeIfPresent(ClubSummary.self, forKey: .club)
        let decodedRole = c.string(.role)
        club = decodedClub
        role = decodedRole
        isMember = c.bool(.isMember) ?? (decodedClub != nil && decodedRole != nil)
        canInvite = c.bool(.canInvite) ?? (decodedClub?.joinCode != nil)
        members = (try? c.decodeIfPresent([ClubMember].self, forKey: .members)) ?? []
        competition = try? c.decodeIfPresent(RunningCompetition.self, forKey: .competition)
        pendingRequests = (try? c.decodeIfPresent([ClubJoinRequest].self, forKey: .pendingRequests)) ?? []
        history = (try? c.decodeIfPresent([ClubHistoryEntry].self, forKey: .history)) ?? []
        trophies = try? c.decodeIfPresent(ClubTrophies.self, forKey: .trophies)
        unlockedCrestPieces = (try? c.decodeIfPresent([String].self, forKey: .unlockedCrestPieces)) ?? []
        requestPending = c.bool(.requestPending) ?? false
        invites = (try? c.decodeIfPresent([ClubInvite].self, forKey: .invites)) ?? []
        myRequests = (try? c.decodeIfPresent([ClubOwnRequest].self, forKey: .myRequests)) ?? []
        unreadCount = c.int(.unreadCount) ?? 0
    }

    var isAdmin: Bool { role == "owner" || role == "admin" }
    var isOwner: Bool { role == "owner" }
}

struct ClubSearchResponse: Decodable {
    let clubs: [ClubSummary]

    enum CodingKeys: String, CodingKey { case clubs }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        clubs = (try? c.decodeIfPresent([ClubSummary].self, forKey: .clubs)) ?? []
    }
}

/// Responses of create / join / join-code / accept invite
struct ClubJoinResponse: Decodable {
    let club: ClubSummary?
    let joined: Bool
    let requested: Bool
    let joinedCompetition: Bool
    /// "joined", "participant", "on_first_run", "closed_entry", "next_cycle" or "none"
    let competitionEntry: String?

    enum CodingKeys: String, CodingKey { case club, joined, requested, joinedCompetition, competitionEntry }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        club = try? c.decodeIfPresent(ClubSummary.self, forKey: .club)
        joined = c.bool(.joined) ?? (club != nil)
        requested = c.bool(.requested) ?? false
        joinedCompetition = c.bool(.joinedCompetition) ?? false
        competitionEntry = c.string(.competitionEntry)
    }
}

struct ClubInviteLinkResponse: Decodable {
    let url: String
    let joinCode: String?

    enum CodingKeys: String, CodingKey { case url, joinCode }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        url = c.string(.url) ?? ""
        joinCode = c.string(.joinCode)
    }
}

struct ClubPreviewResponse: Decodable {
    let club: ClubSummary
    /// Entering with this link sends a request the leader or an officer approves.
    let requiresApproval: Bool
    /// The link is still valid (the member who made it can still invite).
    let valid: Bool

    enum CodingKeys: String, CodingKey { case club, requiresApproval, valid }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        club = try c.decode(ClubSummary.self, forKey: .club)
        requiresApproval = c.bool(.requiresApproval) ?? false
        valid = c.bool(.valid) ?? true
    }
}

// MARK: - Season

struct ModeInfo: Decodable, Hashable {
    let name: String
    let description: String

    enum CodingKeys: String, CodingKey { case name, description }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = c.string(.name) ?? ""
        description = c.string(.description) ?? ""
    }

    /// SF Symbol for a competition mode.
    static func symbol(_ mode: String) -> String {
        switch mode {
        case "teams": return "person.2"
        case "target": return "scope"
        case "duel": return "flag.2.crossed"
        case "derby": return "sportscourt"
        case "flags": return "flag.fill"
        case "elimination": return "flame"
        case "explorers": return "safari"
        default: return "person.3"
        }
    }

    /// Scores of Banderas are hours with flags; the rest, km².
    static func scoreText(mode: String, score: Double) -> String {
        if mode == "flags" {
            return "\(score.formatted(.number.precision(.fractionLength(0...1)).locale(Locale(identifier: "es_ES")))) h"
        }
        return Format.area(score)
    }
}

struct SeasonCycle: Decodable, Hashable {
    let number: Int
    /// "competition", "rest" or "preseason"
    let phase: String
    let competitionStartsAt: String
    let competitionEndsAt: String
    /// Scored at this time (Monday 06:00): runs that started before the end still count until then.
    let competitionClosesAt: String?
    /// Between the end (Sunday 23:59) and the close: the last runs are still arriving.
    let closing: Bool
    let restEndsAt: String
    let mode: String
    let modeInfo: ModeInfo?
    let nextCompetitionStartsAt: String?
    let nextMode: ModeInfo?

    enum CodingKeys: String, CodingKey {
        case number, phase, competitionStartsAt, competitionEndsAt, competitionClosesAt, closing, restEndsAt, mode, modeInfo, nextCompetitionStartsAt, nextMode
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        number = c.int(.number) ?? 0
        phase = c.string(.phase) ?? "rest"
        competitionStartsAt = c.string(.competitionStartsAt) ?? ""
        competitionEndsAt = c.string(.competitionEndsAt) ?? ""
        competitionClosesAt = c.string(.competitionClosesAt)
        closing = c.bool(.closing) ?? false
        restEndsAt = c.string(.restEndsAt) ?? ""
        mode = c.string(.mode) ?? "ffa"
        modeInfo = try? c.decodeIfPresent(ModeInfo.self, forKey: .modeInfo)
        nextCompetitionStartsAt = c.string(.nextCompetitionStartsAt)
        nextMode = try? c.decodeIfPresent(ModeInfo.self, forKey: .nextMode)
    }

    var isCompetition: Bool { phase == "competition" }
    /// Rest days (chests and challenges): also before the first competition.
    var isRest: Bool { phase == "rest" || phase == "preseason" }

    /// When the current phase ends.
    var phaseEndsAt: Date? {
        APIDate.parse(isCompetition ? competitionEndsAt : restEndsAt)
    }

    var phaseTitle: String {
        switch phase {
        case "competition": return "Competición"
        case "preseason": return "Pretemporada"
        default: return "Descanso"
        }
    }
}

struct CompetitionStanding: Decodable, Identifiable, Hashable {
    let rank: Int
    let userId: String
    let user: GameUser?
    let score: Double
    let area: Double
    let bonus: Double
    let team: Int?
    let runs: Int
    let areaStolen: Double
    let distance: Double
    /// Eliminación: the cut they fell in (nil while still in).
    let eliminatedCut: Int?
    var id: String { userId }

    enum CodingKeys: String, CodingKey { case rank, userId, user, score, area, bonus, team, runs, areaStolen, distance, eliminatedCut }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        rank = c.int(.rank) ?? 0
        userId = c.string(.userId) ?? UUID().uuidString
        user = try? c.decodeIfPresent(GameUser.self, forKey: .user)
        score = c.double(.score) ?? 0
        area = c.double(.area) ?? 0
        bonus = c.double(.bonus) ?? 0
        team = c.int(.team)
        runs = c.int(.runs) ?? 0
        areaStolen = c.double(.areaStolen) ?? 0
        distance = c.double(.distance) ?? 0
        eliminatedCut = c.int(.eliminatedCut)
    }
}

/// Banderas: a flag of the competition and who holds it.
struct CompetitionFlag: Decodable, Identifiable, Hashable {
    let id: String
    let name: String
    let latitude: Double
    let longitude: Double
    let holderId: String?
    let holder: GameUser?
    let since: String?

    enum CodingKeys: String, CodingKey { case id, name, lat, lng, holderId, holder, since }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.string(.id) ?? UUID().uuidString
        name = c.string(.name) ?? "Bandera"
        latitude = c.double(.lat) ?? 0
        longitude = c.double(.lng) ?? 0
        holderId = c.string(.holderId)
        holder = try? c.decodeIfPresent(GameUser.self, forKey: .holder)
        since = c.string(.since)
    }

    var coordinate: CLLocationCoordinate2D { CLLocationCoordinate2D(latitude: latitude, longitude: longitude) }
}

/// Eliminación: the cuts done, the next one and the current window (with the danger zone).
struct CompetitionElimination: Decodable, Hashable {
    struct Cut: Decodable, Hashable, Identifiable {
        let index: Int
        let at: String
        let remaining: Int
        let eliminated: [GameUser]
        var id: Int { index }

        enum CodingKeys: String, CodingKey { case index, at, remaining, eliminated }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            index = c.int(.index) ?? 0
            at = c.string(.at) ?? ""
            remaining = c.int(.remaining) ?? 0
            eliminated = (try? c.decodeIfPresent([GameUser].self, forKey: .eliminated)) ?? []
        }
    }

    struct NextCut: Decodable, Hashable {
        let index: Int
        let at: String
        let falls: Int

        enum CodingKeys: String, CodingKey { case index, at, falls }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            index = c.int(.index) ?? 1
            at = c.string(.at) ?? ""
            falls = c.int(.falls) ?? 0
        }
    }

    struct WindowEntry: Decodable, Hashable, Identifiable {
        let userId: String
        let user: GameUser?
        let score: Double
        let danger: Bool
        let immune: Bool
        var id: String { userId }

        enum CodingKeys: String, CodingKey { case userId, user, score, danger, immune }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            userId = c.string(.userId) ?? UUID().uuidString
            user = try? c.decodeIfPresent(GameUser.self, forKey: .user)
            score = c.double(.score) ?? 0
            danger = c.bool(.danger) ?? false
            immune = c.bool(.immune) ?? false
        }
    }

    let cuts: [Cut]
    let next: NextCut?
    let alive: Int
    let totalCuts: Int
    let window: [WindowEntry]
    let myCut: Int?

    enum CodingKeys: String, CodingKey { case cuts, next, alive, totalCuts, window, myCut }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        cuts = (try? c.decodeIfPresent([Cut].self, forKey: .cuts)) ?? []
        next = try? c.decodeIfPresent(NextCut.self, forKey: .next)
        alive = c.int(.alive) ?? 0
        totalCuts = c.int(.totalCuts) ?? 5
        window = (try? c.decodeIfPresent([WindowEntry].self, forKey: .window)) ?? []
        myCut = c.int(.myCut)
    }
}

struct CompetitionTeam: Decodable, Identifiable, Hashable {
    let index: Int
    let name: String
    let score: Double
    let members: Int
    var id: Int { index }

    enum CodingKeys: String, CodingKey { case index, name, score, members }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        index = c.int(.index) ?? 0
        name = c.string(.name) ?? "Equipo"
        score = c.double(.score) ?? 0
        members = c.int(.members) ?? 0
    }
}

struct CompetitionTarget: Decodable, Hashable {
    let target: Double
    let total: Double
    let achieved: Bool
    let progress: Double

    enum CodingKeys: String, CodingKey { case target, total, achieved, progress }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        target = c.double(.target) ?? 1
        total = c.double(.total) ?? 0
        achieved = c.bool(.achieved) ?? false
        progress = c.double(.progress) ?? 0
    }
}

struct CompetitionDuel: Decodable, Hashable {
    struct Rival: Decodable, Hashable, Identifiable {
        let userId: String
        let user: GameUser?
        let score: Double
        var id: String { userId }

        enum CodingKeys: String, CodingKey { case userId, user, score }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            userId = c.string(.userId) ?? UUID().uuidString
            user = try? c.decodeIfPresent(GameUser.self, forKey: .user)
            score = c.double(.score) ?? 0
        }
    }

    let opponent: ClubSummary?
    let runnersCounted: Int
    let perRunnerCap: Double
    let myClubScore: Double
    let opponentScore: Double
    let opponentStandings: [Rival]

    enum CodingKeys: String, CodingKey { case opponent, runnersCounted, perRunnerCap, myClubScore, opponentScore, opponentStandings }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        opponent = try? c.decodeIfPresent(ClubSummary.self, forKey: .opponent)
        runnersCounted = c.int(.runnersCounted) ?? 0
        perRunnerCap = c.double(.perRunnerCap) ?? 0
        myClubScore = c.double(.myClubScore) ?? 0
        opponentScore = c.double(.opponentScore) ?? 0
        opponentStandings = (try? c.decodeIfPresent([Rival].self, forKey: .opponentStandings)) ?? []
    }
}

/// Finished competition result (the parts the app shows).
struct CompetitionResultInfo: Decodable, Hashable {
    let outcome: String?
    let achieved: Bool?
    let winnerTeam: Int?
    let winnerUserId: String?
    let mvpUserId: String?
    let leaguePoints: Int

    enum CodingKeys: String, CodingKey { case outcome, achieved, winnerTeam, winnerUserId, mvpUserId, leaguePoints }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        outcome = c.string(.outcome)
        achieved = c.bool(.achieved)
        winnerTeam = c.int(.winnerTeam)
        winnerUserId = c.string(.winnerUserId)
        mvpUserId = c.string(.mvpUserId)
        leaguePoints = c.int(.leaguePoints) ?? 0
    }
}

/// A club competition as the app shows it (running or finished).
struct ClubCompetition: Decodable, Identifiable, Hashable {
    let id: String
    let cycleNumber: Int
    let mode: String
    let modeInfo: ModeInfo?
    let status: String
    let participants: Int
    let myRank: Int?
    let myScore: Double
    let myTeam: Int?
    let total: Double
    let standings: [CompetitionStanding]
    let teams: [CompetitionTeam]
    let target: CompetitionTarget?
    let duel: CompetitionDuel?
    let result: CompetitionResultInfo?
    /// Banderas
    let flags: [CompetitionFlag]
    let myFlags: Int
    /// Eliminación
    let elimination: CompetitionElimination?

    enum CodingKeys: String, CodingKey {
        case id, cycleNumber, mode, modeInfo, status, participants, myRank, myScore, myTeam, total, standings, teams, target, duel, result
        case flags, myFlags, elimination
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.string(.id) ?? UUID().uuidString
        cycleNumber = c.int(.cycleNumber) ?? 0
        mode = c.string(.mode) ?? "ffa"
        modeInfo = try? c.decodeIfPresent(ModeInfo.self, forKey: .modeInfo)
        status = c.string(.status) ?? "active"
        participants = c.int(.participants) ?? 0
        myRank = c.int(.myRank)
        myScore = c.double(.myScore) ?? 0
        myTeam = c.int(.myTeam)
        total = c.double(.total) ?? 0
        standings = (try? c.decodeIfPresent([CompetitionStanding].self, forKey: .standings)) ?? []
        teams = (try? c.decodeIfPresent([CompetitionTeam].self, forKey: .teams)) ?? []
        target = try? c.decodeIfPresent(CompetitionTarget.self, forKey: .target)
        duel = try? c.decodeIfPresent(CompetitionDuel.self, forKey: .duel)
        result = try? c.decodeIfPresent(CompetitionResultInfo.self, forKey: .result)
        flags = (try? c.decodeIfPresent([CompetitionFlag].self, forKey: .flags)) ?? []
        myFlags = c.int(.myFlags) ?? 0
        elimination = try? c.decodeIfPresent(CompetitionElimination.self, forKey: .elimination)
    }

    var isActive: Bool { status == "active" }

    /// A participant's score as the mode counts it: hours with flags, or km².
    func scoreText(_ score: Double) -> String {
        ModeInfo.scoreText(mode: mode, score: score)
    }
    var modeName: String { modeInfo?.name ?? mode }

    /// One-line result of a finished competition, from the user's point of view.
    func resultLine(userId: String?) -> String {
        switch mode {
        case "duel", "derby":
            let name = mode == "derby" ? "derbi" : "duelo"
            switch result?.outcome {
            case "won": return "Tu club ganó el \(name)"
            case "draw": return "\(name.capitalized) empatado"
            default: return "Tu club perdió el \(name)"
            }
        case "elimination":
            if let userId, result?.winnerUserId == userId { return "¡Fuiste el último en pie!" }
            if let cut = standings.first(where: { $0.userId == userId })?.eliminatedCut { return "Caíste en el corte \(cut)" }
            return "Eliminación terminada"
        case "target":
            return result?.achieved == true ? "Objetivo conseguido" : "Objetivo no alcanzado"
        case "teams":
            guard let winner = result?.winnerTeam else { return "Empate entre equipos" }
            return winner == myTeam ? "Tu equipo ganó" : "Tu equipo perdió"
        default:
            if let rank = myRank { return "Quedaste \(rank)º de \(participants)" }
            return "Competición terminada"
        }
    }
}

struct SeasonChallenge: Decodable, Identifiable, Hashable {
    let id: String
    let type: String
    let title: String
    let description: String
    let unit: String
    let target: Double
    let progress: Double
    let status: String
    let rewardRarity: String
    let rewardItem: ItemDefinition?

    private struct RarityRef: Decodable { let id: String? }

    enum CodingKeys: String, CodingKey { case id, type, title, description, unit, target, progress, status, reward, rewardItem }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.string(.id) ?? UUID().uuidString
        type = c.string(.type) ?? ""
        title = c.string(.title) ?? "Reto"
        description = c.string(.description) ?? ""
        unit = c.string(.unit) ?? "runs"
        target = c.double(.target) ?? 1
        progress = c.double(.progress) ?? 0
        status = c.string(.status) ?? "active"
        rewardRarity = (try? c.decodeIfPresent(RarityRef.self, forKey: .reward))?.id ?? "common"
        rewardItem = try? c.decodeIfPresent(ItemDefinition.self, forKey: .rewardItem)
    }

    var isCompleted: Bool { status == "completed" }
    var fraction: Double { target > 0 ? min(1, progress / target) : 0 }

    var progressText: String {
        switch unit {
        case "m": return "\(Format.distance(progress)) de \(Format.distance(target))"
        case "m2": return "\(Format.area(progress)) de \(Format.area(target))"
        case "days": return "\(Int(progress)) de \(Int(target)) días"
        default: return isCompleted ? "Hecho" : "Pendiente"
        }
    }
}

/// GET /api/season/current
struct SeasonCurrent: Decodable {
    struct InventorySummary: Decodable, Hashable {
        let available: Int
        let active: Int
        let cap: Int

        enum CodingKeys: String, CodingKey { case available, active, cap }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            available = c.int(.available) ?? 0
            active = c.int(.active) ?? 0
            cap = c.int(.cap) ?? 3
        }
    }

    let cycle: SeasonCycle
    let club: ClubSummary?
    let myRole: String?
    let competition: ClubCompetition?
    /// My club's competition when I don't take part in it (inactive, or joined too late), to follow it.
    let clubCompetition: ClubCompetition?
    /// "participant", "on_first_run" (enter with my first run), "closed_entry" (team against team, or
    /// after the first cut: next time), "next_cycle" (joined the club after the first 48 h)
    let competitionEntry: String?
    let lastResult: ClubCompetition?
    let challenges: [SeasonChallenge]
    let inventory: InventorySummary?

    enum CodingKeys: String, CodingKey { case cycle, club, myRole, competition, clubCompetition, competitionEntry, lastResult, challenges, inventory }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        cycle = try c.decode(SeasonCycle.self, forKey: .cycle)
        club = try? c.decodeIfPresent(ClubSummary.self, forKey: .club)
        myRole = c.string(.myRole)
        competition = try? c.decodeIfPresent(ClubCompetition.self, forKey: .competition)
        clubCompetition = try? c.decodeIfPresent(ClubCompetition.self, forKey: .clubCompetition)
        competitionEntry = c.string(.competitionEntry)
        lastResult = try? c.decodeIfPresent(ClubCompetition.self, forKey: .lastResult)
        challenges = (try? c.decodeIfPresent([SeasonChallenge].self, forKey: .challenges)) ?? []
        inventory = try? c.decodeIfPresent(InventorySummary.self, forKey: .inventory)
    }
}

struct SeasonHistoryResponse: Decodable {
    let history: [ClubCompetition]

    enum CodingKeys: String, CodingKey { case history }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        history = (try? c.decodeIfPresent([ClubCompetition].self, forKey: .history)) ?? []
    }
}

// MARK: - Items

struct ItemDefinition: Decodable, Hashable {
    let id: String
    /// "competition", "global" or "cosmetic"
    let scope: String
    let name: String
    let description: String
    let emoji: String
    let rarity: String
    /// "next_run", "timed", "instant", "target", "passive" or "owned"
    let activation: String
    let activeHours: Double?
    let usablePhase: String
    let category: String

    enum CodingKeys: String, CodingKey { case id, scope, name, description, emoji, rarity, activation, activeHours, usablePhase, category }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.string(.id) ?? ""
        scope = c.string(.scope) ?? "competition"
        name = c.string(.name) ?? "Objeto"
        description = c.string(.description) ?? ""
        emoji = c.string(.emoji) ?? ""
        rarity = c.string(.rarity) ?? "common"
        activation = c.string(.activation) ?? "next_run"
        activeHours = c.double(.activeHours)
        usablePhase = c.string(.usablePhase) ?? "competition"
        category = c.string(.category) ?? "attack"
    }

    var needsTarget: Bool { activation == "target" }
    var scopeLabel: String {
        switch scope {
        case "global": return "Global"
        case "rest": return "Descanso"
        case "cosmetic": return "Cosmético"
        default: return "Competición"
        }
    }
}

struct InventoryItem: Decodable, Identifiable, Hashable {
    let id: String
    let itemId: String
    let scope: String
    /// "available", "active", "used", "expired" or "owned"
    let status: String
    let source: String?
    let activatedAt: String?
    let activeUntil: String?
    let unusedExpiresAt: String?
    let createdAt: String?
    let definition: ItemDefinition?

    enum CodingKeys: String, CodingKey {
        case id, itemId, scope, status, source, activatedAt, activeUntil, unusedExpiresAt, createdAt, definition
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        itemId = c.string(.itemId) ?? ""
        scope = c.string(.scope) ?? "competition"
        status = c.string(.status) ?? "available"
        source = c.string(.source)
        activatedAt = c.string(.activatedAt)
        activeUntil = c.string(.activeUntil)
        unusedExpiresAt = c.string(.unusedExpiresAt)
        createdAt = c.string(.createdAt)
        definition = try? c.decodeIfPresent(ItemDefinition.self, forKey: .definition)
    }

    var name: String { definition?.name ?? itemId }
    var rarity: String { definition?.rarity ?? "common" }
    var isAvailable: Bool { status == "available" }
    var isActive: Bool {
        guard status == "active" else { return false }
        if let until = APIDate.parse(activeUntil) { return until > Date() }
        return true
    }
    var isOwnedCosmetic: Bool { status == "owned" }
    var expiresDate: Date? { APIDate.parse(unusedExpiresAt) }
    var activeUntilDate: Date? { APIDate.parse(activeUntil) }
}

struct InventoryResponse: Decodable {
    let items: [InventoryItem]
    let cap: Int
    let equippedTitle: String?

    enum CodingKeys: String, CodingKey { case items, cap, equippedTitle }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        items = (try? c.decodeIfPresent([InventoryItem].self, forKey: .items)) ?? []
        cap = c.int(.cap) ?? 3
        equippedTitle = c.string(.equippedTitle)
    }
}

/// GET /api/season/radar
struct RadarResponse: Decodable {
    let active: Bool
    let rivals: [RadarRival]

    enum CodingKeys: String, CodingKey { case active, rivals }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        active = c.bool(.active) ?? false
        rivals = (try? c.decodeIfPresent([RadarRival].self, forKey: .rivals)) ?? []
    }
}

struct RadarRival: Decodable, Identifiable {
    let user: GameUser?
    let route: RunRoute?
    var id: String { user?.id ?? route?.id ?? UUID().uuidString }

    enum CodingKeys: String, CodingKey { case user, route }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        user = try? c.decodeIfPresent(GameUser.self, forKey: .user)
        route = try? c.decodeIfPresent(RunRoute.self, forKey: .route)
    }
}

/// GET /api/global/compass (Brújula active): nearest spots not explored yet.
struct CompassResponse: Decodable {
    struct Spot: Decodable, Identifiable {
        let latitude: Double
        let longitude: Double
        let distanceMeters: Double
        var id: String { "\(latitude),\(longitude)" }
        var coordinate: CLLocationCoordinate2D { CLLocationCoordinate2D(latitude: latitude, longitude: longitude) }

        enum CodingKeys: String, CodingKey { case lat, lng, distanceMeters }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            latitude = c.double(.lat) ?? 0
            longitude = c.double(.lng) ?? 0
            distanceMeters = c.double(.distanceMeters) ?? 0
        }
    }

    let active: Bool
    let spots: [Spot]

    enum CodingKeys: String, CodingKey { case active, spots }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        active = c.bool(.active) ?? false
        spots = (try? c.decodeIfPresent([Spot].self, forKey: .spots)) ?? []
    }
}

struct ItemActivationResponse: Decodable {
    let success: Bool
    let message: String?
    let route: RunRoute?

    enum CodingKeys: String, CodingKey { case success, message, route }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        success = c.bool(.success) ?? true
        message = c.string(.message)
        route = try? c.decodeIfPresent(RunRoute.self, forKey: .route)
    }
}

// MARK: - Maps

struct Chest: Decodable, Identifiable, Hashable {
    let id: String
    let name: String
    let itemId: String
    let item: ItemDefinition?
    let rarity: String
    let lat: Double
    let lng: Double
    let zone: String?
    let hidden: Bool
    let expiresAt: String?

    private struct RarityRef: Decodable { let id: String? }

    enum CodingKeys: String, CodingKey { case id, name, itemId, item, rarity, lat, lng, zone, hidden, expiresAt }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = c.string(.name) ?? "Cofre"
        itemId = c.string(.itemId) ?? ""
        item = try? c.decodeIfPresent(ItemDefinition.self, forKey: .item)
        rarity = (try? c.decodeIfPresent(RarityRef.self, forKey: .rarity))?.id ?? c.string(.rarity) ?? "common"
        lat = c.double(.lat) ?? 0
        lng = c.double(.lng) ?? 0
        zone = c.string(.zone)
        hidden = c.bool(.hidden) ?? false
        expiresAt = c.string(.expiresAt)
    }

    var coordinate: CLLocationCoordinate2D { CLLocationCoordinate2D(latitude: lat, longitude: lng) }
    var expiresDate: Date? { APIDate.parse(expiresAt) }
}

/// GET /api/season/map
struct SeasonMapResponse: Decodable {
    struct Fortification: Decodable, Identifiable {
        let id: String
        let area: Double
        let polygons: [[[CLLocationCoordinate2D]]]

        enum CodingKeys: String, CodingKey { case id, area, geometry }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = c.string(.id) ?? UUID().uuidString
            area = c.double(.area) ?? 0
            polygons = GeoJSON.polygons(from: c.jsonObject(.geometry))
        }
    }

    let competitionId: String?
    let mode: String?
    let territories: [Territory]
    let fortifications: [Fortification]
    let chests: [Chest]
    /// Banderas: the flags and who holds them.
    let flags: [CompetitionFlag]

    enum CodingKeys: String, CodingKey { case competitionId, mode, territories, fortifications, chests, flags }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        competitionId = c.string(.competitionId)
        mode = c.string(.mode)
        territories = (try? c.decodeIfPresent([Territory].self, forKey: .territories)) ?? []
        fortifications = (try? c.decodeIfPresent([Fortification].self, forKey: .fortifications)) ?? []
        chests = (try? c.decodeIfPresent([Chest].self, forKey: .chests)) ?? []
        flags = (try? c.decodeIfPresent([CompetitionFlag].self, forKey: .flags)) ?? []
    }
}

/// GET /api/global/territories: my world map plus informative overlays of friends and club mates.
struct GlobalTerritoriesResponse: Decodable {
    struct Layer: Decodable, Identifiable {
        let user: GameUser?
        /// "friend" or "club"
        let relation: String
        let area: Double
        let polygons: [[[CLLocationCoordinate2D]]]
        var id: String { user?.id ?? "me" }

        enum CodingKeys: String, CodingKey { case user, relation, area, geometry }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            user = try? c.decodeIfPresent(GameUser.self, forKey: .user)
            relation = c.string(.relation) ?? "friend"
            area = c.double(.area) ?? 0
            polygons = GeoJSON.polygons(from: c.jsonObject(.geometry))
        }
    }

    let me: Layer?
    let overlays: [Layer]

    enum CodingKeys: String, CodingKey { case me, overlays }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        me = try? c.decodeIfPresent(Layer.self, forKey: .me)
        overlays = (try? c.decodeIfPresent([Layer].self, forKey: .overlays)) ?? []
    }
}

/// GET /api/global/me
struct GlobalMe: Decodable, Hashable {
    let area: Double
    let bonusArea: Double
    let monthArea: Double
    let worldRank: Int?
    let countryRank: Int?
    let cityRank: Int?
    let monthRank: Int?
    let city: String?
    let countryCode: String?
    let countryName: String?
    let canChangeLocationAt: String?
    let streakDays: Int
    let title: String?

    private struct Ranks: Decodable {
        let world: Int?
        let country: Int?
        let city: Int?
        let month: Int?
    }

    private struct Location: Decodable {
        let city: String?
        let countryCode: String?
        let countryName: String?
        let canChangeAt: String?
    }

    private struct Streak: Decodable {
        let days: Int?
    }

    enum CodingKeys: String, CodingKey { case area, bonusArea, monthArea, ranks, location, streak, title }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        area = c.double(.area) ?? 0
        bonusArea = c.double(.bonusArea) ?? 0
        monthArea = c.double(.monthArea) ?? 0
        let ranks = try? c.decodeIfPresent(Ranks.self, forKey: .ranks)
        worldRank = ranks?.world
        countryRank = ranks?.country
        cityRank = ranks?.city
        monthRank = ranks?.month
        let location = try? c.decodeIfPresent(Location.self, forKey: .location)
        city = location?.city
        countryCode = location?.countryCode
        countryName = location?.countryName
        canChangeLocationAt = location?.canChangeAt
        streakDays = (try? c.decodeIfPresent(Streak.self, forKey: .streak))?.days ?? 0
        title = c.string(.title)
    }
}

// MARK: - Rankings

struct GlobalRankingResponse: Decodable {
    struct Entry: Decodable, Identifiable, Hashable {
        struct ClubTag: Decodable, Hashable {
            let id: String
            let name: String
            let crest: Crest

            enum CodingKeys: String, CodingKey { case id, name, crest }

            init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: CodingKeys.self)
                id = c.string(.id) ?? ""
                name = c.string(.name) ?? ""
                crest = (try? c.decodeIfPresent(Crest.self, forKey: .crest)) ?? Crest()
            }
        }

        let rank: Int
        let user: GameUser
        let area: Double
        let club: ClubTag?
        var id: String { user.id }

        enum CodingKeys: String, CodingKey { case rank, user, area, club }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            rank = c.int(.rank) ?? 0
            user = try c.decode(GameUser.self, forKey: .user)
            area = c.double(.area) ?? 0
            club = try? c.decodeIfPresent(ClubTag.self, forKey: .club)
        }
    }

    private struct Me: Decodable {
        let rank: Int?
        let area: Double?
    }

    let scope: String
    let period: String
    let label: String
    let entries: [Entry]
    let myRank: Int?
    let myArea: Double

    enum CodingKeys: String, CodingKey { case scope, period, label, entries, me }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        scope = c.string(.scope) ?? "world"
        period = c.string(.period) ?? "all"
        label = c.string(.label) ?? ""
        entries = (try? c.decodeIfPresent([Entry].self, forKey: .entries)) ?? []
        let me = try? c.decodeIfPresent(Me.self, forKey: .me)
        myRank = me?.rank
        myArea = me?.area ?? 0
    }
}

struct ClubRankingResponse: Decodable {
    struct Entry: Decodable, Identifiable, Hashable {
        let rank: Int
        let club: ClubSummary
        let score: Double
        var id: String { club.id }

        enum CodingKeys: String, CodingKey { case rank, club, score }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            rank = c.int(.rank) ?? 0
            club = try c.decode(ClubSummary.self, forKey: .club)
            score = c.double(.score) ?? 0
        }
    }

    let entries: [Entry]
    let myClubId: String?
    let myClubRank: Int?

    enum CodingKeys: String, CodingKey { case entries, myClubId, myClubRank }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        entries = (try? c.decodeIfPresent([Entry].self, forKey: .entries)) ?? []
        myClubId = c.string(.myClubId)
        myClubRank = c.int(.myClubRank)
    }
}

// MARK: - Awards and end-of-competition summary

/// An award won when a competition closes (Conquistador, Ladrón, Fondista…).
/// In a summary `count` is 1; on the profile it is how many times it was won.
struct AwardInfo: Decodable, Identifiable, Hashable {
    let id: String
    let name: String
    /// SF Symbol sent by the API
    let symbol: String
    let description: String
    let count: Int

    enum CodingKeys: String, CodingKey { case id, name, symbol, description, count }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.string(.id) ?? UUID().uuidString
        name = c.string(.name) ?? "Logro"
        symbol = c.string(.symbol) ?? "rosette"
        description = c.string(.description) ?? ""
        count = c.int(.count) ?? 1
    }
}

/// GET /api/season/results/pending and /api/season/results/:id: what the window shown when a
/// competition closes tells each member.
struct CompetitionResultSummary: Decodable, Identifiable, Hashable {
    struct Club: Decodable, Hashable {
        let id: String
        let name: String
        let crest: Crest

        enum CodingKeys: String, CodingKey { case id, name, crest }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = c.string(.id) ?? ""
            name = c.string(.name) ?? "Club"
            crest = (try? c.decodeIfPresent(Crest.self, forKey: .crest)) ?? Crest()
        }
    }

    /// A runner of the club (winner, MVP or podium).
    struct Runner: Decodable, Hashable, Identifiable {
        let id: String
        let name: String
        let avatar: String?
        let color: String
        let rank: Int?
        let score: Double?

        enum CodingKeys: String, CodingKey { case id, userId, name, avatar, color, rank, score }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = c.string(.userId) ?? c.string(.id) ?? UUID().uuidString
            name = c.string(.name) ?? "Corredor"
            avatar = c.string(.avatar)
            color = c.string(.color) ?? "#888888"
            rank = c.int(.rank)
            score = c.double(.score)
        }
    }

    struct Opponent: Decodable, Hashable {
        let name: String
        let crest: Crest?
        let score: Double

        enum CodingKeys: String, CodingKey { case name, crest, score }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            name = c.string(.name) ?? "Rival"
            crest = try? c.decodeIfPresent(Crest.self, forKey: .crest)
            score = c.double(.score) ?? 0
        }
    }

    struct ClubResult: Decodable, Hashable {
        let total: Double
        let participants: Int
        let winner: Runner?
        let mvp: Runner?
        let podium: [Runner]
        let teamScores: [Double]
        let teamNames: [String]
        let winnerTeam: Int?
        let target: Double?
        let achieved: Bool?
        let opponent: Opponent?
        /// Duelo / Derbi: "won", "draw" or "lost"
        let outcome: String?
        let ratingChange: Int?
        let leaguePoints: Int

        enum CodingKeys: String, CodingKey {
            case total, participants, winner, mvp, podium, teamScores, teamNames, winnerTeam, target, achieved, opponent, outcome, ratingChange, leaguePoints
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            total = c.double(.total) ?? 0
            participants = c.int(.participants) ?? 0
            winner = try? c.decodeIfPresent(Runner.self, forKey: .winner)
            mvp = try? c.decodeIfPresent(Runner.self, forKey: .mvp)
            podium = (try? c.decodeIfPresent([Runner].self, forKey: .podium)) ?? []
            teamScores = (try? c.decodeIfPresent([Double].self, forKey: .teamScores)) ?? []
            teamNames = (try? c.decodeIfPresent([String].self, forKey: .teamNames)) ?? []
            winnerTeam = c.int(.winnerTeam)
            target = c.double(.target)
            achieved = c.bool(.achieved)
            opponent = try? c.decodeIfPresent(Opponent.self, forKey: .opponent)
            outcome = c.string(.outcome)
            ratingChange = c.int(.ratingChange)
            leaguePoints = c.int(.leaguePoints) ?? 0
        }

        func teamName(_ index: Int) -> String {
            index < teamNames.count ? teamNames[index] : "Equipo \(index + 1)"
        }
    }

    /// The user's own numbers (nil when they didn't take part).
    struct Mine: Decodable, Hashable {
        let rank: Int?
        let of: Int
        let score: Double
        let team: Int?
        let areaStolen: Double
        let areaLost: Double
        let distance: Double
        let runs: Int
        let days: Int
        let eliminatedCut: Int?

        enum CodingKeys: String, CodingKey { case rank, of, score, team, areaStolen, areaLost, distance, runs, days, eliminatedCut }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            rank = c.int(.rank)
            of = c.int(.of) ?? 0
            score = c.double(.score) ?? 0
            team = c.int(.team)
            areaStolen = c.double(.areaStolen) ?? 0
            areaLost = c.double(.areaLost) ?? 0
            distance = c.double(.distance) ?? 0
            runs = c.int(.runs) ?? 0
            days = c.int(.days) ?? 0
            eliminatedCut = c.int(.eliminatedCut)
        }
    }

    struct Next: Decodable, Hashable {
        let cycleNumber: Int
        let mode: String
        let modeName: String
        let modeDescription: String
        let startsAt: String?
        /// Already started (the summary was opened days later)
        let running: Bool

        private struct ModeInfoRef: Decodable { let name: String?; let description: String? }

        enum CodingKeys: String, CodingKey { case cycleNumber, mode, modeInfo, startsAt, running }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            cycleNumber = c.int(.cycleNumber) ?? 0
            mode = c.string(.mode) ?? "ffa"
            let info = try? c.decodeIfPresent(ModeInfoRef.self, forKey: .modeInfo)
            modeName = info?.name ?? mode
            modeDescription = info?.description ?? ""
            startsAt = c.string(.startsAt)
            running = c.bool(.running) ?? false
        }

        var startDate: Date? { APIDate.parse(startsAt) }
    }

    let competitionId: String
    let cycleNumber: Int
    let mode: String
    let modeName: String
    let finishedAt: String?
    let participated: Bool
    let club: Club?
    let clubResult: ClubResult
    let me: Mine?
    let awards: [AwardInfo]
    let rewards: [InventoryItem]
    let next: Next?
    var id: String { competitionId }

    private struct ModeInfoRef: Decodable { let name: String? }

    enum CodingKeys: String, CodingKey {
        case competitionId, cycleNumber, mode, modeInfo, finishedAt, participated, club, clubResult, me, awards, rewards, next
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        competitionId = c.string(.competitionId) ?? UUID().uuidString
        cycleNumber = c.int(.cycleNumber) ?? 0
        mode = c.string(.mode) ?? "ffa"
        modeName = (try? c.decodeIfPresent(ModeInfoRef.self, forKey: .modeInfo))?.name ?? mode
        finishedAt = c.string(.finishedAt)
        participated = c.bool(.participated) ?? false
        club = try? c.decodeIfPresent(Club.self, forKey: .club)
        clubResult = try c.decode(ClubResult.self, forKey: .clubResult)
        me = try? c.decodeIfPresent(Mine.self, forKey: .me)
        awards = (try? c.decodeIfPresent([AwardInfo].self, forKey: .awards)) ?? []
        rewards = (try? c.decodeIfPresent([InventoryItem].self, forKey: .rewards)) ?? []
        next = try? c.decodeIfPresent(Next.self, forKey: .next)
    }

    /// How it went for the club, in one line.
    func headline(myUserId: String?) -> String {
        let r = clubResult
        switch mode {
        case "duel", "derby":
            let name = mode == "derby" ? "Derbi" : "Duelo"
            switch r.outcome {
            case "won": return "\(name) ganado"
            case "draw": return "\(name) empatado"
            default: return "\(name) perdido"
            }
        case "target":
            return r.achieved == true ? "Objetivo conseguido" : "Objetivo no alcanzado"
        case "teams":
            guard let winnerTeam = r.winnerTeam else { return "Empate entre equipos" }
            if let myTeam = me?.team { return myTeam == winnerTeam ? "Tu equipo ha ganado" : "Ha ganado \(r.teamName(winnerTeam))" }
            return "Ha ganado \(r.teamName(winnerTeam))"
        case "elimination":
            guard let winner = r.winner else { return "Eliminación terminada" }
            return winner.id == myUserId ? "Eres el último en pie" : "\(winner.name) es el último en pie"
        default:
            guard let winner = r.winner ?? r.podium.first else { return "Competición terminada" }
            return winner.id == myUserId ? "Has ganado" : "Ha ganado \(winner.name)"
        }
    }

    /// The score behind the headline (both clubs, both teams, the target).
    var scoreLine: String? {
        let r = clubResult
        switch mode {
        case "duel", "derby":
            guard let opponent = r.opponent else { return nil }
            return "\(Format.area(r.total)) – \(Format.area(opponent.score)) contra \(opponent.name)"
        case "target":
            guard let target = r.target else { return nil }
            return "\(Format.area(r.total)) de \(Format.area(target))"
        case "teams":
            guard r.teamScores.count >= 2 else { return nil }
            return "\(r.teamName(0)) \(Format.area(r.teamScores[0])) · \(r.teamName(1)) \(Format.area(r.teamScores[1]))"
        default:
            return r.participants > 0 ? "\(r.participants) participantes" : nil
        }
    }

    func scoreText(_ score: Double) -> String { ModeInfo.scoreText(mode: mode, score: score) }
}

struct SeasonResultsPendingResponse: Decodable {
    let results: [CompetitionResultSummary]
}

struct SeasonResultResponse: Decodable {
    let result: CompetitionResultSummary
}


// MARK: - Club chat

/// A message of the club chat (GET /api/clubs/:id/messages). System messages have no user.
struct ClubChatMessage: Decodable, Identifiable, Hashable {
    struct Reply: Decodable, Hashable {
        let id: String
        let userName: String
        /// nil when it was deleted or its author is blocked
        let body: String?

        enum CodingKeys: String, CodingKey { case id, userName, body }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = c.string(.id) ?? ""
            userName = c.string(.userName) ?? ""
            body = c.string(.body)
        }
    }

    struct Reaction: Decodable, Hashable, Identifiable {
        let emoji: String
        let count: Int
        let mine: Bool
        var id: String { emoji }

        enum CodingKeys: String, CodingKey { case emoji, count, mine }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            emoji = c.string(.emoji) ?? ""
            count = c.int(.count) ?? 0
            mine = c.bool(.mine) ?? false
        }
    }

    let id: String
    let kind: String
    let user: GameUser?
    let body: String?
    let deleted: Bool
    let deletedByModerator: Bool
    let replyTo: Reply?
    let mentions: [String]
    var reactions: [Reaction]
    let createdAt: String?

    enum CodingKeys: String, CodingKey { case id, kind, user, body, deleted, deletedByModerator, replyTo, mentions, reactions, createdAt }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = c.string(.kind) ?? "user"
        user = try? c.decodeIfPresent(GameUser.self, forKey: .user)
        body = c.string(.body)
        deleted = c.bool(.deleted) ?? false
        deletedByModerator = c.bool(.deletedByModerator) ?? false
        replyTo = try? c.decodeIfPresent(Reply.self, forKey: .replyTo)
        mentions = (try? c.decodeIfPresent([String].self, forKey: .mentions)) ?? []
        reactions = (try? c.decodeIfPresent([Reaction].self, forKey: .reactions)) ?? []
        createdAt = c.string(.createdAt)
    }

    var isSystem: Bool { kind == "system" }
    var date: Date? { APIDate.parse(createdAt) }
}

struct ClubChatResponse: Decodable {
    struct Me: Decodable {
        let role: String?
        let canModerate: Bool
        let mutedUntil: String?

        enum CodingKeys: String, CodingKey { case role, canModerate, mutedUntil }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            role = c.string(.role)
            canModerate = c.bool(.canModerate) ?? false
            mutedUntil = c.string(.mutedUntil)
        }
    }

    struct Mute: Decodable, Hashable {
        let userId: String
        let until: String
    }

    let messages: [ClubChatMessage]
    let hasMore: Bool
    let reactions: [String]
    let me: Me?
    let mutes: [Mute]

    enum CodingKeys: String, CodingKey { case messages, hasMore, reactions, me, mutes }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        messages = (try? c.decodeIfPresent([ClubChatMessage].self, forKey: .messages)) ?? []
        hasMore = c.bool(.hasMore) ?? false
        reactions = (try? c.decodeIfPresent([String].self, forKey: .reactions)) ?? ["👍", "❤️", "🔥", "😂", "👏", "💪"]
        me = try? c.decodeIfPresent(Me.self, forKey: .me)
        mutes = (try? c.decodeIfPresent([Mute].self, forKey: .mutes)) ?? []
    }
}

struct ClubChatPostResponse: Decodable {
    let message: ClubChatMessage
}

struct ClubChatReactionResponse: Decodable {
    let reactions: [ClubChatMessage.Reaction]
}
