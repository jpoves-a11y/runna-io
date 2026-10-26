import Foundation
import CoreLocation
import Observation
import UIKit

/// Records a run with CoreLocation, including while the screen is locked.
/// GPS filtering mirrors the web app: poor accuracy, jitter, stationary drift and impossible jumps are discarded.
@MainActor
@Observable
final class RunTracker {
    enum Phase: Equatable {
        case idle      // nothing recorded yet
        case running
        case paused
    }

    // Filtering thresholds (same values as the web app)
    private let maxAccuracy: CLLocationAccuracy = 30
    private let minMovement: CLLocationDistance = 5
    private let maxJump: CLLocationDistance = 200
    private let maxJumpInterval: TimeInterval = 5
    private let minSpeed: CLLocationSpeed = 0.3
    private let treasureRadius: CLLocationDistance = 100
    /// After a pause, a first step longer than this is the distance moved while paused: it isn't counted.
    private let maxStepAfterPause: CLLocationDistance = 25

    /// Purpose key in Info.plist (NSLocationTemporaryUsageDescriptionDictionary).
    static let fullAccuracyPurposeKey = "RunRecording"

    /// Shows the run screen.
    var isPresented = false

    private(set) var phase: Phase = .idle
    private(set) var coordinates: [CLLocationCoordinate2D] = []
    private(set) var distance: CLLocationDistance = 0
    private(set) var currentLocation: CLLocation?
    private(set) var gpsAccuracy: CLLocationAccuracy?
    private(set) var authorizationStatus: CLAuthorizationStatus
    /// Reduced accuracy ("Ubicación exacta" off) makes every GPS fix useless for recording a route.
    private(set) var accuracyAuthorization: CLAccuracyAuthorization
    private(set) var startDate: Date?
    /// A run saved to disk by a previous launch that never finished (app killed while running).
    private(set) var hasRecoverableRun = false
    /// Treasures collected during this run (competition only).
    private(set) var collectedTreasures: [Treasure] = []
    /// The treasure just collected, shown in a banner for a few seconds.
    private(set) var lastCollected: Treasure?

    /// Active treasures to check while running (set by the map during competitions, refreshed every minute while running).
    var activeTreasures: [Treasure] = []

    /// Friends' and rivals' territories drawn under the run (set by the map).
    var territoryShapes: [TerritoryShape] = []

    /// Treasures still on the map (collected ones are removed).
    var visibleTreasures: [Treasure] {
        activeTreasures.filter { !collectedTreasureIds.contains($0.id) }
    }

    var isRecording: Bool { phase != .idle }

    var hasReducedAccuracy: Bool { accuracyAuthorization == .reducedAccuracy }

    var isLocationDenied: Bool { authorizationStatus == .denied || authorizationStatus == .restricted }

    private var pausedAt: Date?
    private var pausedTotal: TimeInterval = 0
    private var lastAcceptedAt: Date?
    /// The next accepted fix starts a new segment (after a pause or a recovered run).
    private var skipNextSegment = false
    private var collectingTreasureIds: Set<String> = []
    private var collectedTreasureIds: Set<String> = []
    /// Idempotency key of the run being recorded (sent as clientRunId).
    private var runId = UUID().uuidString
    private var ownerId: String?
    private var wantsFullAccuracy = false
    private var fullAccuracyRequested = false

    @ObservationIgnored private var treasureRefreshTask: Task<Void, Never>?
    @ObservationIgnored private var bannerTask: Task<Void, Never>?
    @ObservationIgnored private var forgetObserver: NSObjectProtocol?
    /// Lock screen / Dynamic Island tracker of the run.
    private let liveActivity = RunLiveActivity()

    private let manager = CLLocationManager()
    private let delegate = LocationDelegate()

