import Foundation
import CoreLocation
import Observation
import UIKit

/// The logged-in account, readable outside SwiftUI views (runs saved on the device are tagged with it).
enum RunOwner {
    /// Same keychain entry SessionStore writes when a session starts and deletes when it ends.
    static var currentUserId: String? {
        #if DEBUG
        let environment = ProcessInfo.processInfo.environment
        if environment["RUNNA_TEST_TOKEN"] != nil, let userId = environment["RUNNA_TEST_USER_ID"] {
            return userId
        }
        #endif
        return KeychainStore.get("sessionUserId")
    }
}

/// Uploads a finished run and waits for the server to compute the conquered territory.
@MainActor
@Observable
final class RunSubmission {
    enum State {
        case uploading
        case processing
        case done(ConquestResult?)
        /// Not uploaded yet (no connection or a temporary server error): it stays queued on the device.
        case failed(String)
        /// The server refused the run; it's kept and retried on other days before giving up.
        case rejected(String)
    }

    let run: FinishedRun
    private(set) var state: State = .uploading
    private(set) var routeId: String?

    init(run: FinishedRun) {
        self.run = run
    }

    var isBusy: Bool {
        switch state {
        case .uploading, .processing: return true
        default: return false
        }
    }

    /// Uploads the run (already written to the upload queue by RunTracker.finish) and polls the conquest result.
    func submit() async {
        state = .uploading
        let result = await PendingRuns.upload(PendingRuns.Entry(run: run))
        switch result {
        case .uploaded(let newRouteId):
            routeId = newRouteId
            guard let newRouteId else {
                state = .done(nil)
                return
            }
            // This screen shows the conquest: don't show it again from the inbox
            ConquestInbox.shared.markShown(routeId: newRouteId)
            state = .processing
            state = .done(await Self.waitForConquest(routeId: newRouteId))
        case .pending(let message):
            state = .failed(message)
        case .rejected(let message):
            state = .rejected(message)
        }
    }

    /// The territory is processed in a server queue; poll for up to ~30 s.
    static func waitForConquest(routeId: String) async -> ConquestResult? {
        for attempt in 0..<16 {
            if attempt > 0 {
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
            if Task.isCancelled { return nil }
            if let result: ConquestResult = try? await APIClient.shared.request("GET", "/api/conquest-result/\(routeId)"),
               result.ready {
                return result
            }
        }
        return nil
    }
}

/// Runs waiting to be uploaded. Every finished run is written here before its first upload
/// (write-ahead) and removed once the server has it, so nothing is lost if the app is killed.
/// Uploads are serialized and idempotent (clientRunId), so overlapping callers never duplicate a route.
@MainActor
enum PendingRuns {
    struct Entry: Codable, Identifiable {
        /// Idempotency key sent as clientRunId.
        let id: String
        /// Account that recorded the run (nil for runs saved by older versions).
        let ownerId: String?
        let name: String
        let coordinates: [[Double]]
        let distance: Double
        let duration: Int
        let startedAt: Date
        let completedAt: Date
        /// Seconds since `startedAt` of each point and its altitude (nil for runs saved by older versions).
        let pointTimes: [Double]?
        let altitudes: [Double?]?
        /// Days on which the server refused the run (validation error).
        var attempts: Int
        var lastAttemptDay: String?
        var lastError: String?
        var rejected: Bool

        init(run: FinishedRun) {
            id = run.id
            ownerId = run.ownerId
            name = run.defaultName
            coordinates = run.coordinates.map { [$0.latitude, $0.longitude] }
            distance = run.distance
            duration = run.duration
            startedAt = run.startedAt
            completedAt = run.completedAt
            pointTimes = run.pointTimes
            altitudes = run.altitudes
            attempts = 0
            lastAttemptDay = nil
            lastError = nil
            rejected = false
        }

        enum CodingKeys: String, CodingKey {
            case id, ownerId, name, coordinates, distance, duration, startedAt, completedAt, pointTimes, altitudes
            case attempts, lastAttemptDay, lastError, rejected
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            name = try c.decode(String.self, forKey: .name)
            coordinates = try c.decode([[Double]].self, forKey: .coordinates)
            distance = try c.decode(Double.self, forKey: .distance)
            duration = try c.decode(Int.self, forKey: .duration)
            startedAt = try c.decode(Date.self, forKey: .startedAt)
            completedAt = try c.decode(Date.self, forKey: .completedAt)
            ownerId = try c.decodeIfPresent(String.self, forKey: .ownerId)
            pointTimes = try c.decodeIfPresent([Double].self, forKey: .pointTimes)
            altitudes = try c.decodeIfPresent([Double?].self, forKey: .altitudes)
            attempts = try c.decodeIfPresent(Int.self, forKey: .attempts) ?? 0
            lastAttemptDay = try c.decodeIfPresent(String.self, forKey: .lastAttemptDay)
            lastError = try c.decodeIfPresent(String.self, forKey: .lastError)
            rejected = try c.decodeIfPresent(Bool.self, forKey: .rejected) ?? false
            // Entries saved by older versions have no id: derive a stable one so retries stay idempotent
            if let storedId = try c.decodeIfPresent(String.self, forKey: .id) {
                id = storedId
            } else {
                id = Self.legacyId(startedAt: startedAt, distance: distance)
            }
        }

