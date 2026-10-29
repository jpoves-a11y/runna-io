import Foundation
import CoreLocation
import SwiftUI

// Pure logic used while running (no UI, no CoreLocation manager), so it can be unit tested:
// the territory you would conquer if you finished now, the zone you're in, current pace, km splits
// and auto-pause.

// MARK: - Plane geometry (metres around a reference point; fine at city scale)

enum RunGeometry {
    private static let metersPerDegreeLat = 110_540.0
    private static let metersPerDegreeLng = 111_320.0

    /// (x, y) in metres of `coordinate` relative to `origin`.
    static func project(_ coordinate: CLLocationCoordinate2D, origin: CLLocationCoordinate2D) -> (x: Double, y: Double) {
        let cosLat = max(0.2, cos(origin.latitude * .pi / 180))
        return (
            x: (coordinate.longitude - origin.longitude) * metersPerDegreeLng * cosLat,
            y: (coordinate.latitude - origin.latitude) * metersPerDegreeLat
        )
    }

    /// Area in m² enclosed by a ring (shoelace; the ring may or may not repeat its first point).
    static func area(of ring: [CLLocationCoordinate2D]) -> Double {
        guard ring.count >= 3, let origin = ring.first else { return 0 }
        let points = ring.map { project($0, origin: origin) }
        var sum = 0.0
        for i in 0..<points.count {
            let a = points[i]
            let b = points[(i + 1) % points.count]
            sum += a.x * b.y - b.x * a.y
        }
        return abs(sum) / 2
    }

    /// Ray-casting point-in-polygon test.
    static func contains(_ ring: [CLLocationCoordinate2D], _ point: CLLocationCoordinate2D) -> Bool {
        guard ring.count >= 3 else { return false }
        var inside = false
        var j = ring.count - 1
        for i in 0..<ring.count {
            let a = ring[i]
            let b = ring[j]
            if (a.latitude > point.latitude) != (b.latitude > point.latitude) {
                let crossing = (b.longitude - a.longitude) * (point.latitude - a.latitude) / (b.latitude - a.latitude) + a.longitude
                if point.longitude < crossing { inside.toggle() }
            }
            j = i
        }
        return inside
    }

    /// Inside the outer ring and not in a hole.
    static func contains(rings: [[CLLocationCoordinate2D]], _ point: CLLocationCoordinate2D) -> Bool {
        guard let outer = rings.first, contains(outer, point) else { return false }
        return !rings.dropFirst().contains { contains($0, point) }
    }

    /// Compass bearing in degrees (0 = north) from `a` to `b`.
    static func bearing(from a: CLLocationCoordinate2D, to b: CLLocationCoordinate2D) -> Double {
        let lat1 = a.latitude * .pi / 180
        let lat2 = b.latitude * .pi / 180
        let dLng = (b.longitude - a.longitude) * .pi / 180
        let y = sin(dLng) * cos(lat2)
        let x = cos(lat1) * sin(lat2) - sin(lat1) * cos(lat2) * cos(dLng)
        let degrees = atan2(y, x) * 180 / .pi
        return degrees < 0 ? degrees + 360 : degrees
    }

    static func distance(_ a: CLLocationCoordinate2D, _ b: CLLocationCoordinate2D) -> Double {
        CLLocation(latitude: a.latitude, longitude: a.longitude).distance(from: CLLocation(latitude: b.latitude, longitude: b.longitude))
    }

    /// Bounding box (minLat, minLng, maxLat, maxLng).
    static func bounds(_ points: [CLLocationCoordinate2D]) -> (minLat: Double, minLng: Double, maxLat: Double, maxLng: Double)? {
        guard let first = points.first else { return nil }
        var box = (minLat: first.latitude, minLng: first.longitude, maxLat: first.latitude, maxLng: first.longitude)
        for p in points {
            box.minLat = min(box.minLat, p.latitude)
            box.maxLat = max(box.maxLat, p.latitude)
            box.minLng = min(box.minLng, p.longitude)
            box.maxLng = max(box.maxLng, p.longitude)
        }
        return box
    }

