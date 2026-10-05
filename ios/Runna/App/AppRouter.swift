import Foundation
import Observation

/// Tab selection and deep links (notifications, friend invites).
@MainActor
@Observable
final class AppRouter {
    static let shared = AppRouter()

    enum Tab: Hashable {
        case map, rankings, activity, friends, profile
    }

    enum ActivitySection: Hashable {
        case feed, mine
    }

    var selectedTab: Tab = .map
    var activitySection: ActivitySection = .feed
    /// Friend invite opened from a runnaio://friends/accept/<token> link, accepted once logged in.
    var pendingInviteToken: String?
    /// Bumped when something changed elsewhere (e.g. a notification arrived) so screens reload.
    var reloadSignal = 0

    private init() {}

    func handle(url: URL) {
        guard url.scheme == AppConfig.urlScheme else { return }
        let parts = url.pathComponents.filter { $0 != "/" }
        switch url.host {
        case "friends":
            // runnaio://friends/accept/<token>
            if parts.count >= 2, parts[0] == "accept" {
                pendingInviteToken = parts[1]
                selectedTab = .friends
            }
        case "oauth":
            // runnaio://oauth/<provider>?... (normally handled by the web authentication session)
            selectedTab = .profile
            reloadSignal += 1
        default:
            break
        }
    }

    func openNotification(type: String?) {
        switch type {
        case "friend_request", "friend_accepted":
            selectedTab = .friends
        case "reaction", "comment", "feed_comment", "feed_reply", "feed_mention", "friend_activity":
            activitySection = .feed
            selectedTab = .activity
        case "area_overtake", "weekly_summary":
            selectedTab = .rankings
        case "strava_auto_import", "polar_auto_import":
            activitySection = .mine
            selectedTab = .activity
        default:
            selectedTab = .map
        }
        reloadSignal += 1
    }
}