        private static func legacyId(startedAt: Date, distance: Double) -> String {
            let millis = UInt64(max(0, startedAt.timeIntervalSince1970 * 1000))
            let meters = UInt64(max(0, distance * 100)) & 0xFFFF_FFFF_FFFF
            let time = String(format: "%016llX", millis)
            let a = time.prefix(8)
            let b = time.dropFirst(8).prefix(4)
            let c = time.dropFirst(13).prefix(3)
            return "\(a)-\(b)-4\(c)-8000-\(String(format: "%012llX", meters))"
        }
    }

    enum UploadResult: Sendable {
        /// The server has the run (routeId is nil when it only answered "duplicate").
        case uploaded(routeId: String?)
        /// Not uploaded now; it stays queued and is retried later.
        case pending(String)
        /// Refused by the server; kept for a few more days, then dropped.
        case rejected(String)
    }

    struct Outcome: Sendable {
        var uploaded = 0
        var pending = 0
        var rejected = 0
    }

    /// A rejected run is dropped after being refused on this many different days.
    private static let maxRejectedDays = 5

    private static var chain: Task<Void, Never>?
    private static var passTask: Task<Outcome, Never>?
    /// clientRunId -> routeId ("" when unknown) of runs uploaded during this launch.
    private static var recentlyUploaded: [String: String] = [:]

    private static var fileURL: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("pending-runs.json")
    }

    // MARK: - Queue file

    static func body(for entry: Entry) -> [String: Any] {
        var body: [String: Any] = [
            "name": entry.name,
            "coordinates": entry.coordinates,
            "distance": entry.distance,
            "duration": entry.duration,
            "startedAt": APIDate.string(entry.startedAt),
            "completedAt": APIDate.string(entry.completedAt),
            "clientRunId": entry.id,
        ]
        // One value per point, or nothing (the server ignores arrays of another length)
        if let times = entry.pointTimes, times.count == entry.coordinates.count {
            body["pointTimes"] = times.map { ($0 * 10).rounded() / 10 }
            if let altitudes = entry.altitudes, altitudes.count == entry.coordinates.count {
                body["altitudes"] = altitudes.map { value -> Any in
                    guard let value else { return NSNull() }
                    return (value * 10).rounded() / 10
                }
            }
        }
        return body
    }

    static func all() -> [Entry] {
        guard let data = try? Data(contentsOf: fileURL) else { return [] }
        return (try? JSONDecoder().decode([Entry].self, from: data)) ?? []
    }

    /// Entries the logged-in account may upload.
    static func mine() -> [Entry] {
        guard let me = RunOwner.currentUserId else { return [] }
        return all().filter { $0.ownerId == nil || $0.ownerId == me }
    }

    /// Runs of this account waiting to be uploaded.
    static var pendingCount: Int { mine().count }

    /// Runs of this account the server has refused (still kept and retried on other days).
    static var failedCount: Int { mine().filter(\.rejected).count }

    /// Adds (or replaces, by id) an entry. Returns false if the file couldn't be written.
    @discardableResult
    static func add(_ entry: Entry) -> Bool {
        var entries = all().filter { $0.id != entry.id }
        entries.append(entry)
        return save(entries)
    }

    /// Deletes every queued run and the unfinished run, and forgets the conquest inbox state (called on logout).
    static func forgetAll() {
        recentlyUploaded = [:]
        try? FileManager.default.removeItem(at: fileURL)
        ConquestInbox.shared.reset()
        RunPersistence.forgetAll()
    }

    @discardableResult
    private static func save(_ entries: [Entry]) -> Bool {
        do {
            try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            if entries.isEmpty {
                if FileManager.default.fileExists(atPath: fileURL.path) {
                    try FileManager.default.removeItem(at: fileURL)
                }
            } else {
                try JSONEncoder().encode(entries).write(to: fileURL, options: .atomic)
            }
            return true
        } catch {
            #if DEBUG
            print("Could not save pending runs:", error)
            #endif
            return false
        }
    }

    private static func remove(id: String) {
        let entries = all()
        guard entries.contains(where: { $0.id == id }) else { return }
        save(entries.filter { $0.id != id })
    }

    // MARK: - Uploading

    /// Uploads the pending runs of the logged-in account; returns how many were uploaded.
    @discardableResult
    static func uploadAll() async -> Int {
        await uploadAllDetailed().uploaded
    }

