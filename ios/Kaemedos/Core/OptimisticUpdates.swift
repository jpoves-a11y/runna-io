import SwiftUI

// Optimistic updates: the screen changes the moment the user taps (like, comment, accept a request,
// rename…), the request goes to the server in the background, and the change is rolled back with a
// short message if the server says no. The cached GET bodies are patched too, so every screen that
// draws from ResponseCache (feed, "Mis carreras", map, profile) agrees right away.

// MARK: - Cached bodies

enum OptimisticCache {
    /// Id prefix of items created locally that the server doesn't know yet (a comment being sent,
    /// the feed card of a run just uploaded). They can't be liked, commented or deleted until the
    /// server's version replaces them.
    static let localPrefix = "local-"

    static func isLocal(_ id: String) -> Bool {
        id.hasPrefix(localPrefix)
    }

    static func localId() -> String {
        localPrefix + UUID().uuidString.lowercased()
    }

    /// Feed pages: GET /api/feed/:userId (not the per-event comment endpoints).
    private static func isFeedPage(_ key: String) -> Bool {
        key.hasPrefix("/api/feed/") && !key.hasPrefix("/api/feed/events/")
    }

    /// Applies `change` to every element (dictionary) of every cached array whose key matches,
    /// for elements where `select` is true. Returns nil for bodies that didn't change.
    private static func patchElements(
        where matches: (String) -> Bool,
        select: @escaping ([String: Any]) -> Bool,
        change: @escaping ([String: Any]) -> [String: Any]
    ) {
        ResponseCache.shared.patchJSON(where: matches) { object -> Any? in
            guard let array = object as? [Any] else { return nil }
            var changed = false
            let updated: [Any] = array.map { element -> Any in
                guard let dictionary = element as? [String: Any], select(dictionary) else { return element }
                changed = true
                return change(dictionary)
            }
            return changed ? updated : nil
        }
    }

    /// The string, or JSON null.
    static func nullable(_ value: String?) -> Any {
        if let value { return value }
        return NSNull()
    }

    /// Likes / dislikes of a feed event in the cached feed pages.
    static func setEventReaction(eventId: String, state: ReactionState) {
        patchElements(where: isFeedPage, select: { ($0["id"] as? String) == eventId }) { event in
            var copy = event
            copy["likeCount"] = state.likeCount
            copy["dislikeCount"] = state.dislikeCount
            copy["userReaction"] = nullable(state.userReaction)
            return copy
        }
    }

    /// Comment counter of a feed event in the cached feed pages.
    static func setCommentCount(eventId: String, count: Int) {
        patchElements(where: isFeedPage, select: { ($0["id"] as? String) == eventId }) { event in
            var copy = event
            copy["commentCount"] = count
            return copy
        }
    }

    /// Likes / dislikes of a comment (or reply) in the cached comment lists of its event.
    static func setCommentReaction(eventId: String, commentId: String, state: ReactionState) {
        let prefix = "/api/feed/events/\(eventId)/"
        ResponseCache.shared.patchJSON(where: { $0.hasPrefix(prefix) }) { object -> Any? in
            guard let array = object as? [Any] else { return nil }
            var changed = false
            let updated: [Any] = array.map { element -> Any in
                guard var comment = element as? [String: Any] else { return element }
                if (comment["id"] as? String) == commentId {
                    comment["likeCount"] = state.likeCount
                    comment["dislikeCount"] = state.dislikeCount
                    comment["userReaction"] = nullable(state.userReaction)
                    changed = true
                    return comment
                }
                if let replies = comment["replies"] as? [Any] {
                    var repliesChanged = false
                    let newReplies: [Any] = replies.map { reply -> Any in
                        guard var item = reply as? [String: Any], (item["id"] as? String) == commentId else { return reply }
                        item["likeCount"] = state.likeCount
                        item["dislikeCount"] = state.dislikeCount
                        item["userReaction"] = nullable(state.userReaction)
                        repliesChanged = true
                        return item
                    }
                    if repliesChanged {
                        comment["replies"] = newReplies
                        changed = true
                    }
                }
                return comment
            }
            return changed ? updated : nil
        }
    }

    /// New name of a run in "Mis carreras" / map / profile lists and on its feed cards.
    static func renameRoute(routeId: String, name: String) {
        patchElements(where: { $0.hasPrefix("/api/routes/") }, select: { ($0["id"] as? String) == routeId }) { route in
            var copy = route
            copy["name"] = name
            return copy
        }
        patchElements(where: isFeedPage, select: { ($0["routeId"] as? String) == routeId }) { event in
            var copy = event
            copy["routeName"] = name
            return copy
        }
    }

