import Foundation
import HealthKit
import CoreLocation
import Observation

/// Imports running workouts with GPS routes from Apple Health (e.g. recorded on an Apple Watch),
/// and saves the runs recorded in Runna.io to Apple Health when the user wants.
@MainActor
@Observable
final class HealthImporter {
    static let shared = HealthImporter()

    struct Summary {
        var imported = 0
        var duplicates = 0
        var withoutRoute = 0
        var failed = 0

        var message: String {
            var parts: [String] = []
            if imported > 0 { parts.append("\(imported) carrera(s) importada(s)") }
            if duplicates > 0 { parts.append("\(duplicates) ya estaba(n) en Runna.io") }
            if withoutRoute > 0 { parts.append("\(withoutRoute) sin ruta GPS") }
            if failed > 0 { parts.append("\(failed) no se pudieron subir") }
            return parts.isEmpty ? "No hay carreras nuevas en Apple Salud." : parts.joined(separator: " · ")
        }
    }

    static var isAvailable: Bool { HKHealthStore.isHealthDataAvailable() }

    private let store = HKHealthStore()
    /// Legacy key, shared by every account on the device (read once and migrated per account).
    private let legacyImportedKey = "healthImportedWorkouts"
    private let autoImportKey = "healthAutoImport"
    private let lastImportKey = "healthLastImport"
    private let saveRunsKey = "healthSaveRuns"

    private(set) var isImporting = false

    var autoImport: Bool {
        get { UserDefaults.standard.bool(forKey: autoImportKey) }
        set { UserDefaults.standard.set(newValue, forKey: autoImportKey) }
    }

    /// Runs recorded in the app are written to Apple Health as workouts with their route.
    var saveRuns: Bool {
        get { UserDefaults.standard.bool(forKey: saveRunsKey) }
        set { UserDefaults.standard.set(newValue, forKey: saveRunsKey) }
    }

    /// A workout without a GPS route is only given up on after this long (Apple Watch routes sync later)
    /// unless it's marked as indoor.
    private let routeGracePeriod: TimeInterval = 36 * 60 * 60

    private init() {}

    private func importedKey(for userId: String) -> String { "healthImportedWorkouts.\(userId)" }
    private func linkedAtKey(for userId: String) -> String { "healthLinkedAt.\(userId)" }

    /// When this account first imported from Apple Health on this device: older workouts are never uploaded,
    /// like the Strava / Polar / Suunto / Garmin imports, which start when the account is linked.
    private func linkedAt(userId: String) -> Date {
        let defaults = UserDefaults.standard
        let stored = defaults.double(forKey: linkedAtKey(for: userId))
        if stored > 0 { return Date(timeIntervalSince1970: stored) }
        let now = Date()
        defaults.set(now.timeIntervalSince1970, forKey: linkedAtKey(for: userId))
        return now
    }

    private func loadImported(userId: String) -> Set<String> {
        let defaults = UserDefaults.standard
        if let stored = defaults.stringArray(forKey: importedKey(for: userId)) {
            return Set(stored)
        }
        // First import for this account since workouts were tracked per account
        let legacy = defaults.stringArray(forKey: legacyImportedKey) ?? []
        defaults.removeObject(forKey: legacyImportedKey)
        return Set(legacy)
    }

    private func saveImported(_ imported: Set<String>, userId: String) {
        UserDefaults.standard.set(Array(imported), forKey: importedKey(for: userId))
    }

    func requestAuthorization() async throws {
        let types: Set<HKObjectType> = [HKObjectType.workoutType(), HKSeriesType.workoutRoute()]
        try await store.requestAuthorization(toShare: [], read: types)
    }

    private var shareTypes: Set<HKSampleType> {
        [HKObjectType.workoutType(), HKSeriesType.workoutRoute(), HKQuantityType(.distanceWalkingRunning)]
    }

    /// Asks to write workouts (when the user turns "Guardar en Salud" on).
    func requestWriteAuthorization() async throws {
        let read: Set<HKObjectType> = [HKObjectType.workoutType(), HKSeriesType.workoutRoute()]
        try await store.requestAuthorization(toShare: shareTypes, read: read)
    }

    // MARK: - Saving runs

