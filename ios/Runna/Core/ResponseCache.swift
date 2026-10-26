import Foundation
import CryptoKit

/// Stale-while-revalidate store for the API's GET responses.
///
/// Keeps the raw JSON body of every GET (keyed by path + query) in memory and in the Caches directory,
/// so screens can draw the last known data instantly (also right after a cold start) and refresh it
/// in the background. APIClient fills it after each successful GET and marks everything stale after
/// any successful mutation (POST/PATCH/PUT/DELETE/upload), so the next visit to a screen refetches.
/// Cleared on logout and when another account logs in.
final class ResponseCache {
    static let shared = ResponseCache()

    /// Data younger than this is not refetched when the user just switches tabs (pull-to-refresh always refetches).
    static let freshness: TimeInterval = 45

    struct Entry {
        let data: Data
        /// When the request that returned the body was sent.
        let date: Date
        /// Read back from disk after a launch: always revalidated.
        let fromDisk: Bool
    }

    private let lock = NSLock()
    private var memory: [String: Entry] = [:]
    /// Entries received before this moment are stale (a mutation happened).
    private var invalidatedAt: Date = .distantPast
    /// Bumped by `removeAll()`: responses of requests started before it are not stored.
    private var generationValue = 0
    /// Number of mutations seen (see `mutationCount`).
    private var mutations = 0
    private let directory: URL?
    private let ioQueue = DispatchQueue(label: "io.runna.response-cache", qos: .utility)
    /// Bodies larger than this are kept in memory only.
    private let maxDiskBytes = 6 * 1024 * 1024
    /// Bodies larger than this are not cached at all.
    private let maxMemoryBytes = 12 * 1024 * 1024
    private let ownerKey = "responseCacheOwner"

    /// Paths whose responses are never cached (searches, one-off lookups, auth).
    private let excludedPrefixes = ["/api/users/search", "/api/auth", "/api/friends/invite/"]

    private init() {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
        directory = caches?.appendingPathComponent("APIResponses", isDirectory: true)
        if let directory {
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        }
    }

    // MARK: - Keys

    static func key(path: String, query: [String: String]) -> String {
        guard !query.isEmpty else { return path }
        let items = query.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }
        return path + "?" + items.joined(separator: "&")
    }

    func isCacheable(path: String) -> Bool {
        !excludedPrefixes.contains { path.hasPrefix($0) }
    }

    /// Current generation, captured before a request starts and passed back to `store`.
    var generation: Int {
        lock.lock()
        defer { lock.unlock() }
        return generationValue
    }

    // MARK: - Reading

    /// The cached body (memory, else disk), or nil.
    func entry(for key: String) -> Entry? {
        lock.lock()
        if let hit = memory[key] {
            lock.unlock()
            return hit
        }
        let generationAtRead = generationValue
        lock.unlock()

        guard let url = fileURL(for: key), let data = try? Data(contentsOf: url) else { return nil }
        let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
        let date = (attributes?[.modificationDate] as? Date) ?? .distantPast
        let entry = Entry(data: data, date: date, fromDisk: true)

        lock.lock()
        defer { lock.unlock() }
        // Logged out meanwhile, or a fresher body arrived: don't resurrect / overwrite it
        guard generationAtRead == generationValue else { return nil }
        if let newer = memory[key] { return newer }
        memory[key] = entry
        return entry
    }

    /// True when the body was received less than `maxAge` seconds ago and no mutation happened since.
    func isFresh(_ key: String, maxAge: TimeInterval = ResponseCache.freshness) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard let entry = memory[key], !entry.fromDisk else { return false }
        return entry.date > invalidatedAt && Date().timeIntervalSince(entry.date) < maxAge
    }

    // MARK: - Writing

    /// Stores a GET body. Ignored when the cache was cleared after the request started.
    /// - Parameter requestedAt: when the request was sent; a mutation that happened while it was in
    ///   flight leaves the entry stale (the body may predate it).
    func store(_ data: Data, for key: String, generation: Int, requestedAt: Date) {
        guard data.count <= maxMemoryBytes else { return }
        lock.lock()
        defer { lock.unlock() }
        guard generation == generationValue else { return }
        let previous = memory[key]
        memory[key] = Entry(data: data, date: requestedAt, fromDisk: false)
        // Same bytes already on disk: only the memory timestamp changes
        if let previous, previous.data == data, !previous.fromDisk { return }
        guard data.count <= maxDiskBytes, let url = fileURL(for: key) else { return }
        // Enqueued while holding the lock, so a later removeAll() always deletes it afterwards
        ioQueue.async {
            try? data.write(to: url, options: [.atomic])
        }
    }

    /// Something changed on the server (a mutation succeeded): every entry must be revalidated,
    /// but stays available to draw while that happens.
    func invalidateAll() {
        lock.lock()
        invalidatedAt = Date()
        mutations += 1
        lock.unlock()
    }

    /// Grows with every successful mutation: compare two readings to know whether something was
    /// uploaded or changed in between (e.g. pending runs uploaded while the map was loading).
    var mutationCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return mutations
    }

    /// Marks the entries whose key starts with one of these prefixes as stale.
    func invalidate(prefixes: [String]) {
        lock.lock()
        defer { lock.unlock() }
        for (key, entry) in memory where prefixes.contains(where: { key.hasPrefix($0) }) {
            memory[key] = Entry(data: entry.data, date: .distantPast, fromDisk: entry.fromDisk)
        }
    }

    /// Forgets everything (logout, account deleted, session rejected).
    func removeAll() {
        lock.lock()
        defer { lock.unlock() }
        memory = [:]
        generationValue += 1
        invalidatedAt = .distantPast
        guard let directory else { return }
        ioQueue.async {
            let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
            for file in files {
                try? FileManager.default.removeItem(at: file)
            }
        }
    }

    /// Makes sure the cache on disk belongs to this account (another one may have used the device before).
    func setOwner(_ userId: String) {
        let previous = UserDefaults.standard.string(forKey: ownerKey)
        if previous != userId {
            removeAll()
            UserDefaults.standard.set(userId, forKey: ownerKey)
        }
    }

    func clearOwner() {
        UserDefaults.standard.removeObject(forKey: ownerKey)
    }

    // MARK: - Files

    private func fileURL(for key: String) -> URL? {
        guard let directory else { return nil }
        let digest = SHA256.hash(data: Data(key.utf8))
        let name = digest.map { String(format: "%02x", $0) }.joined()
        return directory.appendingPathComponent(name + ".json", isDirectory: false)
    }
}