    /// At most `maxPoints` points, evenly picked (first and last kept).
    static func thinned(_ points: [CLLocationCoordinate2D], maxPoints: Int) -> [CLLocationCoordinate2D] {
        guard points.count > maxPoints, maxPoints >= 2 else { return points }
        let step = Double(points.count - 1) / Double(maxPoints - 1)
        return (0..<maxPoints).map { points[min(points.count - 1, Int((Double($0) * step).rounded()))] }
    }
}

// MARK: - What you'd conquer if you finished now

/// The route closed back to its start (as the server does when the run ends), with its area and an
/// estimate of how much of it belongs to other runners.
struct RunPreview: Equatable {
    struct Steal: Equatable, Identifiable {
        let userId: String
        let name: String
        let area: Double
        var id: String { userId }
    }

    /// Closed ring (last point = first point).
    let ring: [CLLocationCoordinate2D]
    let area: Double
    /// Area of other runners inside the ring, largest first.
    let steals: [Steal]

    static func == (lhs: RunPreview, rhs: RunPreview) -> Bool {
        lhs.area == rhs.area && lhs.steals == rhs.steals && lhs.ring.count == rhs.ring.count
    }
}

enum RunPreviewCalculator {
    /// Below this the "territory" is GPS noise (same threshold as the server).
    static let minArea = 100.0
    /// Grid used to estimate the overlap with other territories (cells per side).
    private static let gridSide = 40

    static func preview(path: [CLLocationCoordinate2D], territories: [TerritoryShape], myUserId: String?) -> RunPreview? {
        guard path.count >= 3, let start = path.first else { return nil }
        var ring = RunGeometry.thinned(path, maxPoints: 300)
        ring.append(start)
        let area = RunGeometry.area(of: ring)
        guard area >= minArea, let box = RunGeometry.bounds(ring) else { return nil }

        // Rival territories whose bounding box touches the ring
        let rivals = territories.filter { shape in
            guard shape.userId != myUserId, let outer = shape.rings.first, let other = RunGeometry.bounds(outer) else { return false }
            return other.minLat <= box.maxLat && other.maxLat >= box.minLat && other.minLng <= box.maxLng && other.maxLng >= box.minLng
        }
        var steals: [RunPreview.Steal] = []
        if !rivals.isEmpty {
            // Sample the ring on a grid: each cell inside the ring and inside a rival counts for that rival
            let dLat = (box.maxLat - box.minLat) / Double(gridSide)
            let dLng = (box.maxLng - box.minLng) / Double(gridSide)
            let cellArea = RunGeometry.area(of: [
                CLLocationCoordinate2D(latitude: box.minLat, longitude: box.minLng),
                CLLocationCoordinate2D(latitude: box.minLat, longitude: box.minLng + dLng),
                CLLocationCoordinate2D(latitude: box.minLat + dLat, longitude: box.minLng + dLng),
                CLLocationCoordinate2D(latitude: box.minLat + dLat, longitude: box.minLng),
            ])
            var cellsByUser: [String: Int] = [:]
            var names: [String: String] = [:]
            for row in 0..<gridSide {
                for column in 0..<gridSide {
                    let point = CLLocationCoordinate2D(
                        latitude: box.minLat + (Double(row) + 0.5) * dLat,
                        longitude: box.minLng + (Double(column) + 0.5) * dLng
                    )
                    guard RunGeometry.contains(ring, point) else { continue }
                    if let owner = rivals.first(where: { RunGeometry.contains(rings: $0.rings, point) }) {
                        cellsByUser[owner.userId, default: 0] += 1
                        names[owner.userId] = owner.ownerName
                    }
                }
            }
            steals = cellsByUser
                .map { RunPreview.Steal(userId: $0.key, name: names[$0.key] ?? "", area: Double($0.value) * cellArea) }
                .filter { $0.area >= minArea }
                .sorted { $0.area > $1.area }
        }
        return RunPreview(ring: ring, area: area, steals: steals)
    }
}