    /// Uploads the pending runs of the logged-in account. Concurrent callers share the same pass.
    static func uploadAllDetailed() async -> Outcome {
        if let running = passTask {
            return await running.value
        }
        let task = Task { @MainActor () -> Outcome in
            await runPass()
        }
        passTask = task
        let outcome = await task.value
        passTask = nil
        return outcome
    }

    /// Uploads one run (the queued copy if there is one). Waits for any upload in progress.
    static func upload(_ entry: Entry) async -> UploadResult {
        await serialized { await performUpload(id: entry.id, fallback: entry) }
    }

    private static func runPass() async -> Outcome {
        var outcome = Outcome()
        let today = dayString(Date())
        let entries = mine()
        for entry in entries {
            // A refused run is retried at most once a day
            if entry.rejected && entry.lastAttemptDay == today {
                outcome.rejected += 1
                continue
            }
            let result = await serialized { await performUpload(id: entry.id, fallback: nil) }
            switch result {
            case .uploaded(let routeId):
                outcome.uploaded += 1
                // The user hasn't seen what this run conquered yet
                if let routeId {
                    ConquestInbox.shared.enqueue(routeId: routeId)
                }
            case .pending:
                outcome.pending += 1
            case .rejected:
                outcome.rejected += 1
            }
        }
        return outcome
    }

    /// Runs operations one at a time, in order, in tasks that aren't cancelled with their caller
    /// (a cancelled view task must not abort an upload half-way).
    private static func serialized(_ operation: @escaping @MainActor () async -> UploadResult) async -> UploadResult {
        let previous = chain
        let task = Task { @MainActor () -> UploadResult in
            if let previous {
                await previous.value
            }
            return await operation()
        }
        chain = Task { @MainActor in
            _ = await task.value
        }
        return await task.value
    }

    private static func performUpload(id: String, fallback: Entry?) async -> UploadResult {
        if let routeId = recentlyUploaded[id] {
            remove(id: id)
            return .uploaded(routeId: routeId.isEmpty ? nil : routeId)
        }
        guard let entry = all().first(where: { $0.id == id }) ?? fallback else {
            // Already uploaded and removed by an earlier pass
            return .uploaded(routeId: nil)
        }
        guard let me = RunOwner.currentUserId else {
            return .pending("Inicia sesión para subir la carrera.")
        }
        if let owner = entry.ownerId, owner != me {
            return .pending("Esta carrera es de otra cuenta.")
        }

        let background = BackgroundTaskToken()
        background.begin("Subir carrera")
        defer { background.end() }

        do {
            let response: CreateRouteResponse = try await APIClient.shared.request("POST", "/api/routes", body: body(for: entry))
            recentlyUploaded[id] = response.route.id
            remove(id: id)
            // Shown at once in "Mis carreras", the map and the feed (the next refresh confirms it)
            UploadedRuns.didUpload(response.route)
            return .uploaded(routeId: response.route.id)
        } catch let error as APIError where error.status == 409 {
            // Duplicate: the server already has this run
            recentlyUploaded[id] = ""
            remove(id: id)
            return .uploaded(routeId: nil)
        } catch let error as APIError where isRetryable(error.status) {
            keepQueued(entry)
            return .pending(error.message)
        } catch let error as APIError {
            return recordRejection(entry: entry, message: error.message)
        } catch {
            keepQueued(entry)
            return .pending(APIError.network.message)
        }
    }

    /// Makes sure a run that couldn't be uploaded is in the queue file (it normally already is).
    private static func keepQueued(_ entry: Entry) {
        guard !all().contains(where: { $0.id == entry.id }) else { return }
        add(entry)
    }

    /// Network errors (0), expired sessions, timeouts, rate limits and server errors are retried without limit.
    private static func isRetryable(_ status: Int) -> Bool {
        status == 0 || status == 401 || status == 408 || status == 429 || status >= 500
    }

    private static func recordRejection(entry: Entry, message: String) -> UploadResult {
        let today = dayString(Date())
        var updated = all().first(where: { $0.id == entry.id }) ?? entry
        if updated.lastAttemptDay != today {
            updated.attempts += 1
            updated.lastAttemptDay = today
        }
        updated.rejected = true
        updated.lastError = message
        if updated.attempts >= maxRejectedDays {
            remove(id: entry.id)
        } else {
            add(updated)
        }
        return .rejected(message)
    }

    private static func dayString(_ date: Date) -> String {
        let components = Calendar.current.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", components.year ?? 0, components.month ?? 0, components.day ?? 0)
    }
}

/// Keeps the app running for a short while in the background so an upload can finish.
@MainActor
private final class BackgroundTaskToken {
    private var identifier: UIBackgroundTaskIdentifier = .invalid

    func begin(_ name: String) {
        identifier = UIApplication.shared.beginBackgroundTask(withName: name) { [weak self] in
            let token = self
            Task { @MainActor in
                token?.end()
            }
        }
    }

    func end() {
        guard identifier != .invalid else { return }
        UIApplication.shared.endBackgroundTask(identifier)
        identifier = .invalid
    }
}
