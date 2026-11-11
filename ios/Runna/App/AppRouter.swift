import Foundation
import Observation

/// Tab selection and deep links (notifications, friend invites).
@MainActor
@Observable
final class AppRouter {
    static let shared = AppRouter()

    enum Tab: Hashable {
        case map, rankings, activity, club, profile
    }

    /// The Club tab shows my club or my friends.
    enum ClubSection: Hashable {
        case club, friends
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
    /// Opens the inventory (powers, boosts, cosmetics) on the map.
    var showPowers = false
    /// Opens the latest weekly competition summary in Rankings.
    var showWeeklySummary = false

    private init() {}

    func handle(url: URL) {
        guard url.scheme == AppConfig.urlScheme else { return }
        let parts = url.pathComponents.filter { $0 != "/" }
        switch url.host {
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
            // runnaio://tab/<map|rankings|activity|club|friends|profile>[/mine|feed|friends]
            switch parts.first {
            case "rankings": selectedTab = .rankings
            case "activity": selectedTab = .activity
            case "club":
                clubSection = parts.count >= 2 && parts[1] == "friends" ? .friends : .club
                selectedTab = .club
            case "friends": showFriends()
            case "profile": selectedTab = .profile
            default: selectedTab = .map
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
        #endif
        case "oauth":
            // runnaio://oauth/<provider>?... (normally handled by the web authentication session)
            selectedTab = .profile
            reloadSignal += 1
        default:
            break
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
        case "season_competition_started", "season_competition_finished", "rally", "challenge_completed":
            clubSection = .club
            selectedTab = .club
        case "reaction", "comment", "feed_comment", "feed_reply", "feed_mention", "friend_activity",
             "biggest_conquest", "longest_run", "fastest_pace":
            activitySection = .feed
            selectedTab = .activity
        case "area_overtake", "nickname_changed":
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