    /// Writes a run recorded in the app to Apple Health: a running workout with its distance and GPS route.
    /// Does nothing when the option is off or the user didn't allow writing.
    func save(_ run: FinishedRun) async {
        guard Self.isAvailable, saveRuns,
              store.authorizationStatus(for: HKObjectType.workoutType()) == .sharingAuthorized else { return }
        let configuration = HKWorkoutConfiguration()
        configuration.activityType = .running
        configuration.locationType = .outdoor
        let builder = HKWorkoutBuilder(healthStore: store, configuration: configuration, device: .local())
        do {
            try await builder.beginCollection(at: run.startedAt)
            let distance = HKQuantitySample(
                type: HKQuantityType(.distanceWalkingRunning),
                quantity: HKQuantity(unit: .meter(), doubleValue: run.distance),
                start: run.startedAt,
                end: run.completedAt
            )
            try await builder.addSamples([distance])
            try await builder.addMetadata([HKMetadataKeyExternalUUID: run.id, HKMetadataKeyIndoorWorkout: false])
            try await builder.endCollection(at: run.completedAt)
            guard let workout = try await builder.finishWorkout() else { return }

            let locations = Self.locations(of: run)
            guard locations.count >= 2,
                  store.authorizationStatus(for: HKSeriesType.workoutRoute()) == .sharingAuthorized else { return }
            let routeBuilder = HKWorkoutRouteBuilder(healthStore: store, device: .local())
            try await routeBuilder.insertRouteData(locations)
            _ = try await routeBuilder.finishRoute(with: workout, metadata: nil)
        } catch {
            #if DEBUG
            print("Could not save the run to Apple Health:", error)
            #endif
        }
    }

    /// The run's points as locations with their time and altitude (spread evenly when times are unknown).
    private static func locations(of run: FinishedRun) -> [CLLocation] {
        let points = run.coordinates
        guard points.count >= 2 else { return [] }
        let total = run.completedAt.timeIntervalSince(run.startedAt)
        return points.enumerated().map { index, point in
            let offset = run.pointTimes?[safe: index] ?? total * Double(index) / Double(points.count - 1)
            let altitude = run.altitudes?[safe: index] ?? nil
            return CLLocation(
                coordinate: point,
                altitude: altitude ?? 0,
                horizontalAccuracy: 10,
                verticalAccuracy: altitude == nil ? -1 : 10,
                timestamp: run.startedAt.addingTimeInterval(offset)
            )
        }
    }

    /// Imports when the user enabled it, at most every 30 minutes.
    func autoImportIfEnabled() async {
        guard Self.isAvailable, autoImport, !isImporting else { return }
        let last = UserDefaults.standard.double(forKey: lastImportKey)
        guard Date().timeIntervalSince1970 - last > 30 * 60 else { return }
        _ = try? await importRecentRuns(days: 14)
    }