// MARK: - The territory you're running through

/// Whose territory the runner is in. A change needs two fixes in a row (GPS jitter along borders).
struct RunZoneDetector {
    enum Zone: Equatable {
        case none
        case mine
        case rival(userId: String, name: String)

        var isRival: Bool {
            if case .rival = self { return true }
            return false
        }

        var text: String? {
            switch self {
            case .none: return nil
            case .mine: return "En tu territorio"
            case .rival(_, let name): return "En territorio de \(name)"
            }
        }
    }

    private(set) var zone: Zone = .none
    private var candidate: Zone = .none
    private var candidateCount = 0

    /// Returns the new zone when it changes.
    mutating func update(at point: CLLocationCoordinate2D, territories: [TerritoryShape], myUserId: String?) -> Zone? {
        let found: Zone
        if let shape = territories.first(where: { RunGeometry.contains(rings: $0.rings, point) }) {
            found = shape.userId == myUserId ? .mine : .rival(userId: shape.userId, name: shape.ownerName.isEmpty ? "otro corredor" : shape.ownerName)
        } else {
            found = .none
        }
        guard found != zone else {
            candidateCount = 0
            return nil
        }
        if found == candidate {
            candidateCount += 1
        } else {
            candidate = found
            candidateCount = 1
        }
        guard candidateCount >= 2 else { return nil }
        zone = found
        candidateCount = 0
        return found
    }
}

// MARK: - Current pace

/// Pace over the last stretch (about the last 200 m or 40 s of moving time).
struct RecentPace {
    private var samples: [(time: TimeInterval, distance: Double)] = []
    private let window: TimeInterval = 40
    private let minDistance: Double = 30

    mutating func add(movingTime: TimeInterval, distance: Double) {
        samples.append((movingTime, distance))
        // Keep a bit more than the window
        while let first = samples.first, movingTime - first.time > window * 2 { samples.removeFirst() }
    }

    mutating func reset() { samples = [] }

    /// Seconds per km, nil when there's not enough recent movement.
    var secondsPerKm: Double? {
        guard let last = samples.last else { return nil }
        guard let first = samples.first(where: { last.time - $0.time <= window || last.distance - $0.distance <= 200 }) else { return nil }
        let meters = last.distance - first.distance
        let seconds = last.time - first.time
        guard meters >= minDistance, seconds > 0 else { return nil }
        let pace = seconds / (meters / 1000)
        return pace.isFinite && pace < 60 * 30 ? pace : nil
    }
}

// MARK: - Km splits

struct RunSplits {
    struct Split: Equatable {
        /// 1-based km number.
        let km: Int
        /// Moving seconds of that km.
        let seconds: TimeInterval
    }

    private(set) var splits: [Split] = []
    private var lastSplitTime: TimeInterval = 0
    /// Km already done before `restart` (a recovered run): not split again.
    private var baseKm = 0

    /// Call on every distance update; returns the split when a km is completed.
    mutating func update(distance: Double, movingTime: TimeInterval) -> Split? {
        let completed = Int(distance / 1000)
        guard completed > baseKm + splits.count else { return nil }
        let split = Split(km: completed, seconds: movingTime - lastSplitTime)
        splits.append(split)
        lastSplitTime = movingTime
        return split
    }

    mutating func reset() {
        splits = []
        lastSplitTime = 0
        baseKm = 0
    }

    /// Continues counting from a run already in progress (restored after the app was closed).
    mutating func restart(distance: Double, movingTime: TimeInterval) {
        splits = []
        baseKm = Int(distance / 1000)
        lastSplitTime = movingTime
    }

