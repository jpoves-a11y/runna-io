import Foundation

/// Warms the response cache of the tabs the user hasn't opened yet (ranking, activity, friends, profile)
/// once per session, right after the map has its data, so the first visit to each tab is instant.
@MainActor
enum TabPrefetcher {
    private static var prefetchedUserId: String?
    private static var task: Task<Void, Never>?
    /// Comment previews warmed for the first feed cards.
    private static let previewCount = 8

    static func prefetchOnce(userId: String) {
        guard prefetchedUserId != userId else { return }
        prefetchedUserId = userId
        task = Task(priority: .utility) {
            await prefetch(userId: userId)
        }
    }

    /// Logout: stop and allow the next account to prefetch.
    static func reset() {
        task?.cancel()
        task = nil
        prefetchedUserId = nil
    }

    private static func prefetch(userId: String) async {
        var requests: [(path: String, query: [String: String])] = [
            (path: "/api/leaderboard/friends/\(userId)", query: [:]),
            (path: "/api/feed/\(userId)", query: FeedModel.firstPageQuery),
            (path: "/api/friends/\(userId)", query: [:]),
            (path: "/api/friends/requests/\(userId)", query: [:]),
            (path: "/api/friends/requests/sent/\(userId)", query: [:]),
            (path: "/api/routes/\(userId)", query: [:]),
            (path: "/api/conquest-stats/\(userId)", query: [:]),
        ]
        let competition = CompetitionStore.shared
        if competition.isActive || competition.isFinished {
            requests.append((path: "/api/competition/leaderboard", query: [:]))
        }
        let pending = requests.filter { !APIClient.shared.isCacheFresh($0.path, query: $0.query) }
        await withTaskGroup(of: Void.self) { group in
            for request in pending {
                let path: String = request.path
                let query: [String: String] = request.query
                group.addTask {
                    _ = try? await APIClient.shared.getData(path, query: query)
                }
            }
        }
        guard !Task.isCancelled, prefetchedUserId == userId else { return }

        // Comment previews of the first feed cards
        guard let data = APIClient.shared.cachedData("/api/feed/\(userId)", query: FeedModel.firstPageQuery),
              let events = try? APIClient.shared.decodeBody([FeedEvent].self, from: data) else { return }
        let previewQuery: [String: String] = FeedModel.previewQuery
        let paths: [String] = events
            .filter { $0.commentCount > 0 }
            .prefix(previewCount)
            .map { FeedModel.previewPath($0.id) }
            .filter { !APIClient.shared.isCacheFresh($0, query: previewQuery) }
        await withTaskGroup(of: Void.self) { group in
            for path in paths {
                group.addTask {
                    _ = try? await APIClient.shared.getData(path, query: previewQuery)
                }
            }
        }
    }
}
