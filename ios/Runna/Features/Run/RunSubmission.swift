import Foundation
import CoreLocation
import Observation

/// Uploads a finished run and waits for the server to compute the conquered territory.
@MainActor
@Observable
final class RunSubmission {
    enum State {
        case uploading
        case processing
        case done(ConquestResult?)
        case failed(String)
    }

    let run: FinishedRun
    private(set) var state: State = .uploading
    private(set) var route: RunRoute?

    init(run: FinishedRun) {
        self.run = run
    }

    func submit() async {
        state = .uploading
        do {
            let response: CreateRouteResponse = try await APIClient.shared.request(
                "POST", "/api/routes", body: PendingRuns.body(for: PendingRuns.Entry(run: run))
            )
            route = response.route
            state = .processing
            state = .done(await Self.waitForConquest(routeId: response.route.id))
        } catch {
            // Keep the run so it's uploaded later instead of being lost
            PendingRuns.add(PendingRuns.Entry(run: run))
            state = .failed(error.localizedDescription)
        }
    }

    /// The territory is processed in a server queue; poll for up to ~30 s.
    static func waitForConquest(routeId: String) async -> ConquestResult? {
        for _ in 0..<15 {
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            if Task.isCancelled { return nil }
            if let result: ConquestResult = try? await APIClient.shared.request("GET", "/api/conquest-result/\(routeId)"),
               result.ready {
                return result
            }
        }
        return nil
    }
}

/// Runs that couldn't be uploaded (no connection when finishing). Retried when the map appears.
enum PendingRuns {
    struct Entry: Codable {
        let name: String
        let coordinates: [[Double]]
        let distance: Double
        let duration: Int
        let startedAt: Date
        let completedAt: Date

        init(run: FinishedRun) {
            name = "Carrera del \(Format.day(run.startedAt))"
            coordinates = run.coordinates.map { [$0.latitude, $0.longitude] }
            distance = run.distance
            duration = run.duration
            startedAt = run.startedAt
            completedAt = run.completedAt
        }
    }

    private static var fileURL: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("pending-runs.json")
    }

    static func body(for entry: Entry) -> [String: Any] {
        [
            "name": entry.name,
            "coordinates": entry.coordinates,
            "distance": entry.distance,
            "duration": entry.duration,
            "startedAt": APIDate.string(entry.startedAt),
            "completedAt": APIDate.string(entry.completedAt),
        ]
    }

    static func all() -> [Entry] {
        guard let data = try? Data(contentsOf: fileURL) else { return [] }
        return (try? JSONDecoder().decode([Entry].self, from: data)) ?? []
    }

    static func add(_ entry: Entry) {
        save(all() + [entry])
    }

    private static func save(_ entries: [Entry]) {
        do {
            try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            if entries.isEmpty {
                try? FileManager.default.removeItem(at: fileURL)
            } else {
                try JSONEncoder().encode(entries).write(to: fileURL, options: .atomic)
            }
        } catch {
            #if DEBUG
            print("Could not save pending runs:", error)
            #endif
        }
    }

    /// Uploads pending runs; returns how many were uploaded.
    @discardableResult
    static func uploadAll() async -> Int {
        let entries = all()
        guard !entries.isEmpty else { return 0 }
        var remaining: [Entry] = []
        var uploaded = 0
        for entry in entries {
            do {
                let _: CreateRouteResponse = try await APIClient.shared.request("POST", "/api/routes", body: body(for: entry))
                uploaded += 1
            } catch let error as APIError where (400..<500).contains(error.status) && error.status != 401 {
                // Rejected by the server (invalid run): don't retry forever
            } catch {
                remaining.append(entry)
            }
        }
        save(remaining)
        return uploaded
    }
}