    /// Splits of a whole run from the moving time at each point (for the run detail).
    static func from(distances: [Double], times: [TimeInterval]) -> [Split] {
        guard distances.count == times.count, distances.count >= 2 else { return [] }
        var result: [Split] = []
        var nextKm = 1
        var lastTime = times[0]
        for i in 1..<distances.count where distances[i] >= Double(nextKm) * 1000 {
            // Interpolate the moment the km boundary was crossed
            let d0 = distances[i - 1]
            let d1 = distances[i]
            let fraction = d1 > d0 ? (Double(nextKm) * 1000 - d0) / (d1 - d0) : 1
            let crossing = times[i - 1] + (times[i] - times[i - 1]) * min(max(fraction, 0), 1)
            result.append(Split(km: nextKm, seconds: crossing - lastTime))
            lastTime = crossing
            nextKm += 1
        }
        return result
    }
}

// MARK: - Auto-pause

/// Pauses when the runner stops (traffic light) and resumes when they move again.
struct AutoPauseDetector {
    enum Decision: Equatable { case none, pause, resume }

    /// Standing still this long pauses.
    var stillDuration: TimeInterval = 8
    /// Faster than this counts as moving (m/s, ~3.6 km/h: a slow walk uphill still counts).
    var movingSpeed: Double = 1.0
    /// Or this far from where it paused.
    var movedDistance: Double = 15

    private var lastMovementAt: Date?
    private var pausedAt: CLLocationCoordinate2D?
    private var movingFixes = 0

    mutating func reset(at date: Date) {
        lastMovementAt = date
        pausedAt = nil
        movingFixes = 0
    }

    /// Feed every fix. `isAutoPaused` tells whether the run is currently auto-paused.
    mutating func evaluate(speed: Double, coordinate: CLLocationCoordinate2D, at date: Date, isAutoPaused: Bool) -> Decision {
        if isAutoPaused {
            let farEnough = pausedAt.map { RunGeometry.distance($0, coordinate) >= movedDistance } ?? false
            movingFixes = speed >= movingSpeed ? movingFixes + 1 : 0
            if movingFixes >= 2 || farEnough {
                reset(at: date)
                return .resume
            }
            return .none
        }
        if speed >= movingSpeed {
            lastMovementAt = date
            return .none
        }
        guard let last = lastMovementAt else {
            lastMovementAt = date
            return .none
        }
        if date.timeIntervalSince(last) >= stillDuration {
            pausedAt = coordinate
            movingFixes = 0
            return .pause
        }
        return .none
    }
}

// MARK: - Spoken text

enum RunSpeech {
    /// "5 minutos 12 segundos"
    static func duration(_ seconds: TimeInterval) -> String {
        let total = max(0, Int(seconds.rounded()))
        let hours = total / 3600
        let minutes = (total % 3600) / 60
        let secs = total % 60
        var parts: [String] = []
        if hours > 0 { parts.append(hours == 1 ? "1 hora" : "\(hours) horas") }
        if minutes > 0 { parts.append(minutes == 1 ? "1 minuto" : "\(minutes) minutos") }
        if secs > 0 || parts.isEmpty { parts.append(secs == 1 ? "1 segundo" : "\(secs) segundos") }
        return parts.joined(separator: " ")
    }

    /// "Kilómetro 3. Tiempo total, 15 minutos 20 segundos. Último kilómetro a 5 minutos 12 segundos."
    static func split(_ split: RunSplits.Split, totalTime: TimeInterval) -> String {
        "Kilómetro \(split.km). Tiempo total, \(duration(totalTime)). Último kilómetro a \(duration(split.seconds))."
    }

    static let autoPaused = "Pausa automática."
    static let autoResumed = "Reanudando."

    /// "Tesoro a 250 metros."
    static func treasureNear(meters: Double) -> String {
        "Tesoro a \(Int((meters / 50).rounded()) * 50) metros."
    }

    static func zone(_ zone: RunZoneDetector.Zone) -> String? {
        switch zone {
        case .none: return nil
        case .mine: return "Entras en tu territorio."
        case .rival(_, let name): return "Entras en territorio de \(name)."
        }
    }
}