    init() {
        authorizationStatus = manager.authorizationStatus
        accuracyAuthorization = manager.accuracyAuthorization
        manager.delegate = delegate
        manager.activityType = .fitness
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.distanceFilter = kCLDistanceFilterNone
        manager.pausesLocationUpdatesAutomatically = false

        delegate.onLocations = { [weak self] locations in
            MainActor.assumeIsolated {
                self?.handle(locations)
            }
        }
        delegate.onAuthorizationChange = { [weak self] status, accuracy in
            MainActor.assumeIsolated {
                self?.authorizationChanged(status: status, accuracy: accuracy)
            }
        }

        hasRecoverableRun = RunPersistence.loadForCurrentUser() != nil
        // Nothing is recorded at launch: a Live Activity still showing is from a run the app lost when it was closed
        RunLiveActivity.endStaleActivities()
        forgetObserver = NotificationCenter.default.addObserver(
            forName: RunPersistence.didForgetNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.hasRecoverableRun = false
            }
        }
    }

    // MARK: - Derived values

    /// Moving time in seconds (excludes pauses).
    func elapsed(at date: Date = Date()) -> TimeInterval {
        guard let startDate else { return 0 }
        let pausedNow = pausedAt.map { date.timeIntervalSince($0) } ?? 0
        return max(0, date.timeIntervalSince(startDate) - pausedTotal - pausedNow)
    }

    // MARK: - Location permission and preview

    func requestPermission() {
        if authorizationStatus == .notDetermined {
            manager.requestWhenInUseAuthorization()
        }
    }

    /// Asks iOS for precise location for this session (when the user turned "Ubicación exacta" off).
    func requestFullAccuracy() {
        guard manager.accuracyAuthorization == .reducedAccuracy, !isLocationDenied,
              authorizationStatus != .notDetermined else { return }
        fullAccuracyRequested = true
        manager.requestTemporaryFullAccuracyAuthorization(withPurposeKey: Self.fullAccuracyPurposeKey) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.accuracyAuthorization = self.manager.accuracyAuthorization
            }
        }
    }

    /// Starts location updates to show the user's position and GPS quality before running.
    func startPreview() {
        requestPermission()
        wantsFullAccuracy = true
        fullAccuracyRequested = false
        accuracyAuthorization = manager.accuracyAuthorization
        if hasReducedAccuracy {
            requestFullAccuracy()
        }
        manager.startUpdatingLocation()
    }

    func stopPreview() {
        wantsFullAccuracy = false
        if phase == .idle {
            manager.stopUpdatingLocation()
        }
    }

    /// Re-reads the recovery file (e.g. after another account logged in).
    func refreshRecoverableRun() {
        guard phase == .idle else { return }
        hasRecoverableRun = RunPersistence.loadForCurrentUser() != nil
    }

    private func authorizationChanged(status: CLAuthorizationStatus, accuracy: CLAccuracyAuthorization) {
        authorizationStatus = status
        accuracyAuthorization = accuracy
        if wantsFullAccuracy, !fullAccuracyRequested, accuracy == .reducedAccuracy,
           status == .authorizedWhenInUse || status == .authorizedAlways {
            requestFullAccuracy()
        }
    }

    // MARK: - Run lifecycle

    func start() {
        requestPermission()
        if hasReducedAccuracy {
            requestFullAccuracy()
        }
        coordinates = []
        distance = 0
        pausedTotal = 0
        pausedAt = nil
        lastAcceptedAt = nil
        skipNextSegment = false
        collectedTreasures = []
        collectingTreasureIds = []
        collectedTreasureIds = []
        lastCollected = nil
        runId = UUID().uuidString
        ownerId = RunOwner.currentUserId
        // Starting a new run replaces any unfinished one (the run screen asks first)
        hasRecoverableRun = false
        startDate = Date()
        phase = .running
        beginBackgroundUpdates()
        UIApplication.shared.isIdleTimerDisabled = true
        startTreasureRefresh()
        persist()
        if let startDate {
            liveActivity.start(startedAt: startDate, state: liveActivityState())
        }
    }

    func pause() {
        guard phase == .running else { return }
        pausedAt = Date()
        phase = .paused
        treasureRefreshTask?.cancel()
        persist()
        liveActivity.update(liveActivityState())
    }

    func resume() {
        guard phase == .paused else { return }
        if let pausedAt {
            pausedTotal += Date().timeIntervalSince(pausedAt)
        }
        pausedAt = nil
        // Don't count the distance between the point before the pause and the first one after it
        lastAcceptedAt = nil
        skipNextSegment = true
        phase = .running
        UIApplication.shared.isIdleTimerDisabled = true
        startTreasureRefresh()
        persist()
        liveActivity.update(liveActivityState())
    }

    /// Restores a run that was interrupted (e.g. the app was closed by iOS) and keeps recording.
    func resumeRecoveredRun() {
        guard phase == .idle, let saved = RunPersistence.loadForCurrentUser() else {
            hasRecoverableRun = false
            return
        }
        coordinates = saved.coordinates.compactMap { pair -> CLLocationCoordinate2D? in
            guard pair.count >= 2 else { return nil }
            return CLLocationCoordinate2D(latitude: pair[0], longitude: pair[1])
        }
        distance = saved.distance
        startDate = saved.startDate
        pausedTotal = saved.pausedTotal
        // Time while the app was closed counts as a pause
        pausedAt = saved.savedAt
        lastAcceptedAt = nil
        skipNextSegment = true
        runId = saved.id ?? UUID().uuidString
        ownerId = saved.ownerId ?? RunOwner.currentUserId
        collectedTreasures = []
        collectedTreasureIds = Set(saved.collectedTreasureIds ?? [])
        collectingTreasureIds = collectedTreasureIds
        lastCollected = nil
        phase = .paused
        hasRecoverableRun = false
        beginBackgroundUpdates()
        UIApplication.shared.isIdleTimerDisabled = true
        persist()
        if let startDate {
            liveActivity.start(startedAt: startDate, state: liveActivityState())
        }
        isPresented = true
    }

    func discardRecoveredRun() {
        RunPersistence.clear()
        hasRecoverableRun = false
    }

    /// Number of GPS points recorded so far.
    var pointCount: Int { coordinates.count }

    /// Stops recording and returns what to upload. The run is first written to the upload queue
    /// (so it survives the app being killed during the upload) and only then removed from the recovery file.
    /// Returns nil, without stopping anything, when there are too few GPS points
    /// (fewer than 3, or fewer than 2 with `force`).
    func finish(force: Bool = false) -> FinishedRun? {
        let points = coordinates
        guard points.count >= 3 || (force && points.count >= 2) else { return nil }
        let end = Date()
        let movingTime = Int(elapsed(at: end).rounded())
        let run = FinishedRun(
            id: runId,
            ownerId: ownerId ?? RunOwner.currentUserId,
            coordinates: points,
            distance: distance,
            duration: movingTime,
            startedAt: startDate ?? end,
            completedAt: end,
            treasures: collectedTreasures
        )
        liveActivity.end(finalState: liveActivityState(at: end, finished: true), discarded: false)
        let queued = PendingRuns.add(PendingRuns.Entry(run: run))
        // If the queue couldn't be written, keep the recovery file: the run can still be resumed and finished
        reset(clearSavedRun: queued)
        return run
    }

    /// Throws the current run away.
    func cancel() {
        liveActivity.end(finalState: nil, discarded: true)
        reset(clearSavedRun: true)
    }

    private func reset(clearSavedRun: Bool) {
        manager.stopUpdatingLocation()
        manager.allowsBackgroundLocationUpdates = false
        UIApplication.shared.isIdleTimerDisabled = false
        treasureRefreshTask?.cancel()
        treasureRefreshTask = nil
        bannerTask?.cancel()
        bannerTask = nil
        phase = .idle
        coordinates = []
        distance = 0
        startDate = nil
        pausedAt = nil
        pausedTotal = 0
        lastAcceptedAt = nil
        skipNextSegment = false
        lastCollected = nil
        collectingTreasureIds = []
        collectedTreasureIds = []
        if clearSavedRun {
            RunPersistence.clear()
        } else {
            hasRecoverableRun = RunPersistence.loadForCurrentUser() != nil
        }
    }

    private func beginBackgroundUpdates() {
        manager.allowsBackgroundLocationUpdates = true
        manager.showsBackgroundLocationIndicator = true
        manager.startUpdatingLocation()
    }

    // MARK: - Location handling

    private func handle(_ locations: [CLLocation]) {
        for location in locations {
            // Ignore cached fixes delivered when updates start
            guard abs(location.timestamp.timeIntervalSinceNow) < 15 else { continue }
            if location.horizontalAccuracy >= 0 {
                gpsAccuracy = location.horizontalAccuracy
            }
            currentLocation = location
            guard phase == .running else { continue }
            accept(location)
        }
        if isRecording, !locations.isEmpty {
            liveActivity.updateIfNeeded(liveActivityState())
        }
    }

    private func accept(_ location: CLLocation) {
        guard location.horizontalAccuracy >= 0, location.horizontalAccuracy <= maxAccuracy else { return }
        // Stationary drift: the device reports it's not moving
        if location.speed >= 0, location.speed < minSpeed { return }

        if let last = coordinates.last {
            let lastLocation = CLLocation(latitude: last.latitude, longitude: last.longitude)
            let step = location.distance(from: lastLocation)
            if step < minMovement { return }
            if skipNextSegment {
                // First fix after a pause: what was covered while paused (or with the app closed) isn't running
                skipNextSegment = false
                if step <= maxStepAfterPause {
                    distance += step
                }
            } else {
                if let lastAcceptedAt, step > maxJump, location.timestamp.timeIntervalSince(lastAcceptedAt) < maxJumpInterval {
                    return
                }
                distance += step
            }
        } else {
            skipNextSegment = false
        }

        coordinates.append(location.coordinate)
        lastAcceptedAt = location.timestamp
        if coordinates.count % 10 == 0 {
            persist()
        }
        checkTreasures(near: location)
    }

    // MARK: - Treasures

    private func checkTreasures(near location: CLLocation) {
        for treasure in activeTreasures where !collectingTreasureIds.contains(treasure.id) {
            let treasureLocation = CLLocation(latitude: treasure.lat, longitude: treasure.lng)
            guard location.distance(from: treasureLocation) <= treasureRadius else { continue }
            collectingTreasureIds.insert(treasure.id)
            Task {
                do {
                    try await APIClient.shared.send(
                        "POST", "/api/treasures/collect",
                        body: ["treasureId": treasure.id, "lat": location.coordinate.latitude, "lng": location.coordinate.longitude]
                    )
                    guard isRecording else { return }
                    collectedTreasures.append(treasure)
                    collectedTreasureIds.insert(treasure.id)
                    showCollected(treasure)
                    Haptics.success()
                    persist()
                    liveActivity.update(liveActivityState())
                } catch {
                    // Collected by someone else or expired: don't retry during this run
                }
            }
        }
    }

    private func showCollected(_ treasure: Treasure) {
        lastCollected = treasure
        bannerTask?.cancel()
        bannerTask = Task {
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            if Task.isCancelled { return }
            lastCollected = nil
        }
    }

    /// New treasures can appear during a run: refresh the list every minute while running.
    private func startTreasureRefresh() {
        treasureRefreshTask?.cancel()
        treasureRefreshTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 60_000_000_000)
                if Task.isCancelled { return }
                guard let tracker = self, tracker.phase == .running else { return }
                if let response: TreasuresResponse = try? await APIClient.shared.request("GET", "/api/treasures/active") {
                    if Task.isCancelled { return }
                    tracker.activeTreasures = response.treasures
                }
            }
        }
    }

    // MARK: - Live Activity

    /// What the lock screen shows now. The timer anchor is the start date moved forward by the paused time,
    /// so the widget's timer counts the moving time by itself.
    private func liveActivityState(at date: Date = Date(), finished: Bool = false) -> RunLiveActivity.State {
        let moving = elapsed(at: date)
        let pace: Double? = distance >= 50 ? moving / (distance / 1000) : nil
        let treasures = collectedTreasures.count
        let hint: String? = treasures == 0 ? nil : (treasures == 1 ? "1 tesoro recogido" : "\(treasures) tesoros recogidos")
        return RunLiveActivity.State(
            timerStart: date.addingTimeInterval(-moving),
            isPaused: phase == .paused || finished,
            pausedElapsed: moving,
            distanceMeters: distance,
            paceSecondsPerKm: pace,
            conqueredHint: hint,
            isFinished: finished
        )
    }

    // MARK: - Persistence

    private func persist() {
        guard let startDate else { return }
        RunPersistence.save(SavedRun(
            coordinates: coordinates.map { [$0.latitude, $0.longitude] },
            distance: distance,
            startDate: startDate,
            pausedTotal: pausedTotal + (pausedAt.map { Date().timeIntervalSince($0) } ?? 0),
            savedAt: Date(),
            id: runId,
            ownerId: ownerId,
            collectedTreasureIds: Array(collectedTreasureIds)
        ))
    }
}

