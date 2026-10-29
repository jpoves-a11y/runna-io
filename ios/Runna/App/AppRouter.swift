import Foundation
import CoreLocation
import Observation

/// What a push notification carries (APNs payload: {aps, type, data: {...}}).
struct NotificationPayload: Sendable {
    var type: String?
    /// Auto-imported run (conquest animation) or the run that stole territory.
    var routeId: String?
    /// Feed post to open (comments, likes, friends' runs).
    var eventId: String?
    /// Friend request to accept from the notification.
    var requestId: String?
    /// Where to centre the map (territory lost, treasure).
    var latitude: Double?
    var longitude: Double?

    var coordinate: CLLocationCoordinate2D? {
        guard let latitude, let longitude else { return nil }
        return CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
    }

    /// Reads "type" (top level or data.type) and data's fields from the notification's userInfo.
    init(userInfo: [AnyHashable: Any]) {
        let data = userInfo["data"] as? [String: Any] ?? [:]
        func string(_ key: String) -> String? {
            if let value = data[key] as? String, !value.isEmpty { return value }
            if let number = data[key] as? NSNumber { return number.stringValue }
            return userInfo[key] as? String
        }
        func number(_ key: String) -> Double? {
            (data[key] as? NSNumber)?.doubleValue ?? (data[key] as? String).flatMap(Double.init)
        }
        type = (userInfo["type"] as? String) ?? (data["type"] as? String)
        routeId = string("routeId")
        eventId = string("eventId")
        requestId = string("requestId")
        latitude = number("lat")
        longitude = number("lng")
    }
}

/// Map position asked for by a notification (consumed by MapScreen).
struct MapFocusRequest: Equatable {
    let id = UUID()
    let latitude: Double
    let longitude: Double

    var coordinate: CLLocationCoordinate2D { CLLocationCoordinate2D(latitude: latitude, longitude: longitude) }
}

/// Feed post asked for by a notification (consumed by the feed once it has loaded).
struct FeedFocusRequest: Equatable {
    let eventId: String
    /// Comments and mentions open the post's comments.
    let openComments: Bool
}

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
    /// Opens the competition powers sheet on the map.
    var showPowers = false
    /// Opens the latest weekly competition summary in Rankings.
    var showWeeklySummary = false
    /// Centre the map here (territory lost, treasure).
    var mapFocus: MapFocusRequest?
    /// Scroll the feed to this post (and open its comments).
    var feedFocus: FeedFocusRequest?
    /// Open the run screen ("Correr ahora" in a notification).
    var pendingRunStart = false

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
        case "tab":
            // runnaio://tab/<map|rankings|activity|friends|profile>
            switch parts.first {
            case "rankings": selectedTab = .rankings
            case "activity": selectedTab = .activity
            case "friends": selectedTab = .friends
            case "profile": selectedTab = .profile
            default: selectedTab = .map
            }
            if parts.count >= 2 {
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
    func openNotification(_ payload: NotificationPayload) {
        switch payload.type {
        case "friend_request", "friend_accepted":
            selectedTab = .friends
        case "reaction", "comment", "feed_comment", "feed_reply", "feed_mention", "friend_activity",
             "biggest_conquest", "longest_run", "fastest_pace":
            activitySection = .feed
            selectedTab = .activity
            if let eventId = payload.eventId {
                let isComment = ["comment", "feed_comment", "feed_reply", "feed_mention"].contains(payload.type ?? "")
                feedFocus = FeedFocusRequest(eventId: eventId, openComments: isComment)
            }
        case "area_overtake", "nickname_changed":
            selectedTab = .rankings
        case "weekly_summary":
            selectedTab = .rankings
            showWeeklySummary = true
        case "strava_auto_import", "polar_auto_import", "suunto_auto_import", "garmin_auto_import":
            selectedTab = .map
            if let routeId = payload.routeId, !routeId.isEmpty {
                ConquestInbox.shared.enqueue(routeId: routeId)
            }
        default:
            // territory_loss, treasure_spawned (centred on the place), ephemeral-photo, inactivity_reminder…
            selectedTab = .map
            focusMap(payload)
        }
        reloadSignal += 1
    }

    /// A button of a notification ("Correr ahora", "Ver en el mapa", "Aceptar").
    func handleNotificationAction(_ action: String, payload: NotificationPayload) async {
        switch action {
        case NotificationAction.run:
            selectedTab = .map
            pendingRunStart = true
        case NotificationAction.showOnMap:
            selectedTab = .map
            focusMap(payload)
            reloadSignal += 1
        case NotificationAction.acceptFriend:
            selectedTab = .friends
            if let requestId = payload.requestId {
                // The friends screen shows the result; an error leaves the request there to accept by hand
                _ = try? await APIClient.shared.send("POST", "/api/friends/requests/\(requestId)/accept", body: [:])
            }
            reloadSignal += 1
        default:
            openNotification(payload)
        }
    }

    private func focusMap(_ payload: NotificationPayload) {
        if let latitude = payload.latitude, let longitude = payload.longitude {
            mapFocus = MapFocusRequest(latitude: latitude, longitude: longitude)
        }
    }

    /// A push notification arrived while the app is open: refresh what's on screen
    /// (e.g. a taunt photo is shown right away) and queue auto-import results.
    func receivedNotificationInForeground(_ payload: NotificationPayload) {
        if let type = payload.type, Self.autoImportTypes.contains(type), let routeId = payload.routeId, !routeId.isEmpty {
            ConquestInbox.shared.enqueue(routeId: routeId)
        }
        reloadSignal += 1
    }

    /// Back to the initial state (logout). A pending friend invite is kept unless the caller clears it,
    /// so a link opened before logging in still works.
    func reset() {
        selectedTab = .map
        activitySection = .feed
        showPowers = false
        showWeeklySummary = false
        mapFocus = nil
        feedFocus = nil
        pendingRunStart = false
        reloadSignal += 1
    }
}