    /// Removes an element (a friend request, a friend) by id from the cached lists under `prefix`.
    static func removeElement(id: String, keyPrefix prefix: String) {
        ResponseCache.shared.patchJSON(where: { $0.hasPrefix(prefix) }) { object -> Any? in
            guard let array = object as? [Any] else { return nil }
            let filtered: [Any] = array.filter { element in
                guard let dictionary = element as? [String: Any] else { return true }
                return (dictionary["id"] as? String) != id
            }
            return filtered.count == array.count ? nil : filtered
        }
    }

    /// Puts a JSON element first in the cached list at exactly `key` (path + query), unless an
    /// element with the same id is already there.
    static func prepend(_ element: [String: Any], toKey key: String) {
        guard let id = element["id"] as? String else { return }
        ResponseCache.shared.patchJSON(where: { $0 == key }) { object -> Any? in
            guard let array = object as? [Any] else { return nil }
            let exists = array.contains { item in
                ((item as? [String: Any])?["id"] as? String) == id
            }
            guard !exists else { return nil }
            let head: [Any] = [element]
            return head + array
        }
    }

    /// Decodes a locally built JSON object into one of the app's models (they only have Decodable inits).
    static func decode<T: Decodable>(_ type: T.Type, from object: [String: Any]) -> T? {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object, options: []) else { return nil }
        return try? APIClient.shared.decodeBody(T.self, from: data)
    }

    /// Current time as the API writes it (ISO 8601 with milliseconds).
    static func nowString() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date())
    }
}

// MARK: - Reactions

/// Like / dislike counters of an event or a comment, and the user's own reaction.
struct ReactionState: Equatable {
    var likeCount: Int
    var dislikeCount: Int
    var userReaction: String?

    init(likeCount: Int, dislikeCount: Int, userReaction: String?) {
        self.likeCount = likeCount
        self.dislikeCount = dislikeCount
        self.userReaction = userReaction
    }

    init(_ result: ReactionResult) {
        likeCount = result.likeCount
        dislikeCount = result.dislikeCount
        userReaction = result.userReaction
    }

    /// The counters right after tapping `reaction` ("like" / "dislike"): same reaction again removes
    /// it, the other one switches, none adds it (what the server's toggle does).
    func toggled(_ reaction: String) -> ReactionState {
        var next = self
        if userReaction == reaction {
            next.userReaction = nil
            if reaction == "like" {
                next.likeCount = max(0, likeCount - 1)
            } else {
                next.dislikeCount = max(0, dislikeCount - 1)
            }
            return next
        }
        if userReaction == "like" { next.likeCount = max(0, next.likeCount - 1) }
        if userReaction == "dislike" { next.dislikeCount = max(0, next.dislikeCount - 1) }
        if reaction == "like" {
            next.likeCount += 1
        } else {
            next.dislikeCount += 1
        }
        next.userReaction = reaction
        return next
    }
}

/// Sends reactions in the background, one request at a time per target, so fast repeated taps end
/// in the state the user saw last (POST /api/feed/reactions toggles on the server).
@MainActor
final class ReactionSync {
    private struct Wanted {
        let reaction: String?
    }

    private var wanted: [String: Wanted] = [:]
    /// Last state confirmed by the server, per target with requests in flight.
    private var confirmed: [String: ReactionState] = [:]
    private var running: Set<String> = []

    /// - Parameters:
    ///   - before: what was shown before this tap (the server's state when nothing is in flight).
    ///   - after: the optimistic state now shown.
    ///   - onSettled: the server's final state (counts may include other people's reactions).
    ///   - onFailed: the last state the server confirmed (to roll back to) and a short message.
    func send(
        targetType: String,
        targetId: String,
        before: ReactionState,
        after: ReactionState,
        onSettled: @escaping @MainActor (ReactionState) -> Void,
        onFailed: @escaping @MainActor (ReactionState, String) -> Void
    ) {
        wanted[targetId] = Wanted(reaction: after.userReaction)
        guard !running.contains(targetId) else { return }
        confirmed[targetId] = before
        running.insert(targetId)
        Task { @MainActor in
            await self.drain(targetType: targetType, targetId: targetId, onSettled: onSettled, onFailed: onFailed)
        }
    }

    private func finish(_ targetId: String) {
        running.remove(targetId)
        wanted[targetId] = nil
        confirmed[targetId] = nil
    }

