import Foundation
import Observation

/// Tab selection and deep links (notifications, friend invites).
@MainActor
@Observable
final class AppRouter {
    static let shared = AppRouter()

    enum Tab: Hashable {
        case map, rankings, activity, club
    }

    /// The Club tab shows my club, its chat or my friends.
    enum ClubSection: Hashable {
        case club, chat, friends
    }

    enum ActivitySection: Hashable {
        case feed, mine
    }

    var selectedTab: Tab = .map
    var activitySection: ActivitySection = .feed
    var clubSection: ClubSection = .club
    /// Club invite opened from a runnaio://clubs/join/<token> link, shown once logged in.
    var pendingClubInviteToken: String?
    /// Friend invite opened from a runnaio://friends/accept/<token> link, accepted once logged in.
    var pendingInviteToken: String?
    /// Bumped when something changed elsewhere (e.g. a notification arrived) so screens reload.
    var reloadSignal = 0
    /// Opens my profile and settings (from my avatar at the top of each tab).
    var showProfile = false
    /// Opens the inventory (powers, boosts, cosmetics) on the map.
    var showPowers = false
    /// Opens the latest weekly competition summary in Rankings.
    var showWeeklySummary = false
    #if DEBUG
    /// Shows the replay's weather on its own: "rain", "snow" or "fog" (e2e screenshots).
    var weatherDemo: String?
    /// Opens the new-club form (e2e screenshots).
    var showClubFormDemo = false
    /// Asks "¿Cerrar sesión?" once Profile is open (e2e screenshots).
    var logoutConfirmDemo = false
    /// Shows the sign-in screen while signed in (e2e screenshots).
    var showAuthDemo = false
    #endif

    private init() {}

    func handle(url: URL) {
        // Universal links (https://<API host>/invite/…, /club-invite/…, /open?tab=…) open the app
        // directly when it's installed: the same as the runnaio:// link of each page
        if url.scheme == "https" || url.scheme == "http" {
            if let appLink = Self.appLink(forWeb: url) { handle(url: appLink) }
            return
        }
        guard url.scheme == AppConfig.urlScheme else { return }
        let parts = url.pathComponents.filter { $0 != "/" }
        switch url.host {
        case "run":
            // runnaio://run/start (widgets, shortcuts): opens the run screen and starts recording
            if parts.first == "start" { StartRunRequest.post(source: "link") }
        case "friends":
            // runnaio://friends/accept/<token>
            if parts.count >= 2, parts[0] == "accept" {
                pendingInviteToken = parts[1]
                showFriends()
            }
        case "clubs":
            // runnaio://clubs/join/<token>
            if parts.count >= 2, parts[0] == "join" {
                pendingClubInviteToken = parts[1]
                clubSection = .club
                selectedTab = .club
            }
        case "tab":
            // runnaio://tab/<map|rankings|activity|club|friends|profile>[/mine|feed|friends|chat]
            switch parts.first {
            case "rankings": selectedTab = .rankings
            case "activity": selectedTab = .activity
            case "club":
                clubSection = parts.count >= 2 && parts[1] == "friends" ? .friends : parts.count >= 2 && parts[1] == "chat" ? .chat : .club
                selectedTab = .club
            case "friends": showFriends()
            case "profile":
                showProfile = true
                #if DEBUG
                // runnaio://tab/profile/logout (e2e screenshots)
                if parts.count >= 2, parts[1] == "logout" { logoutConfirmDemo = true }
                #endif
            default: selectedTab = .map
            }
            // runnaio://tab/map/<global|competition>
            if parts.count >= 2, parts.first == "map", let mode = MapMode(rawValue: parts[1]) {
                MapModel.shared.mode = mode
            }
            if parts.count >= 2, parts.first == "activity" {
                activitySection = parts[1] == "mine" ? .mine : .feed
            }
        #if DEBUG
        case "powers":
            // runnaio://powers (e2e screenshots)
            selectedTab = .map
            showPowers = true
        case "weekly-summary":
            // runnaio://weekly-summary (e2e screenshots)
            selectedTab = .rankings
            showWeeklySummary = true
        case "season":
            // runnaio://season/results (e2e screenshots): the pending end-of-competition summary pops
            // up (SeasonResultsInbox only does so in tests when launched with this link)
            if parts.first == "results" {
                selectedTab = .club
            }
        case "weather":
            // runnaio://weather/<rain|snow|fog> (e2e screenshots)
            weatherDemo = parts.first ?? "rain"
        case "clubform":
            // runnaio://clubform (e2e screenshots)
            selectedTab = .club
            showClubFormDemo = true
        case "auth":
            // runnaio://auth (e2e screenshots): the sign-in screen, with the Google button
            GoogleSignIn.showButtonForScreenshots = true
            showAuthDemo = true
        #endif
        case "oauth":
            // runnaio://oauth/<provider>?... (normally handled by the web authentication session)
            showProfile = true
            reloadSignal += 1
        default:
            break
        }
    }