/// A finished run ready to upload.
struct FinishedRun {
    /// Client-generated idempotency key (sent as clientRunId).
    let id: String
    /// Account that recorded the run.
    let ownerId: String?
    let coordinates: [CLLocationCoordinate2D]
    let distance: CLLocationDistance
    let duration: Int
    let startedAt: Date
    let completedAt: Date
    let treasures: [Treasure]

    var defaultName: String { "Carrera del \(Format.day(startedAt))" }
}

private final class LocationDelegate: NSObject, CLLocationManagerDelegate {
    var onLocations: (([CLLocation]) -> Void)?
    var onAuthorizationChange: ((CLAuthorizationStatus, CLAccuracyAuthorization) -> Void)?

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        onLocations?(locations)
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        onAuthorizationChange?(manager.authorizationStatus, manager.accuracyAuthorization)
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        // Temporary failures (e.g. no fix yet) are expected; keep updating
    }
}

// MARK: - Persistence of the run in progress

struct SavedRun: Codable {
    let coordinates: [[Double]]
    let distance: Double
    let startDate: Date
    let pausedTotal: TimeInterval
    let savedAt: Date
    /// Optional so files written by older versions still decode.
    let id: String?
    let ownerId: String?
    let collectedTreasureIds: [String]?
}

enum RunPersistence {
    /// Posted by `forgetAll()` so the tracker hides its recovery banner.
    static let didForgetNotification = Notification.Name("RunPersistenceDidForget")

    private static var fileURL: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("current-run.json")
    }

    static func save(_ run: SavedRun) {
        do {
            try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONEncoder().encode(run).write(to: fileURL, options: .atomic)
        } catch {
            #if DEBUG
            print("Could not save run:", error)
            #endif
        }
    }

    static func load() -> SavedRun? {
        guard let data = try? Data(contentsOf: fileURL) else { return nil }
        return try? JSONDecoder().decode(SavedRun.self, from: data)
    }

    /// The unfinished run, only if it belongs to the logged-in account (runs from older versions have no owner).
    static func loadForCurrentUser() -> SavedRun? {
        guard let saved = load(), let me = RunOwner.currentUserId else { return nil }
        if let owner = saved.ownerId, owner != me { return nil }
        return saved
    }

    static func clear() {
        try? FileManager.default.removeItem(at: fileURL)
    }

    /// Forgets the unfinished run (called on logout).
    static func forgetAll() {
        clear()
        NotificationCenter.default.post(name: didForgetNotification, object: nil)
    }
}