    /// Uploads running workouts of the last `days` days, done since the account linked Apple Health, that haven't been imported yet.
    func importRecentRuns(days: Int = 30) async throws -> Summary {
        guard Self.isAvailable else {
            throw APIError(status: 0, message: "Apple Salud no está disponible en este dispositivo.")
        }
        guard !isImporting else { return Summary() }
        isImporting = true
        defer { isImporting = false }

        guard let userId = RunOwner.currentUserId else {
            throw APIError(status: 401, message: "Inicia sesión para importar tus carreras.")
        }

        try await requestAuthorization()

        var imported = loadImported(userId: userId)
        var summary = Summary()

        let since = linkedAt(userId: userId)
        for workout in try await runningWorkouts(days: days, notBefore: since) where !imported.contains(workout.uuid.uuidString) {
            // The account may have changed during a long import
            guard RunOwner.currentUserId == userId else { break }
            let workoutId = workout.uuid.uuidString
            // Runs this app wrote to Apple Health are already in Runna.io
            if workout.sourceRevision.source.bundleIdentifier == Bundle.main.bundleIdentifier {
                imported.insert(workoutId)
                continue
            }
            let coordinates: [CLLocation]
            do {
                coordinates = Self.filtered(try await routeLocations(for: workout))
            } catch is CancellationError {
                break
            } catch {
                // One unreadable route must not stop the others; it's retried next time
                summary.failed += 1
                continue
            }
            guard coordinates.count >= 3 else {
                summary.withoutRoute += 1
                let isIndoor = (workout.metadata?[HKMetadataKeyIndoorWorkout] as? Bool) == true
                let isOld = Date().timeIntervalSince(workout.endDate) > routeGracePeriod
                // The Watch syncs the route after the workout: keep trying for a while
                if isIndoor || isOld {
                    imported.insert(workoutId)
                    saveImported(imported, userId: userId)
                }
                continue
            }

            let distance = workout.totalDistance?.doubleValue(for: .meter()) ?? Self.length(of: coordinates)
            var body: [String: Any] = [
                "name": "Carrera del \(Format.day(workout.startDate))",
                "coordinates": coordinates.map { [$0.coordinate.latitude, $0.coordinate.longitude] },
                "distance": distance,
                "duration": Int(workout.duration.rounded()),
                "startedAt": APIDate.string(workout.startDate),
                "completedAt": APIDate.string(workout.endDate),
                "source": "healthkit",
                // Idempotency key: the workout UUID (a retry after a lost response doesn't duplicate it)
                "clientRunId": "healthkit-\(workoutId)",
            ]
            // Time of each point (pace, splits and the speed check of each stretch) and its altitude
            body["pointTimes"] = coordinates.map { (max(0, $0.timestamp.timeIntervalSince(workout.startDate)) * 10).rounded() / 10 }
            body["altitudes"] = coordinates.map { location -> Any in
                guard location.verticalAccuracy >= 0 else { return NSNull() }
                return (location.altitude * 10).rounded() / 10
            }
            do {
                let response: CreateRouteResponse = try await APIClient.shared.request("POST", "/api/routes", body: body)
                summary.imported += 1
                imported.insert(workoutId)
                saveImported(imported, userId: userId)
                // Show what this run conquered
                ConquestInbox.shared.enqueue(routeId: response.route.id)
                UploadedRuns.didUpload(response.route)
            } catch let error as APIError where error.status == 409 {
                summary.duplicates += 1
                imported.insert(workoutId)
                saveImported(imported, userId: userId)
            } catch is CancellationError {
                break
            } catch {
                summary.failed += 1
            }
        }

        saveImported(imported, userId: userId)
        // Throttle auto-import only after a pass that got through
        UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: lastImportKey)
        return summary
    }

    private func runningWorkouts(days: Int, notBefore: Date) async throws -> [HKWorkout] {
        let windowStart = Calendar.current.date(byAdding: .day, value: -days, to: Date()) ?? Date()
        let start = max(windowStart, notBefore)
        let predicate = NSCompoundPredicate(andPredicateWithSubpredicates: [
            HKQuery.predicateForWorkouts(with: .running),
            HKQuery.predicateForSamples(withStart: start, end: Date()),
        ])
        let descriptor = HKSampleQueryDescriptor(
            predicates: [.workout(predicate)],
            sortDescriptors: [SortDescriptor(\.startDate, order: .forward)],
            limit: 100
        )
        return try await descriptor.result(for: store)
    }

    private func routeLocations(for workout: HKWorkout) async throws -> [CLLocation] {
        let routeDescriptor = HKSampleQueryDescriptor(
            predicates: [.workoutRoute(HKQuery.predicateForObjects(from: workout))],
            sortDescriptors: [],
            limit: 10
        )
        let routes = try await routeDescriptor.result(for: store)
        var locations: [CLLocation] = []
        for route in routes {
            locations += try await Self.locations(of: route, in: store)
        }
        return locations.sorted { $0.timestamp < $1.timestamp }
    }

    private static func locations(of route: HKWorkoutRoute, in store: HKHealthStore) async throws -> [CLLocation] {
        try await withCheckedThrowingContinuation { continuation in
            var collected: [CLLocation] = []
            var finished = false
            let query = HKWorkoutRouteQuery(route: route) { _, batch, done, error in
                guard !finished else { return }
                if let error {
                    finished = true
                    continuation.resume(throwing: error)
                    return
                }
                collected += batch ?? []
                if done {
                    finished = true
                    continuation.resume(returning: collected)
                }
            }
            store.execute(query)
        }
    }

    /// Same idea as live tracking: drop inaccurate fixes and points closer than 5 m.
    private static func filtered(_ locations: [CLLocation]) -> [CLLocation] {
        var result: [CLLocation] = []
        for location in locations where location.horizontalAccuracy >= 0 && location.horizontalAccuracy <= 50 {
            if let last = result.last, location.distance(from: last) < 5 { continue }
            result.append(location)
        }
        return result
    }

    private static func length(of locations: [CLLocation]) -> Double {
        zip(locations, locations.dropFirst()).reduce(0) { $0 + $1.1.distance(from: $1.0) }
    }
}