    /// Domains whose links open the app (com.apple.developer.associated-domains in the entitlements).
    static let universalLinkHosts: Set<String> = [AppConfig.apiBaseURL.host ?? "", "runna-io-api.runna-io-api.workers.dev"]

    /// The runnaio:// link of a web page of the Worker (pages.ts), or nil when it isn't one.
    static func appLink(forWeb url: URL) -> URL? {
        guard let host = url.host, universalLinkHosts.contains(host) else { return nil }
        let parts = url.pathComponents.filter { $0 != "/" }
        let token = parts.count >= 2 ? parts[1] : ""
        let tokenIsValid = token.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil
        switch parts.first {
        case "invite" where tokenIsValid:
            return URL(string: "\(AppConfig.urlScheme)://friends/accept/\(token)")
        case "club-invite" where tokenIsValid:
            return URL(string: "\(AppConfig.urlScheme)://clubs/join/\(token)")
        case "open":
            let tab = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "tab" }?.value ?? "map"
            let allowed = ["map", "rankings", "activity", "club", "friends", "profile"]
            return URL(string: "\(AppConfig.urlScheme)://tab/\(allowed.contains(tab) ? tab : "map")")
        default:
            return nil
        }
    }

    /// Push types of activities imported automatically from a connected service (data.routeId is the new route).
    static let autoImportTypes: Set<String> = ["strava_auto_import", "polar_auto_import", "suunto_auto_import", "garmin_auto_import"]

    /// The user tapped a push notification.
    /// - Parameters:
    ///   - type: the payload's "type".
    ///   - routeId: data.routeId (Strava/Polar/Suunto/Garmin auto-imports), shown as a conquest result on the map.
    func openNotification(type: String?, routeId: String? = nil) {
        switch type {
        case "friend_request", "friend_accepted":
            showFriends()
        case "club_invite", "club_request", "club_request_accepted", "club_member_joined":
            clubSection = .club
            selectedTab = .club
        case "season_competition_started", "season_competition_finished", "season_inactive", "rally", "challenge_completed",
             "nickname_changed", "time_bomb", "ambush":
            // The club screen: the competition and its Actividad (where a nickname can be reported)
            clubSection = .club
            selectedTab = .club
        case "club_chat":
            clubSection = .chat
            selectedTab = .club
        case "reaction", "comment", "feed_comment", "feed_reply", "feed_mention", "friend_activity",
             "biggest_conquest", "longest_run", "fastest_pace":
            activitySection = .feed
            selectedTab = .activity
        case "area_overtake":
            selectedTab = .rankings
        case "weekly_summary":
            selectedTab = .rankings
            showWeeklySummary = true
        case "strava_auto_import", "polar_auto_import", "suunto_auto_import", "garmin_auto_import":
            selectedTab = .map
            if let routeId, !routeId.isEmpty {
                ConquestInbox.shared.enqueue(routeId: routeId)
            }
        default:
            // ephemeral-photo, treasure_spawned, inactivity_reminder, territory_loss…
            selectedTab = .map
        }
        reloadSignal += 1
    }

    /// A push notification arrived while the app is open: refresh what's on screen
    /// (e.g. a taunt photo is shown right away) and queue auto-import results.
    func receivedNotificationInForeground(type: String?, routeId: String? = nil) {
        if let type, Self.autoImportTypes.contains(type), let routeId, !routeId.isEmpty {
            ConquestInbox.shared.enqueue(routeId: routeId)
        }
        reloadSignal += 1
    }

    /// Back to the initial state (logout). A pending friend invite is kept unless the caller clears it,
    /// so a link opened before logging in still works.
    /// Friends live in the Club tab.
    func showFriends() {
        clubSection = .friends
        selectedTab = .club
    }

    func reset() {
        selectedTab = .map
        activitySection = .feed
        clubSection = .club
        showPowers = false
        showWeeklySummary = false
        reloadSignal += 1
    }
}
