import Foundation

/// One GET endpoint drawn by a screen, stale-while-revalidate:
/// `loadCached()` returns the last known body (memory or disk) so the screen draws instantly,
/// `fetch()` refetches it; both only decode when the body differs from the one already shown,
/// and decode off the main thread.
@MainActor
final class CachedResource<Value: Decodable> {
    let path: String
    let query: [String: String]
    /// Latest decoded value (from the cache or the server).
    private(set) var value: Value?
    /// Body behind `value` (identical refreshes are skipped without decoding).
    private var shownData: Data?
    /// Bumped when `value` changes; `takenVersion` is the one last handed to the screen, so an update
    /// whose caller was cancelled before drawing it is handed out by the next call instead of being lost.
    private var version = 0
    private var takenVersion = 0

    nonisolated init(_ path: String, query: [String: String] = [:]) {
        self.path = path
        self.query = query
    }

    var hasValue: Bool { value != nil }

    /// Answered recently and nothing changed since: no need to refetch when the user just switches tabs.
    var isFresh: Bool {
        APIClient.shared.isCacheFresh(path, query: query)
    }

    /// The cached body, decoded, when it differs from what the screen last drew; nil otherwise
    /// (or when there is no cache).
    func loadCached() async -> Value? {
        let path = self.path
        let query = self.query
        let shown = shownData
        let decoded: (Data, Value)? = await Self.decodeCached(path: path, query: query, unlessEqualTo: shown)
        if let decoded, decoded.0 != shownData {
            accept(data: decoded.0, value: decoded.1)
        }
        return takeUpdate()
    }

    /// Fetches the body from the server. Returns the new value, or nil when the screen already drew it.
    func fetch() async throws -> Value? {
        let data = try await APIClient.shared.getData(path, query: query)
        if data != shownData {
            let newValue: Value = try await Self.decode(data)
            // Another refresh may have accepted a body meanwhile; the last one to arrive wins
            accept(data: data, value: newValue)
        }
        return takeUpdate()
    }

    /// Forgets what is shown (the next `loadCached` / `fetch` hands a value back again).
    func forget() {
        shownData = nil
        value = nil
        takenVersion = version
    }

    private func accept(data: Data, value newValue: Value) {
        shownData = data
        value = newValue
        version += 1
    }

    private func takeUpdate() -> Value? {
        guard version != takenVersion else { return nil }
        takenVersion = version
        return value
    }

    // MARK: - Off the main thread

    private nonisolated static func decodeCached(path: String, query: [String: String], unlessEqualTo shown: Data?) async -> (Data, Value)? {
        guard let data = APIClient.shared.cachedData(path, query: query), data != shown else { return nil }
        guard let value = try? APIClient.shared.decodeBody(Value.self, from: data) else { return nil }
        return (data, value)
    }

    private nonisolated static func decode(_ data: Data) async throws -> Value {
        try APIClient.shared.decodeBody(Value.self, from: data)
    }
}

/// Tells a screen whether `AppRouter.reloadSignal` changed since its last load
/// (a notification arrived, an OAuth flow finished…): then it must refetch even if its data is fresh.
struct ReloadSignalTracker {
    private var handled: Int?

    /// True when the signal changed since the previous call (false on the first call).
    mutating func consume(_ signal: Int) -> Bool {
        defer { handled = signal }
        guard let handled else { return false }
        return handled != signal
    }
}
