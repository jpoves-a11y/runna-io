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

    /// Shows the run screen.
    var isPresented = false

    private(set) var phase: Phase = .idle
    private(set) var coordinates: [CLLocationCoordinate2D] = []
    private(set) var distance: CLLocationDistance = 0
    private(set) var currentLocation: CLLocation?
    private(set) var gpsAccuracy: CLLocationAccuracy?
    private(set) var authorizationStatus: CLAuthorizationStatus
    private(set) var startDate: Date?
    /// A run saved to disk by a previous launch that never finished (app killed while running).
    private(set) var hasRecoverableRun = false
    /// Treasures collected during this run (competition only).
    private(set) var collectedTreasures: [Treasure] = []

    /// Active treasures to check while running (set by the map during competitions).
    var activeTreasures: [Treasure] = []

    private var pausedAt: Date?
    private var pausedTotal: TimeInterval = 0
    private var lastAcceptedAt: Date?
    private var collectingTreasureIds: Set<String> = []

    private let manager = CLLocationManager()
    private let delegate = LocationDelegate()

    init() {
        authorizationStatus = manager.authorizationStatus
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
        delegate.onAuthorizationChange = { [weak self] status in
            MainActor.assumeIsolated {
                self?.authorizationStatus = status
            }
        }

        hasRecoverableRun = RunPersistence.load() != nil
    }

    // MARK: - Derived values

    /// Moving time in seconds (excludes pauses).
    func elapsed(at date: Date = Date()) -> TimeInterval {
        guard let startDate else { return 0 }
        let pausedNow = pausedAt.map { date.timeIntervalSince($0) } ?? 0
        return max(0, date.timeIntervalSince(startDate) - pausedTotal - pausedNow)
    }

    var isRecording: Bool { phase != .idle }

    // MARK: - Location permission and preview

    func requestPermission() {
        if authorizationStatus == .notDetermined {
            manager.requestWhenInUseAuthorization()
        }
    }

    /// Starts location updates to show the user's position and GPS quality before running.
    func startPreview() {
        requestPermission()
        manager.startUpdatingLocation()
    }

    func stopPreview() {
        if phase == .idle {
            manager.stopUpdatingLocation()
        }
    }

    // MARK: - Run lifecycle

    func start() {
        requestPermission()
        coordinates = []
        distance = 0
        pausedTotal = 0
        pausedAt = nil
        lastAcceptedAt = nil
        collectedTreasures = []
        collectingTreasureIds = []
        startDate = Date()
        phase = .running
        beginBackgroundUpdates()
        UIApplication.shared.isIdleTimerDisabled = true
        persist()
    }

    func pause() {
        guard phase == .running else { return }
        pausedAt = Date()
        phase = .paused
        persist()
    }

    func resume() {
        guard phase == .paused else { return }
        if let pausedAt {
            pausedTotal += Date().timeIntervalSince(pausedAt)
        }
        pausedAt = nil
        // Don't join the point before the pause with the first one after it as a "jump"
        lastAcceptedAt = nil
        phase = .running
        persist()
    }

    /// Restores a run that was interrupted (e.g. the app was closed by iOS) and keeps recording.
    func resumeRecoveredRun() {
        guard let saved = RunPersistence.load() else {
            hasRecoverableRun = false
            return
        }
        coordinates = saved.coordinates.map { CLLocationCoordinate2D(latitude: $0[0], longitude: $0[1]) }
        distance = saved.distance
        startDate = saved.startDate
        pausedTotal = saved.pausedTotal
        // Time while the app was closed counts as a pause
        pausedAt = saved.savedAt
        phase = .paused
        hasRecoverableRun = false
        beginBackgroundUpdates()
        isPresented = true
    }

    func discardRecoveredRun() {
        RunPersistence.clear()
        hasRecoverableRun = false
    }

    /// Stops recording and returns what to upload.
    func finish() -> FinishedRun? {
        let end = Date()
        let movingTime = Int(elapsed(at: end).rounded())
        let points = coordinates
        let totalDistance = distance
        let start = startDate ?? end
        reset()
        guard points.count >= 3 else { return nil }
        return FinishedRun(
            coordinates: points,
            distance: totalDistance,
            duration: movingTime,
            startedAt: start,
            completedAt: end,
            treasures: collectedTreasures
        )
    }

    /// Throws the current run away.
    func cancel() {
        reset()
    }

    private func reset() {
        manager.stopUpdatingLocation()
        manager.allowsBackgroundLocationUpdates = false
        UIApplication.shared.isIdleTimerDisabled = false
        phase = .idle
        coordinates = []
        distance = 0
        startDate = nil
        pausedAt = nil
        pausedTotal = 0
        lastAcceptedAt = nil
        RunPersistence.clear()
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
    }

    private func accept(_ location: CLLocation) {
        guard location.horizontalAccuracy >= 0, location.horizontalAccuracy <= maxAccuracy else { return }
        // Stationary drift: the device reports it's not moving
        if location.speed >= 0, location.speed < minSpeed { return }

        if let last = coordinates.last {
            let lastLocation = CLLocation(latitude: last.latitude, longitude: last.longitude)
            let step = location.distance(from: lastLocation)
            if step < minMovement { return }
            if let lastAcceptedAt, step > maxJump, location.timestamp.timeIntervalSince(lastAcceptedAt) < maxJumpInterval {
                return
            }
            distance += step
        }

        coordinates.append(location.coordinate)
        lastAcceptedAt = location.timestamp
        if coordinates.count % 10 == 0 {
            persist()
        }
        checkTreasures(near: location)
    }

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
                    collectedTreasures.append(treasure)
                    Haptics.success()
                } catch {
                    // Collected by someone else or expired: don't retry during this run
                }
            }
        }
    }

    private func persist() {
        guard let startDate else { return }
        RunPersistence.save(SavedRun(
            coordinates: coordinates.map { [$0.latitude, $0.longitude] },
            distance: distance,
            startDate: startDate,
            pausedTotal: pausedTotal + (pausedAt.map { Date().timeIntervalSince($0) } ?? 0),
            savedAt: Date()
        ))
    }
}

/// A finished run ready to upload.
struct FinishedRun {
    let coordinates: [CLLocationCoordinate2D]
    let distance: CLLocationDistance
    let duration: Int
    let startedAt: Date
    let completedAt: Date
    let treasures: [Treasure]
}

private final class LocationDelegate: NSObject, CLLocationManagerDelegate {
    var onLocations: (([CLLocation]) -> Void)?
    var onAuthorizationChange: ((CLAuthorizationStatus) -> Void)?

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        onLocations?(locations)
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        onAuthorizationChange?(manager.authorizationStatus)
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
}

enum RunPersistence {
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

    static func clear() {
        try? FileManager.default.removeItem(at: fileURL)
    }
}
