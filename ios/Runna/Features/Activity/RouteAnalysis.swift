import Foundation
import CoreLocation

/// Km splits, pace along the run and elevation, from the time and altitude of each point.
/// Only for runs that have them (recorded or imported since they are kept).
struct RouteAnalysis {
    struct Split: Identifiable {
        /// 1-based; the last one may be a partial km.
        let km: Int
        /// Length of this split in km (1, or less for the last one).
        let length: Double
        /// Moving seconds of this split.
        let seconds: TimeInterval
        var id: Int { km }
        /// Seconds per km.
        var pace: Double { seconds / max(length, 0.001) }
    }

    struct Sample: Identifiable {
        let id: Int
        /// Distance from the start in km.
        let km: Double
        let value: Double
    }

    let splits: [Split]
    /// Pace (seconds per km) every 100 m, over the last 300 m.
    let pace: [Sample]
    /// Smoothed altitude every ~50 m.
    let elevation: [Sample]
    /// Metres climbed (ignoring GPS noise below 3 m).
    let elevationGain: Double

    /// A gap longer than this with almost no movement is a pause: its time doesn't count.
    private static let pauseGap: TimeInterval = 20
    private static let pauseSpeed: Double = 1.0
    /// Paces slower than this (walking stretches, GPS trouble) are left out of the chart.
    private static let slowestPace: Double = 20 * 60

    init?(coordinates: [CLLocationCoordinate2D], times: [Double]?, altitudes: [Double?]?) {
        guard let times, times.count == coordinates.count, coordinates.count >= 3 else { return nil }

        // Cumulative distance and moving time at each point
        var distances: [Double] = [0]
        var moving: [Double] = [0]
        for i in 1..<coordinates.count {
            let step = RunGeometry.distance(coordinates[i - 1], coordinates[i])
            let dt = max(0, times[i] - times[i - 1])
            let isPause = dt > Self.pauseGap && step / max(dt, 1) < Self.pauseSpeed
            distances.append(distances[i - 1] + step)
            moving.append(moving[i - 1] + (isPause ? 0 : dt))
        }
        guard let total = distances.last, total >= 200, (moving.last ?? 0) > 0 else { return nil }

        /// Moving time when the runner was `meters` from the start (interpolated).
        func movingTime(at meters: Double) -> Double {
            guard meters > 0 else { return 0 }
            guard meters < total else { return moving[moving.count - 1] }
            var low = 0
            var high = distances.count - 1
            while high - low > 1 {
                let mid = (low + high) / 2
                if distances[mid] < meters { low = mid } else { high = mid }
            }
            let d0 = distances[low]
            let d1 = distances[high]
            let fraction = d1 > d0 ? (meters - d0) / (d1 - d0) : 0
            return moving[low] + (moving[high] - moving[low]) * fraction
        }

        // Splits: every full km, plus the last part when it's at least 100 m
        var splits: [Split] = []
        var km = 1
        while Double(km) * 1000 <= total {
            splits.append(Split(km: km, length: 1, seconds: movingTime(at: Double(km) * 1000) - movingTime(at: Double(km - 1) * 1000)))
            km += 1
        }
        let rest = total - Double(km - 1) * 1000
        if rest >= 100 {
            splits.append(Split(km: km, length: rest / 1000, seconds: movingTime(at: total) - movingTime(at: Double(km - 1) * 1000)))
        }
        self.splits = splits.filter { $0.seconds > 0 }

        // Pace every 100 m over the previous 300 m
        var pace: [Sample] = []
        var mark = 300.0
        while mark <= total {
            let seconds = movingTime(at: mark) - movingTime(at: mark - 300)
            let value = seconds / 0.3
            if value > 60, value < Self.slowestPace {
                pace.append(Sample(id: pace.count, km: mark / 1000, value: value))
            }
            mark += 100
        }
        self.pace = pace

        // Elevation: points with an altitude, smoothed, then sampled every ~50 m
        var elevation: [Sample] = []
        var gain = 0.0
        if let altitudes, altitudes.count == coordinates.count {
            let known = altitudes.enumerated().compactMap { index, value in value.map { (distance: distances[index], altitude: $0) } }
            if known.count >= 3 {
                let window = 2
                let smoothed = known.indices.map { index -> Double in
                    let slice = known[max(0, index - window)...min(known.count - 1, index + window)]
                    return slice.reduce(0) { $0 + $1.altitude } / Double(slice.count)
                }
                var nextMark = 0.0
                for (index, point) in known.enumerated() where point.distance >= nextMark {
                    elevation.append(Sample(id: elevation.count, km: point.distance / 1000, value: smoothed[index]))
                    nextMark = point.distance + 50
                }
                // Climb counted in steps of at least 3 m so GPS noise doesn't add up
                var base = smoothed[0]
                for value in smoothed.dropFirst() {
                    if value - base >= 3 {
                        gain += value - base
                        base = value
                    } else if value < base {
                        base = value
                    }
                }
            }
        }
        self.elevation = elevation
        elevationGain = gain
    }

    init?(route: RunRoute) {
        self.init(coordinates: route.locations, times: route.pointTimes, altitudes: route.altitudes)
    }

    /// "5:12"
    static func paceText(_ secondsPerKm: Double) -> String {
        let total = Int(secondsPerKm.rounded())
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}
