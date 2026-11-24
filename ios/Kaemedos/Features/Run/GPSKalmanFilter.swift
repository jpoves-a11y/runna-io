import Foundation
import CoreLocation

/// Smooths GPS fixes while recording a run: a constant-velocity Kalman filter on local metres,
/// one independent filter per axis (east, north). Each fix is weighted by its reported accuracy,
/// so a 25 m fix moves the estimate much less than a 5 m one and the GPS zigzag doesn't add distance.
struct GPSKalmanFilter {
    /// How much the runner's speed can change, in m/s² (process noise). Higher follows turns
    /// faster but smooths less.
    var acceleration: Double = 3
    /// After a gap longer than this (seconds) the estimate is stale: restart from the new fix.
    var maxGap: TimeInterval = 10

    private struct Axis {
        var position: Double
        var velocity: Double
        // Covariance [[p00, p01], [p01, p11]]
        var p00: Double
        var p01: Double
        var p11: Double

        init(position: Double, variance: Double) {
            self.position = position
            velocity = 0
            p00 = variance
            p01 = 0
            p11 = 25 // up to ~5 m/s unknown at first
        }

        mutating func predict(dt: Double, q: Double) {
            position += velocity * dt
            let dt2 = dt * dt
            let newP00 = p00 + dt * (2 * p01 + dt * p11) + q * dt2 * dt2 / 4
            let newP01 = p01 + dt * p11 + q * dt2 * dt / 2
            let newP11 = p11 + q * dt2
            p00 = newP00
            p01 = newP01
            p11 = newP11
        }

        mutating func update(measurement: Double, variance: Double) {
            let s = p00 + variance
            guard s > 0 else { return }
            let k0 = p00 / s
            let k1 = p01 / s
            let innovation = measurement - position
            position += k0 * innovation
            velocity += k1 * innovation
            let newP00 = (1 - k0) * p00
            let newP01 = (1 - k0) * p01
            let newP11 = p11 - k1 * p01
            p00 = newP00
            p01 = newP01
            p11 = newP11
        }
    }

    private var origin: CLLocationCoordinate2D?
    private var metresPerDegreeLng: Double = 0
    private var east: Axis?
    private var north: Axis?
    private var lastTimestamp: Date?

    private static let metresPerDegreeLat = 111_320.0

    mutating func reset() {
        origin = nil
        east = nil
        north = nil
        lastTimestamp = nil
    }

    /// Feeds a fix and returns the smoothed position.
    mutating func process(_ location: CLLocation) -> CLLocationCoordinate2D {
        let coordinate = location.coordinate
        let accuracy = max(location.horizontalAccuracy, 3)
        let variance = accuracy * accuracy

        if origin == nil {
            origin = coordinate
            metresPerDegreeLng = Self.metresPerDegreeLat * cos(coordinate.latitude * .pi / 180)
        }
        let (x, y) = toMetres(coordinate)

        let dt = lastTimestamp.map { location.timestamp.timeIntervalSince($0) } ?? -1
        guard var east = self.east, var north = self.north, dt > 0, dt <= maxGap else {
            self.east = Axis(position: x, variance: variance)
            self.north = Axis(position: y, variance: variance)
            self.lastTimestamp = location.timestamp
            return coordinate
        }

        let q = acceleration * acceleration
        east.predict(dt: dt, q: q)
        north.predict(dt: dt, q: q)
        east.update(measurement: x, variance: variance)
        north.update(measurement: y, variance: variance)
        self.east = east
        self.north = north
        self.lastTimestamp = location.timestamp
        return toCoordinate(x: east.position, y: north.position)
    }

    private func toMetres(_ coordinate: CLLocationCoordinate2D) -> (Double, Double) {
        guard let origin else { return (0, 0) }
        let x = (coordinate.longitude - origin.longitude) * metresPerDegreeLng
        let y = (coordinate.latitude - origin.latitude) * Self.metresPerDegreeLat
        return (x, y)
    }

    private func toCoordinate(x: Double, y: Double) -> CLLocationCoordinate2D {
        guard let origin, metresPerDegreeLng > 0 else { return CLLocationCoordinate2D(latitude: 0, longitude: 0) }
        return CLLocationCoordinate2D(
            latitude: origin.latitude + y / Self.metresPerDegreeLat,
            longitude: origin.longitude + x / metresPerDegreeLng
        )
    }
}
