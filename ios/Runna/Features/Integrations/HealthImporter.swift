import Foundation
import HealthKit
import CoreLocation
import Observation

/// Imports running workouts with GPS routes from Apple Health (e.g. recorded on an Apple Watch).
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

    private(set) var isImporting = false

    var autoImport: Bool {
        get { UserDefaults.standard.bool(forKey: autoImportKey) }
        set { UserDefaults.standard.set(newValue, forKey: autoImportKey) }
    }

    /// A workout without a GPS route is only given up on after this long (Apple Watch routes sync later)
    /// unless it's marked as indoor.
    private let routeGracePeriod: TimeInterval = 36 * 60 * 60

    private init() {}

    private func importedKey(for userId: String) -> String { "healthImportedWorkouts.\(userId)" }

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

    /// Imports when the user enabled it, at most every 30 minutes.
    func autoImportIfEnabled() async {
        guard Self.isAvailable, autoImport, !isImporting else { return }
        let last = UserDefaults.standard.double(forKey: lastImportKey)
        guard Date().timeIntervalSince1970 - last > 30 * 60 else { return }
        _ = try? await importRecentRuns(days: 14)
    }

    /// Uploads running workouts of the last `days` days that haven't been imported yet.
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

        for workout in try await runningWorkouts(days: days) where !imported.contains(workout.uuid.uuidString) {
            // The account may have changed during a long import
            guard RunOwner.currentUserId == userId else { break }
            let workoutId = workout.uuid.uuidString
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
            let body: [String: Any] = [
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

    private func runningWorkouts(days: Int) async throws -> [HKWorkout] {
        let start = Calendar.current.date(byAdding: .day, value: -days, to: Date()) ?? Date()
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