    private func drain(
        targetType: String,
        targetId: String,
        onSettled: @escaping @MainActor (ReactionState) -> Void,
        onFailed: @escaping @MainActor (ReactionState, String) -> Void
    ) async {
        var attempts = 0
        while attempts < 4 {
            guard let base = confirmed[targetId] else {
                finish(targetId)
                return
            }
            let target: String? = wanted[targetId]?.reaction
            if base.userReaction == target {
                finish(targetId)
                onSettled(base)
                return
            }
            // Removing sends the current reaction again (toggle off); otherwise the wanted one
            let reaction: String = target ?? base.userReaction ?? "like"
            attempts += 1
            do {
                let result = try await APIClient.shared.request(
                    "POST", "/api/feed/reactions",
                    body: ["targetType": targetType, "targetId": targetId, "reactionType": reaction],
                    as: ReactionResult.self
                )
                confirmed[targetId] = ReactionState(result)
            } catch {
                finish(targetId)
                onFailed(base, "No se ha podido guardar tu reacción. Inténtalo de nuevo.")
                return
            }
        }
        let last: ReactionState? = confirmed[targetId]
        finish(targetId)
        if let last {
            onSettled(last)
        }
    }
}

// MARK: - Your runs, right after uploading them

@MainActor
enum UploadedRuns {
    /// A run was just accepted by the server: show it at once in "Mis carreras" (and the map, which
    /// shares that cache) and at the top of the feed, before any refetch. The next refresh replaces
    /// the local feed card with the server's one (created in the same request).
    static func didUpload(_ route: RunRoute) {
        let routeJSON: [String: Any] = [
            "id": route.id,
            "userId": route.userId,
            "name": route.name,
            "coordinates": route.coordinates,
            "distance": route.distance,
            "duration": route.duration,
            "startedAt": route.startedAt,
            "completedAt": route.completedAt,
            "territory": NSNull(),
            "ranTogetherWithUsers": [Any](),
        ]
        OptimisticCache.prepend(routeJSON, toKey: "/api/routes/\(route.userId)")
        MyRoutesModel.shared.insertUploaded(route)

        guard let me = APIClient.shared.cached("/api/current-user/\(route.userId)", as: AppUser.self) else { return }
        let user: [String: Any] = [
            "id": me.id,
            "username": me.username,
            "name": me.name,
            "color": me.color,
            "avatar": OptimisticCache.nullable(me.avatar),
        ]
        let event: [String: Any] = [
            "id": OptimisticCache.localPrefix + "run-" + route.id,
            "userId": route.userId,
            "eventType": "activity",
            "routeId": route.id,
            "distance": route.distance,
            "duration": route.duration,
            "newArea": 0,
            "createdAt": OptimisticCache.nowString(),
            "activityDate": route.startedAt,
            "user": user,
            "routeName": route.name,
            "routeCoordinates": route.coordinates,
            "commentCount": 0,
            "likeCount": 0,
            "dislikeCount": 0,
            "userReaction": NSNull(),
        ]
        let feedKey = ResponseCache.key(path: "/api/feed/\(route.userId)", query: FeedModel.firstPageQuery)
        OptimisticCache.prepend(event, toKey: feedKey)
        if let card = OptimisticCache.decode(FeedEvent.self, from: event) {
            FeedModel.shared.insertLocal(card, userId: route.userId)
        }
    }
}

// MARK: - Pull to refresh

enum QuickRefresh {
    /// Runs `work` (a refresh that keeps the cached data on screen) and returns as soon as it ends
    /// or `maxWait` seconds pass, whichever comes first: the pull-to-refresh spinner goes away fast
    /// and the new data, when it arrives, replaces the old one in place.
    @MainActor
    static func run(maxWait: Double = 0.8, _ work: @escaping @MainActor () async -> Void) async {
        let box = FinishedBox()
        Task { @MainActor in
            await work()
            box.finished = true
        }
        let deadline = Date().addingTimeInterval(maxWait)
        while !box.finished && Date() < deadline {
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
    }

    @MainActor
    private final class FinishedBox {
        var finished = false
    }
}

// MARK: - Short error message

extension View {
    /// A small banner at the bottom that hides itself after a few seconds (failed optimistic updates).
    func errorToast(_ message: Binding<String?>) -> some View {
        modifier(ErrorToastModifier(message: message))
    }
}

private struct ErrorToastModifier: ViewModifier {
    @Binding var message: String?

    func body(content: Content) -> some View {
        content
            .overlay(alignment: .bottom) {
                if let text = message {
                    ErrorBanner(message: text, onDismiss: { message = nil })
                        .padding(.horizontal, DS.Spacing.l)
                        .padding(.bottom, DS.Spacing.l)
                        .shadow(color: Color.black.opacity(0.12), radius: 10, y: 4)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                        .task(id: text) {
                            try? await Task.sleep(nanoseconds: 3_500_000_000)
                            if !Task.isCancelled, message == text {
                                message = nil
                            }
                        }
                }
            }
            .animation(.snappy, value: message)
    }
}
